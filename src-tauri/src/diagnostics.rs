use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use chrono::Utc;
use parking_lot::Mutex;
use serde_json::{json, Value};
use uuid::Uuid;

const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;
const MAX_BACKUPS: u32 = 3;
const MAX_BUFFERED: usize = 500;

#[derive(Debug)]
pub struct DiagnosticsLog {
    session_id: String,
    directory: PathBuf,
    file_path: PathBuf,
    mirror_path: Option<PathBuf>,
    current_bytes: AtomicU64,
    buffered: Mutex<Vec<Value>>,
    write_lock: Mutex<()>,
}

impl DiagnosticsLog {
    pub fn create(user_data: &Path) -> Self {
        let directory = user_data.join("logs");
        let _ = fs::create_dir_all(&directory);
        let file_path = directory.join("yoiniwa.jsonl");
        let current_bytes = fs::metadata(&file_path).map(|meta| meta.len()).unwrap_or(0);
        let mirror_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.dev-runtime");
        let _ = fs::create_dir_all(&mirror_dir);
        let mirror_path = Some(mirror_dir.join("yoiniwa.jsonl"));
        Self {
            session_id: Uuid::new_v4().to_string(),
            directory,
            file_path,
            mirror_path,
            current_bytes: AtomicU64::new(current_bytes),
            buffered: Mutex::new(Vec::new()),
            write_lock: Mutex::new(()),
        }
    }

    pub fn session_id(&self) -> &str { &self.session_id }
    pub fn directory(&self) -> &Path { &self.directory }
    pub fn path(&self) -> &Path { &self.file_path }
    pub fn mirror_path(&self) -> Option<&Path> { self.mirror_path.as_deref() }

    pub fn info(&self, event: &str, data: Value) { self.log("info", event, data); }
    pub fn warn(&self, event: &str, data: Value) { self.log("warn", event, data); }
    pub fn error(&self, event: &str, data: Value) { self.log("error", event, data); }

    pub fn error_with_message(&self, event: &str, message: impl AsRef<str>, data: Value) {
        let mut payload = data;
        if let Some(object) = payload.as_object_mut() {
            object.insert("message".into(), Value::String(message.as_ref().into()));
        } else {
            payload = json!({ "message": message.as_ref(), "data": payload });
        }
        self.error(event, payload);
    }

    pub fn log(&self, level: &str, event: &str, data: Value) {
        let record = json!({
            "timestamp": Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            "level": level,
            "event": event,
            "sessionId": self.session_id,
            "pid": std::process::id(),
            "data": sanitize(data, 0),
        });
        self.enqueue(record);
    }

    pub fn append_renderer_entries(&self, entries: &[Value]) {
        for entry in entries.iter().take(200) {
            let level = entry.get("level").and_then(|value| value.as_str()).unwrap_or("info");
            let level = match level { "debug" | "info" | "warn" | "error" => level, _ => "info" };
            let event = entry.get("event").and_then(|value| value.as_str()).unwrap_or("event");
            let data = entry.get("data").cloned().unwrap_or_else(|| json!({}));
            self.log(level, &format!("renderer.{event}"), data);
        }
    }

    pub fn recent_lines(&self, limit: usize) -> Vec<String> {
        let Ok(content) = fs::read_to_string(&self.file_path) else { return Vec::new(); };
        content.lines().rev().take(limit).map(str::to_string).collect::<Vec<_>>().into_iter().rev().collect()
    }

    pub fn recent_problems(&self, limit: usize) -> Vec<Value> {
        self.recent_lines(400).into_iter().filter_map(|line| {
            let value: Value = serde_json::from_str(&line).ok()?;
            let level = value.get("level")?.as_str()?;
            (level == "warn" || level == "error").then_some(value)
        }).rev().take(limit).collect::<Vec<_>>().into_iter().rev().collect()
    }

    fn enqueue(&self, record: Value) {
        let _guard = self.write_lock.lock();
        if !self.file_path.exists() && self.current_bytes.load(Ordering::Relaxed) == 0 {
            // Keep early records until first successful open after create.
        }
        let Ok(line) = serde_json::to_string(&record) else { return; };
        let line = format!("{line}\n");
        let bytes = line.len() as u64;
        if let Err(error) = self.write_line(&line, bytes) {
            let mut buffered = self.buffered.lock();
            buffered.push(record);
            if buffered.len() > MAX_BUFFERED { buffered.remove(0); }
            let _ = error;
            return;
        }
        let pending = std::mem::take(&mut *self.buffered.lock());
        for buffered in pending {
            if let Ok(buffered_line) = serde_json::to_string(&buffered) {
                let buffered_line = format!("{buffered_line}\n");
                let _ = self.write_line(&buffered_line, buffered_line.len() as u64);
            }
        }
    }

    fn write_line(&self, line: &str, bytes: u64) -> std::io::Result<()> {
        if let Some(parent) = self.file_path.parent() { fs::create_dir_all(parent)?; }
        self.rotate_if_needed(bytes)?;
        let mut file = OpenOptions::new().create(true).append(true).open(&self.file_path)?;
        file.write_all(line.as_bytes())?;
        self.current_bytes.fetch_add(bytes, Ordering::Relaxed);
        if let Some(mirror) = &self.mirror_path {
            if let Some(parent) = mirror.parent() { let _ = fs::create_dir_all(parent); }
            if let Ok(mut mirror_file) = OpenOptions::new().create(true).append(true).open(mirror) {
                let _ = mirror_file.write_all(line.as_bytes());
            }
        }
        Ok(())
    }

    fn rotate_if_needed(&self, next_bytes: u64) -> std::io::Result<()> {
        let current = self.current_bytes.load(Ordering::Relaxed);
        if current + next_bytes <= MAX_LOG_BYTES || !self.file_path.exists() { return Ok(()); }
        for index in (1..=MAX_BACKUPS).rev() {
            let source = if index == 1 { self.file_path.clone() } else { PathBuf::from(format!("{}.{}", self.file_path.display(), index - 1)) };
            let target = PathBuf::from(format!("{}.{}", self.file_path.display(), index));
            let _ = fs::remove_file(&target);
            let _ = fs::rename(&source, &target);
        }
        self.current_bytes.store(0, Ordering::Relaxed);
        Ok(())
    }
}

fn sanitize(value: Value, depth: usize) -> Value {
    if depth >= 4 { return Value::String("[truncated]".into()); }
    match value {
        Value::String(text) if text.len() > 4000 => Value::String(format!("{}…", &text[..4000])),
        Value::Array(items) => Value::Array(items.into_iter().take(100).map(|item| sanitize(item, depth + 1)).collect()),
        Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (key, entry) in map.into_iter().take(100) {
                out.insert(key, sanitize(entry, depth + 1));
            }
            Value::Object(out)
        }
        other => other,
    }
}
