use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{atomic::{AtomicBool, AtomicU64, Ordering}, mpsc, Arc},
    thread,
    time::{Duration, Instant},
};

use anyhow::{anyhow, Context, Result};
use parking_lot::{Mutex, RwLock};
use serde::Serialize;
use serde_json::json;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition,
    WebviewWindow,
};

use crate::{diagnostics::DiagnosticsLog, types::{WindowState, WindowStatePatch}};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use windows::Win32::{
    Foundation::{HWND, POINT, RECT},
    Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromPoint, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    },
    System::Threading::CREATE_NO_WINDOW,
    UI::{
        WindowsAndMessaging::{
            FindWindowExW, FindWindowW, GetAncestor, GetWindow, GetWindowLongPtrW, SetWindowLongPtrW,
            SetWindowPos, GA_ROOT, GWL_EXSTYLE, GW_HWNDNEXT, HWND_TOPMOST,
            SWP_NOMOVE, SWP_NOSIZE, SWP_NOACTIVATE, WS_EX_APPWINDOW, WS_EX_NOACTIVATE,
        },
    },
};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativePointerPayload {
    kind: String,
    client_x: f64,
    client_y: f64,
    alt_key: bool,
    space_key: bool,
    pointer_type: String,
    delta: f64,
    visible_bounds: VisibleBounds,
    #[serde(skip_serializing_if = "Option::is_none")]
    screen_x: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    screen_y: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    hit_bounds: Option<VisibleBounds>,
}

#[derive(Clone, Copy, Debug, Serialize)]
pub(crate) struct VisibleBounds { left: f64, top: f64, right: f64, bottom: f64 }

#[derive(Clone, Copy)]
struct PointerCoordinateSpace {
    window_x: i32,
    window_y: i32,
    scale: f64,
    visible_bounds: VisibleBounds,
}

struct NativeHelper {
    child: Child,
    stdin: ChildStdin,
}

struct NativeShared {
    app: AppHandle,
    state: RwLock<WindowState>,
    pending_input: Mutex<HashMap<String, mpsc::Sender<bool>>>,
    pending_layer: Mutex<HashMap<String, mpsc::Sender<String>>>,
    pending_key: Mutex<HashMap<String, mpsc::Sender<bool>>>,
    pending_shutdown: Mutex<Option<mpsc::Sender<()>>>,
    ready: AtomicBool,
    /// True while the helper LL hooks are armed. Used to skip a second disable
    /// IPC when the shortcut path already released INPUT before set_mode.
    input_hooks_active: AtomicBool,
    /// True while the helper-owned, no-activate Win32 input HWND covers the
    /// collaboration window. The HWND dies with the helper process.
    input_layer_active: AtomicBool,
    /// Skip blur Z-order / INPUT repair while Alt-pick handoff is critical.
    pick_critical_until: Mutex<Option<Instant>>,
    /// The collaboration window is locked for a gesture, so its physical origin
    /// and DPI can be reused instead of asking WebView2 on every pen packet.
    pointer_coordinate_space: Mutex<Option<PointerCoordinateSpace>>,
    sequence: AtomicU64,
}

pub struct NativeWindowManager {
    helper_script: PathBuf,
    helper: Mutex<Option<NativeHelper>>,
    shared: Arc<NativeShared>,
    diagnostics: Arc<DiagnosticsLog>,
    mode_lock: Mutex<()>,
    dirty: AtomicBool,
    close_confirmed: AtomicBool,
    close_pending: AtomicBool,
    move_sent: AtomicBool,
    shortcut: RwLock<String>,
}

impl NativeWindowManager {
    pub fn new(app: AppHandle, resource_dir: &Path, diagnostics: Arc<DiagnosticsLog>) -> Arc<Self> {
        Arc::new(Self {
            helper_script: normalize_helper_script(resource_dir.join("resources/native-window-move.ps1")), helper: Mutex::new(None),
            shared: Arc::new(NativeShared {
                app, state: RwLock::new(WindowState::default()),
                pending_input: Mutex::new(HashMap::new()), pending_layer: Mutex::new(HashMap::new()),
                pending_key: Mutex::new(HashMap::new()),
                pending_shutdown: Mutex::new(None),
                ready: AtomicBool::new(false), input_hooks_active: AtomicBool::new(false),
                input_layer_active: AtomicBool::new(false),
                pick_critical_until: Mutex::new(None),
                pointer_coordinate_space: Mutex::new(None),
                sequence: AtomicU64::new(0),
            }),
            diagnostics,
            mode_lock: Mutex::new(()),
            dirty: AtomicBool::new(false), close_confirmed: AtomicBool::new(false), close_pending: AtomicBool::new(false),
            move_sent: AtomicBool::new(false),
            shortcut: RwLock::new("Ctrl+Alt+Y".into()),
        })
    }

