use std::{
    fs, collections::HashSet,
    path::{Path, PathBuf},
    sync::Arc,
};

use anyhow::{anyhow, Result};
use parking_lot::Mutex;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::{
    assets::{atomic_write, AssetService, SharedAssets},
    diagnostics::DiagnosticsLog,
    image_jobs::ImageJobQueue,
    native::{NativeWindowManager, SharedNative},
    photoshop::{PhotoshopService, SharedPhotoshop},
    project::ProjectService,
    types::RecentScene,
};

pub struct AppState {
    pub assets: SharedAssets,
    pub project: Mutex<ProjectService>,
    pub native: SharedNative,
    pub photoshop: SharedPhotoshop,
    pub diagnostics: Arc<DiagnosticsLog>,
    pub user_data: PathBuf,
    pub temp_dir: PathBuf,
    pub resource_dir: PathBuf,
    pub session_id: String,
    startup_path: Mutex<Option<String>>,
    pending_external_open: Mutex<Option<String>>,
}

impl AppState {
    pub fn new(app: &AppHandle, startup_path: Option<String>) -> Result<Self> {
        let user_data = dirs::config_dir().ok_or_else(|| anyhow!("无法定位 Windows AppData"))?.join("Yoiniwa");
        fs::create_dir_all(&user_data)?;
        let diagnostics = Arc::new(DiagnosticsLog::create(&user_data));
        let resource_dir = resolve_resource_dir(app);
        let jobs = ImageJobQueue::new(4);
        let assets = Arc::new(AssetService::new(user_data.clone(), jobs, diagnostics.clone())?);
        assets.bind_app(app.clone());
        let native = NativeWindowManager::new(app.clone(), &resource_dir, diagnostics.clone());
        let photoshop = Arc::new(PhotoshopService::new(&resource_dir, diagnostics.clone()));
        diagnostics.info("app.start", json!({
            "userData": user_data,
            "resourceDir": resource_dir,
            "logPath": diagnostics.path(),
            "mirrorPath": diagnostics.mirror_path(),
            "scripts": {
                "nativeHelper": resource_dir.join("resources/native-window-move.ps1").exists(),
                "colorBridge": resource_dir.join("resources/photoshop-color-bridge.ps1").exists(),
                "focusBridge": resource_dir.join("resources/photoshop-focus-bridge.ps1").exists(),
                "documentBridge": resource_dir.join("resources/photoshop-document-bridge.ps1").exists(),
            },
            "startupPath": startup_path,
        }));
        Ok(Self {
            project: Mutex::new(ProjectService::new(assets.clone())),
            assets,
            native,
            photoshop,
            session_id: diagnostics.session_id().to_string(),
            diagnostics,
            user_data,
            temp_dir: std::env::temp_dir(),
            resource_dir,
            startup_path: Mutex::new(startup_path),
            pending_external_open: Mutex::new(None),
        })
    }

    pub fn take_startup_path(&self) -> Option<String> { self.startup_path.lock().take() }
    pub fn queue_external_open(&self, value: String) { *self.pending_external_open.lock() = Some(value); }
    pub fn take_pending_external_open(&self) -> Option<String> { self.pending_external_open.lock().take() }

    pub fn state_path(&self) -> PathBuf { self.user_data.join("state.json") }

    pub fn read_persisted_state(&self) -> Value {
        fs::read(self.state_path()).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_else(|| json!({}))
    }

    pub fn write_persisted_state(&self, value: &Value) -> Result<()> {
        atomic_write(&self.state_path(), &serde_json::to_vec_pretty(value)?)
    }

    pub fn recent_scenes(&self) -> Vec<RecentScene> {
        let mut state = self.read_persisted_state();
        let source = state.get("recent").and_then(|value| value.as_array()).cloned().unwrap_or_default();
        let mut seen = HashSet::new();
        let recent = source.iter().filter_map(|value| {
            Some(RecentScene {
                path: value.get("path")?.as_str()?.to_string(), name: value.get("name")?.as_str()?.to_string(),
                opened_at: value.get("openedAt")?.as_str()?.to_string(),
                asset_ids: value.get("assetIds").and_then(|value| serde_json::from_value(value.clone()).ok()),
            })
        }).filter(|item| Path::new(&item.path).try_exists().unwrap_or(false)
            && seen.insert(crate::paths::path_key(Path::new(&item.path)))).collect::<Vec<_>>();
        if recent.len() != source.len() {
            if let Some(object) = state.as_object_mut() {
                object.insert("recent".into(), serde_json::to_value(&recent).unwrap_or_else(|_| Value::Array(Vec::new())));
                let _ = self.write_persisted_state(&state);
            }
        }
        recent
    }

    pub fn add_recent(&self, path: &Path, asset_ids: Vec<String>) -> Result<()> {
        let mut state = self.read_persisted_state();
        let object = state.as_object_mut().ok_or_else(|| anyhow!("state.json 格式无效"))?;
        let path_string = path.to_string_lossy().into_owned();
        let name = path.file_stem().and_then(|name| name.to_str()).unwrap_or("未命名画板");
        let mut recent = object.get("recent").and_then(|value| value.as_array()).cloned().unwrap_or_default();
        recent.retain(|item| item.get("path").and_then(|value| value.as_str())
            .is_none_or(|value| !crate::paths::same_path(Path::new(value), path)));
        recent.insert(0, json!({
            "path": path_string, "name": name, "openedAt": chrono::Utc::now().to_rfc3339(), "assetIds": asset_ids,
        }));
        recent.truncate(12); object.insert("recent".into(), Value::Array(recent)); self.write_persisted_state(&state)
    }

    pub fn remove_recent(&self, path: &str) -> Result<Vec<RecentScene>> {
        let mut state = self.read_persisted_state();
        let object = state.as_object_mut().ok_or_else(|| anyhow!("state.json 格式无效"))?;
        let mut recent = object.get("recent").and_then(|value| value.as_array()).cloned().unwrap_or_default();
        recent.retain(|item| item.get("path").and_then(|value| value.as_str())
            .is_none_or(|value| !crate::paths::same_path(Path::new(value), Path::new(path))));
        object.insert("recent".into(), Value::Array(recent));
        self.write_persisted_state(&state)?;
        Ok(self.recent_scenes())
    }

    pub fn append_logs(&self, entries: &[Value]) -> Result<()> {
        self.diagnostics.append_renderer_entries(entries);
        Ok(())
    }

    pub fn log_path(&self) -> PathBuf { self.diagnostics.path().to_path_buf() }
}

fn resolve_resource_dir(app: &AppHandle) -> PathBuf {
    let packaged = normalize_fs_path(app.path().resource_dir().unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR"))));
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    if packaged.join("resources/native-window-move.ps1").exists() { packaged }
    else if manifest.join("resources/native-window-move.ps1").exists() { manifest }
    else { packaged }
}

fn normalize_fs_path(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(stripped) = text.strip_prefix(r"\\?\") {
        PathBuf::from(stripped)
    } else {
        path
    }
}
