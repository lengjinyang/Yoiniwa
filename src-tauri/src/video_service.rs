use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicI32, AtomicU64, Ordering},
        Arc,
    },
    time::Instant,
};

use anyhow::Result;
use parking_lot::RwLock;
use tauri::{AppHandle, Emitter};

use crate::{
    image_jobs::{ImageJobQueue, ImageJobStats},
    video_proxy::{self, VideoScrubIndex},
};

/// FFmpeg index/proxy jobs and in-memory scrub state.
/// Asset registration stays in `AssetService`; this type only schedules derived video work.
#[derive(Debug)]
pub struct VideoJobService {
    jobs: Arc<ImageJobQueue>,
    indexes: RwLock<HashMap<String, Arc<VideoScrubIndex>>>,
    decode_generations: RwLock<HashMap<String, u64>>,
    priority: AtomicI32,
    decode_active: AtomicU64,
    decode_requests: AtomicU64,
    decode_total_us: AtomicU64,
}

pub(crate) struct VideoDecodeActivity<'a> {
    service: &'a VideoJobService,
    started_at: Instant,
}

impl Drop for VideoDecodeActivity<'_> {
    fn drop(&mut self) {
        self.service.decode_active.fetch_sub(1, Ordering::Relaxed);
        self.service.decode_total_us.fetch_add(
            self.started_at.elapsed().as_micros().min(u128::from(u64::MAX)) as u64,
            Ordering::Relaxed,
        );
    }
}

impl VideoJobService {
    pub fn new() -> Self {
        Self {
            jobs: ImageJobQueue::new(1),
            indexes: RwLock::new(HashMap::new()),
            decode_generations: RwLock::new(HashMap::new()),
            priority: AtomicI32::new(100),
            decode_active: AtomicU64::new(0),
            decode_requests: AtomicU64::new(0),
            decode_total_us: AtomicU64::new(0),
        }
    }

    pub fn stats(&self) -> ImageJobStats {
        self.jobs.stats()
    }

