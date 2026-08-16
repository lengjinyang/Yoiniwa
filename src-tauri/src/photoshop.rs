use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{mpsc, Arc},
    time::{Duration, Instant},
};

use anyhow::{anyhow, Context, Result};
use arboard::Clipboard;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{json, Value};
use wait_timeout::ChildExt;

use crate::{
    diagnostics::DiagnosticsLog,
    image_pipeline,
    types::{PickedColor, PhotoshopColorSyncResult, PhotoshopDocumentResult, WindowState},
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use windows::Win32::System::Threading::CREATE_NO_WINDOW;

#[derive(Clone, Debug)]
struct BridgeStatus { sync: String, focus: String }

struct PersistentHelper {
    child: Child,
    stdin: ChildStdin,
    lines: mpsc::Receiver<String>,
    request_id: u64,
}

impl PersistentHelper {
    fn start(script: &Path) -> Result<Self> {
        let mut command = Command::new("powershell.exe");
        command.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(script).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        #[cfg(windows)] command.creation_flags(CREATE_NO_WINDOW.0);
        let mut child = command.spawn().with_context(|| format!("无法启动 {}", script.display()))?;
        let stdin = child.stdin.take().ok_or_else(|| anyhow!("Photoshop helper stdin 不可用"))?;
        let stdout = child.stdout.take().ok_or_else(|| anyhow!("Photoshop helper stdout 不可用"))?;
        let (sender, lines) = mpsc::channel();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) { let _ = sender.send(line); }
        });
        Ok(Self { child, stdin, lines, request_id: 0 })
    }

    fn send(&mut self, kind: char, values: &[u8], timeout: Duration, fallback: BridgeStatus) -> BridgeStatus {
        self.request_id += 1;
        let id = self.request_id.to_string();
        let suffix = values.iter().map(u8::to_string).collect::<Vec<_>>().join("|");
        let line = if suffix.is_empty() { format!("{kind}|{id}\n") } else { format!("{kind}|{id}|{suffix}\n") };
        if self.stdin.write_all(line.as_bytes()).and_then(|_| self.stdin.flush()).is_err() { return fallback; }
        let deadline = Instant::now() + timeout;
        while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
            match self.lines.recv_timeout(remaining) {
                Ok(line) => {
                    let parts = line.trim().split('|').collect::<Vec<_>>();
                    if parts.first() != Some(&id.as_str()) || parts.len() < 3 { continue; }
                    return BridgeStatus {
                        sync: match parts[1] { "SYNCED" => "synced", "NOT_RUNNING" => "not-running", _ => "automation-error" }.into(),
                        focus: match parts[2] { "ACTIVATED" => "activated", "NOT_FOUND" => "not-found", "SKIPPED" => "skipped", _ => "automation-error" }.into(),
                    };
                }
                Err(_) => break,
            }
        }
        let _ = self.child.kill();
        fallback
    }
}

impl Drop for PersistentHelper { fn drop(&mut self) { let _ = self.child.kill(); } }

struct ColorBridges {
    color: Option<PersistentHelper>,
    focus: Option<PersistentHelper>,
}

pub struct PhotoshopService {
    color_script: PathBuf,
    focus_script: PathBuf,
    document_script: PathBuf,
    bridges: Mutex<ColorBridges>,
    document_queue: Mutex<()>,
    diagnostics: Arc<DiagnosticsLog>,
}

impl PhotoshopService {
    pub fn new(resource_dir: &Path, diagnostics: Arc<DiagnosticsLog>) -> Self {
        Self {
            color_script: resource_dir.join("resources/photoshop-color-bridge.ps1"),
            focus_script: resource_dir.join("resources/photoshop-focus-bridge.ps1"),
            document_script: resource_dir.join("resources/photoshop-document-bridge.ps1"),
            bridges: Mutex::new(ColorBridges { color: None, focus: None }),
            document_queue: Mutex::new(()),
            diagnostics,
        }
    }

    pub fn warm(&self) {
        let mut bridges = self.bridges.lock();
        if bridges.color.is_none() { bridges.color = PersistentHelper::start(&self.color_script).ok(); }
        if bridges.focus.is_none() { bridges.focus = PersistentHelper::start(&self.focus_script).ok(); }
        if let Some(color) = bridges.color.as_mut() {
            let _ = color.send('W', &[], Duration::from_millis(800), sync_error());
        }
    }

    pub fn capture_focus(&self) {
        let mut bridges = self.bridges.lock();
        if bridges.focus.is_none() { bridges.focus = PersistentHelper::start(&self.focus_script).ok(); }
        if let Some(focus) = bridges.focus.as_mut() {
            let _ = focus.send('P', &[], Duration::from_millis(800), focus_error());
        }
    }