    pub fn start_helper(&self) -> Result<()> {
        if self.helper_alive() { return Ok(()); }
        self.clear_helper();
        Self::kill_orphan_helpers();
        if !self.helper_script.exists() {
            return Err(anyhow!("原生窗口 helper 脚本不存在: {}", self.helper_script.display()));
        }
        let mut command = Command::new("powershell.exe");
        command.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(&self.helper_script).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(windows)] command.creation_flags(CREATE_NO_WINDOW.0);
        let mut child = command.spawn().with_context(|| format!("无法启动 {}", self.helper_script.display()))?;
        let stdin = child.stdin.take().ok_or_else(|| anyhow!("原生窗口 helper stdin 不可用"))?;
        let stdout = child.stdout.take().ok_or_else(|| anyhow!("原生窗口 helper stdout 不可用"))?;
        let stderr = child.stderr.take();
        let shared = self.shared.clone();
        let diagnostics = self.diagnostics.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) { handle_helper_line(&shared, &diagnostics, &line); }
            shared.ready.store(false, Ordering::SeqCst);
            shared.input_hooks_active.store(false, Ordering::SeqCst);
            shared.input_layer_active.store(false, Ordering::SeqCst);
            diagnostics.warn("window.helper_stdout_closed", json!({}));
            // The helper-owned HWND is destroyed by Windows with the process.
            // Never inject a synthetic button release during crash recovery.
        });
        if let Some(stderr) = stderr {
            let diagnostics = self.diagnostics.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    if !line.trim().is_empty() {
                        diagnostics.warn("window.helper_stderr", json!({ "line": line.chars().take(400).collect::<String>() }));
                    }
                }
            });
        }
        *self.helper.lock() = Some(NativeHelper { child, stdin });
        Ok(())
    }

    fn helper_alive(&self) -> bool {
        let mut helper = self.helper.lock();
        let Some(current) = helper.as_mut() else { return false; };
        match current.child.try_wait() {
            Ok(None) => true,
            Ok(Some(status)) => {
                self.diagnostics.warn("window.helper_exited", json!({ "status": format!("{status}") }));
                *helper = None;
                self.shared.ready.store(false, Ordering::SeqCst);
                self.shared.input_hooks_active.store(false, Ordering::SeqCst);
                self.shared.input_layer_active.store(false, Ordering::SeqCst);
                false
            }
            Err(error) => {
                self.diagnostics.warn("window.helper_wait_failed", json!({ "error": error.to_string() }));
                *helper = None;
                self.shared.ready.store(false, Ordering::SeqCst);
                self.shared.input_hooks_active.store(false, Ordering::SeqCst);
                self.shared.input_layer_active.store(false, Ordering::SeqCst);
                false
            }
        }
    }

    fn clear_helper(&self) {
        // Ask the helper to release its Hook and native HWND on their owning
        // threads before considering a forced process stop.
        let had_helper = {
            let mut helper = self.helper.lock();
            if let Some(current) = helper.as_mut() {
                let (sender, receiver) = mpsc::channel();
                *self.shared.pending_shutdown.lock() = Some(sender);
                let _ = current.stdin.write_all(b"SHUTDOWN\n");
                let _ = current.stdin.flush();
                // Drop helper lock before waiting so stdout thread can progress.
                drop(helper);
                let acked = receiver.recv_timeout(Duration::from_millis(2000)).is_ok();
                if !acked {
                    self.diagnostics.warn("window.helper_shutdown_timeout", json!({}));
                    thread::sleep(Duration::from_millis(400));
                }
                true
            } else {
                false
            }
        };
        *self.shared.pending_shutdown.lock() = None;
        let mut helper = self.helper.lock();
        if let Some(mut current) = helper.take() {
            drop(current.stdin);
            let deadline = Instant::now() + Duration::from_millis(800);
            while Instant::now() < deadline {
                match current.child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) => thread::sleep(Duration::from_millis(20)),
                    Err(_) => break,
                }
            }
            if current.child.try_wait().ok().flatten().is_none() {
                let _ = current.child.kill();
            }
            let _ = current.child.wait();
        }
        self.shared.ready.store(false, Ordering::SeqCst);
        self.shared.input_hooks_active.store(false, Ordering::SeqCst);
        self.shared.input_layer_active.store(false, Ordering::SeqCst);
        if had_helper {
            self.diagnostics.info("window.helper_shutdown", json!({}));
        }
    }

    /// Release LL hooks then stop the helper. Call on app exit.
    pub fn shutdown(&self) {
        if self.helper_alive() {
            let _ = self.request_input(false, false, Duration::from_millis(800));
        }
        self.clear_helper();
        Self::kill_orphan_helpers();
    }

    fn kill_orphan_helpers() {
        #[cfg(windows)]
        {
            let mut command = Command::new("powershell.exe");
            command.args([
                "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
                "Get-CimInstance Win32_Process -Filter \"name='powershell.exe'\" | Where-Object { $_.CommandLine -like '*native-window-move.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
            ]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
            command.creation_flags(CREATE_NO_WINDOW.0);
            let _ = command.status();
        }
    }

    fn ensure_helper_ready(&self, timeout: Duration) -> Result<()> {
        if self.shared.ready.load(Ordering::SeqCst) && self.helper_alive() {
            return Ok(());
        }
        self.start_helper()?;
        let deadline = std::time::Instant::now() + timeout;
        while std::time::Instant::now() < deadline {
            if self.shared.ready.load(Ordering::SeqCst) && self.helper_alive() {
                return Ok(());
            }
            if !self.helper_alive() {
                self.start_helper()?;
            }
            thread::sleep(Duration::from_millis(20));
        }
        Err(anyhow!("原生窗口 helper 未能在时限内 READY"))
    }

    pub fn apply_flat_appearance(&self) {
        for _ in 0..40 {
            if self.shared.ready.load(Ordering::SeqCst) { break; }
            thread::sleep(Duration::from_millis(50));
        }
        if !self.shared.ready.load(Ordering::SeqCst) { return; }
        if let Ok(window) = self.main_window() {
            if let Ok(handle) = raw_handle(&window) { let _ = self.send_line(&format!("APPEARANCE|{handle}\n")); }
        }
    }

    pub fn set_mode(&self, patch: WindowStatePatch) -> Result<WindowState> {
        // Serialize like Electron enqueueWindowModeTransition — overlapping enters corrupt helper state.
        let _guard = self.mode_lock.lock();
        self.set_mode_inner(patch)
    }

    fn set_mode_inner(&self, patch: WindowStatePatch) -> Result<WindowState> {
        let previous = self.shared.state.read().clone();
        let next = previous.patched(patch.clone());
        let focusless_before = focusless(&previous);
        let focusless_next = focusless(&next);
        let native_input_before = focusless_before || previous.collaboration_mode;
        let native_input_next = focusless_next || next.collaboration_mode;
        let mode_changed = previous.collaboration_mode != next.collaboration_mode;
        self.diagnostics.info("window.set_mode.begin", json!({
            "previous": previous, "patch": patch, "next": next,
            "focuslessBefore": focusless_before, "focuslessNext": focusless_next,
        }));
        let main = self.main_window()?;
        let helper_transition = focusless_before != focusless_next || mode_changed;
        if helper_transition {
            // Resolve input ownership before mutating focus, Z order or non-client
            // state. A physical contact makes helper release return FAILED, so an
            // exit attempt cannot tear down the layer halfway through a stroke.
            let hooks_active = self.shared.input_hooks_active.load(Ordering::SeqCst);
            let need_input_ipc = native_input_next || (native_input_before && hooks_active);
            if need_input_ipc {
                let input_timeout = if native_input_next { Duration::from_millis(2500) } else { Duration::from_millis(800) };
                let input_ready = match self.request_input(native_input_next, next.collaboration_mode, input_timeout) {
                    Ok(ready) => ready,
                    Err(error) => {
                        self.diagnostics.error_with_message("window.set_mode.input_failed", error.to_string(), json!({
                            "previous": previous, "next": next,
                        }));
                        return Ok(previous);
                    }
                };
                if !input_ready {
                    let message = if native_input_next {
                        "无法启用协作输入钩子（INPUT），请重试或检查数位板驱动"
                    } else {
                        "笔尖或鼠标仍处于按下状态，已保留协作模式"
                    };
                    self.diagnostics.error_with_message("window.set_mode.input_failed", message, json!({
                        "previous": previous, "next": next,
                    }));
                    return Ok(previous);
                }
            } else {
                self.diagnostics.info("window.input_skip", json!({
                    "enabled": native_input_next, "hooksActive": hooks_active,
                }));
            }
            self.diagnostics.info("window.input_ready", json!({ "enabled": native_input_next }));

            if mode_changed {
                let layer_timeout = if next.collaboration_mode { Duration::from_millis(2500) } else { Duration::from_millis(1200) };
                let layer_ready = self.request_input_layer(next.collaboration_mode, layer_timeout).unwrap_or(false);
                if !layer_ready {
                    // Restore the previous input configuration before returning to
                    // the previous state. INPUT is restored before LAYER, matching
                    // both the normal enter and reverse-order exit contracts.
                    let _ = self.request_input(native_input_before, previous.collaboration_mode, Duration::from_millis(1200));
                    let restored_layer = self.request_input_layer(previous.collaboration_mode, Duration::from_millis(1800)).unwrap_or(false);
                    let message = if next.collaboration_mode {
                        "无法建立原生协作输入层，已取消进入协作模式"
                    } else {
                        "原生协作输入层尚未安全释放，已保留协作模式"
                    };
                    self.diagnostics.error_with_message("window.set_mode.input_layer_failed", message, json!({
                        "previous": previous, "next": next, "restoredLayer": restored_layer,
                    }));
                    return Ok(previous);
                }
                self.diagnostics.info("window.input_layer_ready", json!({
                    "enabled": next.collaboration_mode, "backend": "system-static",
                }));
            }
        }

        let window_properties = (|| -> Result<()> {
            if previous.always_on_top != next.always_on_top {
                set_always_on_top_screen_saver(&main, next.always_on_top)?;
            }
            set_window_opacity(&main, next.opacity.clamp(0.25, 1.0))?;
            main.set_resizable(!next.collaboration_mode)?;
            Ok(())
        })();
        if let Err(error) = window_properties {
            let _ = self.request_input(native_input_before, previous.collaboration_mode, Duration::from_millis(1200));
            if mode_changed {
                let _ = self.request_input_layer(previous.collaboration_mode, Duration::from_millis(1200));
            }
            let _ = self.rollback_mode(&main, &previous);
            self.diagnostics.error_with_message("window.set_mode.properties_failed", error.to_string(), json!({
                "previous": previous, "next": next,
            }));
            return Ok(previous);
        }

        if helper_transition {
            // Apply NOACTIVATE/taskbar placement only after helper ownership is
            // settled, never while helper reports an active contact.
            let layer_applied = apply_focusless_layer(&main, focusless_next, next.collaboration_mode).unwrap_or(false);
            if !layer_applied {
                let _ = self.request_input(native_input_before, previous.collaboration_mode, Duration::from_millis(1200));
                if mode_changed {
                    let _ = self.request_input_layer(previous.collaboration_mode, Duration::from_millis(1200));
                }
                let _ = apply_focusless_layer(&main, focusless_before, previous.collaboration_mode);
                self.rollback_mode(&main, &previous)?;
                let message = "无法建立协作窗口层级（NOACTIVATE/任务栏）";
                self.diagnostics.error_with_message("window.set_mode.layer_failed", message, json!({ "previous": previous, "next": next }));
                return Ok(previous);
            }
            self.diagnostics.info("window.layer_ready", json!({
                "enabled": focusless_next, "aboveTaskbar": next.collaboration_mode,
            }));
        }

        // Commit the click-through mode only after the native input observer is ready.
        if let Err(error) = main.set_ignore_cursor_events(next.click_through || focusless_next) {
            let _ = self.request_input(native_input_before, previous.collaboration_mode, Duration::from_millis(1200));
            if mode_changed {
                let _ = self.request_input_layer(previous.collaboration_mode, Duration::from_millis(1200));
            }
            let _ = apply_focusless_layer(&main, focusless_before, previous.collaboration_mode);
            let _ = self.rollback_mode(&main, &previous);
            self.diagnostics.error_with_message("window.set_mode.pointer_target_failed", error.to_string(), json!({
                "previous": previous, "next": next,
            }));
            return Ok(previous);
        }
        if next.collaboration_mode {
            // The overlay is created before set_resizable(false) and DWM placement.
            // Sync it to the final visible frame so the click-through main window
            // does not leave an uncovered strip around every edge.
            let _ = self.request_input_layer(true, Duration::from_millis(1500));
        }
        *self.shared.state.write() = next.clone();
        *self.shared.pointer_coordinate_space.lock() = None;
        if focusless_next && (!focusless_before || !previous.collaboration_mode && next.collaboration_mode) {
            self.shared.app.state::<crate::state::AppState>().photoshop.warm();
            self.shared.app.state::<crate::state::AppState>().photoshop.capture_focus();
        }
        if focusless_before && !focusless_next { let _ = main.set_focus(); }
        self.diagnostics.info("window.set_mode.ok", json!({ "state": next }));

        Ok(next)
    }

    fn rollback_mode(&self, window: &WebviewWindow, state: &WindowState) -> Result<()> {
        set_always_on_top_screen_saver(window, state.always_on_top)?;
        set_window_opacity(window, state.opacity.clamp(0.25, 1.0))?;
        window.set_resizable(!state.collaboration_mode)?;
        window.set_ignore_cursor_events(state.click_through || focusless(state))?;
        *self.shared.state.write() = state.clone();
        Ok(())
    }

    pub fn mode(&self) -> WindowState { self.shared.state.read().clone() }
    pub fn document_blocked(&self) -> bool { let state = self.shared.state.read(); state.collaboration_mode || focusless(&state) }
    pub fn shortcut(&self) -> String { self.shortcut.read().clone() }
    pub fn set_shortcut_value(&self, value: String) { *self.shortcut.write() = value; }
    pub fn set_dirty(&self, dirty: bool) { self.dirty.store(dirty, Ordering::SeqCst); }

    pub fn should_intercept_close(&self) -> bool {
        self.dirty.load(Ordering::SeqCst) && !self.close_confirmed.load(Ordering::SeqCst)
    }
    pub fn request_close_prompt(&self) {
        if !self.close_pending.swap(true, Ordering::SeqCst) { let _ = self.shared.app.emit("window:close-requested", ()); }
    }
    pub fn respond_close(&self, should_close: bool) {
        self.close_pending.store(false, Ordering::SeqCst);
        if should_close {
            self.close_confirmed.store(true, Ordering::SeqCst);
            if let Ok(window) = self.main_window() { let _ = window.close(); }
        }
    }

    pub fn disable_click_through(&self) {
        let mut state = self.shared.state.write();
        if !state.click_through { return; }
        state.click_through = false;
        if let Ok(window) = self.main_window() { let _ = window.set_ignore_cursor_events(focusless(&state)); }
        let _ = self.shared.app.emit("window:click-through-disabled", ());
    }

    pub fn toggle_collaboration_requested(&self) {
        let state = self.mode();
        self.diagnostics.info("window.toggle_collaboration_requested", json!({
            "collaborationMode": state.collaboration_mode,
            "locked": state.locked,
            "alwaysOnTop": state.always_on_top,
        }));
        if state.collaboration_mode {
            // Release helper ownership before React restores any window state.
            // A physical contact makes either request fail; in that case keep the
            // collaboration window untouched and do not emit the toggle request.
            let released = self.request_input(false, false, Duration::from_millis(500)).unwrap_or(false);
            self.diagnostics.info("window.collaboration_input_release", json!({ "released": released }));
            if !released {
                self.diagnostics.warn("window.collaboration_input_release_blocked", json!({ "reason": "active_contact_or_timeout" }));
                return;
            }
            let layer_released = self.request_input_layer(false, Duration::from_millis(900)).unwrap_or(false);
            self.diagnostics.info("window.collaboration_layer_release", json!({ "released": layer_released }));
            if !layer_released {
                let restored = self.request_input(true, true, Duration::from_millis(1200)).unwrap_or(false);
                let restored_layer = self.request_input_layer(true, Duration::from_millis(1800)).unwrap_or(false);
                self.diagnostics.warn("window.collaboration_layer_release_blocked", json!({
                    "inputRestored": restored, "layerRestored": restored_layer,
                }));
                return;
            }
            if let Ok(main) = self.main_window() {
                let _ = main.set_ignore_cursor_events(state.click_through);
            }
        }
        let _ = self.shared.app.emit("window:toggle-collaboration-requested", ());
    }

    pub fn begin_native_move(&self) -> Result<()> {
        if self.move_sent.swap(true, Ordering::SeqCst) { return Ok(()); }
        let window = self.main_window()?;
        if self.mode().locked || window.is_maximized()? { self.move_sent.store(false, Ordering::SeqCst); return Ok(()); }
        self.ensure_helper_ready(Duration::from_millis(2000))?;
        let handle = raw_handle(&window)?;
        self.send_line(&format!("{handle}\n"))
    }

    pub fn prepare_native_move(&self) { self.move_sent.store(false, Ordering::SeqCst); }
    pub fn finish_native_move(&self) { self.move_sent.store(false, Ordering::SeqCst); }

    pub fn query_key(&self, virtual_key: i32) -> bool {
        let id = self.next_id(); let (sender, receiver) = mpsc::channel(); self.shared.pending_key.lock().insert(id.clone(), sender);
        if self.send_line(&format!("KEY|{id}|{virtual_key}\n")).is_err() { self.shared.pending_key.lock().remove(&id); return false; }
        receiver.recv_timeout(Duration::from_millis(300)).unwrap_or(false)
    }

    pub fn work_area(&self, point: Option<(f64, f64)>) -> Result<VisibleBounds> {
        let window = self.main_window()?; let position = window.inner_position()?; let size = window.inner_size()?; let scale = window.scale_factor()?;
        let point = point.unwrap_or((size.width as f64 / scale / 2.0, size.height as f64 / scale / 2.0));
        Ok(monitor_bounds(position.x as f64 + point.0 * scale, position.y as f64 + point.1 * scale, position, scale))
    }

    pub fn extend_pick_critical(&self, extra: Duration) {
        extend_pick_critical(&self.shared, extra);
    }

    pub fn repair_after_blur(&self) {
        // AGENTS.md: do not re-apply Z-order / INPUT / pen sync during pick handoff.
        if pick_critical_active(&self.shared) {
            self.diagnostics.info("window.repair_after_blur_skipped", json!({ "reason": "pick_critical" }));
            return;
        }
        let state = self.mode();
        if focusless(&state) {
            if let Ok(main) = self.main_window() {
                let _ = apply_focusless_layer(&main, true, state.collaboration_mode);
            }
            let input_ready = self.request_input(true, state.collaboration_mode, Duration::from_millis(800)).unwrap_or(false);
            if input_ready && state.collaboration_mode {
                let _ = self.request_input_layer(true, Duration::from_millis(1500));
            }
        } else if state.always_on_top && !state.collaboration_mode {
            if let Ok(window) = self.main_window() { let _ = set_always_on_top_screen_saver(&window, true); }
        }
    }

    fn request_input(&self, enabled: bool, collaboration_zoom: bool, timeout: Duration) -> Result<bool> {
        if !enabled && !self.shared.input_hooks_active.load(Ordering::SeqCst) {
            return Ok(true);
        }
        // Disable should not wait 3s just to spawn a helper that we are about to disarm.
        let ready_timeout = if enabled { timeout.max(Duration::from_millis(3000)) } else { timeout.min(Duration::from_millis(800)) };
        if enabled {
            self.ensure_helper_ready(ready_timeout)?;
        } else if !self.shared.ready.load(Ordering::SeqCst) || !self.helper_alive() {
            self.shared.input_hooks_active.store(false, Ordering::SeqCst);
            return Ok(true);
        }
        let id = self.next_id();
        let handle = raw_handle(&self.main_window()?)?;
        let (sender, receiver) = mpsc::channel();
        self.shared.pending_input.lock().insert(id.clone(), sender);
        if let Err(error) = self.send_line(&format!("INPUT|{id}|{handle}|{}|{}\n", enabled as u8, collaboration_zoom as u8)) {
            self.shared.pending_input.lock().remove(&id);
            return Err(error);
        }
        match receiver.recv_timeout(timeout) {
            Ok(ready) => {
                if ready { self.shared.input_hooks_active.store(enabled, Ordering::SeqCst); }
                else if !enabled { self.shared.input_hooks_active.store(false, Ordering::SeqCst); }
                Ok(ready)
            }
            Err(_) => {
                self.shared.pending_input.lock().remove(&id);
                self.diagnostics.warn("window.input_timeout", json!({ "id": id, "enabled": enabled }));
                // A disable timeout is not proof that the physical contact and Hook
                // were released. Keep the prior state and refuse the mode transition.
                Ok(false)
            }
        }
    }

    fn request_input_layer(&self, enabled: bool, timeout: Duration) -> Result<bool> {
        if !enabled && !self.shared.input_layer_active.load(Ordering::SeqCst) {
            return Ok(true);
        }
        if enabled {
            self.ensure_helper_ready(timeout.max(Duration::from_millis(3000)))?;
        } else if !self.shared.ready.load(Ordering::SeqCst) || !self.helper_alive() {
            // The HWND belongs to the helper process and cannot survive its exit.
            self.shared.input_layer_active.store(false, Ordering::SeqCst);
            return Ok(true);
        }
        let id = self.next_id();
        let handle = raw_handle(&self.main_window()?)?;
        let (sender, receiver) = mpsc::channel();
        self.shared.pending_layer.lock().insert(id.clone(), sender);
        if let Err(error) = self.send_line(&format!("LAYER|{id}|{handle}|{}\n", enabled as u8)) {
            self.shared.pending_layer.lock().remove(&id);
            return Err(error);
        }
        match receiver.recv_timeout(timeout) {
            Ok(status) => {
                let ready = if enabled { status == "READY" } else { status == "RELEASED" };
                if ready {
                    self.shared.input_layer_active.store(enabled, Ordering::SeqCst);
                }
                Ok(ready)
            }
            Err(_) => {
                self.shared.pending_layer.lock().remove(&id);
                self.diagnostics.warn("window.input_layer_timeout", json!({ "id": id, "enabled": enabled }));
                Ok(false)
            }
        }
    }

    fn send_line(&self, line: &str) -> Result<()> {
        self.start_helper()?;
        let mut helper = self.helper.lock(); let helper = helper.as_mut().ok_or_else(|| anyhow!("原生窗口 helper 不可用"))?;
        helper.stdin.write_all(line.as_bytes())?; helper.stdin.flush()?; Ok(())
    }
    fn next_id(&self) -> String { self.shared.sequence.fetch_add(1, Ordering::Relaxed).to_string() }
    fn main_window(&self) -> Result<WebviewWindow> { self.shared.app.get_webview_window("main").ok_or_else(|| anyhow!("主窗口不可用")) }
}

