use anyhow::Result;
use tauri::http;
use url::Url;

use crate::assets::{
    is_video_asset, ok_asset_bytes, query_u32, response, AssetService,
};

impl AssetService {
    pub fn protocol_response(&self, request: &http::Request<Vec<u8>>) -> http::Response<Vec<u8>> {
        match self.protocol_response_inner(request) {
            Ok(response) => {
                if response.status().is_server_error() || response.status() == http::StatusCode::NOT_FOUND {
                    let body = String::from_utf8_lossy(response.body()).chars().take(200).collect::<String>();
                    self.diagnostics.warn("assets.protocol", serde_json::json!({
                        "uri": request.uri().to_string(),
                        "status": response.status().as_u16(),
                        "body": body,
                    }));
                }
                response
            }
            Err(error) => {
                self.diagnostics.error_with_message("assets.protocol", error.to_string(), serde_json::json!({
                    "uri": request.uri().to_string(),
                }));
                response(http::StatusCode::INTERNAL_SERVER_ERROR, "text/plain; charset=utf-8", error.to_string().into_bytes())
            }
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
        if variant == "playback" {
            return self.playback_response(request, &entry);
        }
        if variant == "video-poster" {
            if !is_video_asset(&entry.record) {
                return Ok(response(http::StatusCode::BAD_REQUEST, "text/plain", b"Not a video".to_vec()));
            }
            if request.method() == http::Method::HEAD {
                return Ok(response(http::StatusCode::METHOD_NOT_ALLOWED, "text/plain", Vec::new()));
            }
            let edge = query_u32(&url, "edge")?.clamp(128, 2048);
            let priority = url.query_pairs().find(|(key, _)| key == "priority")
                .and_then(|(_, value)| value.parse::<i32>().ok()).unwrap_or(10);
            if let Some(bytes) = self.read_video_poster(id, edge) {
                return ok_asset_bytes(id, "image/png", bytes);
            }
            return Ok(match self.wait_job(self.enqueue_video_poster(id, edge, priority)) {
                Ok(bytes) => ok_asset_bytes(id, "image/png", bytes)?,
                Err(error) => response(http::StatusCode::INTERNAL_SERVER_ERROR, "text/plain; charset=utf-8", error.into_bytes()),
            });
        }
        if is_video_asset(&entry.record) {
            return Ok(response(http::StatusCode::NOT_FOUND, "text/plain", b"Video has no image derivatives".to_vec()));
        }
        if request.method() == http::Method::HEAD {
            return Ok(response(http::StatusCode::METHOD_NOT_ALLOWED, "text/plain", Vec::new()));
        }
        let priority = url.query_pairs().find(|(key, _)| key == "priority")
            .and_then(|(_, value)| value.parse::<i32>().ok()).unwrap_or(10);

        // Canvas mip/tile: Electron-like await generation on the async protocol thread, then 200.
        // Never 404 for these — blank tiles break browsing.
        if variant == "mip" {
            let edge = query_u32(&url, "edge")?;
            if let Some(bytes) = self.read_mip(id, edge) {
                return ok_asset_bytes(id, "image/webp", bytes);
            }
            // Electron: whole-image mips up to 4096 reuse the thumbnail pipeline when the edge matches.
            if matches!(edge, 128 | 256 | 512 | 1024) {
                if let Some(bytes) = self.read_thumbnail(id, edge) {
                    return ok_asset_bytes(id, "image/png", bytes);
                }
                return Ok(match self.wait_job(self.enqueue_thumbnail(id, edge, priority.max(if edge <= 128 { 20 } else { 10 }))) {
                    Ok(bytes) => ok_asset_bytes(id, "image/png", bytes)?,
                    Err(error) => response(http::StatusCode::INTERNAL_SERVER_ERROR, "text/plain; charset=utf-8", error.into_bytes()),
                });
            }
            return Ok(match self.wait_job(self.enqueue_mip(id, edge, priority)) {
                Ok(bytes) => ok_asset_bytes(id, "image/webp", bytes)?,
                Err(error) => response(http::StatusCode::INTERNAL_SERVER_ERROR, "text/plain; charset=utf-8", error.into_bytes()),
            });
        }
        if variant == "tile" {
            let level = query_u32(&url, "level")?;
            let column = query_u32(&url, "column")?;
            let row = query_u32(&url, "row")?;
            if let Some(bytes) = self.read_tile(id, level, column, row) {
                return ok_asset_bytes(id, "image/webp", bytes);
            }
            // Electron contract: wait for pyramid level OUTSIDE the tile job slot,
            // so concurrent tiles cannot deadlock the worker pool on one level encode.
            return Ok(match self.serve_tile(id, level, column, row, priority) {
                Ok(bytes) => ok_asset_bytes(id, "image/webp", bytes)?,
                Err(error) => response(http::StatusCode::INTERNAL_SERVER_ERROR, "text/plain; charset=utf-8", error.into_bytes()),
            });
        }
        if let Some(edge) = variant.strip_prefix("thumb").and_then(|value| value.parse::<u32>().ok()) {
            if let Some(bytes) = self.read_thumbnail(id, edge) {
                return ok_asset_bytes(id, "image/png", bytes);
            }
            // Optional UI thumbs: fire-and-forget + 404 (listeners use thumbnail-ready).
            // Thumb128 is critical — wait like Electron so import preview never blanks.
            if edge <= 128 {
                return Ok(match self.wait_job(self.enqueue_thumbnail(id, edge, priority.max(20))) {
                    Ok(bytes) => ok_asset_bytes(id, "image/png", bytes)?,
                    Err(error) => response(http::StatusCode::INTERNAL_SERVER_ERROR, "text/plain; charset=utf-8", error.into_bytes()),
                });
            }
            let _ = self.enqueue_thumbnail(id, edge, priority.max(5));
            let mut result = response(http::StatusCode::NOT_FOUND, "text/plain", b"Generating".to_vec());
            result.headers_mut().insert(http::header::CACHE_CONTROL, "no-store".parse()?);
            return Ok(result);
        }
        Ok(response(http::StatusCode::NOT_FOUND, "text/plain", b"Unknown variant".to_vec()))
    }
}
