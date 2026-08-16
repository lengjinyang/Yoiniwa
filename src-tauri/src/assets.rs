use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{BufReader, Read, Write},
    path::{Path, PathBuf},
    sync::{mpsc, Arc, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{anyhow, Result};
use arboard::Clipboard;
use parking_lot::{Mutex, RwLock};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{http, AppHandle, Emitter};
use url::Url;
use uuid::Uuid;

use crate::{
    diagnostics::DiagnosticsLog,
    image_jobs::ImageJobQueue,
    image_pipeline,
    types::{AssetRecord, CacheInfo, ImagePipelinePerformanceStats, ImportedImage},
    video_meta, video_poster, video_proxy,
    video_service::VideoJobService,
};

const MAX_IMAGE_BYTES: u64 = 200 * 1024 * 1024;
const MAX_VIDEO_BYTES: u64 = 500 * 1024 * 1024;
const ASSET_CACHE_BUDGET: u64 = 2 * 1024 * 1024 * 1024;
const VIDEO_RANGE_CHUNK_BYTES: u64 = 4 * 1024 * 1024;

fn image_cache_version() -> u32 {
    #[derive(serde::Deserialize)]
    struct Format { version: u32 }
    static VERSION: OnceLock<u32> = OnceLock::new();
    *VERSION.get_or_init(|| {
        serde_json::from_str::<Format>(include_str!("../../src/shared/imageCacheFormat.json"))
            .expect("src/shared/imageCacheFormat.json")
            .version
    })
}

#[derive(Clone, Debug)]
pub struct AssetEntry {
    pub record: AssetRecord,
    pub cache_path: PathBuf,
    pub package_source: Option<PackageAssetSource>,
}

#[derive(Clone, Debug)]
pub struct PackageAssetSource {
    pub package_path: PathBuf,
    pub payload_offset: u64,
    pub byte_length: u64,
    pub sha256: String,
}

#[derive(Debug)]
pub struct AssetService {
    user_data: PathBuf,
    cache_override: RwLock<Option<PathBuf>>,
    registry: RwLock<HashMap<String, AssetEntry>>,
    canceled_prewarm: Mutex<HashSet<String>>,
    stats: Mutex<ImagePipelinePerformanceStats>,
    jobs: Arc<ImageJobQueue>,
    pub(crate) video: VideoJobService,
    pub(crate) diagnostics: Arc<DiagnosticsLog>,
    app: Mutex<Option<AppHandle>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PrewarmProgress<'a> {
    request_id: &'a str,
    completed: usize,
    total: usize,
    stage: &'a str,
    fraction: f64,
    failed: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_failed_name: Option<&'a str>,
}

impl AssetService {
    pub fn new(user_data: PathBuf, jobs: Arc<ImageJobQueue>, diagnostics: Arc<DiagnosticsLog>) -> Result<Self> {
        fs::create_dir_all(&user_data)?;
        let cache_override = read_json(&user_data.join("state.json"))
            .and_then(|value| value.get("cacheRoot").and_then(|value| value.as_str()).map(PathBuf::from))
            .filter(|path| path.is_absolute());
        let service = Self {
            user_data,
            cache_override: RwLock::new(cache_override),
            registry: RwLock::new(HashMap::new()),
            canceled_prewarm: Mutex::new(HashSet::new()),
            stats: Mutex::new(ImagePipelinePerformanceStats::default()),
            jobs,
            video: VideoJobService::new(),
            diagnostics,
            app: Mutex::new(None),
        };
        fs::create_dir_all(service.asset_cache_dir())?;
        video_proxy::cleanup_stale_proxy_temps(&service.cache_root());
        Ok(service)
    }

    pub fn bind_app(&self, app: AppHandle) { *self.app.lock() = Some(app); }

    pub fn shutdown(&self) {
        self.video.shutdown();
        self.jobs.cancel(|_| true);
        for _ in 0..20 {
            if self.video.stats().active == 0 && self.jobs.stats().active == 0 { break; }
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    pub fn cache_root(&self) -> PathBuf {
        self.cache_override.read().as_ref()
            .map(|root| root.join("RefCanvas"))
            .unwrap_or_else(|| self.user_data.clone())
    }

    pub fn asset_cache_dir(&self) -> PathBuf { self.cache_root().join("asset-cache") }
    pub fn image_cache_dir(&self) -> PathBuf { self.cache_root().join(format!("image-cache/v{}", image_cache_version())) }
    pub fn derived_cache_dir(&self) -> PathBuf { self.cache_root().join("derived-cache") }

    pub fn entry(&self, id: &str) -> Option<AssetEntry> { self.registry.read().get(id).cloned() }

    pub fn register_existing(&self, record: AssetRecord, cache_path: PathBuf) {
        self.registry.write().insert(record.id.clone(), AssetEntry { record, cache_path, package_source: None });
    }

    pub fn register_packaged(&self, record: AssetRecord, source: PackageAssetSource) {
        let cache_path = self.asset_cache_dir().join(format!("{}{}", record.hash, extension_for_mime(&record.mime_type)));
        self.registry.write().insert(record.id.clone(), AssetEntry { record, cache_path, package_source: Some(source) });
    }

    pub fn unregister_missing(&self, active_ids: &HashSet<String>) {
        self.registry.write().retain(|id, _| active_ids.contains(id));
    }

    pub fn ensure_file(&self, id: &str) -> Result<PathBuf> {
        let entry = self.entry(id).ok_or_else(|| anyhow!("资源不存在: {id}"))?;
        if fs::metadata(&entry.cache_path).map(|metadata| metadata.is_file() && metadata.len() == entry.record.byte_length).unwrap_or(false) {
            return Ok(entry.cache_path);
        }
        let source = entry.package_source.ok_or_else(|| anyhow!("资源缓存缺失: {id}"))?;
        materialize_package_asset(&source, &entry.cache_path)?;
        Ok(entry.cache_path)
    }

    pub fn register_path(&self, path: &Path, source_type: &str) -> Result<ImportedImage> {
        if !path.is_absolute() { return Err(anyhow!("媒体路径必须是绝对路径")); }
        let metadata = fs::metadata(path)?;
        let mime = media_mime(path).ok_or_else(|| anyhow!("不支持的媒体格式"))?;
        let max_bytes = if is_video_mime(mime) { MAX_VIDEO_BYTES } else { MAX_IMAGE_BYTES };
        if !metadata.is_file() || metadata.len() == 0 || metadata.len() > max_bytes {
            return Err(anyhow!(if is_video_mime(mime) { "视频文件大小无效" } else { "图片文件大小无效" }));
        }
        let name = path.file_name().and_then(|name| name.to_str()).unwrap_or(if is_video_mime(mime) { "video" } else { "image" }).to_string();
        let temporary = self.asset_cache_dir().join(format!(".import-{}.tmp", Uuid::new_v4()));
        fs::create_dir_all(self.asset_cache_dir())?;
        let mut reader = BufReader::new(File::open(path)?);
        let mut writer = File::create(&temporary)?;
        let mut hasher = Sha256::new();
        let mut buffer = vec![0_u8; 1024 * 1024];
        loop {
            let read = reader.read(&mut buffer)?;
            if read == 0 { break; }
            hasher.update(&buffer[..read]);
            writer.write_all(&buffer[..read])?;
        }
        writer.sync_all()?;
        let hash = format!("{:x}", hasher.finalize());
        let cache_path = self.asset_cache_dir().join(format!("{hash}{}", extension_for_mime(mime)));
        install_cache_file(&temporary, &cache_path, metadata.len())?;
        let record = self.build_record(hash.clone(), mime, metadata.len(), name.clone(), Some(path.to_string_lossy().into_owned()), &cache_path, metadata.modified().ok().and_then(system_time_ms))?;
        self.register_existing(record.clone(), cache_path.clone());
        self.trim_asset_cache()?;
        let imported = ImportedImage {
            name, path: Some(path.to_string_lossy().into_owned()), asset_id: hash,
            asset: record, data_url: None, source_type: Some(source_type.to_string()), poster: None,
        };
        // Video posters and compatibility proxies are derived lazily from viewport/playback demand.
        Ok(imported)
    }

    pub fn register_bytes(&self, name: String, data: &[u8], source_path: Option<String>, source_type: &str) -> Result<ImportedImage> {
        let mime = media_mime(Path::new(&name)).ok_or_else(|| anyhow!("不支持的媒体格式"))?;
        let max_bytes = if is_video_mime(mime) { MAX_VIDEO_BYTES } else { MAX_IMAGE_BYTES };
        if data.is_empty() || data.len() as u64 > max_bytes {
            return Err(anyhow!(if is_video_mime(mime) { "视频数据大小无效" } else { "图片数据大小无效" }));
        }
        let hash = format!("{:x}", Sha256::digest(data));
        fs::create_dir_all(self.asset_cache_dir())?;
        let cache_path = self.asset_cache_dir().join(format!("{hash}{}", extension_for_mime(mime)));
        if fs::metadata(&cache_path).map(|metadata| metadata.len()).unwrap_or(0) != data.len() as u64 {
            atomic_write(&cache_path, data)?;
        }
        let record = self.build_record(hash.clone(), mime, data.len() as u64, name.clone(), source_path.clone(), &cache_path, Some(now_ms()))?;
        self.register_existing(record.clone(), cache_path);
        self.trim_asset_cache()?;
        let imported = ImportedImage {
            name, path: source_path, asset_id: hash.clone(), asset: record, data_url: None,
            source_type: Some(source_type.to_string()), poster: None,
        };
        // Never fan out poster extraction or ffmpeg work during a large batch import.
        Ok(imported)
    }

    pub(crate) fn enqueue_video_index(&self, asset_id: &str) -> Result<()> {
        if video_proxy::ready_source_index(&self.cache_root(), asset_id).is_some() { return Ok(()); }
        let source = self.ensure_file(asset_id)?;
        self.video.enqueue_index(self.cache_root(), asset_id, source, self.app.lock().clone())
    }

    pub(crate) fn video_frame_index(&self, asset_id: &str) -> Result<serde_json::Value> {
        if asset_id.len() != 64 || !asset_id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(anyhow!("资源标识无效"));
        }
        let cache_root = self.cache_root();
        let Some(index) = video_proxy::ready_source_index(&cache_root, asset_id)
            .or_else(|| video_proxy::ready_scrub_index(&cache_root, asset_id))
        else {
            return Ok(serde_json::Value::Null);
        };
        let frames = index.frames.iter().map(|frame| {
            serde_json::json!([frame.pts_us, frame.duration_us])
        }).collect::<Vec<_>>();
        Ok(serde_json::json!({
            "assetId": index.asset_id,
            "fps": index.fps,
            "frameCount": index.frame_count,
            "durationUs": index.duration_us,
            "vfr": index.vfr,
            "frames": frames,
        }))
    }

    pub(crate) fn enqueue_video_proxy(&self, asset_id: &str) -> Result<()> {
        if video_proxy::ready_proxy_path(&self.cache_root(), asset_id).is_some() { return Ok(()); }
        let source = self.ensure_file(asset_id)?;
        self.video.enqueue_proxy(self.cache_root(), asset_id, source, self.app.lock().clone())
    }

    pub fn cancel_video_playback(&self, asset_id: &str) {
        self.video.cancel_playback(asset_id);
    }

    pub fn ensure_video_playback(&self, asset_id: &str) -> Result<serde_json::Value> {
        if asset_id.len() != 64 || !asset_id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(anyhow!("资源标识无效"));
        }
        let source = self.ensure_file(asset_id)?;
        self.video.ensure_playback(self.cache_root(), asset_id, source, self.app.lock().clone())
    }

    #[allow(clippy::too_many_arguments)]
    fn build_record(
        &self,
        hash: String,
        mime: &str,
        byte_length: u64,
        name: String,
        source_path: Option<String>,
        cache_path: &Path,
        source_mtime_ms: Option<f64>,
    ) -> Result<AssetRecord> {
        if is_video_mime(mime) {
            // Import stays copy/hash/container-metadata only. WebView metadata probing is
            // bounded on the frontend; ffmpeg/ffprobe is reserved for an actual play request.
            let meta = video_meta::read_video_metadata(cache_path).unwrap_or_default();
            return Ok(AssetRecord {
                id: hash.clone(), asset_id: Some(hash.clone()), hash: hash.clone(), mime_type: mime.to_string(),
                byte_length, source_size: Some(byte_length), source_mtime_ms,
                natural_width: meta.width.max(1), natural_height: meta.height.max(1), orientation: Some(1),
                has_alpha: Some(false), content_hash: Some(hash), cache_version: Some(image_cache_version()),
                original_name: name, source_path, kind: Some("video".into()), duration_sec: meta.duration_sec,
            });
        }
        let image = image_pipeline::metadata(cache_path, &self.stats)?;
        Ok(AssetRecord {
            id: hash.clone(), asset_id: Some(hash.clone()), hash: hash.clone(), mime_type: mime.to_string(),
            byte_length, source_size: Some(byte_length), source_mtime_ms,
            natural_width: image.width, natural_height: image.height, orientation: Some(image.orientation),
            has_alpha: Some(image.has_alpha), content_hash: Some(hash), cache_version: Some(image_cache_version()),
            original_name: name, source_path, kind: Some("image".into()), duration_sec: None,
        })
    }

    pub fn register_url(&self, raw_url: &str) -> Result<ImportedImage> {
        let url = Url::parse(raw_url)?;
        if !matches!(url.scheme(), "http" | "https") { return Err(anyhow!("只支持 HTTP 或 HTTPS 媒体地址")); }
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(15)).redirect(reqwest::redirect::Policy::limited(6)).build()?;
        let response = client.get(url.clone()).send()?;
        if !response.status().is_success() { return Err(anyhow!("媒体下载失败: HTTP {}", response.status())); }
        if response.content_length().unwrap_or(0) > MAX_VIDEO_BYTES { return Err(anyhow!("网络媒体超过大小限制")); }
        let content_type = response.headers().get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok()).unwrap_or("").split(';').next().unwrap_or("").to_string();
        let bytes = response.bytes()?;
        if bytes.len() as u64 > MAX_VIDEO_BYTES { return Err(anyhow!("网络媒体超过大小限制")); }
        let mut name = url.path_segments().and_then(|mut segments| segments.next_back()).filter(|value| !value.is_empty())
            .unwrap_or("network-media").to_string();
        if media_mime(Path::new(&name)).is_none() {
            name.push_str(extension_for_mime(&content_type));
        }
        self.register_bytes(name, &bytes, Some(raw_url.to_string()), "drop")
    }

    pub fn register_clipboard(&self) -> Result<Vec<ImportedImage>> {
        let mut clipboard = Clipboard::new().map_err(|error| anyhow!("无法打开剪贴板: {error}"))?;
        let image = match clipboard.get_image() { Ok(image) => image, Err(_) => return Ok(Vec::new()) };
        let mut encoded = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut encoded, image.width as u32, image.height as u32);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header()?;
            writer.write_image_data(image.bytes.as_ref())?;
        }
        Ok(vec![self.register_bytes(format!("clipboard-{}.png", now_ms() as u64), &encoded, None, "clipboard")?])
    }

    pub fn sample_pixel(&self, id: &str, x: u32, y: u32) -> Result<[u8; 4]> {
        image_pipeline::sample_pixel(&self.ensure_file(id)?, x, y)
    }

    pub fn performance_stats(&self) -> ImagePipelinePerformanceStats {
        let mut stats = self.stats.lock().clone();
        let jobs = self.jobs.stats();
        stats.jobs_active = jobs.active as u64;
        stats.jobs_pending = jobs.pending as u64;
        stats.jobs_inflight = jobs.inflight as u64;
        stats.jobs_concurrency = jobs.concurrency as u64;
        stats.jobs_completed = self.jobs.completed();
        let video_jobs = self.video.stats();
        stats.proxy_active = video_jobs.active as u64;
        stats.proxy_queued = video_jobs.pending as u64;
        stats
    }

    pub fn cancel_prewarm(&self, request_id: &str) {
        self.canceled_prewarm.lock().insert(request_id.to_string());
        // Drop speculative thumbnail work when import prewarm is canceled.
        let _ = self.jobs.cancel(|key| key.starts_with("thumbnail:"));
    }

    pub fn prewarm(&self, app: &AppHandle, ids: &[String], request_id: &str) -> Result<serde_json::Value> {
        self.canceled_prewarm.lock().remove(request_id);
        let mut completed = 0;
        let mut failed = 0;
        let total = ids.len();
        for id in ids {
            if self.canceled_prewarm.lock().contains(request_id) { break; }
            let is_video = self.entry(id).is_some_and(|entry| is_video_asset(&entry.record));
            let result = if is_video {
                self.ensure_file(id).map(|_| Vec::new())
            } else {
                self.ensure_thumbnail(id, 128, 20)
            };
            if result.is_err() { failed += 1; }
            completed += 1;
            let failed_name = result.err().map(|error| error.to_string());
            let _ = app.emit("images:prewarm-progress", PrewarmProgress {
                request_id, completed, total, stage: "preview",
                fraction: if total == 0 { 1.0 } else { completed as f64 / total as f64 },
                failed, last_failed_name: failed_name.as_deref(),
            });
        }
        let canceled = self.canceled_prewarm.lock().remove(request_id);
        Ok(serde_json::json!({ "canceled": canceled, "completed": completed, "total": total, "failed": failed, "detailFailed": 0 }))
    }

    pub fn boost_resource(&self, key: &str, priority: i32) -> usize {
        let priority = priority.max(0);
        if let Ok(url) = Url::parse(key).or_else(|_| Url::parse(&format!("http://refcanvas-asset.localhost{key}"))) {
            let id = url.path().trim_start_matches('/').strip_prefix("asset/").unwrap_or(url.path().trim_start_matches('/'));
            if id.len() == 64 && id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                let variant = url.query_pairs().find(|(name, _)| name == "variant").map(|(_, value)| value.into_owned()).unwrap_or_else(|| "original".into());
                if variant == "mip" {
                    if let Ok(edge) = query_u32(&url, "edge") {
                        if matches!(edge, 128 | 256 | 512 | 1024) {
                            let _ = self.enqueue_thumbnail(id, edge, priority);
                            return self.jobs.boost(|job| job == format!("thumbnail:{id}:{edge}"), priority);
                        }
                        let _ = self.enqueue_mip(id, edge, priority);
                        return self.jobs.boost(|job| job == format!("mip:{id}:{edge}"), priority);
                    }
                } else if variant == "tile" {
                    if let (Ok(level), Ok(column), Ok(row)) = (query_u32(&url, "level"), query_u32(&url, "column"), query_u32(&url, "row")) {
                        if level > 0 {
                            let _ = self.enqueue_level(id, level, priority);
                        }
                        if let Ok(level_path) = self.pyramid_level_path_if_ready(id, level) {
                            let _ = self.enqueue_tile(id, level, column, row, priority, level_path);
                        }
                        return self.jobs.boost(|job| {
                            job == format!("tile:{id}:{level}:{column}:{row}") || job == format!("level:{id}:{level}")
                        }, priority);
                    }
                } else if let Some(edge) = variant.strip_prefix("thumb").and_then(|value| value.parse::<u32>().ok()) {
                    let _ = self.enqueue_thumbnail(id, edge, priority);
                    return self.jobs.boost(|job| job == format!("thumbnail:{id}:{edge}"), priority);
                }
            }
        }
        self.jobs.boost(|job| job.contains(key), priority)
    }

    fn image_asset_root(&self, id: &str) -> PathBuf { self.image_cache_dir().join("assets").join(id) }

    pub(crate) fn wait_job(&self, receiver: mpsc::Receiver<Result<Vec<u8>, String>>) -> Result<Vec<u8>, String> {
        receiver.recv_timeout(Duration::from_secs(120)).map_err(|_| "等待图像生成超时".to_string())?
    }

    pub(crate) fn read_thumbnail(&self, id: &str, edge: u32) -> Option<Vec<u8>> {
        let path = self.image_asset_root(id).join(format!("thumb-{edge}.png"));
        fs::read(path).ok().filter(|bytes| is_png(bytes))
    }

    fn video_poster_path(&self, id: &str, edge: u32) -> PathBuf {
        self.derived_cache_dir().join("video-poster").join(id).join(format!("poster-{edge}.png"))
    }

    pub(crate) fn read_video_poster(&self, id: &str, edge: u32) -> Option<Vec<u8>> {
        fs::read(self.video_poster_path(id, edge)).ok().filter(|bytes| is_png(bytes))
    }

    pub(crate) fn enqueue_video_poster(&self, id: &str, edge: u32, priority: i32) -> mpsc::Receiver<Result<Vec<u8>, String>> {
        let edge = edge.clamp(128, 2048);
        if let Some(bytes) = self.read_video_poster(id, edge) {
            return immediate_result(Ok(bytes));
        }
        let entry = match self.entry(id) {
            Some(entry) if is_video_asset(&entry.record) => entry,
            _ => return immediate_result(Err(format!("视频资源不存在: {id}"))),
        };
        let source = match self.ensure_file(id) {
            Ok(path) => path,
            Err(error) => return immediate_result(Err(error.to_string())),
        };
        let output = self.video_poster_path(id, edge);
        let asset_id = id.to_string();
        let width = entry.record.natural_width.max(1);
        let height = entry.record.natural_height.max(1);
        let app = self.app.lock().clone();
        self.jobs.enqueue(format!("video-poster:{id}:{edge}"), priority, move |canceled| {
            if canceled.load(std::sync::atomic::Ordering::SeqCst) {
                return Err("视频海报任务已取消".into());
            }
            if let Some(bytes) = fs::read(&output).ok().filter(|bytes| is_png(bytes)) {
                return Ok(bytes);
            }
            let bytes = video_poster::video_poster_png(&source, edge, width, height).map_err(|error| error.to_string())?;
            atomic_write(&output, &bytes).map_err(|error| error.to_string())?;
            emit_derivative_ready_app(app.as_ref(), &asset_id, "video-poster", Some(edge), None, None, None);
            Ok(bytes)
        })
    }

    pub(crate) fn read_mip(&self, id: &str, edge: u32) -> Option<Vec<u8>> {
        let path = self.image_asset_root(id).join(format!("level-{edge}.webp"));
        fs::read(path).ok().filter(|bytes| is_webp(bytes))
    }

    pub(crate) fn read_tile(&self, id: &str, level: u32, column: u32, row: u32) -> Option<Vec<u8>> {
        let path = self.image_asset_root(id).join(format!("tiles/{level}/{column}-{row}.webp"));
        fs::read(path).ok().filter(|bytes| is_webp(bytes))
    }

    fn ensure_thumbnail(&self, id: &str, edge: u32, _priority: i32) -> Result<Vec<u8>> {
        self.generate_thumbnail_now(id, edge)
    }

    fn generate_thumbnail_now(&self, id: &str, edge: u32) -> Result<Vec<u8>> {
        if let Some(bytes) = self.read_thumbnail(id, edge) { return Ok(bytes); }
        let source = self.ensure_file(id)?;
        let path = self.image_asset_root(id).join(format!("thumb-{edge}.png"));
        let bytes = match image_pipeline::thumbnail_png(&source, edge, &self.stats) {
            Ok(bytes) => bytes,
            Err(_) => {
                self.stats.lock().thumbnail_failures += 1;
                image_pipeline::emergency_thumbnail_png(&source, edge).inspect_err(|_| {
                    self.stats.lock().thumbnail_failures += 1;
                })?
            }
        };
        atomic_write(&path, &bytes)?;
        self.emit_thumbnail_ready(id, edge);
        Ok(bytes)
    }

    fn emit_thumbnail_ready(&self, id: &str, edge: u32) {
        emit_thumbnail_ready_app(self.app.lock().as_ref(), id, edge);
    }

    /// Electron: never wait for a level job while holding a tile queue slot.
    pub(crate) fn serve_tile(&self, id: &str, level: u32, column: u32, row: u32, priority: i32) -> Result<Vec<u8>, String> {
        if let Some(bytes) = self.read_tile(id, level, column, row) {
            return Ok(bytes);
        }
        let level_path = self.ensure_pyramid_level(id, level, priority)?;
        self.wait_job(self.enqueue_tile(id, level, column, row, priority, level_path))
    }

    fn ensure_pyramid_level(&self, id: &str, level: u32, priority: i32) -> Result<PathBuf, String> {
        // Level 0 crops from the original asset — never re-encode a full-res WebP.
        if level == 0 {
            return self.ensure_file(id).map_err(|error| error.to_string());
        }
        let level_path = self.image_asset_root(id).join(format!("levels/{level}.webp"));
        if fs::read(&level_path).ok().filter(|bytes| is_webp(bytes)).is_some() {
            return Ok(level_path);
        }
        let _ = self.wait_job(self.enqueue_level(id, level, priority))?;
        Ok(level_path)
    }

    fn pyramid_level_path_if_ready(&self, id: &str, level: u32) -> Result<PathBuf, String> {
        if level == 0 {
            return self.ensure_file(id).map_err(|error| error.to_string());
        }
        let level_path = self.image_asset_root(id).join(format!("levels/{level}.webp"));
        if fs::read(&level_path).ok().filter(|bytes| is_webp(bytes)).is_some() {
            Ok(level_path)
        } else {
            Err("pyramid level not ready".into())
        }
    }

    pub(crate) fn enqueue_thumbnail(&self, id: &str, edge: u32, priority: i32) -> mpsc::Receiver<Result<Vec<u8>, String>> {
        if let Some(bytes) = self.read_thumbnail(id, edge) {
            return immediate_result(Ok(bytes));
        }
        let source = match self.ensure_file(id) {
            Ok(path) => path,
            Err(error) => return immediate_result(Err(error.to_string())),
        };
        let out = self.image_asset_root(id).join(format!("thumb-{edge}.png"));
        let asset_id = id.to_string();
        let app = self.app.lock().clone();
        let stats = Arc::new(Mutex::new(ImagePipelinePerformanceStats::default()));
        self.jobs.enqueue(format!("thumbnail:{id}:{edge}"), priority, move |canceled| {
            if canceled.load(std::sync::atomic::Ordering::SeqCst) {
                return Err("图像任务已取消".into());
            }
            if let Some(bytes) = fs::read(&out).ok().filter(|bytes| is_png(bytes)) {
                emit_thumbnail_ready_app(app.as_ref(), &asset_id, edge);
                return Ok(bytes);
            }
            let bytes = match image_pipeline::thumbnail_png(&source, edge, &stats) {
                Ok(bytes) => bytes,
                Err(error) => {
                    stats.lock().thumbnail_failures += 1;
                    image_pipeline::emergency_thumbnail_png(&source, edge).map_err(|fallback| {
                        format!("thumbnail failed: {error}; emergency: {fallback}")
                    })?
                }
            };
            atomic_write(&out, &bytes).map_err(|error| error.to_string())?;
            emit_thumbnail_ready_app(app.as_ref(), &asset_id, edge);
            Ok(bytes)
        })
    }

    pub(crate) fn enqueue_mip(&self, id: &str, edge: u32, priority: i32) -> mpsc::Receiver<Result<Vec<u8>, String>> {
        if let Some(bytes) = self.read_mip(id, edge) {
            return immediate_result(Ok(bytes));
        }
        let source = match self.ensure_file(id) {
            Ok(path) => path,
            Err(error) => return immediate_result(Err(error.to_string())),
        };
        let out = self.image_asset_root(id).join(format!("level-{edge}.webp"));
        let asset_id = id.to_string();
        let app = self.app.lock().clone();
        self.jobs.enqueue(format!("mip:{id}:{edge}"), priority, move |canceled| {
            if canceled.load(std::sync::atomic::Ordering::SeqCst) {
                return Err("图像任务已取消".into());
            }
            if let Some(bytes) = fs::read(&out).ok().filter(|bytes| is_webp(bytes)) {
                emit_derivative_ready_app(app.as_ref(), &asset_id, "mip", Some(edge), None, None, None);
                return Ok(bytes);
            }
            let bytes = image_pipeline::mip_webp(&source, edge).map_err(|error| error.to_string())?;
            atomic_write(&out, &bytes).map_err(|error| error.to_string())?;
            emit_derivative_ready_app(app.as_ref(), &asset_id, "mip", Some(edge), None, None, None);
            Ok(bytes)
        })
    }

    fn enqueue_level(&self, id: &str, level: u32, priority: i32) -> mpsc::Receiver<Result<Vec<u8>, String>> {
        if level == 0 {
            return match self.ensure_file(id) {
                Ok(_) => immediate_result(Ok(Vec::new())),
                Err(error) => immediate_result(Err(error.to_string())),
            };
        }
        let level_path = self.image_asset_root(id).join(format!("levels/{level}.webp"));
        if let Some(bytes) = fs::read(&level_path).ok().filter(|bytes| is_webp(bytes)) {
            return immediate_result(Ok(bytes));
        }
        let entry = match self.entry(id) {
            Some(entry) => entry,
            None => return immediate_result(Err(format!("资源不存在: {id}"))),
        };
        let source = match self.ensure_file(id) {
            Ok(path) => path,
            Err(error) => return immediate_result(Err(error.to_string())),
        };
        let natural_width = entry.record.natural_width;
        let natural_height = entry.record.natural_height;
        self.jobs.enqueue(format!("level:{id}:{level}"), priority, move |canceled| {
            if canceled.load(std::sync::atomic::Ordering::SeqCst) {
                return Err("图像任务已取消".into());
            }
            if let Some(bytes) = fs::read(&level_path).ok().filter(|bytes| is_webp(bytes)) {
                return Ok(bytes);
            }
            let denominator = 2_u32.checked_pow(level).unwrap_or(u32::MAX).max(1);
            let width = natural_width.div_ceil(denominator).max(1);
            let height = natural_height.div_ceil(denominator).max(1);
            let bytes = image_pipeline::level_webp(&source, width, height).map_err(|error| error.to_string())?;
            atomic_write(&level_path, &bytes).map_err(|error| error.to_string())?;
            Ok(bytes)
        })
    }

    fn enqueue_tile(
        &self, id: &str, level: u32, column: u32, row: u32, priority: i32, level_path: PathBuf,
    ) -> mpsc::Receiver<Result<Vec<u8>, String>> {
        if let Some(bytes) = self.read_tile(id, level, column, row) {
            return immediate_result(Ok(bytes));
        }
        let entry = match self.entry(id) {
            Some(entry) => entry,
            None => return immediate_result(Err(format!("资源不存在: {id}"))),
        };
        let out = self.image_asset_root(id).join(format!("tiles/{level}/{column}-{row}.webp"));
        let natural_width = entry.record.natural_width;
        let natural_height = entry.record.natural_height;
        let asset_id = id.to_string();
        let app = self.app.lock().clone();
        // Crop-only: level bytes must already exist (or be the original for level 0).
        self.jobs.enqueue(format!("tile:{id}:{level}:{column}:{row}"), priority, move |canceled| {
            if canceled.load(std::sync::atomic::Ordering::SeqCst) {
                return Err("图像任务已取消".into());
            }
            if let Some(bytes) = fs::read(&out).ok().filter(|bytes| is_webp(bytes)) {
                emit_derivative_ready_app(app.as_ref(), &asset_id, "tile", None, Some(level), Some(column), Some(row));
                return Ok(bytes);
            }
            let bytes = image_pipeline::tile_from_level(
                &level_path, natural_width, natural_height, level, column, row, 512, 1,
            ).map_err(|error| error.to_string())?;
            atomic_write(&out, &bytes).map_err(|error| error.to_string())?;
            emit_derivative_ready_app(app.as_ref(), &asset_id, "tile", None, Some(level), Some(column), Some(row));
            Ok(bytes)
        })
    }

    pub(crate) fn original_response(&self, request: &http::Request<Vec<u8>>, entry: &AssetEntry) -> Result<http::Response<Vec<u8>>> {
        let cache_available = fs::metadata(&entry.cache_path)
            .map(|metadata| metadata.is_file() && metadata.len() == entry.record.byte_length).unwrap_or(false);
        let (source_path, source_offset, length) = if cache_available {
            (entry.cache_path.clone(), 0, entry.record.byte_length)
        } else if let Some(source) = &entry.package_source {
            (source.package_path.clone(), source.payload_offset, source.byte_length)
        } else {
            return Err(anyhow!("资源缓存缺失: {}", entry.record.id));
        };
        self.ranged_file_response(request, &source_path, source_offset, length, &entry.record.mime_type, &entry.record.hash)
    }

    /// Serve the WebView-safe H.264 proxy when ready (Range-capable custom protocol).
    pub(crate) fn playback_response(&self, request: &http::Request<Vec<u8>>, entry: &AssetEntry) -> Result<http::Response<Vec<u8>>> {
        if !is_video_asset(&entry.record) {
            return Ok(response(http::StatusCode::BAD_REQUEST, "text/plain", b"Not a video".to_vec()));
        }
        if let Some(proxy) = video_proxy::ready_proxy_path(&self.cache_root(), &entry.record.id) {
            video_proxy::touch_proxy(&proxy);
            let length = fs::metadata(&proxy)?.len();
            return self.ranged_file_response(request, &proxy, 0, length, "video/mp4", &entry.record.hash);
        }
        self.enqueue_video_proxy(&entry.record.id)?;
        let mut result = response(http::StatusCode::NOT_FOUND, "text/plain", b"Generating playback proxy".to_vec());
        result.headers_mut().insert(http::header::CACHE_CONTROL, "no-store".parse()?);
        Ok(result)
    }

    fn ranged_file_response(
        &self,
        request: &http::Request<Vec<u8>>,
        source_path: &Path,
        source_offset: u64,
        length: u64,
        mime: &str,
        etag: &str,
    ) -> Result<http::Response<Vec<u8>>> {
        let mut file = File::open(source_path)?;
        let range = request.headers().get(http::header::RANGE).and_then(|value| value.to_str().ok());
        let (mut status, start, mut end) = match range {
            Some(value) => match parse_range(value, length) {
                Ok(range) => (http::StatusCode::PARTIAL_CONTENT, range.0, range.1),
                Err(_) => {
                    let mut result = response(http::StatusCode::RANGE_NOT_SATISFIABLE, mime, Vec::new());
                    result.headers_mut().insert(http::header::CONTENT_RANGE, format!("bytes */{length}").parse()?);
                    result.headers_mut().insert(http::header::ACCEPT_RANGES, "bytes".parse()?);
                    result.headers_mut().insert(http::header::CONTENT_LENGTH, "0".parse()?);
                    immutable_headers(result.headers_mut(), etag);
                    return Ok(result);
                }
            },
            None => (http::StatusCode::OK, 0, length.saturating_sub(1)),
        };
        let is_head = request.method() == http::Method::HEAD;
        (status, end) = bounded_media_range(status, start, end, mime, range.is_some(), is_head, length);
        let body_length = if length == 0 { 0 } else { end - start + 1 };
        let mut body = Vec::new();
        if request.method() != http::Method::HEAD && body_length > 0 {
            use std::io::{Seek, SeekFrom};
            file.seek(SeekFrom::Start(source_offset + start))?;
            body.resize(body_length as usize, 0);
            file.read_exact(&mut body)?;
        }
        let mut result = response(status, mime, body);
        let headers = result.headers_mut();
        headers.insert(http::header::CONTENT_LENGTH, body_length.to_string().parse()?);
        headers.insert(http::header::ACCEPT_RANGES, "bytes".parse()?);
        if status == http::StatusCode::PARTIAL_CONTENT {
            headers.insert(http::header::CONTENT_RANGE, format!("bytes {start}-{end}/{length}").parse()?);
        }
        immutable_headers(headers, etag);
        Ok(result)
    }

    pub fn cache_info(&self) -> Result<CacheInfo> {
        let root = self.cache_root();
        let asset_bytes = directory_size(&self.asset_cache_dir())?;
        let derived_bytes = directory_size(&self.derived_cache_dir())? + directory_size(&self.image_cache_dir())?;
        let warning = self.cache_override.read().as_ref().and_then(|path| {
            let value = path.to_string_lossy().to_ascii_lowercase();
            (value.contains("onedrive") || value.contains("dropbox") || value.contains("google drive") || value.starts_with("\\\\"))
                .then(|| "此位置可能是同步或网络目录，缓存性能可能不稳定。".to_string())
        });
        Ok(CacheInfo { root: root.to_string_lossy().into_owned(), is_default: self.cache_override.read().is_none(), asset_bytes, derived_bytes, warning })
    }

    pub fn set_cache_location(&self, parent: Option<PathBuf>) -> Result<CacheInfo> {
        if let Some(path) = &parent {
            if !path.is_absolute() { return Err(anyhow!("缓存位置无效")); }
            fs::create_dir_all(path)?;
        }
        let previous_override = self.cache_override.read().clone();
        let source = previous_override.as_ref().map(|path| path.join("RefCanvas")).unwrap_or_else(|| self.user_data.clone());
        let target = parent.as_ref().map(|path| path.join("RefCanvas")).unwrap_or_else(|| self.user_data.clone());
        if source != target {
            // No producer may retain or write an old cache path while the
            // directories and registry are being migrated.
            self.shutdown();
            if !cache_jobs_idle(self.jobs.stats().active, self.video.stats().active) {
                return Err(anyhow!("缓存任务未能及时停止，请稍后重试"));
            }
            fs::create_dir_all(&target)?;
            copy_directory_if_exists(&source.join("asset-cache"), &target.join("asset-cache"))?;
            copy_directory_if_exists(&source.join("derived-cache"), &target.join("derived-cache"))?;
            copy_directory_if_exists(&source.join("image-cache"), &target.join("image-cache"))?;
            *self.cache_override.write() = parent.clone();
            self.persist_cache_override(parent.as_deref())?;
            for entry in self.registry.write().values_mut() {
                entry.cache_path = target.join("asset-cache").join(entry.cache_path.file_name().unwrap_or_default());
            }
            if previous_override.as_ref().is_some_and(|root| source == root.join("RefCanvas")) {
                let _ = fs::remove_dir_all(source);
            }
        }
        self.cache_info()
    }

    pub fn clear_regenerable_cache(&self) -> Result<CacheInfo> {
        self.shutdown();
        let _ = fs::remove_dir_all(self.derived_cache_dir());
        let _ = fs::remove_dir_all(self.image_cache_dir());
        self.cache_info()
    }

    fn persist_cache_override(&self, value: Option<&Path>) -> Result<()> {
        let state_path = self.user_data.join("state.json");
        let mut state = read_json(&state_path).unwrap_or_else(|| serde_json::json!({}));
        let object = state.as_object_mut().ok_or_else(|| anyhow!("state.json 格式无效"))?;
        if let Some(path) = value { object.insert("cacheRoot".into(), serde_json::Value::String(path.to_string_lossy().into_owned())); }
        else { object.remove("cacheRoot"); }
        atomic_write(&state_path, serde_json::to_vec_pretty(&state)?.as_slice())
    }

    fn trim_asset_cache(&self) -> Result<()> {
        let active: HashSet<PathBuf> = self.registry.read().values().map(|entry| entry.cache_path.clone()).collect();
        let mut files = Vec::new();
        for entry in fs::read_dir(self.asset_cache_dir())? {
            let entry = entry?;
            let metadata = entry.metadata()?;
            if metadata.is_file() {
                files.push((entry.path(), metadata.len(), metadata.accessed().or_else(|_| metadata.modified()).unwrap_or(UNIX_EPOCH)));
            }
        }
        let mut bytes: u64 = files.iter().map(|(_, size, _)| size).sum();
        files.sort_by_key(|(_, _, used)| *used);
        for (path, size, _) in files {
            if bytes <= ASSET_CACHE_BUDGET { break; }
            if active.contains(&path) { continue; }
            if fs::remove_file(path).is_ok() { bytes = bytes.saturating_sub(size); }
        }
        Ok(())
    }
}