    fn activate(&self) -> BridgeStatus {
        let mut bridges = self.bridges.lock();
        if bridges.focus.is_none() { bridges.focus = PersistentHelper::start(&self.focus_script).ok(); }
        bridges.focus.as_mut().map(|helper| helper.send('F', &[], Duration::from_millis(1200), focus_error())).unwrap_or_else(focus_error)
    }

    pub fn set_foreground(&self, color: PickedColor, requested_return_focus: bool, window_state: &WindowState) -> PhotoshopColorSyncResult {
        let started = Instant::now();
        if !self.color_script.exists() {
            return PhotoshopColorSyncResult {
                ok: false, status: "automation-error".into(), sync_status: "automation-error".into(),
                focus_status: "skipped".into(), copied: true, sync_latency_ms: 0.0,
                message: Some(format!("缺少 Photoshop 颜色桥接脚本：{}", self.color_script.display())),
            };
        }
        // Focusless / collaboration windows must never steal Photoshop focus.
        let focusless = window_state.locked && window_state.always_on_top;
        let return_focus = requested_return_focus && !focusless;
        let mut bridges = self.bridges.lock();
        if bridges.color.is_none() {
            bridges.color = match PersistentHelper::start(&self.color_script) {
                Ok(helper) => Some(helper),
                Err(error) => {
                    let _ = Clipboard::new().and_then(|mut clipboard| clipboard.set_text(color.hex.clone()));
                    return PhotoshopColorSyncResult {
                        ok: false, status: "automation-error".into(), sync_status: "automation-error".into(),
                        focus_status: "skipped".into(), copied: true,
                        sync_latency_ms: started.elapsed().as_secs_f64() * 1000.0,
                        message: Some(format!("无法启动 Photoshop 颜色桥：{error}")),
                    };
                }
            };
        }
        let mut sync = bridges.color.as_mut().map(|helper| helper.send('S', &[color.r, color.g, color.b], Duration::from_millis(1200), sync_error()))
            .unwrap_or_else(sync_error);
        if sync.sync == "automation-error" {
            // Bridge may have died mid-flight; restart once then retry.
            bridges.color = PersistentHelper::start(&self.color_script).ok();
            sync = bridges.color.as_mut().map(|helper| helper.send('S', &[color.r, color.g, color.b], Duration::from_millis(1200), sync_error()))
                .unwrap_or_else(sync_error);
        }
        let focus = if return_focus {
            if !self.focus_script.exists() {
                "automation-error".into()
            } else {
                if bridges.focus.is_none() { bridges.focus = PersistentHelper::start(&self.focus_script).ok(); }
                bridges.focus.as_mut().map(|helper| helper.send('F', &[], Duration::from_millis(1200), focus_error())).unwrap_or_else(focus_error).focus
            }
        } else { "skipped".into() };
        let copied = sync.sync != "synced";
        if copied { let _ = Clipboard::new().and_then(|mut clipboard| clipboard.set_text(color.hex.clone())); }
        let message = match sync.sync.as_str() {
            "not-running" => Some("Photoshop 未运行，颜色已复制".into()),
            "automation-error" => Some("Photoshop 自动化失败，颜色已复制".into()),
            _ if return_focus && focus != "activated" => Some("颜色已同步，但未能自动返回 Photoshop".into()),
            _ => None,
        };
        let result = PhotoshopColorSyncResult {
            ok: sync.sync == "synced", status: sync.sync.clone(), sync_status: sync.sync,
            focus_status: focus, copied, sync_latency_ms: started.elapsed().as_secs_f64() * 1000.0, message,
        };
        if result.ok {
            self.diagnostics.info("photoshop.set_foreground", json!({
                "hex": color.hex, "focusStatus": result.focus_status, "latencyMs": result.sync_latency_ms, "focusless": focusless,
            }));
        } else {
            self.diagnostics.warn("photoshop.set_foreground", json!({
                "hex": color.hex, "status": result.sync_status, "message": result.message, "copied": result.copied, "focusless": focusless,
            }));
        }
        result
    }

