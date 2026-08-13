use std::{borrow::Cow, collections::HashSet, fs, path::{Path, PathBuf}, process::Command, thread, time::Duration};

use anyhow::{anyhow, Result};
use arboard::{Clipboard, ImageData};
use percent_encoding::percent_decode_str;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{ipc::{InvokeBody, Request, Response}, AppHandle, Manager, State, WebviewWindow};
use uuid::Uuid;

use crate::{
    image_pipeline,
    native::TaskbarPointerInput,
    photoshop::{automation_error, blocked_result},
    project::{build_compaction_candidate, BlobSource},
    state::AppState,
    types::{
        CacheInfo, ImportedImage, PhotoshopColorSyncResult, PhotoshopDocumentResult,
        PhotoshopProjectMetadata, PhotoshopVersionRecord, PickedColor, ProjectCommitRequest,
        ProjectCommitResult, ProjectStorageStats, RecentScene, Scene, WindowState, WindowStatePatch,
    },
};

type CommandResult<T> = std::result::Result<T, String>;
fn command_result<T>(value: Result<T>) -> CommandResult<T> { value.map_err(|error| error.to_string()) }

#[tauri::command(rename_all = "camelCase")]
pub async fn images_import(app: AppHandle, state: State<'_, AppState>, request_id: Option<String>) -> CommandResult<Vec<ImportedImage>> {
    let Some(paths) = rfd::AsyncFileDialog::new()
        .add_filter("图片与视频", &["png", "jpg", "jpeg", "webp", "bmp", "gif", "mp4", "webm", "mov", "m4v"])
        .add_filter("图片", &["png", "jpg", "jpeg", "webp", "bmp", "gif"])
        .add_filter("视频", &["mp4", "webm", "mov", "m4v"])
        .pick_files().await else { return Ok(Vec::new()); };
    let assets = state.assets.clone();
    let app_handle = app.clone();
    let raw_paths = paths.into_iter().map(|file| file.path().to_path_buf()).collect::<Vec<_>>();
    tauri::async_runtime::spawn_blocking(move || {
        let total = raw_paths.len(); let mut imported = Vec::new();
        for (index, path) in raw_paths.iter().enumerate() {
            if let Ok(image) = assets.register_path(path, "file") { imported.push(image); }
            if let Some(request_id) = request_id.as_deref() {
                let _ = tauri::Emitter::emit(&app_handle, "images:prewarm-progress", serde_json::json!({
                    "requestId": request_id, "completed": index + 1, "total": total, "stage": "metadata",
                    "fraction": if total == 0 { 1.0 } else { (index + 1) as f64 / total as f64 },
                }));
            }
        }
        Ok(imported)
    }).await.map_err(|error| error.to_string())?.map_err(|error: anyhow::Error| error.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn images_register_paths(
    app: AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
    source_type: String,
    request_id: Option<String>,
) -> CommandResult<Vec<ImportedImage>> {
    if paths.len() > 2000 { return Err("一次拖入的图片数量无效".into()); }
    let assets = state.assets.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut imported = Vec::new();
        let mut last_error: Option<String> = None;
        let total = paths.len();
        for (index, path) in paths.into_iter().enumerate() {
            match assets.register_path(Path::new(&path), &source_type) {
                Ok(image) => imported.push(image),
                Err(error) => last_error = Some(format!("{path}: {error}")),
            }
            if let Some(request_id) = request_id.as_deref() {
                let _ = tauri::Emitter::emit(&app, "images:prewarm-progress", serde_json::json!({
                    "requestId": request_id, "completed": index + 1, "total": total,
                    "stage": "metadata", "fraction": if total == 0 { 1.0 } else { (index + 1) as f64 / total as f64 },
                }));
            }
        }
        if imported.is_empty() {
            return Err(anyhow!(last_error.unwrap_or_else(|| "没有可导入的媒体".into())));
        }
        Ok(imported)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error: anyhow::Error| error.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn images_register_urls(state: State<'_, AppState>, urls: Vec<String>) -> CommandResult<Vec<ImportedImage>> {
    if urls.len() > 100 { return Err("一次拖入的网络图片数量无效".into()); }
    let assets = state.assets.clone();
    tauri::async_runtime::spawn_blocking(move || Ok(urls.into_iter().filter_map(|url| assets.register_url(&url).ok()).collect()))
        .await.map_err(|error| error.to_string())?.map_err(|error: anyhow::Error| error.to_string())
}

#[tauri::command]
pub fn images_register_clipboard(state: State<'_, AppState>) -> CommandResult<Vec<ImportedImage>> { command_result(state.assets.register_clipboard()) }

#[tauri::command]
pub fn images_register_bytes(state: State<'_, AppState>, request: Request<'_>) -> CommandResult<ImportedImage> {
    let data = raw_body(&request)?;
    let name = decoded_header(&request, "x-yoiniwa-name")?;
    let source_type = decoded_header(&request, "x-yoiniwa-source-type").unwrap_or_else(|_| "drop".into());
    command_result(state.assets.register_bytes(name, data, None, &source_type))
}

#[tauri::command(rename_all = "camelCase")]
pub fn videos_ensure_playback(state: State<'_, AppState>, asset_id: String) -> CommandResult<Value> {
    command_result(state.assets.ensure_video_playback(&asset_id))
}

#[tauri::command(rename_all = "camelCase")]
pub fn videos_ensure_scrub(state: State<'_, AppState>, asset_id: String) -> CommandResult<Value> {
    command_result(state.assets.ensure_video_scrub(&asset_id))
}

#[tauri::command(rename_all = "camelCase")]
pub fn videos_cancel_playback(state: State<'_, AppState>, asset_id: String) -> CommandResult<()> {
    state.assets.cancel_video_playback(&asset_id);
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub fn images_asset_path(state: State<'_, AppState>, asset_id: String) -> CommandResult<String> {
    if asset_id.len() != 64 || !asset_id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("资源标识无效".into());
    }
    command_result(state.assets.ensure_file(&asset_id).map(|path| path.to_string_lossy().into_owned()))
}

#[tauri::command(rename_all = "camelCase")]
pub fn images_start_native_drag(window: WebviewWindow, state: State<'_, AppState>, asset_ids: Vec<String>) -> CommandResult<()> {
    if state.native.document_blocked() { return Ok(()); }
    let mut files = asset_ids.into_iter().collect::<HashSet<_>>().into_iter().take(32)
        .filter_map(|id| state.assets.ensure_file(&id).ok()).collect::<Vec<_>>();
    files.retain(|path| path.is_absolute() && path.exists()); if files.is_empty() { return Ok(()); }
    let icon = if state.resource_dir.join("../build/yoiniwa.ico").exists() { state.resource_dir.join("../build/yoiniwa.ico") }
        else { files[0].clone() };
    drag::start_drag(&window, drag::DragItem::Files(files), drag::Image::File(icon), |_, _| {}, drag::Options::default())
        .map_err(|error| error.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn images_prewarm(app: AppHandle, state: State<'_, AppState>, ids: Vec<String>, request_id: String) -> CommandResult<Value> {
    let assets = state.assets.clone();
    tauri::async_runtime::spawn_blocking(move || assets.prewarm(&app, &ids, &request_id)).await
        .map_err(|error| error.to_string())?.map_err(|error| error.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub fn images_cancel_prewarm(state: State<'_, AppState>, request_id: String) { state.assets.cancel_prewarm(&request_id); }
#[tauri::command(rename_all = "camelCase")]
pub fn images_boost_resource(state: State<'_, AppState>, key: String, priority: f64) {
    let _ = state.assets.boost_resource(&key, priority.round() as i32);
}
#[tauri::command]
pub fn images_performance_stats(state: State<'_, AppState>) -> crate::types::ImagePipelinePerformanceStats { state.assets.performance_stats() }
#[tauri::command(rename_all = "camelCase")]
pub fn images_sample_pixel(state: State<'_, AppState>, asset_id: String, x: u32, y: u32) -> CommandResult<Value> {
    command_result(state.assets.sample_pixel(&asset_id, x, y).map(|pixel| serde_json::json!({ "r": pixel[0], "g": pixel[1], "b": pixel[2], "a": pixel[3] })))
}

#[tauri::command(rename_all = "camelCase")]
pub fn project_open(state: State<'_, AppState>, path: Option<String>) -> CommandResult<ProjectCommitResult> {
    let selected = match path {
        Some(path) => PathBuf::from(path),
        None => match rfd::FileDialog::new().add_filter("Yoiniwa 画板", &["yoi", "refcanvas"]).pick_file() {
            Some(path) => path,
            None => return Ok(ProjectCommitResult { canceled: Some(true), ..Default::default() }),
        },
    };
    command_result((|| {
        let result = state.project.lock().open(&selected)?;
        let asset_ids = result.scene.as_ref().map(|scene| scene.assets.keys().cloned().collect()).unwrap_or_default();
        state.add_recent(&selected, asset_ids)?; Ok(result)
    })())
}

#[tauri::command(rename_all = "camelCase")]
pub fn project_commit(app: AppHandle, state: State<'_, AppState>, request: ProjectCommitRequest) -> CommandResult<ProjectCommitResult> {
    let result = command_result((|| {
        let result = state.project.lock().commit(request, Vec::new())?;
        if let Some(path) = result.path.as_ref() { state.add_recent(Path::new(path), result.scene.as_ref().map(|scene| scene.assets.keys().cloned().collect()).unwrap_or_default())?; }
        Ok(result)
    })())?;
    schedule_background_compaction(&app, &result);
    Ok(result)
}

#[tauri::command(rename_all = "camelCase")]
pub fn project_save_as(state: State<'_, AppState>, request: ProjectCommitRequest) -> CommandResult<ProjectCommitResult> {
    let name = if request.scene.name.trim().is_empty() { "未命名画板" } else { request.scene.name.trim() };
    let Some(path) = rfd::FileDialog::new().set_file_name(format!("{name}.yoi")).add_filter("Yoiniwa 画板", &["yoi"]).save_file() else {
        return Ok(ProjectCommitResult { canceled: Some(true), ..Default::default() });
    };
    let target = if path.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("yoi")) { path } else { path.with_extension("yoi") };
    command_result((|| {
        let result = state.project.lock().save_as_to(request, &target, Vec::new())?;
        state.add_recent(&target, result.scene.as_ref().map(|scene| scene.assets.keys().cloned().collect()).unwrap_or_default())?; Ok(result)
    })())
}

#[tauri::command(rename_all = "camelCase")]
pub fn project_close(state: State<'_, AppState>, session_id: Option<String>) -> CommandResult<()> { command_result(state.project.lock().close(session_id.as_deref())) }
#[tauri::command(rename_all = "camelCase")]
pub fn project_compact(state: State<'_, AppState>, session_id: Option<String>) -> CommandResult<Value> {
    command_result(state.project.lock().compact(session_id.as_deref()).map(|result| result.map_or_else(|| serde_json::json!({ "skipped": true }), |stats| serde_json::to_value(stats).unwrap())))
}
#[tauri::command(rename_all = "camelCase")]
pub fn project_stats(state: State<'_, AppState>, session_id: Option<String>) -> CommandResult<ProjectStorageStats> { command_result(state.project.lock().stats(session_id.as_deref())) }
#[tauri::command(rename_all = "camelCase")]
pub fn project_recover(state: State<'_, AppState>, session_id: Option<String>) -> CommandResult<Value> {
    command_result(state.project.lock().recover(session_id.as_deref()).map(|(recovered, session_id)| serde_json::json!({ "recovered": recovered, "sessionId": session_id })))
}

#[tauri::command]
pub fn scene_startup_path(state: State<'_, AppState>) -> Option<String> { state.take_startup_path() }
#[tauri::command]
pub fn scene_recent(state: State<'_, AppState>) -> Vec<RecentScene> { state.recent_scenes() }
#[tauri::command]
pub fn scene_import(state: State<'_, AppState>) -> CommandResult<Value> {
    let Some(path) = rfd::FileDialog::new().add_filter("Yoiniwa 画板", &["yoi", "refcanvas"]).pick_file() else { return Ok(serde_json::json!({ "canceled": true })); };
    command_result(state.project.lock().import(&path).map(|(scene, _)| serde_json::json!({ "canceled": false, "path": path, "scene": scene })))
}

#[tauri::command]
pub fn cache_info(state: State<'_, AppState>) -> CommandResult<CacheInfo> { command_result(state.assets.cache_info()) }
#[tauri::command]
pub fn cache_choose_location(state: State<'_, AppState>) -> CommandResult<Value> {
    let Some(path) = rfd::FileDialog::new().pick_folder() else { return Ok(serde_json::json!({ "canceled": true })); };
    command_result(state.assets.set_cache_location(Some(path)).map(|info| serde_json::json!({ "canceled": false, "info": info })))
}
#[tauri::command]
pub fn cache_reset_location(state: State<'_, AppState>) -> CommandResult<CacheInfo> { command_result(state.assets.set_cache_location(None)) }
#[tauri::command]
pub fn cache_clear(state: State<'_, AppState>) -> CommandResult<CacheInfo> { command_result(state.assets.clear_regenerable_cache()) }

#[tauri::command]
pub fn image_export(request: Request<'_>) -> CommandResult<Value> {
    let data = raw_body(&request)?;
    let suggested_name = decoded_header(&request, "x-yoiniwa-name")?;
    let extension = Path::new(&suggested_name).extension().and_then(|value| value.to_str()).unwrap_or("png");
    let Some(path) = rfd::FileDialog::new().set_file_name(&suggested_name).add_filter("图片", &[extension]).save_file() else { return Ok(serde_json::json!({ "canceled": true })); };
    command_result(fs::write(&path, data).map(|_| serde_json::json!({ "canceled": false, "path": path })).map_err(Into::into))
}
#[tauri::command]
pub fn image_copy(request: Request<'_>) -> CommandResult<()> {
    let data = raw_body(&request)?;
    command_result((|| {
        let (pixels, width, height) = image_pipeline::decode_rgba(data)?;
        Clipboard::new()?.set_image(ImageData { width: width as usize, height: height as usize, bytes: Cow::Owned(pixels) })?; Ok(())
    })())
}
#[tauri::command]
pub fn image_show_source(path: String) -> Value {
    let path = PathBuf::from(path);
    if !path.is_absolute() || !path.exists() { return serde_json::json!({ "ok": false, "message": "源文件已经移动或不存在" }); }
    let status = Command::new("explorer.exe").arg(format!("/select,{}", path.display())).status();
    if status.is_ok() { serde_json::json!({ "ok": true }) } else { serde_json::json!({ "ok": false, "message": "无法打开资源管理器" }) }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OriginalExportItem {
    asset_id: String,
    suggested_name: String,
}

#[tauri::command(rename_all = "camelCase")]
pub fn image_export_originals(state: State<'_, AppState>, items: Vec<OriginalExportItem>) -> CommandResult<Value> {
    command_result((|| {
        if items.is_empty() || items.len() > 256 { return Err(anyhow!("请选择 1 至 256 张图片导出")); }
        let prepared = items.into_iter().map(|item| {
            if !is_asset_id(&item.asset_id) { return Err(anyhow!("导出原图请求无效")); }
            let path = state.assets.ensure_file(&item.asset_id)?;
            let name = original_export_name(&path, &item.suggested_name);
            Ok((path, name))
        }).collect::<Result<Vec<_>>>()?;
        if prepared.len() == 1 {
            let (source, name) = &prepared[0];
            let extension = Path::new(name).extension().and_then(|value| value.to_str()).unwrap_or("bin");
            let Some(target) = rfd::FileDialog::new().set_file_name(name).add_filter("原始图片", &[extension]).save_file() else {
                return Ok(serde_json::json!({ "canceled": true }));
            };
            if source.canonicalize().ok() != target.canonicalize().ok() {
                fs::copy(source, &target)?;
            }
            return Ok(serde_json::json!({ "canceled": false, "path": target, "count": 1 }));
        }
        let Some(directory) = rfd::FileDialog::new().set_title(&format!("选择保存 {} 张原图的文件夹", prepared.len())).pick_folder() else {
            return Ok(serde_json::json!({ "canceled": true }));
        };
        let mut reserved = std::collections::HashSet::new();
        for (source, name) in &prepared {
            let target = available_export_path(&directory, name, &mut reserved);
            fs::copy(source, &target)?;
        }
        Ok(serde_json::json!({ "canceled": false, "path": directory, "count": prepared.len() }))
    })())
}

#[tauri::command(rename_all = "camelCase")]
pub fn image_copy_original(state: State<'_, AppState>, asset_id: String) -> CommandResult<()> {
    command_result((|| {
        if !is_asset_id(&asset_id) { return Err(anyhow!("复制原图请求无效")); }
        let path = state.assets.ensure_file(&asset_id)?;
        let (pixels, width, height) = image_pipeline::file_rgba(&path)?;
        if !clipboard_image_dimensions_allowed(width, height) {
            return Err(anyhow!("原图尺寸过大，无法安全复制到系统剪贴板"));
        }
        Clipboard::new()?.set_image(ImageData { width: width as usize, height: height as usize, bytes: Cow::Owned(pixels) })?;
        Ok(())
    })())
}

fn is_asset_id(value: &str) -> bool {
    value.len() == 64 && value.chars().all(|ch| ch.is_ascii_hexdigit())
}

fn clipboard_image_dimensions_allowed(width: u32, height: u32) -> bool {
    const MAX_EDGE: u32 = 16384;
    const MAX_PIXELS: u64 = 100_000_000;
    width > 0 && height > 0 && width <= MAX_EDGE && height <= MAX_EDGE
        && (width as u64).saturating_mul(height as u64) <= MAX_PIXELS
}

fn original_export_name(source: &Path, suggested: &str) -> String {
    let suggested = suggested.trim();
    let fallback = source.file_name().and_then(|value| value.to_str()).unwrap_or("image.bin");
    if suggested.is_empty() { return fallback.to_string(); }
    let has_ext = Path::new(suggested).extension().is_some();
    if has_ext { suggested.to_string() } else {
        match source.extension().and_then(|value| value.to_str()) {
            Some(ext) => format!("{suggested}.{ext}"),
            None => suggested.to_string(),
        }
    }
}

fn available_export_path(directory: &Path, name: &str, reserved: &mut std::collections::HashSet<String>) -> PathBuf {
    let stem = Path::new(name).file_stem().and_then(|value| value.to_str()).unwrap_or("image");
    let extension = Path::new(name).extension().and_then(|value| value.to_str()).unwrap_or("bin");
    for index in 0..10_000 {
        let candidate_name = if index == 0 { format!("{stem}.{extension}") } else { format!("{stem}-{index}.{extension}") };
        let key = candidate_name.to_ascii_lowercase();
        let path = directory.join(&candidate_name);
        if reserved.contains(&key) || path.exists() { continue; }
        reserved.insert(key);
        return path;
    }
    directory.join(format!("{stem}-{}.{}", Uuid::new_v4(), extension))
}

#[tauri::command(rename_all = "camelCase")]
pub fn photoshop_set_foreground(state: State<'_, AppState>, color: PickedColor, return_focus: Option<bool>) -> PhotoshopColorSyncResult {
    // Color COM sync must not race with blur Z-order repair during collab handoff.
    state.native.extend_pick_critical(std::time::Duration::from_millis(500));
    state.photoshop.set_foreground(color, return_focus.unwrap_or(false), &state.native.mode())
}

#[tauri::command]
pub fn photoshop_place_rendered(state: State<'_, AppState>, request: Request<'_>) -> CommandResult<PhotoshopDocumentResult> {
    let name = decoded_header(&request, "x-yoiniwa-name")?;
    Ok(state.photoshop.rendered_command(raw_body(&request)?, &name, "place-raster", state.native.document_blocked(), &state.temp_dir))
}
#[tauri::command]
pub fn photoshop_place_rendered_layers(state: State<'_, AppState>, request: Request<'_>) -> CommandResult<PhotoshopDocumentResult> {
    let images = decode_rendered_layers(raw_body(&request)?)?;
    Ok(state.photoshop.rendered_layers(&images, state.native.document_blocked(), &state.temp_dir))
}
#[tauri::command]
pub fn photoshop_open_rendered(state: State<'_, AppState>, request: Request<'_>) -> CommandResult<PhotoshopDocumentResult> {
    let name = decoded_header(&request, "x-yoiniwa-name")?;
    Ok(state.photoshop.rendered_command(raw_body(&request)?, &name, "open-image", state.native.document_blocked(), &state.temp_dir))
}
#[tauri::command]
pub fn photoshop_get_document_info(state: State<'_, AppState>) -> PhotoshopDocumentResult {
    if state.native.document_blocked() { return blocked_result("无焦点取色模式期间不能读取 Photoshop 文档，请先退出协作模式或解除锁定置顶"); }
    state.photoshop.run_document(&serde_json::json!({ "kind": "document-info" }), Duration::from_secs(15))
}
#[tauri::command]
pub fn photoshop_capture_preview(state: State<'_, AppState>) -> PhotoshopDocumentResult {
    if state.native.document_blocked() { return blocked_result("无焦点取色模式期间不能捕获 Photoshop 预览，请先退出协作模式或解除锁定置顶"); }
    let directory = state.temp_dir.join(format!("yoiniwa-photoshop-preview-{}", Uuid::new_v4())); let _ = fs::create_dir_all(&directory);
    let path = directory.join("preview.png");
    let mut result = state.photoshop.run_document(&serde_json::json!({ "kind": "capture-preview", "previewPath": path }), Duration::from_secs(120));
    if let Some(preview) = result.preview.take() {
        let token = Uuid::new_v4().to_string();
        let transfer = state.temp_dir.join(format!("yoiniwa-ipc-preview-{token}.png"));
        if fs::write(&transfer, preview).is_ok() { result.preview_path = Some(token); }
        else { result.ok = false; result.status = "automation-error".into(); result.message = Some("无法暂存 Photoshop 预览".into()); }
    }
    let _ = fs::remove_dir_all(directory); result
}

#[tauri::command]
pub fn photoshop_take_preview(state: State<'_, AppState>, request: Request<'_>) -> CommandResult<Response> {
    let token = decoded_header(&request, "x-yoiniwa-token")?;
    Uuid::parse_str(&token).map_err(|_| "Photoshop 预览令牌无效".to_string())?;
    let path = state.temp_dir.join(format!("yoiniwa-ipc-preview-{token}.png"));
    let bytes = fs::read(&path).map_err(|error| error.to_string())?;
    let _ = fs::remove_file(path);
    Ok(Response::new(bytes))
}

#[tauri::command(rename_all = "camelCase")]
pub fn photoshop_create_version(
    app: AppHandle, state: State<'_, AppState>, session_id: Option<String>, scene: Scene, metadata: PhotoshopProjectMetadata,
    name: String, note: Option<String>, revision: Option<u64>, preview: Option<Vec<u8>>,
) -> CommandResult<ProjectCommitResult> {
    command_result((|| {
        if state.native.document_blocked() { return Ok(ProjectCommitResult { canceled: Some(false), message: Some("无焦点取色模式期间不能保存 Photoshop 版本，请先退出协作模式或解除锁定置顶".into()), ..Default::default() }); }
        let name = name.trim().chars().take(160).collect::<String>(); if name.is_empty() { return Ok(ProjectCommitResult { canceled: Some(false), message: Some("请输入版本名称".into()), ..Default::default() }); }
        let directory = state.temp_dir.join(format!("yoiniwa-photoshop-version-{}", Uuid::new_v4())); fs::create_dir_all(&directory)?;
        let version_id = Uuid::new_v4().to_string(); let psd = directory.join(format!("{version_id}.psd")); let psb = directory.join(format!("{version_id}.psb")); let preview_path = directory.join(format!("{version_id}.jpg"));
        let capture = state.photoshop.run_document(&serde_json::json!({ "kind": "capture-version", "archivePsdPath": psd, "archivePsbPath": psb, "previewPath": preview_path }), Duration::from_secs(120));
        if !capture.ok { let _ = fs::remove_dir_all(directory); return Ok(ProjectCommitResult { canceled: Some(false), message: capture.message, ..Default::default() }); }
        let archive_path = capture.archive_path.clone().ok_or_else(|| anyhow!("Photoshop 版本缺少归档路径"))?;
        let archive_bytes = fs::read(&archive_path)?; let sha256 = format!("{:x}", Sha256::digest(&archive_bytes));
        let preview_bytes = fs::read(capture.preview_path.as_ref().unwrap_or(&preview_path.to_string_lossy().into_owned()))?;
        let preview_image = state.assets.register_bytes(format!("{name}.jpg"), &preview_bytes, None, "file")?;
        let version = PhotoshopVersionRecord {
            id: version_id, name: name.clone(), note: note.map(|value| value.trim().chars().take(4000).collect()).filter(|value: &String| !value.is_empty()),
            created_at: chrono::Utc::now().to_rfc3339(), document_name: capture.document_name.unwrap_or_else(|| name.clone()),
            width: capture.width.unwrap_or(0), height: capture.height.unwrap_or(0), color_mode: capture.color_mode.unwrap_or_else(|| "RGB".into()),
            bit_depth: capture.bit_depth.unwrap_or(8), layer_count: capture.layer_count.unwrap_or(0), format: capture.format.unwrap_or_else(|| "psd".into()),
            byte_length: archive_bytes.len() as u64, sha256: sha256.clone(), blob_id: Some(sha256.clone()), archive_entry: None,
            preview_asset_id: preview_image.asset_id.clone(), preview_asset: preview_image.asset.clone(),
        };
        let mut next_metadata = metadata; next_metadata.versions.push(version.clone());
        let request = ProjectCommitRequest { session_id, scene, photoshop_project: next_metadata, renderer_revision: revision, preview, reason: "version-add".into() };
        let source = BlobSource { id: sha256, source_path: PathBuf::from(archive_path), source_offset: 0, byte_length: archive_bytes.len() as u64, kind: "photoshop-version".into(), mime_type: Some("image/vnd.adobe.photoshop".into()) };
        let mut project = state.project.lock();
        let mut result = if project.current_session_id().is_some() { project.commit(request, vec![source])? } else {
            let Some(path) = rfd::FileDialog::new().set_file_name(format!("{}.yoi", name)).add_filter("Yoiniwa 画板", &["yoi"]).save_file() else { return Ok(ProjectCommitResult { canceled: Some(true), ..Default::default() }); };
            project.save_as_to(request, &path.with_extension("yoi"), vec![source])?
        };
        result.version = Some(version); let _ = fs::remove_dir_all(directory);
        schedule_background_compaction(&app, &result);
        Ok(result)
    })())
}

#[tauri::command(rename_all = "camelCase")]
pub fn photoshop_open_version(state: State<'_, AppState>, session_id: Option<String>, version_id: String) -> PhotoshopDocumentResult {
    if state.native.document_blocked() { return blocked_result("无焦点取色模式期间不能打开 Photoshop 版本，请先退出协作模式或解除锁定置顶"); }
    let project = state.project.lock(); let Some(metadata) = project.current_metadata() else { return automation_error("当前画板尚未保存"); };
    let Some(version) = metadata.versions.iter().find(|version| version.id == version_id) else { return automation_error("找不到 Photoshop 版本"); };
    let directory = state.temp_dir.join(format!("yoiniwa-photoshop-open-{}", Uuid::new_v4())); let _ = fs::create_dir_all(&directory);
    let path = directory.join(format!("{}.{}", version.id, version.format));
    let result = project.extract_photoshop_version(session_id.as_deref(), version.blob_id.as_deref().unwrap_or(&version.sha256), &path)
        .map(|_| state.photoshop.run_document(&serde_json::json!({ "kind": "open-version", "versionPath": path, "name": version.name }), Duration::from_secs(15)))
        .unwrap_or_else(|error| automation_error(&format!("无法打开 Photoshop 版本: {error}")));
    drop(project); let _ = fs::remove_dir_all(directory); result
}

#[tauri::command(rename_all = "camelCase")]
pub fn photoshop_delete_version(
    app: AppHandle, state: State<'_, AppState>, session_id: Option<String>, scene: Scene, mut metadata: PhotoshopProjectMetadata,
    version_id: String, revision: Option<u64>, preview: Option<Vec<u8>>,
) -> CommandResult<ProjectCommitResult> {
    if state.native.document_blocked() { return Ok(ProjectCommitResult { canceled: Some(false), message: Some("无焦点取色模式期间不能删除 Photoshop 版本，请先退出协作模式或解除锁定置顶".into()), ..Default::default() }); }
    if !metadata.versions.iter().any(|version| version.id == version_id) { return Ok(ProjectCommitResult { canceled: Some(false), message: Some("找不到 Photoshop 版本".into()), ..Default::default() }); }
    metadata.versions.retain(|version| version.id != version_id);
    let result = command_result(state.project.lock().commit(ProjectCommitRequest { session_id, scene, photoshop_project: metadata, renderer_revision: revision, preview, reason: "version-delete".into() }, Vec::new()))?;
    schedule_background_compaction(&app, &result);
    Ok(result)
}

#[tauri::command(rename_all = "camelCase")]
pub fn window_set_mode(state: State<'_, AppState>, mode: WindowStatePatch) -> CommandResult<WindowState> { command_result(state.native.set_mode(mode)) }
#[tauri::command]
pub fn window_get_mode(state: State<'_, AppState>) -> WindowState { state.native.mode() }
#[derive(serde::Deserialize)] pub struct Point { x: f64, y: f64 }
#[tauri::command(rename_all = "camelCase")]
pub fn window_get_work_area(state: State<'_, AppState>, point: Option<Point>) -> CommandResult<Value> { command_result(state.native.work_area(point.map(|point| (point.x, point.y))).and_then(|value| serde_json::to_value(value).map_err(Into::into))) }
#[tauri::command]
pub fn window_get_collaboration_shortcut(state: State<'_, AppState>) -> Value { serde_json::json!({ "shortcut": state.native.shortcut() }) }
#[tauri::command(rename_all = "camelCase")]
pub fn window_set_collaboration_shortcut(app: AppHandle, state: State<'_, AppState>, shortcut: String) -> Value {
    if state.native.mode().collaboration_mode { return serde_json::json!({ "ok": false, "shortcut": state.native.shortcut(), "message": "请先退出协作模式，再更改协作快捷键" }); }
    if !crate::app::valid_collaboration_shortcut(&shortcut) { return serde_json::json!({ "ok": false, "shortcut": state.native.shortcut(), "message": "全局快捷键需要包含 Ctrl 或 Alt，且不能使用固定退出兜底键" }); }
    match crate::app::replace_collaboration_shortcut(&app, &state.native.shortcut(), &shortcut) {
        Ok(()) => {
            state.native.set_shortcut_value(shortcut.clone()); let mut persisted = state.read_persisted_state();
            if let Some(object) = persisted.as_object_mut() { object.insert("shortcuts".into(), serde_json::json!({ "collaboration": shortcut })); }
            let _ = state.write_persisted_state(&persisted); serde_json::json!({ "ok": true, "shortcut": state.native.shortcut() })
        }
        Err(error) => serde_json::json!({ "ok": false, "shortcut": state.native.shortcut(), "message": error.to_string() }),
    }
}
#[tauri::command(rename_all = "camelCase")]
pub fn window_is_key_down(state: State<'_, AppState>, key: String) -> bool { key == "Space" && state.native.query_key(0x20) }
#[tauri::command]
pub fn window_set_title(window: WebviewWindow, title: String) { let title = title.trim().chars().take(260).collect::<String>(); if !title.is_empty() { let _ = window.set_title(&title); } }
#[tauri::command] pub fn window_minimize(window: WebviewWindow) { let _ = window.minimize(); }
#[tauri::command] pub fn window_toggle_maximize(window: WebviewWindow) { if window.is_maximized().unwrap_or(false) { let _ = window.unmaximize(); } else { let _ = window.maximize(); } }
#[tauri::command] pub fn window_move_start(state: State<'_, AppState>) { state.native.prepare_native_move(); }
#[tauri::command] pub fn window_move_update(state: State<'_, AppState>) { let _ = state.native.begin_native_move(); }
#[tauri::command] pub fn window_move_end(state: State<'_, AppState>) { state.native.finish_native_move(); }
#[tauri::command] pub fn window_close(window: WebviewWindow) { let _ = window.close(); }
#[tauri::command(rename_all = "camelCase")] pub fn window_close_response(state: State<'_, AppState>, should_close: bool) { state.native.respond_close(should_close); }
#[tauri::command(rename_all = "camelCase")] pub fn window_dirty(state: State<'_, AppState>, dirty: bool, _revision: Option<u64>) { state.native.set_dirty(dirty); }

#[tauri::command(rename_all = "camelCase")]
pub fn taskbar_pen_start(state: State<'_, AppState>, input: TaskbarPointerInput) -> String { state.native.taskbar_pen_start(&input) }
#[tauri::command(rename_all = "camelCase")]
pub fn taskbar_pen_pointer(window: WebviewWindow, state: State<'_, AppState>, input: TaskbarPointerInput) { let _ = state.native.taskbar_pen_pointer(&window, input); }

#[tauri::command(rename_all = "camelCase")]
pub fn logs_write(state: State<'_, AppState>, entries: Vec<Value>) -> CommandResult<()> { command_result(state.append_logs(&entries)) }
#[tauri::command]
pub fn logs_open_folder(state: State<'_, AppState>) -> CommandResult<Value> {
    let path = state.diagnostics.directory().to_path_buf();
    command_result(Command::new("explorer.exe").arg(&path).spawn().map(|_| serde_json::json!({ "path": path })).map_err(Into::into))
}
#[tauri::command]
pub fn logs_copy_diagnostics(state: State<'_, AppState>) -> CommandResult<Value> {
    let path = state.log_path();
    let problems = state.diagnostics.recent_problems(30);
    let mirror = state.diagnostics.mirror_path().map(|path| path.display().to_string());
    let text = format!(
        "Yoiniwa diagnostics\nsession: {}\nlog: {}\nmirror: {}\nrecentProblems: {}\n",
        state.session_id,
        path.display(),
        mirror.unwrap_or_else(|| "(none)".into()),
        serde_json::to_string_pretty(&problems).unwrap_or_else(|_| "[]".into()),
    );
    command_result((|| {
        Clipboard::new()?.set_text(text)?;
        Ok(serde_json::json!({
            "sessionId": state.session_id,
            "path": path,
            "mirrorPath": state.diagnostics.mirror_path(),
            "problemCount": problems.len(),
        }))
    })())
}
#[tauri::command]
pub fn logs_recent_problems(state: State<'_, AppState>, limit: Option<usize>) -> Value {
    serde_json::json!({
        "sessionId": state.session_id,
        "path": state.log_path(),
        "mirrorPath": state.diagnostics.mirror_path(),
        "problems": state.diagnostics.recent_problems(limit.unwrap_or(50).clamp(1, 200)),
    })
}
#[tauri::command(rename_all = "camelCase")]
pub fn performance_record_manual_wheel(state: State<'_, AppState>, payload: Value) -> CommandResult<Value> {
    let root = state.user_data.join("performance-results"); command_result((|| { fs::create_dir_all(&root)?; let path = root.join("manual-wheel-latest.json"); fs::write(&path, serde_json::to_vec_pretty(&payload)?)?; Ok(serde_json::json!({ "path": path })) })())
}

fn raw_body<'a>(request: &'a Request<'_>) -> CommandResult<&'a [u8]> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(bytes),
        _ => Err("该操作需要原始字节数据".into()),
    }
}

fn decoded_header(request: &Request<'_>, name: &str) -> CommandResult<String> {
    let encoded = request.headers().get(name).and_then(|value| value.to_str().ok()).ok_or_else(|| format!("缺少 {name} 请求头"))?;
    percent_decode_str(encoded).decode_utf8().map(|value| value.into_owned()).map_err(|_| format!("{name} 请求头不是有效 UTF-8"))
}

fn decode_rendered_layers(bytes: &[u8]) -> CommandResult<Vec<(Vec<u8>, String)>> {
    fn take<'a>(bytes: &'a [u8], cursor: &mut usize, length: usize) -> Option<&'a [u8]> {
        let end = cursor.checked_add(length)?;
        let value = bytes.get(*cursor..end)?;
        *cursor = end;
        Some(value)
    }
    fn u32_le(bytes: &[u8], cursor: &mut usize) -> Option<u32> {
        Some(u32::from_le_bytes(take(bytes, cursor, 4)?.try_into().ok()?))
    }
    fn u64_le(bytes: &[u8], cursor: &mut usize) -> Option<u64> {
        Some(u64::from_le_bytes(take(bytes, cursor, 8)?.try_into().ok()?))
    }

    let mut cursor = 0;
    let count = u32_le(bytes, &mut cursor).ok_or_else(|| "Photoshop 图层数据头无效".to_string())? as usize;
    if count == 0 || count > 128 { return Err("发送到 Photoshop 的图层数量无效".into()); }
    let mut images = Vec::with_capacity(count);
    for _ in 0..count {
        let name_length = u32_le(bytes, &mut cursor).ok_or_else(|| "Photoshop 图层名称长度无效".to_string())? as usize;
        let data_length = usize::try_from(u64_le(bytes, &mut cursor).ok_or_else(|| "Photoshop 图层数据长度无效".to_string())?)
            .map_err(|_| "Photoshop 图层数据长度无效".to_string())?;
        if name_length > 4096 || data_length == 0 || data_length > 512 * 1024 * 1024 { return Err("发送到 Photoshop 的图层数据无效".into()); }
        let name = std::str::from_utf8(take(bytes, &mut cursor, name_length).ok_or_else(|| "Photoshop 图层名称数据不完整".to_string())?)
            .map_err(|_| "Photoshop 图层名称不是有效 UTF-8".to_string())?.to_string();
        let data = take(bytes, &mut cursor, data_length).ok_or_else(|| "Photoshop 图层数据不完整".to_string())?.to_vec();
        images.push((data, name));
    }
    if cursor != bytes.len() { return Err("Photoshop 图层数据包含多余内容".into()); }
    Ok(images)
}

fn schedule_background_compaction(app: &AppHandle, result: &ProjectCommitResult) {
    if result.compaction_scheduled != Some(true) { return; }
    let (Some(session_id), Some(generation)) = (result.session_id.clone(), result.generation) else { return; };
    let app = app.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(30));
        let plan = {
            let Some(state) = app.try_state::<AppState>() else { return; };
            let plan = state.project.lock().compaction_plan(&session_id, generation).ok().flatten();
            plan
        };
        let Some(plan) = plan else { return; };
        let Ok(candidate) = build_compaction_candidate(plan) else { return; };
        let Some(state) = app.try_state::<AppState>() else { return; };
        let _ = state.project.lock().activate_compaction(&session_id, candidate);
    });
}