pub(crate) fn ok_asset_bytes(id: &str, mime: &str, bytes: Vec<u8>) -> Result<http::Response<Vec<u8>>> {
    let mut result = response(http::StatusCode::OK, mime, bytes);
    immutable_headers(result.headers_mut(), id);
    Ok(result)
}

fn immediate_result(result: Result<Vec<u8>, String>) -> mpsc::Receiver<Result<Vec<u8>, String>> {
    let (sender, receiver) = mpsc::channel();
    let _ = sender.send(result);
    receiver
}

pub(crate) fn response(status: http::StatusCode, mime: &str, body: Vec<u8>) -> http::Response<Vec<u8>> {
    http::Response::builder().status(status)
        .header(http::header::CONTENT_TYPE, mime)
        .header(http::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(body).unwrap_or_else(|_| http::Response::new(Vec::new()))
}

fn immutable_headers(headers: &mut http::HeaderMap, etag: &str) {
    headers.insert(http::header::CACHE_CONTROL, "public, max-age=31536000, immutable".parse().unwrap());
    headers.insert(http::header::ETAG, format!("\"{etag}\"").parse().unwrap());
}

fn parse_range(value: &str, length: u64) -> Result<(u64, u64)> {
    let raw = value.strip_prefix("bytes=").ok_or_else(|| anyhow!("Range 单位无效"))?;
    if raw.contains(',') || length == 0 { return Err(anyhow!("不支持多区间 Range")); }
    let (start, end) = raw.split_once('-').ok_or_else(|| anyhow!("Range 格式无效"))?;
    if start.is_empty() {
        let suffix = end.parse::<u64>()?;
        if suffix == 0 { return Err(anyhow!("Range 后缀无效")); }
        return Ok((length.saturating_sub(suffix.min(length)), length - 1));
    }
    let start = start.parse::<u64>()?;
    if start >= length { return Err(anyhow!("Range 超出范围")); }
    let end = if end.is_empty() { length - 1 } else { end.parse::<u64>()?.min(length - 1) };
    if end < start { return Err(anyhow!("Range 顺序无效")); }
    Ok((start, end))
}

fn bounded_media_range(
    mut status: http::StatusCode,
    start: u64,
    end: u64,
    mime: &str,
    requested_range: bool,
    is_head: bool,
    length: u64,
) -> (http::StatusCode, u64) {
    if !is_video_mime(mime) || length == 0 || (is_head && !requested_range) { return (status, end); }
    let capped_end = start.saturating_add(VIDEO_RANGE_CHUNK_BYTES - 1).min(end);
    if capped_end < end || requested_range { status = http::StatusCode::PARTIAL_CONTENT; }
    (status, capped_end)
}

pub(crate) fn query_u32(url: &Url, key: &str) -> Result<u32> {
    url.query_pairs().find(|(name, _)| name == key).ok_or_else(|| anyhow!("缺少参数 {key}"))?.1.parse().map_err(Into::into)
}

fn media_mime(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_string_lossy().to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        "gif" => Some("image/gif"),
        "mp4" | "m4v" => Some("video/mp4"),
        "webm" => Some("video/webm"),
        "mov" => Some("video/quicktime"),
        _ => None,
    }
}