    pub fn run_document(&self, request: &Value, timeout: Duration) -> PhotoshopDocumentResult {
        if !self.document_script.exists() {
            let message = format!("缺少 Photoshop 文档桥接脚本：{}", self.document_script.display());
            self.diagnostics.error_with_message("photoshop.document", &message, json!({ "kind": request.get("kind") }));
            return automation_error(&message);
        }
        let kind = request.get("kind").and_then(|value| value.as_str()).unwrap_or("unknown").to_string();
        let _guard = self.document_queue.lock();
        let result = match run_document_process(&self.document_script, request, timeout) {
            Ok(result) => result,
            Err(error) => {
                self.diagnostics.error_with_message("photoshop.document", error.to_string(), json!({ "kind": kind }));
                PhotoshopDocumentResult {
                    ok: false, status: "automation-error".into(), message: Some(error.to_string()), document_name: None,
                    width: None, height: None, color_mode: None, bit_depth: None, layer_count: None,
                    format: None, archive_path: None, preview_path: None, preview: None,
                }
            }
        };
        if result.ok {
            self.diagnostics.info("photoshop.document", json!({ "kind": kind, "status": result.status, "documentName": result.document_name }));
        } else {
            self.diagnostics.warn("photoshop.document", json!({ "kind": kind, "status": result.status, "message": result.message }));
        }
        result
    }

    pub fn rendered_command(&self, data: &[u8], name: &str, kind: &str, blocked: bool, temp_root: &Path) -> PhotoshopDocumentResult {
        if blocked { return blocked_result("无焦点取色模式期间不能执行 Photoshop 文档操作，请先退出协作模式或解除锁定置顶"); }
        if data.is_empty() || data.len() > 512 * 1024 * 1024 { return automation_error("发送到 Photoshop 的图片大小无效"); }
        let directory = temp_root.join(format!("yoiniwa-photoshop-{}", uuid::Uuid::new_v4()));
        if fs::create_dir_all(&directory).is_err() { return automation_error("无法创建 Photoshop 临时目录"); }
        let image_path = directory.join("selection.png");
        let result = (|| -> Result<PhotoshopDocumentResult> {
            fs::write(&image_path, data)?;
            let (width, height) = image_pipeline::dimensions_for_file(&image_path).unwrap_or((0, 0));
            let request = if kind == "place-raster" {
                serde_json::json!({ "kind": kind, "imagePath": image_path, "name": normalized_name(name, "Yoiniwa Selection"), "pixelWidth": width, "pixelHeight": height })
            } else { serde_json::json!({ "kind": kind, "imagePath": image_path, "name": normalized_name(name, "Yoiniwa Selection") }) };
            Ok(self.run_document(&request, Duration::from_secs(15)))
        })().unwrap_or_else(|error| automation_error(&format!("Photoshop 操作失败: {error}")));
        let _ = fs::remove_dir_all(directory);
        if result.ok { let _ = self.activate(); }
        result
    }

    pub fn rendered_layers(&self, images: &[(Vec<u8>, String)], blocked: bool, temp_root: &Path) -> PhotoshopDocumentResult {
        if blocked { return blocked_result("无焦点取色模式期间不能执行 Photoshop 文档操作，请先退出协作模式或解除锁定置顶"); }
        if images.is_empty() || images.len() > 128 { return automation_error("发送到 Photoshop 的图层数量无效"); }
        let directory = temp_root.join(format!("yoiniwa-photoshop-layers-{}", uuid::Uuid::new_v4()));
        if fs::create_dir_all(&directory).is_err() { return automation_error("无法创建 Photoshop 临时目录"); }
        let result = (|| -> Result<PhotoshopDocumentResult> {
            let mut entries = Vec::new();
            for (index, (bytes, name)) in images.iter().enumerate() {
                if bytes.is_empty() || bytes.len() > 512 * 1024 * 1024 { return Err(anyhow!("发送到 Photoshop 的图片大小无效")); }
                let path = directory.join(format!("selection-{index}.png")); fs::write(&path, bytes)?;
                let (width, height) = image_pipeline::dimensions_for_file(&path).unwrap_or((0, 0));
                entries.push(serde_json::json!({ "imagePath": path, "name": normalized_name(name, &format!("Yoiniwa Selection {}", index + 1)), "pixelWidth": width, "pixelHeight": height }));
            }
            Ok(self.run_document(&serde_json::json!({ "kind": "place-raster-batch", "images": entries }), Duration::from_secs(15)))
        })().unwrap_or_else(|error| automation_error(&format!("发送到 Photoshop 失败: {error}")));
        let _ = fs::remove_dir_all(directory);
        if result.ok { let _ = self.activate(); }
        result
    }
}

