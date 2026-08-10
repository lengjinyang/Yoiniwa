use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{atomic::{AtomicBool, AtomicU64, Ordering}, mpsc, Arc},
    thread,
    time::Duration,
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
    Graphics::Gdi::{GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTONEAREST},
    System::Threading::CREATE_NO_WINDOW,
    UI::{
        WindowsAndMessaging::{
            GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, ShowWindow, GWL_EXSTYLE,
            HWND_TOPMOST, SWP_NOMOVE, SWP_NOSIZE, SWP_NOACTIVATE, SW_SHOWNOACTIVATE,
            WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
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
    pending_layer: Mutex<HashMap<String, mpsc::Sender<bool>>>,
    pending_input: Mutex<HashMap<String, mpsc::Sender<bool>>>,
    pending_key: Mutex<HashMap<String, mpsc::Sender<bool>>>,
    ready: AtomicBool,
    non_activating_ready: AtomicBool,
    sequence: AtomicU64,
}

pub struct NativeWindowManager {
    helper_script: PathBuf,
    helper: Mutex<Option<NativeHelper>>,
    shared: Arc<NativeShared>,
    diagnostics: Arc<DiagnosticsLog>,
    dirty: AtomicBool,
    close_confirmed: AtomicBool,
    close_pending: AtomicBool,
    move_sent: AtomicBool,
    shortcut: RwLock<String>,
}

impl NativeWindowManager {
    pub fn new(app: AppHandle, resource_dir: &Path, diagnostics: Arc<DiagnosticsLog>) -> Arc<Self> {
        Arc::new(Self {
            helper_script: resource_dir.join("resources/native-window-move.ps1"), helper: Mutex::new(None),
            shared: Arc::new(NativeShared {
                app, state: RwLock::new(WindowState::default()), pen_labels: Mutex::new(Vec::new()),
                pending_layer: Mutex::new(HashMap::new()), pending_input: Mutex::new(HashMap::new()), pending_key: Mutex::new(HashMap::new()),
                ready: AtomicBool::new(false), non_activating_ready: AtomicBool::new(false), sequence: AtomicU64::new(0),
            }),
            diagnostics,
            dirty: AtomicBool::new(false), close_confirmed: AtomicBool::new(false), close_pending: AtomicBool::new(false),
            move_sent: AtomicBool::new(false),
            shortcut: RwLock::new("Ctrl+Alt+Y".into()),
        })
    }

    pub fn start_helper(&self) -> Result<()> {
        if self.helper.lock().is_some() { return Ok(()); }
        let mut command = Command::new("powershell.exe");
        command.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(&self.helper_script).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        #[cfg(windows)] command.creation_flags(CREATE_NO_WINDOW.0);
        let mut child = command.spawn().with_context(|| format!("无法启动 {}", self.helper_script.display()))?;
        let stdin = child.stdin.take().ok_or_else(|| anyhow!("原生窗口 helper stdin 不可用"))?;
        let stdout = child.stdout.take().ok_or_else(|| anyhow!("原生窗口 helper stdout 不可用"))?;
        let shared = self.shared.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) { handle_helper_line(&shared, &line); }
            shared.ready.store(false, Ordering::SeqCst);
            shared.non_activating_ready.store(false, Ordering::SeqCst);
        });
        *self.helper.lock() = Some(NativeHelper { child, stdin });
        Ok(())
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
        if previous.always_on_top != next.always_on_top { main.set_always_on_top(next.always_on_top)?; }
        set_window_opacity(&main, next.opacity.clamp(0.25, 1.0))?;
        main.set_resizable(!next.collaboration_mode)?;
        if focusless_before != focusless_next || mode_changed {
            if !self.request_layer(focusless_next, next.collaboration_mode, Duration::from_millis(1500))? && focusless_next {
                self.restore_window_state(&main, &previous)?;
                let message = "无法建立协作窗口层级（LAYER），请确认原生助手已启动后重试";
                self.diagnostics.error_with_message("window.set_mode.layer_failed", message, json!({ "previous": previous, "next": next }));
                return Err(anyhow!(message));
            }
            if !self.request_input(focusless_next, next.collaboration_mode, Duration::from_millis(2000))? && focusless_next {
                let _ = self.request_layer(focusless_before, previous.collaboration_mode, Duration::from_millis(500));
                self.restore_window_state(&main, &previous)?;
                let message = "无法启用协作输入钩子（INPUT），请重试或检查数位板驱动";
                self.diagnostics.error_with_message("window.set_mode.input_failed", message, json!({ "previous": previous, "next": next }));
                return Err(anyhow!(message));
            }
        }
        let pen_before = focusless_before && previous.collaboration_mode;
        let pen_next = focusless_next && next.collaboration_mode;
        let pen_missing = pen_next && self.shared.pen_labels.lock().is_empty();
        if pen_before != pen_next || pen_missing {
            if let Err(error) = self.configure_pen_window(pen_next) {
                if focusless_next {
                    let _ = self.configure_pen_window(pen_before);
                    let _ = self.request_input(focusless_before, previous.collaboration_mode, Duration::from_millis(500));
                    let _ = self.request_layer(focusless_before, previous.collaboration_mode, Duration::from_millis(500));
                    self.restore_window_state(&main, &previous)?;
                    self.diagnostics.error_with_message("window.set_mode.pen_failed", error.to_string(), json!({ "previous": previous, "next": next }));
                    return Err(anyhow!("无法创建任务栏笔迹窗口：{error}"));
                }
                self.diagnostics.error_with_message("window.set_mode.pen_failed", error.to_string(), json!({ "enabled": pen_next }));
                return Err(error);
            }
        }
        main.set_ignore_cursor_events(next.click_through || focusless_next)?;
        *self.shared.state.write() = next.clone();
        if focusless_next && (!focusless_before || !previous.collaboration_mode && next.collaboration_mode) {
            let _ = self.shared.app.state::<crate::state::AppState>().photoshop.warm();
            self.shared.app.state::<crate::state::AppState>().photoshop.capture_focus();
        }
        if focusless_before && !focusless_next { let _ = main.set_focus(); }
        self.diagnostics.info("window.set_mode.ok", json!({ "state": next }));
        Ok(next)
    }

    fn restore_window_state(&self, window: &WebviewWindow, state: &WindowState) -> Result<()> {
        window.set_always_on_top(state.always_on_top)?;
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
        {
            let mut helper = self.helper.lock();
            if let Some(mut current) = helper.take() {
                let _ = current.child.kill();
            }
        }
        self.shared.ready.store(false, Ordering::SeqCst);
        self.shared.non_activating_ready.store(false, Ordering::SeqCst);
        let _ = self.start_helper();
    }

    pub fn begin_native_move(&self) -> Result<()> {
        if self.move_sent.swap(true, Ordering::SeqCst) { return Ok(()); }
        let window = self.main_window()?;
        if self.mode().locked || window.is_maximized()? { self.move_sent.store(false, Ordering::SeqCst); return Ok(()); }
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
        let window = self.main_window()?; let position = window.outer_position()?; let size = window.inner_size()?; let scale = window.scale_factor()?;
        let point = point.unwrap_or((size.width as f64 / scale / 2.0, size.height as f64 / scale / 2.0));
        Ok(monitor_bounds(position.x as f64 + point.0 * scale, position.y as f64 + point.1 * scale, position, scale))
    }

    pub fn taskbar_pen_start(&self, input: &TaskbarPointerInput) -> String {
        if !self.mode().collaboration_mode || !focusless(&self.mode()) || input.pointer_type != "pen" { return "block".into(); }
        if input.alt_key { "pick".into() } else if self.query_key(0x20) { "pan".into() } else { "block".into() }
    }

    pub fn taskbar_pen_pointer(&self, source: &WebviewWindow, input: TaskbarPointerInput) -> Result<()> {
        if !self.mode().collaboration_mode || !focusless(&self.mode()) || input.pointer_type != "pen" { return Ok(()); }
        if !matches!(input.kind.as_str(), "down" | "move" | "up" | "cancel") { return Ok(()); }
        let mode = input.mode.as_deref().unwrap_or("block"); if mode == "block" { return Ok(()); }
        let source_position = source.outer_position()?; let main = self.main_window()?; let main_position = main.outer_position()?;
        let scale = main.scale_factor()?;
        let screen_x = source_position.x as f64 + input.client_x * scale;
        let screen_y = source_position.y as f64 + input.client_y * scale;
        let visible_bounds = monitor_bounds(screen_x, screen_y, main_position, scale);
        let payload = NativePointerPayload {
            kind: input.kind, client_x: (screen_x - main_position.x as f64) / scale,
            client_y: (screen_y - main_position.y as f64) / scale, alt_key: mode == "pick", space_key: mode == "pan",
            pointer_type: "pen".into(), delta: 0.0, visible_bounds,
        };
        self.shared.app.emit("window:native-pointer", payload)?; Ok(())
    }

    pub fn repair_after_blur(&self) {
        let state = self.mode();
        if focusless(&state) {
            let _ = self.request_layer(true, state.collaboration_mode, Duration::from_millis(500));
            let _ = self.request_input(true, state.collaboration_mode, Duration::from_millis(500));
        } else if state.always_on_top && !state.collaboration_mode {
            if let Ok(window) = self.main_window() { let _ = window.set_always_on_top(true); }
        }
    }

    fn request_layer(&self, enabled: bool, above_taskbar: bool, timeout: Duration) -> Result<bool> {
        self.start_helper()?; let id = self.next_id(); let (sender, receiver) = mpsc::channel();
        self.shared.pending_layer.lock().insert(id.clone(), sender);
        self.send_line(&format!("LAYER|{id}|{}|{}|{}\n", raw_handle(&self.main_window()?)?, enabled as u8, above_taskbar as u8))?;
        Ok(receiver.recv_timeout(timeout).unwrap_or(!enabled))
    }

    fn request_input(&self, enabled: bool, collaboration_zoom: bool, timeout: Duration) -> Result<bool> {
        self.start_helper()?; let id = self.next_id(); let (sender, receiver) = mpsc::channel();
        self.shared.pending_input.lock().insert(id.clone(), sender);
        self.send_line(&format!("INPUT|{id}|{}|{}|{}\n", raw_handle(&self.main_window()?)?, enabled as u8, collaboration_zoom as u8))?;
        Ok(receiver.recv_timeout(timeout).unwrap_or(!enabled))
    }

    fn configure_pen_window(&self, enabled: bool) -> Result<()> {
        let labels = std::mem::take(&mut *self.shared.pen_labels.lock());
        for label in labels { if let Some(window) = self.shared.app.get_webview_window(&label) { let _ = window.destroy(); } }
        if !enabled { return Ok(()); }
        let main = self.main_window()?; let position = main.outer_position()?; let size = main.outer_size()?; let scale = main.scale_factor()?;
        let label = "taskbar-pen-0".to_string();
        let window = WebviewWindowBuilder::new(&self.shared.app, &label, WebviewUrl::App("taskbar-pen.html".into()))
            .title("Yoiniwa Pen Input").decorations(false).transparent(true).shadow(false).visible(false)
            .focused(false).focusable(false).skip_taskbar(true).resizable(false).always_on_top(true)
            .position(position.x as f64 / scale, position.y as f64 / scale)
            .inner_size(size.width as f64 / scale, size.height as f64 / scale).build()?;
        configure_no_activate_tool_window(&window)?;
        self.shared.pen_labels.lock().push(label);
        Ok(())
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
    fn drop(&mut self) { if let Some(helper) = self.helper.get_mut().take() { let mut child = helper.child; let _ = child.kill(); } }
}

