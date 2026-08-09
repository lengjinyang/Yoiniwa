use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
};

use anyhow::{anyhow, Result};
use chrono::Utc;
use parking_lot::Mutex;
use serde_json::Value;
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use crate::{
    assets::{atomic_write, AssetService, SharedAssets},
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
    pub user_data: PathBuf,
    pub temp_dir: PathBuf,
    pub resource_dir: PathBuf,
    pub session_id: String,
    startup_path: Mutex<Option<String>>,
    log_file: Mutex<PathBuf>,
}

impl AppState {
    pub fn new(app: &AppHandle, startup_path: Option<String>) -> Result<Self> {
        let user_data = dirs::config_dir().ok_or_else(|| anyhow!("无法定位 Windows AppData"))?.join("Yoiniwa");
        fs::create_dir_all(&user_data)?;
        let resource_dir = resolve_resource_dir(app);
        let assets = Arc::new(AssetService::new(user_data.clone())?);
        let native = NativeWindowManager::new(app.clone(), &resource_dir);
        let photoshop = Arc::new(PhotoshopService::new(&resource_dir));
        let session_id = Uuid::new_v4().to_string();
        let logs = user_data.join("logs"); fs::create_dir_all(&logs)?;
        let log_file = logs.join(format!("yoiniwa-{}.jsonl", Utc::now().format("%Y-%m-%d")));
        Ok(Self {
            project: Mutex::new(ProjectService::new(assets.clone())), assets, native, photoshop,
            user_data, temp_dir: std::env::temp_dir(), resource_dir, session_id,
            startup_path: Mutex::new(startup_path), log_file: Mutex::new(log_file),
        })
    }

    pub fn take_startup_path(&self) -> Option<String> { self.startup_path.lock().take() }
    pub fn set_startup_path(&self, value: String) { *self.startup_path.lock() = Some(value); }

    pub fn state_path(&self) -> PathBuf { self.user_data.join("state.json") }

    pub fn read_persisted_state(&self) -> Value {
        fs::read(self.state_path()).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_else(|| serde_json::json!({}))
    }

    pub fn write_persisted_state(&self, value: &Value) -> Result<()> {
        atomic_write(&self.state_path(), &serde_json::to_vec_pretty(value)?)
    }

    pub fn recent_scenes(&self) -> Vec<RecentScene> {
        self.read_persisted_state().get("recent").and_then(|value| value.as_array()).into_iter().flatten().filter_map(|value| {
            Some(RecentScene {
                path: value.get("path")?.as_str()?.to_string(), name: value.get("name")?.as_str()?.to_string(),
                opened_at: value.get("openedAt")?.as_str()?.to_string(),
                asset_ids: value.get("assetIds").and_then(|value| serde_json::from_value(value.clone()).ok()),
            })
        }).collect()
    }

    pub fn add_recent(&self, path: &Path, asset_ids: Vec<String>) -> Result<()> {
        let mut state = self.read_persisted_state();
        let object = state.as_object_mut().ok_or_else(|| anyhow!("state.json 格式无效"))?;
        let path_string = path.to_string_lossy().into_owned();
        let name = path.file_stem().and_then(|name| name.to_str()).unwrap_or("未命名画板");
        let mut recent = object.get("recent").and_then(|value| value.as_array()).cloned().unwrap_or_default();
        recent.retain(|item| item.get("path").and_then(|value| value.as_str()) != Some(&path_string));
        recent.insert(0, serde_json::json!({
            "path": path_string, "name": name, "openedAt": Utc::now().to_rfc3339(), "assetIds": asset_ids,
        }));
        recent.truncate(12); object.insert("recent".into(), Value::Array(recent)); self.write_persisted_state(&state)
    }

    pub fn append_logs(&self, entries: &[Value]) -> Result<()> {
        let mut file = OpenOptions::new().create(true).append(true).open(self.log_file.lock().clone())?;
        for entry in entries {
            let value = serde_json::json!({ "timestamp": Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true), "sessionId": self.session_id, "source": "renderer", "entry": entry });
            writeln!(file, "{}", serde_json::to_string(&value)?)?;
        }
        Ok(())
    }

    pub fn log_path(&self) -> PathBuf { self.log_file.lock().clone() }
}

fn resolve_resource_dir(app: &AppHandle) -> PathBuf {
    let packaged = app.path().resource_dir().unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")));
    if packaged.join("resources/native-window-move.ps1").exists() { packaged }
    else { PathBuf::from(env!("CARGO_MANIFEST_DIR")) }
}