fn run_document_process(script: &Path, request: &Value, timeout: Duration) -> Result<PhotoshopDocumentResult> {
    let encoded = BASE64.encode(serde_json::to_vec(request)?);
    let runnable = ensure_powershell_script(script)?;
    let mut command = Command::new("powershell.exe");
    command.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(&runnable).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)] command.creation_flags(CREATE_NO_WINDOW.0);
    let mut child = command.spawn().with_context(|| format!("无法启动 {}", runnable.display()))?;
    child.stdin.take().ok_or_else(|| anyhow!("Photoshop 文档桥 stdin 不可用"))?.write_all(encoded.as_bytes())?;
    if child.wait_timeout(timeout)?.is_none() {
        let _ = child.kill();
        cleanup_temp_script(script, &runnable);
        return Err(anyhow!("Photoshop 文档操作超时"));
    }
    let mut output = String::new();
    let mut stderr = String::new();
    if let Some(mut stdout) = child.stdout.take() { stdout.read_to_string(&mut output)?; }
    if let Some(mut err) = child.stderr.take() { err.read_to_string(&mut stderr)?; }
    cleanup_temp_script(script, &runnable);
    let line = output.lines().rfind(|line| !line.trim().is_empty());
    let Some(line) = line else {
        let detail = stderr.lines().find(|line| !line.trim().is_empty()).unwrap_or("Photoshop 文档桥没有返回结果");
        return Err(anyhow!("Photoshop 文档桥失败: {}", detail.chars().take(400).collect::<String>()));
    };
    let raw: RawDocumentResponse = serde_json::from_str(line)
        .with_context(|| format!("Photoshop 文档桥返回了无效结果: {}{}", line.chars().take(200).collect::<String>(), if stderr.trim().is_empty() { String::new() } else { format!(" / stderr: {}", stderr.chars().take(200).collect::<String>()) }))?;
    let details = raw.document.or(raw.preview).or(raw.document_info).unwrap_or_default();
    let preview = details.preview_path.as_ref().and_then(|path| fs::read(path).ok());
    Ok(PhotoshopDocumentResult {
        ok: raw.ok, status: raw.status, message: raw.message, document_name: details.document_name,
        width: details.width, height: details.height, color_mode: details.color_mode, bit_depth: details.bit_depth,
        layer_count: details.layer_count, format: details.format, archive_path: details.archive_path,
        preview_path: details.preview_path, preview,
    })
}

/// Windows PowerShell 5.1 `-File` mis-parses UTF-8 scripts that contain non-ASCII
/// unless a UTF-8 BOM is present. Electron avoids this via `-Command`; we keep
/// `-File` but materialize a BOM copy when needed.
fn ensure_powershell_script(script: &Path) -> Result<PathBuf> {
    let bytes = fs::read(script).with_context(|| format!("无法读取 {}", script.display()))?;
    let has_bom = bytes.starts_with(&[0xEF, 0xBB, 0xBF]);
    let ascii_only = bytes.iter().all(|byte| *byte < 0x80);
    if has_bom || ascii_only {
        return Ok(script.to_path_buf());
    }
    let temporary = std::env::temp_dir().join(format!("yoiniwa-ps-bridge-{}.ps1", uuid::Uuid::new_v4()));
    let mut with_bom = Vec::with_capacity(bytes.len() + 3);
    with_bom.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    with_bom.extend_from_slice(&bytes);
    fs::write(&temporary, with_bom)?;
    Ok(temporary)
}

fn cleanup_temp_script(original: &Path, runnable: &Path) {
    if runnable != original {
        let _ = fs::remove_file(runnable);
    }
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawDetails {
    document_name: Option<String>, width: Option<u32>, height: Option<u32>, color_mode: Option<String>,
    bit_depth: Option<u32>, layer_count: Option<u32>, format: Option<String>, archive_path: Option<String>, preview_path: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawDocumentResponse {
    ok: bool, status: String, message: Option<String>, document: Option<RawDetails>, preview: Option<RawDetails>, document_info: Option<RawDetails>,
}

fn sync_error() -> BridgeStatus { BridgeStatus { sync: "automation-error".into(), focus: "skipped".into() } }
fn focus_error() -> BridgeStatus { BridgeStatus { sync: "synced".into(), focus: "automation-error".into() } }
fn normalized_name(value: &str, fallback: &str) -> String { let value = value.trim(); if value.is_empty() { fallback.into() } else { value.chars().take(160).collect() } }
pub fn blocked_result(message: &str) -> PhotoshopDocumentResult { PhotoshopDocumentResult { ok: false, status: "blocked".into(), message: Some(message.into()), document_name: None, width: None, height: None, color_mode: None, bit_depth: None, layer_count: None, format: None, archive_path: None, preview_path: None, preview: None } }
pub(crate) fn automation_error(message: &str) -> PhotoshopDocumentResult { PhotoshopDocumentResult { ok: false, status: "automation-error".into(), message: Some(message.into()), document_name: None, width: None, height: None, color_mode: None, bit_depth: None, layer_count: None, format: None, archive_path: None, preview_path: None, preview: None } }

pub type SharedPhotoshop = Arc<PhotoshopService>;