impl Drop for NativeWindowManager {
    fn drop(&mut self) {
        if let Some(mut helper) = self.helper.get_mut().take() {
            let _ = helper.stdin.write_all(b"SHUTDOWN\n");
            let _ = helper.stdin.flush();
            drop(helper.stdin);
            // Prefer graceful exit so the Hook and helper-owned HWND are released
            // on their owning threads without synthesizing any input.
            let deadline = std::time::Instant::now() + Duration::from_millis(2000);
            while std::time::Instant::now() < deadline {
                match helper.child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) => thread::sleep(Duration::from_millis(50)),
                    Err(_) => break,
                }
            }
            let _ = helper.child.kill();
            let _ = helper.child.wait();
        }
        Self::kill_orphan_helpers();
    }
}

fn handle_helper_line(shared: &Arc<NativeShared>, diagnostics: &Arc<DiagnosticsLog>, line: &str) {
    if line == "READY" {
        shared.ready.store(true, Ordering::SeqCst);
        diagnostics.info("window.helper_ready", json!({}));
        return;
    }
    if let Some(message) = line.strip_prefix("ERROR ") {
        diagnostics.warn("window.helper_error", json!({ "message": message }));
        return;
    }
    let parts = line.split('|').collect::<Vec<_>>();
    match parts.first().copied() {
        Some("INPUT_ACK") if parts.len() >= 3 => if let Some(sender) = shared.pending_input.lock().remove(parts[1]) {
            let _ = sender.send(parts[2] == "READY" || parts[2] == "RELEASED");
        },
        Some("LAYER_ACK") if parts.len() >= 3 => if let Some(sender) = shared.pending_layer.lock().remove(parts[1]) {
            let _ = sender.send(parts[2].to_string());
        },
        Some("KEY") if parts.len() >= 3 => if let Some(sender) = shared.pending_key.lock().remove(parts[1]) { let _ = sender.send(parts[2] == "1"); },
        Some("ZOOM") if parts.len() >= 2 => { let _ = shared.app.emit("window:native-zoom", if parts[1] == "IN" { "in" } else { "out" }); }
        Some("POINTER") if parts.len() >= 8 => emit_helper_pointer(shared, &parts),
        Some("DONE") | Some("SKIPPED") | Some("APPEARANCE_DONE") | Some("APPEARANCE_SKIPPED") => {}
        Some("PICK_CRITICAL") if parts.len() >= 2 => {
            let extra = if parts[1] == "HOLD" {
                Duration::from_millis(500)
            } else {
                Duration::from_millis(2000)
            };
            extend_pick_critical(shared, extra);
        }
        Some("INPUT_SHUTDOWN") => {
            diagnostics.info("window.input_hooks_shutdown", json!({ "line": line }));
        }
        Some("SHUTDOWN_ACK") => {
            diagnostics.info("window.helper_shutdown_ack", json!({}));
            if let Some(sender) = shared.pending_shutdown.lock().take() {
                let _ = sender.send(());
            }
        }
        _ => {
            if !line.trim().is_empty() {
                diagnostics.warn("window.helper_unhandled", json!({ "line": line.chars().take(200).collect::<String>() }));
            }
        }
    }
}

