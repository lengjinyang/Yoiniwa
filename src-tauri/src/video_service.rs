use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicI32, Ordering},
        Arc,
    },
};

use anyhow::Result;
use tauri::{AppHandle, Emitter};

use crate::{
    image_jobs::{ImageJobQueue, ImageJobStats},
    video_proxy,
};

/// FFmpeg index/proxy jobs.
/// Asset registration stays in `AssetService`; this type only schedules derived video work.
#[derive(Debug)]
pub struct VideoJobService {
    jobs: Arc<ImageJobQueue>,
    priority: AtomicI32,
}

impl VideoJobService {
    pub fn new() -> Self {
        Self {
            jobs: ImageJobQueue::new(1),
            priority: AtomicI32::new(100),
        }
    }

    pub fn stats(&self) -> ImageJobStats {
        self.jobs.stats()
    }

    pub fn shutdown(&self) {
        self.jobs.cancel(|_| true);
    }

    fn next_priority(&self) -> i32 {
        self.priority.fetch_add(1, Ordering::Relaxed)
    }

    pub fn enqueue_index(
        &self,
        cache_root: PathBuf,
        asset_id: &str,
        source: PathBuf,
        app: Option<AppHandle>,
    ) -> Result<()> {
        if video_proxy::ready_source_index(&cache_root, asset_id).is_some() {
            return Ok(());
        }
        let asset_id = asset_id.to_string();
        let priority = self.next_priority();
        let key = format!("video-index:{asset_id}");
        let receiver = self.jobs.enqueue(key, priority, move |canceled| {
            if let Some(app) = app.as_ref() {
                let _ = app.emit("videos:preparation-progress", serde_json::json!({
                    "assetId": asset_id, "stage": "indexing", "fraction": 0.02,
                }));
            }
            match video_proxy::ensure_source_frame_index(
                &cache_root, &asset_id, &source, canceled.as_ref(),
            ) {
                Ok(index) => {
                    if let Some(app) = app.as_ref() {
                        let _ = app.emit("videos:preparation-progress", serde_json::json!({
                            "assetId": asset_id,
                            "stage": "index-ready",
                            "fraction": 1.0,
                            "fps": index.fps,
                            "frameCount": index.frame_count,
                        }));
                    }
                    Ok(Vec::new())
                }
                Err(error) => {
                    if !canceled.load(std::sync::atomic::Ordering::SeqCst) {
                        if let Some(app) = app.as_ref() {
                            let _ = app.emit("videos:preparation-progress", serde_json::json!({
                                "assetId": asset_id,
                                "stage": "failed",
                                "fraction": 0.0,
                                "message": error.to_string(),
                            }));
                        }
                    }
                    Err(error.to_string())
                }
            }
        });
        drop(receiver);
        Ok(())
    }

    pub fn enqueue_proxy(
        &self,
        cache_root: PathBuf,
        asset_id: &str,
        source: PathBuf,
        app: Option<AppHandle>,
    ) -> Result<()> {
        if video_proxy::ready_proxy_path(&cache_root, asset_id).is_some() {
            return Ok(());
        }
        let asset_id = asset_id.to_string();
        let priority = self.next_priority();
        let key = format!("video-proxy:{asset_id}");
        let receiver = self.jobs.enqueue(key, priority, move |canceled| {
            let emit_progress = |stage: &str, fraction: f64| {
                if let Some(app) = app.as_ref() {
                    let _ = app.emit("videos:preparation-progress", serde_json::json!({
                        "assetId": asset_id, "stage": stage, "fraction": fraction,
                    }));
                }
            };
            let result = video_proxy::ensure_h264_proxy_with_progress(
                &cache_root, &asset_id, &source, canceled.as_ref(), &emit_progress,
            );
            match result {
                Ok(_) => {
                    let index = video_proxy::ready_scrub_index(&cache_root, &asset_id);
                    let fps = index.as_ref().map(|value| value.fps).unwrap_or(30.0);
                    let frame_count = index.as_ref().map(|value| value.frame_count);
                    if let Some(app) = app.as_ref() {
                        let _ = app.emit("videos:proxy-ready", serde_json::json!({
                            "assetId": asset_id, "fps": fps, "frameCount": frame_count,
                        }));
                    }
                    Ok(Vec::new())
                }
                Err(error) => {
                    let message = error.to_string();
                    if !canceled.load(std::sync::atomic::Ordering::SeqCst) {
                        let source_index = video_proxy::ready_source_index(&cache_root, &asset_id);
                        if let Some(app) = app.as_ref() {
                            let _ = app.emit("videos:proxy-failed", serde_json::json!({
                                "assetId": asset_id, "message": message,
                                "indexReady": source_index.is_some(),
                                "unsupportedReason": source_index.and_then(|value| value.unsupported_reason),
                            }));
                        }
                    }
                    Err(message)
                }
            }
        });
        // The completion is delivered through Tauri events; dropping this waiter avoids a blocking thread.
        drop(receiver);
        Ok(())
    }

    pub fn cancel_playback(&self, asset_id: &str) {
        let proxy_key = format!("video-proxy:{asset_id}");
        let index_key = format!("video-index:{asset_id}");
        self.jobs.cancel(|job| job == proxy_key || job == index_key);
    }

    pub fn ensure_playback(
        &self,
        cache_root: PathBuf,
        asset_id: &str,
        source: PathBuf,
        app: Option<AppHandle>,
    ) -> Result<serde_json::Value> {
        let source_index = video_proxy::ready_source_index(&cache_root, asset_id);
        let fps = source_index.as_ref().map(|value| value.fps).unwrap_or(30.0);
        let frame_count = source_index.as_ref().map(|value| value.frame_count);
        if let Some(path) = video_proxy::ready_proxy_path(&cache_root, asset_id) {
            let index = video_proxy::ready_scrub_index(&cache_root, asset_id);
            let fps = index.as_ref().map(|value| value.fps).unwrap_or(fps);
            let frame_count = index.as_ref().map(|value| value.frame_count).or(frame_count);
            video_proxy::touch_proxy(&path);
            return Ok(serde_json::json!({
                "fps": fps,
                "frameCount": frame_count,
                "ready": true,
                "unsupportedReason": serde_json::Value::Null,
            }));
        }
        if let Some(reason) = source_index.as_ref().and_then(|value| value.unsupported_reason.clone()) {
            return Ok(serde_json::json!({
                "fps": fps,
                "frameCount": frame_count,
                "ready": false,
                "unsupportedReason": reason,
            }));
        }
        // Never block the invoke on ffmpeg — spawn encode and let the UI wait for videos:proxy-ready.
        // A selection-triggered background index must not hold the only FFmpeg
        // job slot when the user explicitly asks to play. The proxy task builds
        // the same index as its first stage, so canceling this work is safe.
        let index_key = format!("video-index:{asset_id}");
        self.jobs.cancel(|job| job == index_key);
        self.enqueue_proxy(cache_root, asset_id, source, app)?;
        Ok(serde_json::json!({
            "fps": fps,
            "frameCount": frame_count,
            "ready": false,
            "unsupportedReason": source_index.as_ref().and_then(|value| value.unsupported_reason.clone()),
        }))
    }
}