fn handle_helper_line(shared: &Arc<NativeShared>, line: &str) {
    if line == "READY" { shared.ready.store(true, Ordering::SeqCst); return; }
    let parts = line.split('|').collect::<Vec<_>>();
    match parts.first().copied() {
        Some("LAYER") if parts.len() >= 3 => {
            let ready = parts[2] == "READY"; shared.non_activating_ready.store(ready, Ordering::SeqCst);
            if let Some(sender) = shared.pending_layer.lock().remove(parts[1]) { let _ = sender.send(ready); }
        }
        Some("INPUT_ACK") if parts.len() >= 3 => if let Some(sender) = shared.pending_input.lock().remove(parts[1]) { let _ = sender.send(parts[2] == "READY"); },
        Some("KEY") if parts.len() >= 3 => if let Some(sender) = shared.pending_key.lock().remove(parts[1]) { let _ = sender.send(parts[2] == "1"); },
        Some("ZOOM") if parts.len() >= 2 => { let _ = shared.app.emit("window:native-zoom", if parts[1] == "IN" { "in" } else { "out" }); }
        Some("POINTER") if parts.len() >= 8 => emit_helper_pointer(shared, &parts),
        Some("DONE") | Some("SKIPPED") => { let _ = shared.app.emit("window:move-finished", ()); }
        _ => {}
    }
}