fn extend_pick_critical(shared: &NativeShared, extra: Duration) {
    let until = Instant::now() + extra;
    let mut slot = shared.pick_critical_until.lock();
    *slot = Some(match *slot {
        Some(existing) if existing > until => existing,
        _ => until,
    });
}

fn pick_critical_active(shared: &NativeShared) -> bool {
    shared.pick_critical_until.lock().is_some_and(|until| Instant::now() < until)
}

fn emit_helper_pointer(shared: &Arc<NativeShared>, parts: &[&str]) {
    let pointer_type = if parts[6] == "pen" { "pen" } else { "mouse" };
    let kind = parts[1].to_ascii_lowercase();
    let begins_gesture = kind == "down";
    let Ok(screen_x) = parts[2].parse::<f64>() else { return; };
    let Ok(screen_y) = parts[3].parse::<f64>() else { return; };
    // HOVER/WHEEL must never seed a gesture cache: the helper can move the
    // no-activate window directly with the right button, so a hover-time origin
    // may already be stale by the next tip-down. Every DOWN is authoritative.
    let cached_coordinates = if begins_gesture {
        None
    } else {
        *shared.pointer_coordinate_space.lock()
    };
    let coordinates = if let Some(cached) = cached_coordinates {
        cached
    } else {
        let Some(window) = shared.app.get_webview_window("main") else { return; };
        let Ok(position) = window.inner_position() else { return; };
        let Ok(scale) = window.scale_factor() else { return; };
        let coordinates = PointerCoordinateSpace {
            window_x: position.x,
            window_y: position.y,
            scale,
            visible_bounds: monitor_bounds(screen_x, screen_y, position, scale),
        };
        if begins_gesture {
            *shared.pointer_coordinate_space.lock() = Some(coordinates);
        }
        coordinates
    };
    let position = PhysicalPosition::new(coordinates.window_x, coordinates.window_y);
    let scale = coordinates.scale;
    let ends_gesture = matches!(kind.as_str(), "up" | "cancel");
    let hit_bounds = if parts.len() >= 12 {
        let left = parts[8].parse::<f64>().ok();
        let top = parts[9].parse::<f64>().ok();
        let right = parts[10].parse::<f64>().ok();
        let bottom = parts[11].parse::<f64>().ok();
        match (left, top, right, bottom) {
            (Some(left), Some(top), Some(right), Some(bottom)) if right > left && bottom > top => {
                Some(VisibleBounds { left, top, right, bottom })
            }
            _ => None,
        }
    } else {
        None
    };
    let payload = NativePointerPayload {
        kind, client_x: (screen_x - position.x as f64) / scale,
        client_y: (screen_y - position.y as f64) / scale, alt_key: parts[4] == "1", space_key: parts[5] == "1",
        pointer_type: pointer_type.into(), delta: parts[7].parse().unwrap_or(0.0),
        visible_bounds: coordinates.visible_bounds,
        screen_x: Some(screen_x), screen_y: Some(screen_y), hit_bounds,
    };
    let _ = shared.app.emit("window:native-pointer", payload);
    if ends_gesture {
        *shared.pointer_coordinate_space.lock() = None;
    }
}

