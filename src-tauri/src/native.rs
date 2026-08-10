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
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition,
    WebviewUrl, WebviewWindow, WebviewWindowBuilder,
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
            SetWindowPos, ShowWindow, GA_ROOT, GWLP_HWNDPARENT, GWL_EXSTYLE, GW_HWNDNEXT, HWND_TOPMOST,
            SWP_NOMOVE, SWP_NOSIZE, SWP_NOACTIVATE, SW_SHOWNOACTIVATE, WS_EX_APPWINDOW, WS_EX_NOACTIVATE,
            WS_EX_TOOLWINDOW,
        },
    },
};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct TaskbarPointerInput {
    pub kind: String,
    pub pointer_id: f64,
    pub pointer_type: String,
    pub button: f64,
    pub buttons: f64,
    pub client_x: f64,
    pub client_y: f64,
    pub alt_key: bool,
    pub mode: Option<String>,
}

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
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct VisibleBounds { left: f64, top: f64, right: f64, bottom: f64 }

struct NativeHelper {
    child: Child,
    stdin: ChildStdin,
}

struct NativeShared {
    app: AppHandle,
    state: RwLock<WindowState>,
    pen_labels: Mutex<Vec<String>>,
    pending_input: Mutex<HashMap<String, mpsc::Sender<bool>>>,
    pending_key: Mutex<HashMap<String, mpsc::Sender<bool>>>,
    pending_shutdown: Mutex<Option<mpsc::Sender<()>>>,
    ready: AtomicBool,
    /// True while the helper LL hooks are armed. Used to skip a second disable
    /// IPC when the shortcut path already released INPUT before set_mode.
    input_hooks_active: AtomicBool,
    /// Skip blur Z-order / INPUT repair while Alt-pick handoff is critical.
    pick_critical_until: Mutex<Option<Instant>>,
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
                app, state: RwLock::new(WindowState::default()), pen_labels: Mutex::new(Vec::new()),
                pending_input: Mutex::new(HashMap::new()), pending_key: Mutex::new(HashMap::new()),
                pending_shutdown: Mutex::new(None),
                ready: AtomicBool::new(false), input_hooks_active: AtomicBool::new(false),
                pick_critical_until: Mutex::new(None),
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
            diagnostics.warn("window.helper_stdout_closed", json!({}));
            // Do not kill_orphan here — a racing restart can murder the live helper.
            // Button release only; orphan scrub belongs to clear_helper/shutdown.
            let _ = std::process::Command::new("powershell.exe")
                .args([
                    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
                    "Add-Type -Name YoiniwaMouseFix -Namespace Yoiniwa -MemberDefinition '[DllImport(\"user32.dll\")] public static extern void mouse_event(uint f,uint x,uint y,uint d,System.UIntPtr e);'; [Yoiniwa.YoiniwaMouseFix]::mouse_event(0x0004,0,0,0,[UIntPtr]::Zero); [Yoiniwa.YoiniwaMouseFix]::mouse_event(0x0010,0,0,0,[UIntPtr]::Zero)",
                ])
                .creation_flags(CREATE_NO_WINDOW.0)
                .status();
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
                false
            }
            Err(error) => {
                self.diagnostics.warn("window.helper_wait_failed", json!({ "error": error.to_string() }));
                *helper = None;
                self.shared.ready.store(false, Ordering::SeqCst);
                self.shared.input_hooks_active.store(false, Ordering::SeqCst);
                false
            }
        }
    }

    fn clear_helper(&self) {
        // Never TerminateProcess while WH_MOUSE_LL may still be installed — that can
        // leave LBUTTON swallowed system-wide (HWND reuse / missed button-up).
        let had_helper = {
            let mut helper = self.helper.lock();
            if let Some(current) = helper.as_mut() {
                let (sender, receiver) = mpsc::channel();
                *self.shared.pending_shutdown.lock() = Some(sender);
                let _ = current.stdin.write_all(b"INPUT|shutdown-release|0|0|0\nSHUTDOWN\n");
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
            let _ = current.child.wait();
            let _ = current.child.kill();
            let _ = current.child.wait();
        }
        self.shared.ready.store(false, Ordering::SeqCst);
        self.shared.input_hooks_active.store(false, Ordering::SeqCst);
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
        let mode_changed = previous.collaboration_mode != next.collaboration_mode;
        self.diagnostics.info("window.set_mode.begin", json!({
            "previous": previous, "patch": patch, "next": next,
            "focuslessBefore": focusless_before, "focuslessNext": focusless_next,
        }));
        let main = self.main_window()?;
        if previous.always_on_top != next.always_on_top {
            set_always_on_top_screen_saver(&main, next.always_on_top)?;
        }
        set_window_opacity(&main, next.opacity.clamp(0.25, 1.0))?;
        main.set_resizable(!next.collaboration_mode)?;

        if focusless_before != focusless_next || mode_changed {
            // Apply focusless layer in-process (NOACTIVATE + taskbar place).
            if !apply_focusless_layer(&main, focusless_next, next.collaboration_mode)? && focusless_next {
                self.rollback_mode(&main, &previous)?;
                let message = "无法建立协作窗口层级（NOACTIVATE/任务栏）";
                self.diagnostics.error_with_message("window.set_mode.layer_failed", message, json!({ "previous": previous, "next": next }));
                return Ok(previous);
            }
            self.diagnostics.info("window.layer_ready", json!({
                "enabled": focusless_next, "aboveTaskbar": next.collaboration_mode,
            }));

            // Enabling needs a live helper. Disabling can skip IPC when hooks are
            // already down (shortcut pre-release) or the helper is already gone.
            let hooks_active = self.shared.input_hooks_active.load(Ordering::SeqCst);
            let need_input_ipc = focusless_next || (focusless_before && hooks_active);
            if need_input_ipc {
                if let Err(error) = self.ensure_helper_ready(Duration::from_millis(if focusless_next { 5000 } else { 800 })) {
                    if focusless_next {
                        let _ = apply_focusless_layer(&main, focusless_before, previous.collaboration_mode);
                        self.rollback_mode(&main, &previous)?;
                        self.diagnostics.error_with_message("window.set_mode.helper_not_ready", error.to_string(), json!({ "previous": previous, "next": next }));
                        return Ok(previous);
                    }
                    self.diagnostics.warn("window.set_mode.helper_skip_disable", json!({ "error": error.to_string() }));
                    self.shared.input_hooks_active.store(false, Ordering::SeqCst);
                } else {
                    let input_timeout = if focusless_next { Duration::from_millis(2500) } else { Duration::from_millis(600) };
                    if !self.request_input(focusless_next, next.collaboration_mode, input_timeout)? && focusless_next {
                        let _ = apply_focusless_layer(&main, focusless_before, previous.collaboration_mode);
                        self.rollback_mode(&main, &previous)?;
                        let message = "无法启用协作输入钩子（INPUT），请重试或检查数位板驱动";
                        self.diagnostics.error_with_message("window.set_mode.input_failed", message, json!({ "previous": previous, "next": next }));
                        return Ok(previous);
                    }
                }
            } else {
                self.diagnostics.info("window.input_skip", json!({
                    "enabled": focusless_next, "hooksActive": hooks_active,
                }));
            }
            self.diagnostics.info("window.input_ready", json!({ "enabled": focusless_next }));
        }

        // Do not place an interactive WebView above the click-through main window.
        // A pen down implicitly captures to that WebView and releases to Photoshop
        // at the contact boundary; on a virtual multi-monitor desktop that handoff
        // can also expose a different absolute cursor coordinate. INPUT observes
        // the physical packets while the real target remains Photoshop.
        let remove_pen_layer = !self.shared.pen_labels.lock().is_empty();

        // Commit the click-through mode only after the native input observer is ready.
        main.set_ignore_cursor_events(next.click_through || focusless_next)?;
        *self.shared.state.write() = next.clone();
        if focusless_next && (!focusless_before || !previous.collaboration_mode && next.collaboration_mode) {
            let _ = self.shared.app.state::<crate::state::AppState>().photoshop.warm();
            self.shared.app.state::<crate::state::AppState>().photoshop.capture_focus();
        }
        if focusless_before && !focusless_next { let _ = main.set_focus(); }
        self.diagnostics.info("window.set_mode.ok", json!({ "state": next }));

        if remove_pen_layer {
            self.spawn_pen_window_update(false);
        }
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
            // Electron contract: release native INPUT before React restores window state.
            // Must not activate a window or inject input (AGENTS.md first-stroke invariant).
            if let Ok(main) = self.main_window() {
                let _ = main.set_ignore_cursor_events(state.click_through);
            }
            let released = self.request_input(false, false, Duration::from_millis(500)).unwrap_or(false);
            self.diagnostics.info("window.collaboration_input_release", json!({ "released": released }));
            if !released {
                self.diagnostics.warn("window.collaboration_input_release", json!({ "action": "restart_helper" }));
                self.restart_helper();
            }
        }
        let _ = self.shared.app.emit("window:toggle-collaboration-requested", ());
    }

    fn restart_helper(&self) {
        self.clear_helper();
        let _ = self.start_helper();
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

    pub fn taskbar_pen_start(&self, input: &TaskbarPointerInput) -> String {
        if !self.mode().collaboration_mode || !focusless(&self.mode()) || input.pointer_type != "pen" { return "block".into(); }
        let mode = if input.alt_key { "pick" } else if self.query_key(0x20) { "pan" } else { "block" };
        // Drive LL-hook gesture state from the pen overlay because hook-level
        // Alt sampling alone can miss the start of a Windows Ink contact.
        let _ = self.send_line(&format!("GESTURE|{mode}\n"));
        if mode == "pick" || mode == "pan" {
            self.extend_pick_critical(Duration::from_millis(2000));
        }
        mode.into()
    }

    pub fn taskbar_pen_pointer(&self, source: &WebviewWindow, input: TaskbarPointerInput) -> Result<()> {
        if !self.mode().collaboration_mode || !focusless(&self.mode()) || input.pointer_type != "pen" { return Ok(()); }
        if !matches!(input.kind.as_str(), "down" | "move" | "up" | "cancel") { return Ok(()); }
        let mode = input.mode.as_deref().unwrap_or("block"); if mode == "block" { return Ok(()); }
        if matches!(input.kind.as_str(), "down") && (mode == "pick" || mode == "pan") {
            let _ = self.send_line(&format!("GESTURE|{mode}\n"));
            self.extend_pick_critical(Duration::from_millis(2000));
        } else if matches!(input.kind.as_str(), "up" | "cancel") {
            let _ = self.send_line("GESTURE|none\n");
            self.extend_pick_critical(Duration::from_millis(500));
        } else if matches!(input.kind.as_str(), "move") && mode == "pick" {
            self.extend_pick_critical(Duration::from_millis(2000));
        }
        // DOM client coordinates belong to the pen WebView's DPI space. On a
        // multi-monitor desktop its scale can differ from the main WebView's,
        // and virtual-screen coordinates can be negative. Convert through
        // physical screen coordinates using each window's own client origin.
        let source_position = source.inner_position()?;
        let source_scale = source.scale_factor()?;
        let main = self.main_window()?;
        let main_position = main.inner_position()?;
        let main_scale = main.scale_factor()?;
        let screen_x = source_position.x as f64 + input.client_x * source_scale;
        let screen_y = source_position.y as f64 + input.client_y * source_scale;
        let client_x = (screen_x - main_position.x as f64) / main_scale;
        let client_y = (screen_y - main_position.y as f64) / main_scale;
        let visible_bounds = monitor_bounds(screen_x, screen_y, main_position, main_scale);
        if input.kind == "down" {
            self.diagnostics.info("window.pen_coordinate_space", json!({
                "sourcePosition": { "x": source_position.x, "y": source_position.y },
                "sourceScale": source_scale,
                "mainPosition": { "x": main_position.x, "y": main_position.y },
                "mainScale": main_scale,
                "screen": { "x": screen_x, "y": screen_y },
                "client": { "x": client_x, "y": client_y },
            }));
        }
        let payload = NativePointerPayload {
            kind: input.kind.clone(), client_x, client_y,
            alt_key: mode == "pick", space_key: mode == "pan",
            pointer_type: "pen".into(), delta: 0.0, visible_bounds,
        };
        self.shared.app.emit("window:native-pointer", payload)?; Ok(())
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
            let _ = self.request_input(true, state.collaboration_mode, Duration::from_millis(500));
            self.sync_pen_windows();
        } else if state.always_on_top && !state.collaboration_mode {
            if let Ok(window) = self.main_window() { let _ = set_always_on_top_screen_saver(&window, true); }
        }
    }

    pub fn sync_pen_windows(&self) {
        let Ok(main) = self.main_window() else { return; };
        let Ok(position) = main.outer_position() else { return; };
        let Ok(size) = main.outer_size() else { return; };
        let labels = self.shared.pen_labels.lock().clone();
        for label in labels {
            let Some(window) = self.shared.app.get_webview_window(&label) else { continue; };
            let _ = window.set_position(tauri::Position::Physical(position));
            let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize { width: size.width, height: size.height }));
            let _ = set_pen_window_owner(&window, &main);
            let _ = configure_no_activate_tool_window(&window);
            let _ = window.set_always_on_top(true);
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
                // On disable timeout assume disarmed so exit does not restart the helper
                // or wait again; enable timeout remains a hard failure for the caller.
                if !enabled { self.shared.input_hooks_active.store(false, Ordering::SeqCst); }
                Ok(!enabled)
            }
        }
    }

    fn spawn_pen_window_update(&self, enabled: bool) {
        let app = self.shared.app.clone();
        let diagnostics = self.diagnostics.clone();
        let shared = self.shared.clone();
        thread::spawn(move || {
            // Let the invoking command finish so the main/event loop can accept a new WebView.
            thread::sleep(Duration::from_millis(32));
            let app_for_main = app.clone();
            let diagnostics_for_main = diagnostics.clone();
            let shared_for_main = shared.clone();
            // Prefer main-thread create; falling back to direct build if dispatch fails.
            let dispatched = app.run_on_main_thread(move || {
                if let Err(error) = configure_pen_window_impl(
                    &app_for_main, &shared_for_main, enabled, &diagnostics_for_main,
                ) {
                    diagnostics_for_main.warn("window.collaboration_pen_layer_failed", json!({
                        "enabled": enabled,
                        "error": error.to_string(),
                    }));
                }
            });
            if let Err(error) = dispatched {
                diagnostics.warn("window.collaboration_pen_layer_failed", json!({
                    "enabled": enabled,
                    "error": format!("run_on_main_thread: {error}"),
                }));
            }
        });
    }

    fn send_line(&self, line: &str) -> Result<()> {
        self.start_helper()?;
        let mut helper = self.helper.lock(); let helper = helper.as_mut().ok_or_else(|| anyhow!("原生窗口 helper 不可用"))?;
        helper.stdin.write_all(line.as_bytes())?; helper.stdin.flush()?; Ok(())
    }
    fn next_id(&self) -> String { self.shared.sequence.fetch_add(1, Ordering::Relaxed).to_string() }
    fn main_window(&self) -> Result<WebviewWindow> { self.shared.app.get_webview_window("main").ok_or_else(|| anyhow!("主窗口不可用")) }
}