fn emit_helper_pointer(shared: &Arc<NativeShared>, parts: &[&str]) {
    let pointer_type = if parts[6] == "pen" { "pen" } else { "mouse" };
    if pointer_type == "pen" && !shared.pen_labels.lock().is_empty() && parts[1] != "HOVER" { return; }
    let Some(window) = shared.app.get_webview_window("main") else { return; };
    let Ok(position) = window.outer_position() else { return; }; let Ok(scale) = window.scale_factor() else { return; };
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
fn raw_handle(window: &WebviewWindow) -> Result<isize> { Ok(window.hwnd()?.0 as isize) }
#[cfg(not(windows))]
fn raw_handle(_window: &WebviewWindow) -> Result<isize> { Err(anyhow!("Windows HWND 不可用")) }

#[cfg(windows)]
fn configure_no_activate_tool_window(window: &WebviewWindow) -> Result<()> {
    unsafe {
        let hwnd = HWND(window.hwnd()?.0 as *mut std::ffi::c_void);
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
                left: (info.rcMonitor.left - main_position.x) as f64 / scale,
                top: (info.rcMonitor.top - main_position.y) as f64 / scale,
                right: (info.rcMonitor.right - main_position.x) as f64 / scale,
                bottom: (info.rcMonitor.bottom - main_position.y) as f64 / scale,
            };
        }
    }
    VisibleBounds { left: 0.0, top: 0.0, right: 0.0, bottom: 0.0 }
}
#[cfg(not(windows))]
fn monitor_bounds(_x: f64, _y: f64, _position: PhysicalPosition<i32>, _scale: f64) -> VisibleBounds { VisibleBounds { left: 0.0, top: 0.0, right: 0.0, bottom: 0.0 } }

pub type SharedNative = Arc<NativeWindowManager>;