fn is_video_mime(mime: &str) -> bool {
    mime.starts_with("video/")
}

pub(crate) fn is_video_asset(record: &AssetRecord) -> bool {
    record.kind.as_deref() == Some("video") || is_video_mime(&record.mime_type)
}

fn extension_for_mime(mime: &str) -> &'static str {
    match mime {
        "image/png" => ".png",
        "image/jpeg" => ".jpg",
        "image/webp" => ".webp",
        "image/bmp" => ".bmp",
        "image/gif" => ".gif",
        "video/mp4" => ".mp4",
        "video/webm" => ".webm",
        "video/quicktime" => ".mov",
        _ => ".bin",
    }
}

fn install_cache_file(temporary: &Path, target: &Path, expected: u64) -> Result<()> {
    if fs::metadata(target).map(|metadata| metadata.len()).unwrap_or(0) == expected {
        fs::remove_file(temporary)?;
        return Ok(());
    }
    if target.exists() { fs::remove_file(target)?; }
    fs::rename(temporary, target)?;
    Ok(())
}

fn materialize_package_asset(source: &PackageAssetSource, target: &Path) -> Result<()> {
    use std::io::{Seek, SeekFrom};
    if let Some(parent) = target.parent() { fs::create_dir_all(parent)?; }
    let temporary = target.with_extension(format!("{}.tmp", Uuid::new_v4()));
    let mut input = File::open(&source.package_path)?;
    input.seek(SeekFrom::Start(source.payload_offset))?;
    let mut limited = input.take(source.byte_length);
    let mut output = File::create(&temporary)?;
    let mut hasher = Sha256::new();
    let mut copied = 0_u64;
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = limited.read(&mut buffer)?;
        if read == 0 { break; }
        output.write_all(&buffer[..read])?;
        hasher.update(&buffer[..read]);
        copied += read as u64;
    }
    output.sync_all()?;
    if copied != source.byte_length || format!("{:x}", hasher.finalize()) != source.sha256 {
        let _ = fs::remove_file(&temporary);
        return Err(anyhow!("YoiStorage 资产校验失败: {}", source.sha256));
    }
    if target.exists() { fs::remove_file(target)?; }
    fs::rename(temporary, target)?;
    Ok(())
}

pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() { fs::create_dir_all(parent)?; }
    let temporary = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    let mut file = File::create(&temporary)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    if path.exists() { fs::remove_file(path)?; }
    fs::rename(temporary, path)?;
    Ok(())
}

fn directory_size(path: &Path) -> Result<u64> {
    if !path.exists() { return Ok(0); }
    let mut total = 0;
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let metadata = entry.metadata()?;
        total += if metadata.is_dir() { directory_size(&entry.path())? } else if metadata.is_file() { metadata.len() } else { 0 };
    }
    Ok(total)
}

fn copy_directory_if_exists(source: &Path, target: &Path) -> Result<()> {
    if !source.exists() { return Ok(()); }
    fs::create_dir_all(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let destination = target.join(entry.file_name());
        if entry.file_type()?.is_dir() { copy_directory_if_exists(&entry.path(), &destination)?; }
        else if !destination.exists() { fs::copy(entry.path(), destination)?; }
    }
    Ok(())
}

fn read_json(path: &Path) -> Option<serde_json::Value> { serde_json::from_slice(&fs::read(path).ok()?).ok() }
fn now_ms() -> f64 { system_time_ms(SystemTime::now()).unwrap_or(0.0) }
fn system_time_ms(value: SystemTime) -> Option<f64> { value.duration_since(UNIX_EPOCH).ok().map(|duration| duration.as_secs_f64() * 1000.0) }
fn is_png(bytes: &[u8]) -> bool { bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) }
fn is_webp(bytes: &[u8]) -> bool { bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" }

fn emit_thumbnail_ready_app(app: Option<&AppHandle>, id: &str, edge: u32) {
    let Some(app) = app else { return; };
    let variant = match edge {
        128 => "thumb128", 256 => "thumb256", 512 => "thumb512", 768 => "thumb768", 1024 => "thumb1024", _ => return,
    };
    let _ = app.emit("images:thumbnail-ready", serde_json::json!({ "assetId": id, "variant": variant }));
}

fn emit_derivative_ready_app(
    app: Option<&AppHandle>, id: &str, kind: &str, edge: Option<u32>, level: Option<u32>, column: Option<u32>, row: Option<u32>,
) {
    let Some(app) = app else { return; };
    let _ = app.emit("images:derivative-ready", serde_json::json!({
        "assetId": id, "kind": kind, "edge": edge, "level": level, "column": column, "row": row,
    }));
}

fn cache_jobs_idle(image_active: usize, video_active: usize) -> bool {
    image_active == 0 && video_active == 0
}

pub type SharedAssets = Arc<AssetService>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caps_full_video_reads_to_four_megabytes() {
        let (status, end) = bounded_media_range(
            http::StatusCode::OK, 0, 20 * 1024 * 1024 - 1, "video/mp4", false, false, 20 * 1024 * 1024,
        );
        assert_eq!(status, http::StatusCode::PARTIAL_CONTENT);
        assert_eq!(end + 1, VIDEO_RANGE_CHUNK_BYTES);
    }

    #[test]
    fn preserves_seek_start_while_capping_requested_video_range() {
        let start = 12 * 1024 * 1024;
        let (status, end) = bounded_media_range(
            http::StatusCode::PARTIAL_CONTENT, start, 30 * 1024 * 1024, "video/mp4", true, false, 40 * 1024 * 1024,
        );
        assert_eq!(status, http::StatusCode::PARTIAL_CONTENT);
        assert_eq!(end - start + 1, VIDEO_RANGE_CHUNK_BYTES);
    }

    #[test]
    fn leaves_image_responses_unbounded() {
        let (status, end) = bounded_media_range(http::StatusCode::OK, 0, 9_999_999, "image/png", false, false, 10_000_000);
        assert_eq!(status, http::StatusCode::OK);
        assert_eq!(end, 9_999_999);
    }

    #[test]
    fn video_head_without_range_reports_the_full_resource() {
        let (status, end) = bounded_media_range(
            http::StatusCode::OK, 0, 20 * 1024 * 1024 - 1, "video/mp4", false, true, 20 * 1024 * 1024,
        );
        assert_eq!(status, http::StatusCode::OK);
        assert_eq!(end, 20 * 1024 * 1024 - 1);
    }

    #[test]
    fn cache_migration_requires_both_job_pools_to_be_idle() {
        assert!(cache_jobs_idle(0, 0));
        assert!(!cache_jobs_idle(1, 0));
        assert!(!cache_jobs_idle(0, 1));
        assert!(!cache_jobs_idle(2, 3));
    }

    #[test]
    fn image_cache_version_comes_from_the_shared_frontend_format_file() {
        assert_eq!(image_cache_version(), 3);
    }
}
