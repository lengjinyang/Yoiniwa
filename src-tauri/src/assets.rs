use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{BufReader, Read, Write},
    path::{Path, PathBuf},
    sync::Arc,
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
    image_pipeline,
    types::{AssetRecord, CacheInfo, ImagePipelinePerformanceStats, ImportedImage},
};

const MAX_IMAGE_BYTES: u64 = 200 * 1024 * 1024;
const ASSET_CACHE_BUDGET: u64 = 2 * 1024 * 1024 * 1024;
const IMAGE_CACHE_VERSION: u32 = 3;

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
    pub fn new(user_data: PathBuf) -> Result<Self> {
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
        };
        fs::create_dir_all(service.asset_cache_dir())?;
        Ok(service)
    }

    pub fn cache_root(&self) -> PathBuf {
        self.cache_override.read().as_ref()
            .map(|root| root.join("RefCanvas"))
            .unwrap_or_else(|| self.user_data.clone())
    }

    pub fn asset_cache_dir(&self) -> PathBuf { self.cache_root().join("asset-cache") }
    pub fn image_cache_dir(&self) -> PathBuf { self.cache_root().join(format!("image-cache/v{IMAGE_CACHE_VERSION}")) }
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
        if !path.is_absolute() { return Err(anyhow!("图片路径必须是绝对路径")); }
        let metadata = fs::metadata(path)?;
        if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_IMAGE_BYTES {
            return Err(anyhow!("图片文件大小无效"));
        }
        let name = path.file_name().and_then(|name| name.to_str()).unwrap_or("image").to_string();
        let mime = image_mime(path).ok_or_else(|| anyhow!("不支持的图片格式"))?;
        let temporary = self.asset_cache_dir().join(format!(".import-{}.tmp", Uuid::new_v4()));
        fs::create_dir_all(self.asset_cache_dir())?;
        let mut reader = BufReader::new(File::open(path)?);
        let mut writer = File::create(&temporary)?;
        let mut hasher = Sha256::new();
        let mut buffer = [0_u8; 1024 * 1024];
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
        let image = image_pipeline::metadata(&cache_path, &self.stats)?;
        let record = AssetRecord {
            id: hash.clone(), asset_id: Some(hash.clone()), hash: hash.clone(), mime_type: mime.to_string(),
            byte_length: metadata.len(), source_size: Some(metadata.len()),
            source_mtime_ms: metadata.modified().ok().and_then(system_time_ms),
            natural_width: image.width, natural_height: image.height, orientation: Some(image.orientation),
            has_alpha: Some(image.has_alpha), content_hash: Some(hash.clone()), cache_version: Some(IMAGE_CACHE_VERSION),
            original_name: name.clone(), source_path: Some(path.to_string_lossy().into_owned()),
        };
        self.register_existing(record.clone(), cache_path);
        self.trim_asset_cache()?;
        Ok(ImportedImage {
            name, path: Some(path.to_string_lossy().into_owned()), asset_id: hash,
            asset: record, data_url: None, source_type: Some(source_type.to_string()),
        })
    }

    pub fn register_bytes(&self, name: String, data: &[u8], source_path: Option<String>, source_type: &str) -> Result<ImportedImage> {
        if data.is_empty() || data.len() as u64 > MAX_IMAGE_BYTES { return Err(anyhow!("图片数据大小无效")); }
        let mime = image_mime(Path::new(&name)).ok_or_else(|| anyhow!("不支持的图片格式"))?;
        let hash = format!("{:x}", Sha256::digest(data));
        fs::create_dir_all(self.asset_cache_dir())?;
        let cache_path = self.asset_cache_dir().join(format!("{hash}{}", extension_for_mime(mime)));
        if fs::metadata(&cache_path).map(|metadata| metadata.len()).unwrap_or(0) != data.len() as u64 {
            atomic_write(&cache_path, data)?;
        }
        let image = image_pipeline::metadata(&cache_path, &self.stats)?;
        let record = AssetRecord {
            id: hash.clone(), asset_id: Some(hash.clone()), hash: hash.clone(), mime_type: mime.to_string(),
            byte_length: data.len() as u64, source_size: Some(data.len() as u64), source_mtime_ms: Some(now_ms()),
            natural_width: image.width, natural_height: image.height, orientation: Some(image.orientation),
            has_alpha: Some(image.has_alpha), content_hash: Some(hash.clone()), cache_version: Some(IMAGE_CACHE_VERSION),
            original_name: name.clone(), source_path: source_path.clone(),
        };
        self.register_existing(record.clone(), cache_path);
        self.trim_asset_cache()?;
        Ok(ImportedImage { name, path: source_path, asset_id: hash, asset: record, data_url: None, source_type: Some(source_type.to_string()) })
    }

    pub fn register_url(&self, raw_url: &str) -> Result<ImportedImage> {
        let url = Url::parse(raw_url)?;
        if !matches!(url.scheme(), "http" | "https") { return Err(anyhow!("只支持 HTTP 或 HTTPS 图片地址")); }
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(15)).redirect(reqwest::redirect::Policy::limited(6)).build()?;
        let response = client.get(url.clone()).send()?;
        if !response.status().is_success() { return Err(anyhow!("图片下载失败: HTTP {}", response.status())); }
        if response.content_length().unwrap_or(0) > MAX_IMAGE_BYTES { return Err(anyhow!("网络图片超过 200MB")); }
        let content_type = response.headers().get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok()).unwrap_or("").split(';').next().unwrap_or("").to_string();
        let bytes = response.bytes()?;
        if bytes.len() as u64 > MAX_IMAGE_BYTES { return Err(anyhow!("网络图片超过 200MB")); }
        let mut name = url.path_segments().and_then(|mut segments| segments.next_back()).filter(|value| !value.is_empty())
            .unwrap_or("network-image").to_string();
        if image_mime(Path::new(&name)).is_none() {
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

    pub fn performance_stats(&self) -> ImagePipelinePerformanceStats { self.stats.lock().clone() }

    pub fn cancel_prewarm(&self, request_id: &str) { self.canceled_prewarm.lock().insert(request_id.to_string()); }

    pub fn prewarm(&self, app: &AppHandle, ids: &[String], request_id: &str) -> Result<serde_json::Value> {
        self.canceled_prewarm.lock().remove(request_id);
        let mut completed = 0;
        let mut failed = 0;
        let total = ids.len();
        for id in ids {
            if self.canceled_prewarm.lock().contains(request_id) { break; }
            let result = self.thumbnail(id, 128).and_then(|_| self.thumbnail(id, 512));
            if result.is_err() { failed += 1; }
            completed += 1;
            let failed_name = result.err().map(|error| error.to_string());
            let _ = app.emit("images:prewarm-progress", PrewarmProgress {
                request_id, completed, total, stage: "detail",
                fraction: if total == 0 { 1.0 } else { completed as f64 / total as f64 },
                failed, last_failed_name: failed_name.as_deref(),
            });
        }
        let canceled = self.canceled_prewarm.lock().remove(request_id);
        Ok(serde_json::json!({ "canceled": canceled, "completed": completed, "total": total, "failed": failed, "detailFailed": failed }))
    }

    pub fn thumbnail(&self, id: &str, edge: u32) -> Result<Vec<u8>> {
        let entry = self.entry(id).ok_or_else(|| anyhow!("资源不存在: {id}"))?;
        let path = self.image_asset_root(id).join(format!("thumb-{edge}.png"));
        if let Ok(bytes) = fs::read(&path) { if is_png(&bytes) { return Ok(bytes); } }
        let bytes = image_pipeline::thumbnail_png(&entry.cache_path, edge, &self.stats).inspect_err(|_| {
            self.stats.lock().thumbnail_failures += 1;
        })?;
        atomic_write(&path, &bytes)?;
        Ok(bytes)
    }

    pub fn mip(&self, id: &str, edge: u32) -> Result<Vec<u8>> {
        let entry = self.entry(id).ok_or_else(|| anyhow!("资源不存在: {id}"))?;
        let path = self.image_asset_root(id).join(format!("level-{edge}.webp"));
        if let Ok(bytes) = fs::read(&path) { if is_webp(&bytes) { return Ok(bytes); } }
        let bytes = image_pipeline::mip_webp(&entry.cache_path, edge)?;
        atomic_write(&path, &bytes)?;
        Ok(bytes)
    }

    pub fn tile(&self, id: &str, level: u32, column: u32, row: u32) -> Result<Vec<u8>> {
        let entry = self.entry(id).ok_or_else(|| anyhow!("资源不存在: {id}"))?;
        let path = self.image_asset_root(id).join(format!("tiles/{level}/{column}-{row}.webp"));
        if let Ok(bytes) = fs::read(&path) { if is_webp(&bytes) { return Ok(bytes); } }
        let bytes = image_pipeline::tile_webp(
            &entry.cache_path, entry.record.natural_width, entry.record.natural_height,
            level, column, row, 512, 1,
        )?;
        atomic_write(&path, &bytes)?;
        Ok(bytes)
    }

    fn image_asset_root(&self, id: &str) -> PathBuf { self.image_cache_dir().join("assets").join(id) }

    pub fn protocol_response(&self, request: &http::Request<Vec<u8>>) -> http::Response<Vec<u8>> {
        match self.protocol_response_inner(request) {
            Ok(response) => response,
            Err(error) => response(http::StatusCode::INTERNAL_SERVER_ERROR, "text/plain; charset=utf-8", error.to_string().into_bytes()),
        }
    }

    fn protocol_response_inner(&self, request: &http::Request<Vec<u8>>) -> Result<http::Response<Vec<u8>>> {
        if request.method() != http::Method::GET && request.method() != http::Method::HEAD {
            return Ok(response(http::StatusCode::METHOD_NOT_ALLOWED, "text/plain", Vec::new()));
        }
        let url = Url::parse(&request.uri().to_string()).or_else(|_| Url::parse(&format!("http://refcanvas-asset.localhost{}", request.uri())))?;
        let id = url.path().trim_start_matches('/').strip_prefix("asset/").unwrap_or(url.path().trim_start_matches('/'));
        if id.len() != 64 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Ok(response(http::StatusCode::BAD_REQUEST, "text/plain", b"Invalid asset id".to_vec()));
        }
        let entry = match self.entry(id) {
            Some(entry) => entry,
            None => return Ok(response(http::StatusCode::NOT_FOUND, "text/plain", b"Not found".to_vec())),
        };
        let variant = url.query_pairs().find(|(key, _)| key == "variant").map(|(_, value)| value.into_owned()).unwrap_or_else(|| "original".into());
        if variant == "original" {
            return self.original_response(request, &entry);
        }
        if request.method() == http::Method::HEAD {
            return Ok(response(http::StatusCode::METHOD_NOT_ALLOWED, "text/plain", Vec::new()));
        }
        let (bytes, mime) = if variant == "mip" {
            let edge = query_u32(&url, "edge")?;
            (self.mip(id, edge)?, "image/webp")
        } else if variant == "tile" {
            (self.tile(id, query_u32(&url, "level")?, query_u32(&url, "column")?, query_u32(&url, "row")?)?, "image/webp")
        } else if let Some(edge) = variant.strip_prefix("thumb").and_then(|value| value.parse::<u32>().ok()) {
            (self.thumbnail(id, edge)?, "image/png")
        } else {
            return Ok(response(http::StatusCode::NOT_FOUND, "text/plain", b"Unknown variant".to_vec()));
        };
        let mut result = response(http::StatusCode::OK, mime, bytes);
        immutable_headers(result.headers_mut(), id);
        Ok(result)
    }

    fn original_response(&self, request: &http::Request<Vec<u8>>, entry: &AssetEntry) -> Result<http::Response<Vec<u8>>> {
        let cache_available = fs::metadata(&entry.cache_path)
            .map(|metadata| metadata.is_file() && metadata.len() == entry.record.byte_length).unwrap_or(false);
        let (source_path, source_offset, length) = if cache_available {
            (entry.cache_path.clone(), 0, entry.record.byte_length)
        } else if let Some(source) = &entry.package_source {
            (source.package_path.clone(), source.payload_offset, source.byte_length)
        } else {
            return Err(anyhow!("资源缓存缺失: {}", entry.record.id));
        };
        let mut file = File::open(source_path)?;
        let range = request.headers().get(http::header::RANGE).and_then(|value| value.to_str().ok());
        let (status, start, end) = match range {
            Some(value) => match parse_range(value, length) {
                Ok(range) => (http::StatusCode::PARTIAL_CONTENT, range.0, range.1),
                Err(_) => {
                    let mut result = response(http::StatusCode::RANGE_NOT_SATISFIABLE, &entry.record.mime_type, Vec::new());
                    result.headers_mut().insert(http::header::CONTENT_RANGE, format!("bytes */{length}").parse()?);
                    result.headers_mut().insert(http::header::ACCEPT_RANGES, "bytes".parse()?);
                    result.headers_mut().insert(http::header::CONTENT_LENGTH, "0".parse()?);
                    immutable_headers(result.headers_mut(), &entry.record.hash);
                    return Ok(result);
                }
            },
            None => (http::StatusCode::OK, 0, length.saturating_sub(1)),
        };
        let body_length = if length == 0 { 0 } else { end - start + 1 };
        let mut body = Vec::new();
        if request.method() != http::Method::HEAD && body_length > 0 {
            use std::io::{Seek, SeekFrom};
            file.seek(SeekFrom::Start(source_offset + start))?;
            body.resize(body_length as usize, 0);
            file.read_exact(&mut body)?;
        }
        let mut result = response(status, &entry.record.mime_type, body);
        let headers = result.headers_mut();
        headers.insert(http::header::CONTENT_LENGTH, body_length.to_string().parse()?);
        headers.insert(http::header::ACCEPT_RANGES, "bytes".parse()?);
        if status == http::StatusCode::PARTIAL_CONTENT {
            headers.insert(http::header::CONTENT_RANGE, format!("bytes {start}-{end}/{length}").parse()?);
        }
        immutable_headers(headers, &entry.record.hash);
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

fn response(status: http::StatusCode, mime: &str, body: Vec<u8>) -> http::Response<Vec<u8>> {
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

fn query_u32(url: &Url, key: &str) -> Result<u32> {
    url.query_pairs().find(|(name, _)| name == key).ok_or_else(|| anyhow!("缺少参数 {key}"))?.1.parse().map_err(Into::into)
}

fn image_mime(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_string_lossy().to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        "gif" => Some("image/gif"),
        _ => None,
    }
}

fn extension_for_mime(mime: &str) -> &'static str {
    match mime { "image/png" => ".png", "image/jpeg" => ".jpg", "image/webp" => ".webp", "image/bmp" => ".bmp", "image/gif" => ".gif", _ => ".bin" }
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
    let mut buffer = [0_u8; 1024 * 1024];
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

pub type SharedAssets = Arc<AssetService>;