    pub(crate) fn begin_decode(&self) -> VideoDecodeActivity<'_> {
        self.decode_active.fetch_add(1, Ordering::Relaxed);
        self.decode_requests.fetch_add(1, Ordering::Relaxed);
        VideoDecodeActivity { service: self, started_at: Instant::now() }
    }

    pub(crate) fn decode_stats(&self) -> (u64, u64, f64) {
        let requests = self.decode_requests.load(Ordering::Relaxed);
        let total_us = self.decode_total_us.load(Ordering::Relaxed);
        (
            self.decode_active.load(Ordering::Relaxed),
            requests,
            if requests == 0 { 0.0 } else { total_us as f64 / requests as f64 / 1000.0 },
        )
    }

    pub fn shutdown(&self) {
        self.jobs.cancel(|_| true);
    }

    pub fn clear_indexes(&self) {
        self.indexes.write().clear();
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
                            "vfr": index.vfr,
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
                Ok(path) => {
                    let index = video_proxy::ready_scrub_index(&cache_root, &asset_id);
                    let fps = index.as_ref().map(|value| value.fps).unwrap_or(30.0);
                    let frame_count = index.as_ref().map(|value| value.frame_count);
                    if let Some(app) = app.as_ref() {
                        let _ = app.emit("videos:proxy-ready", serde_json::json!({
                            "assetId": asset_id, "path": path, "fps": fps, "frameCount": frame_count,
                            "indexReady": true, "playbackReady": true,
                            "vfr": index.as_ref().is_some_and(|value| value.vfr),
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
                "assetId": asset_id,
                "path": path,
                "fps": fps,
                "frameCount": frame_count,
                "ready": true,
                "indexReady": true,
                "playbackReady": true,
                "vfr": index.as_ref().is_some_and(|value| value.vfr),
                "unsupportedReason": serde_json::Value::Null,
                "state": "ready",
                "queuePosition": serde_json::Value::Null,
            }));
        }
        if let Some(reason) = source_index.as_ref().and_then(|value| value.unsupported_reason.clone()) {
            return Ok(serde_json::json!({
                "assetId": asset_id,
                "path": serde_json::Value::Null,
                "fps": fps,
                "frameCount": frame_count,
                "ready": false,
                "indexReady": true,
                "playbackReady": false,
                "vfr": source_index.as_ref().is_some_and(|value| value.vfr),
                "unsupportedReason": reason,
                "state": "ready",
                "queuePosition": serde_json::Value::Null,
            }));
        }
        // Never block the invoke on ffmpeg — spawn encode and let the UI wait for videos:proxy-ready.
        // A selection-triggered background index must not hold the only FFmpeg
        // job slot when the user explicitly asks to play. The proxy task builds
        // the same index as its first stage, so canceling this work is safe.
        let index_key = format!("video-index:{asset_id}");
        self.jobs.cancel(|job| job == index_key);
        self.enqueue_proxy(cache_root, asset_id, source, app)?;
        let key = format!("video-proxy:{asset_id}");
        let status = self.jobs.job_status(&key);
        Ok(serde_json::json!({
            "assetId": asset_id,
            "path": serde_json::Value::Null,
            "fps": fps,
            "frameCount": frame_count,
            "ready": false,
            "indexReady": source_index.is_some(),
            "playbackReady": false,
            "vfr": source_index.as_ref().is_some_and(|value| value.vfr),
            "unsupportedReason": source_index.as_ref().and_then(|value| value.unsupported_reason.clone()),
            "state": if status.as_ref().is_some_and(|value| value.running) { "running" } else { "queued" },
            "queuePosition": status.and_then(|value| value.queue_position),
        }))
    }

    pub fn claim_decode_generation(&self, asset_id: &str, generation: u64) -> bool {
        let mut generations = self.decode_generations.write();
        let current = generations.entry(asset_id.to_string()).or_default();
        if generation <= *current {
            return false;
        }
        *current = generation;
        true
    }

    pub fn is_decode_stale(&self, asset_id: &str, generation: u64) -> bool {
        self.decode_generations.read().get(asset_id).copied() != Some(generation)
    }

    pub fn bump_decode_generation(&self, asset_id: &str, generation: u64) {
        let mut generations = self.decode_generations.write();
        let current = generations.entry(asset_id.to_string()).or_default();
        *current = (*current).max(generation);
    }

    pub fn cached_or_load_scrub_index(
        &self,
        cache_root: &Path,
        asset_id: &str,
    ) -> Option<Arc<VideoScrubIndex>> {
        if let Some(index) = self.indexes.read().get(asset_id).cloned() {
            return Some(index);
        }
        let index = video_proxy::ready_scrub_index(cache_root, asset_id)?;
        let index = Arc::new(index);
        self.indexes.write().insert(asset_id.to_string(), index.clone());
        Some(index)
    }
}

#[cfg(test)]
mod tests {
    use super::VideoJobService;

    #[test]
    fn decode_generations_are_strictly_monotonic_per_asset() {
        let service = VideoJobService::new();
        assert!(service.claim_decode_generation("shared", 10));
        assert!(!service.claim_decode_generation("shared", 10));
        assert!(!service.claim_decode_generation("shared", 9));
        assert!(service.claim_decode_generation("shared", 11));
        assert!(service.claim_decode_generation("other", 1));
    }

    #[test]
    fn decode_activity_tracks_process_lifetime() {
        let service = VideoJobService::new();
        {
            let _activity = service.begin_decode();
            let (active, requests, _) = service.decode_stats();
            assert_eq!(active, 1);
            assert_eq!(requests, 1);
        }
        let (active, requests, milliseconds) = service.decode_stats();
        assert_eq!(active, 0);
        assert_eq!(requests, 1);
        assert!(milliseconds >= 0.0);
    }
}