fn configure_pen_window_impl(
    app: &AppHandle,
    shared: &NativeShared,
    enabled: bool,
    diagnostics: &DiagnosticsLog,
) -> Result<()> {
    let labels = std::mem::take(&mut *shared.pen_labels.lock());
    for label in labels {
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.destroy();
        }
    }
    if !enabled {
        return Ok(());
    }
    let main = app.get_webview_window("main").ok_or_else(|| anyhow!("主窗口不可用"))?;
    let position = main.outer_position()?;
    let size = main.outer_size()?;
    let scale = main.scale_factor()?;
    let label = "taskbar-pen-0".to_string();
    // Builder only accepts logical x/y; correct with Physical immediately after build
    // so mixed-DPI multi-monitor layouts do not place the overlay on the wrong screen.
    let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("taskbar-pen.html".into()))
        .title("Yoiniwa Pen Input").decorations(false).transparent(true).shadow(false).visible(false)
        .focused(false).focusable(false).skip_taskbar(true).resizable(false).always_on_top(true)
        .position(position.x as f64 / scale, position.y as f64 / scale)
        .inner_size(size.width as f64 / scale, size.height as f64 / scale).build()?;
    let _ = window.set_position(tauri::Position::Physical(position));
    let _ = window.set_size(tauri::Size::Physical(size));
    set_pen_window_owner(&window, &main)?;
    configure_no_activate_tool_window(&window)?;
    set_always_on_top_screen_saver(&window, true)?;
    let _ = window.set_position(tauri::Position::Physical(position));
    let _ = window.show();
    shared.pen_labels.lock().push(label);
    diagnostics.info("window.collaboration_pen_layer_ready", json!({ "windows": 1 }));
    Ok(())
}