fn focusless(state: &WindowState) -> bool { state.locked && state.always_on_top }

#[cfg(windows)]
fn raw_handle(window: &WebviewWindow) -> Result<u64> {
    // Match Electron: operate on the top-level root HWND, not a WebView2 child.
    unsafe {
        let hwnd = HWND(window.hwnd()?.0);
        let root = GetAncestor(hwnd, GA_ROOT);
        let chosen = if root.0.is_null() { hwnd } else { root };
        Ok(chosen.0 as usize as u64)
    }
}
#[cfg(not(windows))]
fn raw_handle(_window: &WebviewWindow) -> Result<u64> { Err(anyhow!("Windows HWND 不可用")) }

fn normalize_helper_script(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(stripped) = text.strip_prefix(r"\\?\") { PathBuf::from(stripped) } else { path }
}

#[cfg(windows)]
fn root_hwnd(window: &WebviewWindow) -> Result<HWND> {
    unsafe {
        let hwnd = HWND(window.hwnd()?.0);
        let root = GetAncestor(hwnd, GA_ROOT);
        Ok(if root.0.is_null() { hwnd } else { root })
    }
}

#[cfg(windows)]
fn set_focusless_exstyle(window: &WebviewWindow, enabled: bool) -> Result<bool> {
    unsafe {
        let chosen = root_hwnd(window)?;
        let current = GetWindowLongPtrW(chosen, GWL_EXSTYLE);
        let appwindow = WS_EX_APPWINDOW.0 as isize;
        let noactivate = WS_EX_NOACTIVATE.0 as isize;
        let mut next = current | appwindow;
        if enabled { next |= noactivate; } else { next &= !noactivate; }
        if next == current { return Ok(true); }
        // Style only — never SWP_FRAMECHANGED (can block tens of seconds on WebView2).
        SetWindowLongPtrW(chosen, GWL_EXSTYLE, next);
        let applied = GetWindowLongPtrW(chosen, GWL_EXSTYLE);
        Ok(if enabled { (applied & noactivate) != 0 } else { (applied & noactivate) == 0 })
    }
}
#[cfg(not(windows))]
fn set_focusless_exstyle(_window: &WebviewWindow, _enabled: bool) -> Result<bool> { Ok(true) }

#[cfg(windows)]
fn apply_focusless_layer(window: &WebviewWindow, enabled: bool, above_taskbar: bool) -> Result<bool> {
    if !set_focusless_exstyle(window, enabled)? {
        return Ok(false);
    }
    if !enabled {
        return Ok(true);
    }
    // Collaboration uses above-taskbar (TOPMOST); plain focusless places below taskbar like Electron.
    place_relative_to_taskbar(window, above_taskbar)
}
#[cfg(not(windows))]
fn apply_focusless_layer(_window: &WebviewWindow, _enabled: bool, _above_taskbar: bool) -> Result<bool> { Ok(true) }

#[cfg(windows)]
fn place_relative_to_taskbar(window: &WebviewWindow, above_taskbar: bool) -> Result<bool> {
    unsafe {
        let hwnd = root_hwnd(window)?;
        if above_taskbar {
            let ok = SetWindowPos(hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE).is_ok();
            return Ok(ok);
        }
        let Some(taskbar) = taskbar_for_window(hwnd) else { return Ok(false); };
        if is_behind_taskbar(hwnd, taskbar) { return Ok(true); }
        Ok(SetWindowPos(hwnd, Some(taskbar), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE).is_ok())
    }
}
#[cfg(not(windows))]
fn place_relative_to_taskbar(_window: &WebviewWindow, _above_taskbar: bool) -> Result<bool> { Ok(true) }

#[cfg(windows)]
unsafe fn taskbar_for_window(window: HWND) -> Option<HWND> {
    let monitor = MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST);
    let primary = FindWindowW(windows::core::w!("Shell_TrayWnd"), None).ok()?;
    if primary.0.is_null() { return None; }
    if MonitorFromWindow(primary, MONITOR_DEFAULTTONEAREST) == monitor {
        return Some(primary);
    }
    let mut secondary = HWND(std::ptr::null_mut());
    loop {
        secondary = FindWindowExW(None, Some(secondary), windows::core::w!("Shell_SecondaryTrayWnd"), None)
            .unwrap_or(HWND(std::ptr::null_mut()));
        if secondary.0.is_null() { break; }
        if MonitorFromWindow(secondary, MONITOR_DEFAULTTONEAREST) == monitor {
            return Some(secondary);
        }
    }
    None
}

#[cfg(windows)]
unsafe fn is_behind_taskbar(window: HWND, taskbar: HWND) -> bool {
    let mut current = GetWindow(taskbar, GW_HWNDNEXT).unwrap_or(HWND(std::ptr::null_mut()));
    for _ in 0..2048 {
        if current.0.is_null() { break; }
        if current == window { return true; }
        current = GetWindow(current, GW_HWNDNEXT).unwrap_or(HWND(std::ptr::null_mut()));
    }
    false
}

#[cfg(windows)]
fn set_always_on_top_screen_saver(window: &WebviewWindow, enabled: bool) -> Result<()> {
    window.set_always_on_top(enabled)?;
    if enabled {
        unsafe {
            let hwnd = root_hwnd(window)?;
            let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        }
    }
    Ok(())
}
#[cfg(not(windows))]
fn set_always_on_top_screen_saver(window: &WebviewWindow, enabled: bool) -> Result<()> {
    window.set_always_on_top(enabled)?;
    Ok(())
}

#[cfg(windows)]
fn set_window_opacity(window: &WebviewWindow, opacity: f64) -> Result<()> {
    use windows::Win32::UI::WindowsAndMessaging::{SetLayeredWindowAttributes, LWA_ALPHA, WS_EX_LAYERED};
    unsafe {
        let hwnd = HWND(window.hwnd()?.0);
        let current = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, current | WS_EX_LAYERED.0 as isize);
        SetLayeredWindowAttributes(hwnd, windows::Win32::Foundation::COLORREF(0), (opacity * 255.0).round() as u8, LWA_ALPHA)?;
    }
    Ok(())
}
#[cfg(not(windows))]
fn set_window_opacity(_window: &WebviewWindow, _opacity: f64) -> Result<()> { Ok(()) }

#[cfg(windows)]
fn monitor_bounds(screen_x: f64, screen_y: f64, main_position: PhysicalPosition<i32>, scale: f64) -> VisibleBounds {
    unsafe {
        let monitor = MonitorFromPoint(POINT { x: screen_x as i32, y: screen_y as i32 }, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, rcMonitor: RECT::default(), rcWork: RECT::default(), dwFlags: 0 };
        if GetMonitorInfoW(monitor, &mut info).as_bool() {
            return VisibleBounds {
                left: (info.rcWork.left - main_position.x) as f64 / scale,
                top: (info.rcWork.top - main_position.y) as f64 / scale,
                right: (info.rcWork.right - main_position.x) as f64 / scale,
                bottom: (info.rcWork.bottom - main_position.y) as f64 / scale,
            };
        }
    }
    VisibleBounds { left: 0.0, top: 0.0, right: 0.0, bottom: 0.0 }
}
#[cfg(not(windows))]
fn monitor_bounds(_x: f64, _y: f64, _position: PhysicalPosition<i32>, _scale: f64) -> VisibleBounds { VisibleBounds { left: 0.0, top: 0.0, right: 0.0, bottom: 0.0 } }

pub type SharedNative = Arc<NativeWindowManager>;