impl Drop for NativeWindowManager {
    fn drop(&mut self) {
        if let Some(mut helper) = self.helper.get_mut().take() {
            let _ = helper.stdin.write_all(b"INPUT|drop-release|0|0|0\nSHUTDOWN\n");
            let _ = helper.stdin.flush();
            drop(helper.stdin);
            // Prefer graceful exit so ShutdownInputHooks can Unhook + release buttons.
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
        Some("INPUT_ACK") if parts.len() >= 3 => if let Some(sender) = shared.pending_input.lock().remove(parts[1]) { let _ = sender.send(parts[2] == "READY"); },
        Some("KEY") if parts.len() >= 3 => if let Some(sender) = shared.pending_key.lock().remove(parts[1]) { let _ = sender.send(parts[2] == "1"); },
        Some("ZOOM") if parts.len() >= 2 => { let _ = shared.app.emit("window:native-zoom", if parts[1] == "IN" { "in" } else { "out" }); }
        Some("POINTER") if parts.len() >= 8 => emit_helper_pointer(shared, &parts),
        Some("DONE") | Some("SKIPPED") => { let _ = shared.app.emit("window:move-finished", ()); }
        Some("APPEARANCE_DONE") | Some("APPEARANCE_SKIPPED") => {}
        Some("INPUT_PROBE") => {
            diagnostics.info("window.native_input_probe", json!({ "line": line }));
        }
        Some("PICK_CRITICAL") if parts.len() >= 2 => {
            let extra = if parts[1] == "HOLD" {
                Duration::from_millis(500)
            } else {
                Duration::from_millis(2000)
            };
            extend_pick_critical(shared, extra);
            diagnostics.info("window.pick_critical", json!({ "phase": parts[1], "ms": extra.as_millis() }));
        }
        Some("GESTURE_ACK") if parts.len() >= 2 => {
            diagnostics.info("window.gesture_ack", json!({ "mode": parts[1] }));
        }
        Some("INPUT_SHUTDOWN") | Some("SHUTDOWN_ACK") => {
            diagnostics.info("window.input_hooks_shutdown", json!({ "line": line }));
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
    if pointer_type == "pen" && !shared.pen_labels.lock().is_empty() && parts[1] != "HOVER" { return; }
    let Some(window) = shared.app.get_webview_window("main") else { return; };
    let Ok(position) = window.inner_position() else { return; }; let Ok(scale) = window.scale_factor() else { return; };
    let Ok(screen_x) = parts[2].parse::<f64>() else { return; }; let Ok(screen_y) = parts[3].parse::<f64>() else { return; };
    let payload = NativePointerPayload {
        kind: parts[1].to_ascii_lowercase(), client_x: (screen_x - position.x as f64) / scale,
        client_y: (screen_y - position.y as f64) / scale, alt_key: parts[4] == "1", space_key: parts[5] == "1",
        pointer_type: pointer_type.into(), delta: parts[7].parse().unwrap_or(0.0), visible_bounds: monitor_bounds(screen_x, screen_y, position, scale),
    };
    let _ = shared.app.emit("window:native-pointer", payload);
}

fn focusless(state: &WindowState) -> bool { state.locked && state.always_on_top }

#[cfg(windows)]
fn raw_handle(window: &WebviewWindow) -> Result<u64> {
    // Match Electron: operate on the top-level root HWND, not a WebView2 child.
    unsafe {
        let hwnd = HWND(window.hwnd()?.0 as *mut std::ffi::c_void);
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
        let hwnd = HWND(window.hwnd()?.0 as *mut std::ffi::c_void);
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
fn set_pen_window_owner(pen: &WebviewWindow, main: &WebviewWindow) -> Result<()> {
    unsafe {
        let pen_hwnd = root_hwnd(pen)?;
        let main_hwnd = root_hwnd(main)?;
        // Owner relationship (GWLP_HWNDPARENT on top-level) matches Electron parent: mainWindow.
        SetWindowLongPtrW(pen_hwnd, GWLP_HWNDPARENT, main_hwnd.0 as isize);
    }
    Ok(())
}
#[cfg(not(windows))]
fn set_pen_window_owner(_pen: &WebviewWindow, _main: &WebviewWindow) -> Result<()> { Ok(()) }

#[cfg(windows)]
fn configure_no_activate_tool_window(window: &WebviewWindow) -> Result<()> {
    unsafe {
        let hwnd = root_hwnd(window)?;
        let current = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, current | WS_EX_NOACTIVATE.0 as isize | WS_EX_TOOLWINDOW.0 as isize);
        let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
    }
    Ok(())
}
#[cfg(not(windows))]
fn configure_no_activate_tool_window(_window: &WebviewWindow) -> Result<()> { Ok(()) }

#[cfg(windows)]
fn set_window_opacity(window: &WebviewWindow, opacity: f64) -> Result<()> {
    use windows::Win32::UI::WindowsAndMessaging::{SetLayeredWindowAttributes, LWA_ALPHA, WS_EX_LAYERED};
    unsafe {
        let hwnd = HWND(window.hwnd()?.0 as *mut std::ffi::c_void);
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
