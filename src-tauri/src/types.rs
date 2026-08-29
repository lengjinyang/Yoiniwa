use std::collections::HashMap;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CropRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetRecord {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset_id: Option<String>,
    pub hash: String,
    pub mime_type: String,
    pub byte_length: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_mtime_ms: Option<f64>,
    pub natural_width: u32,
    pub natural_height: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orientation: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_alpha: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_version: Option<u32>,
    pub original_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_sec: Option<f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageItem {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
    pub source_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pose: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub poster_asset_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_sec: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub muted: Option<bool>,
    #[serde(rename = "loop", default, skip_serializing_if = "Option::is_none")]
    pub loop_playback: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_url: Option<String>,
    pub natural_width: f64,
    pub natural_height: f64,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub rotation: f64,
    pub flip_x: bool,
    pub flip_y: bool,
    pub opacity: f64,
    pub z_index: i64,
    pub locked: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hidden: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grayscale: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grayscale_contrast: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    pub crop: CropRect,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GroupMember {
    #[serde(rename = "type")]
    pub member_type: String,
    pub id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageGroup {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub header_layout_version: Option<u8>,
    pub id: String,
    pub name: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub color: String,
    pub opacity: f64,
    pub title_color: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title_opacity: Option<f64>,
    pub collapsed: bool,
    pub size_locked: bool,
    pub contents_hidden: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_fit: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detached_image_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locked: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hidden: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub members: Vec<GroupMember>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Viewport {
    pub x: f64,
    pub y: f64,
    pub scale: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualNoteStyle {
    pub color: String,
    pub opacity: f64,
    pub width: String,
    pub base_width: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualNotePoint {
    pub x: f64,
    pub y: f64,
    pub width_factor: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum VisualNoteAnchor {
    Scene,
    Image { #[serde(rename = "imageId")] image_id: String },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum VisualMark {
    Stroke {
        id: String,
        anchor: VisualNoteAnchor,
        #[serde(rename = "createdAt")]
        created_at: f64,
        style: VisualNoteStyle,
        points: Vec<VisualNotePoint>,
    },
    Arrow {
        id: String,
        anchor: VisualNoteAnchor,
        #[serde(rename = "createdAt")]
        created_at: f64,
        style: VisualNoteStyle,
        start: VisualNotePoint,
        end: VisualNotePoint,
    },
    Number {
        id: String,
        anchor: VisualNoteAnchor,
        #[serde(rename = "createdAt")]
        created_at: f64,
        style: VisualNoteStyle,
        point: VisualNotePoint,
        number: u32,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualNotesState {
    pub visible: bool,
    pub next_number: u32,
    #[serde(default)]
    pub marks: Vec<VisualMark>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasSettings {
    pub background: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background_opacity: Option<f64>,
    pub padding: f64,
    pub snap: bool,
    pub include_background_on_export: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scene {
    pub format: String,
    pub version: u32,
    pub name: String,
    pub saved_at: String,
    pub viewport: Viewport,
    pub canvas: CanvasSettings,
    #[serde(default)]
    pub assets: HashMap<String, AssetRecord>,
    #[serde(default)]
    pub items: Vec<ImageItem>,
    #[serde(default)]
    pub groups: Vec<ImageGroup>,
    pub visual_notes: VisualNotesState,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedImage {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub asset_id: String,
    pub asset: AssetRecord,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub poster: Option<Box<ImportedImage>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoshopVersionRecord {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    pub created_at: String,
    pub document_name: String,
    pub width: u32,
    pub height: u32,
    pub color_mode: String,
    pub bit_depth: u32,
    pub layer_count: u32,
    pub format: String,
    pub byte_length: u64,
    pub sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blob_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archive_entry: Option<String>,
    pub preview_asset_id: String,
    pub preview_asset: AssetRecord,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct PhotoshopProjectMetadata {
    #[serde(default)]
    pub versions: Vec<PhotoshopVersionRecord>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCommitRequest {
    #[serde(default)]
    pub session_id: Option<String>,
    pub scene: Scene,
    pub photoshop_project: PhotoshopProjectMetadata,
    #[serde(default)]
    pub renderer_revision: Option<u64>,
    #[serde(default)]
    pub preview: Option<Vec<u8>>,
    pub reason: String,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCommitResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub canceled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipped: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scene: Option<Scene>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<PhotoshopProjectMetadata>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generation: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub committed_revision: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes_appended: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compaction_scheduled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovered: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upgraded: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovery_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_only: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<PhotoshopVersionRecord>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentScene {
    pub path: String,
    pub name: String,
    pub opened_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_ids: Option<Vec<String>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheInfo {
    pub root: String,
    pub is_default: bool,
    pub asset_bytes: u64,
    pub derived_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImagePipelinePerformanceStats {
    pub metadata_count: u64,
    pub metadata_ms: f64,
    pub thumbnail_count: u64,
    pub thumbnail_ms: f64,
    pub thumbnail_failures: u64,
    #[serde(default)]
    pub jobs_active: u64,
    #[serde(default)]
    pub jobs_pending: u64,
    #[serde(default)]
    pub jobs_inflight: u64,
    #[serde(default)]
    pub jobs_concurrency: u64,
    #[serde(default)]
    pub jobs_completed: u64,
    #[serde(default)]
    pub proxy_active: u64,
    #[serde(default)]
    pub proxy_queued: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowState {
    pub always_on_top: bool,
    pub click_through: bool,
    pub locked: bool,
    pub collaboration_mode: bool,
    pub opacity: f64,
}

impl Default for WindowState {
    fn default() -> Self {
        Self { always_on_top: false, click_through: false, locked: false, collaboration_mode: false, opacity: 1.0 }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowStatePatch {
    pub always_on_top: Option<bool>,
    pub click_through: Option<bool>,
    pub locked: Option<bool>,
    pub collaboration_mode: Option<bool>,
    pub opacity: Option<f64>,
}

impl WindowState {
    pub fn patched(&self, patch: WindowStatePatch) -> Self {
        Self {
            always_on_top: patch.always_on_top.unwrap_or(self.always_on_top),
            click_through: patch.click_through.unwrap_or(self.click_through),
            locked: patch.locked.unwrap_or(self.locked),
            collaboration_mode: patch.collaboration_mode.unwrap_or(self.collaboration_mode),
            opacity: patch.opacity.unwrap_or(self.opacity),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedColor {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub hex: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoshopColorSyncResult {
    pub ok: bool,
    pub status: String,
    pub sync_status: String,
    pub focus_status: String,
    pub copied: bool,
    pub sync_latency_ms: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoshopDocumentResult {
    pub ok: bool,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub document_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bit_depth: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layer_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archive_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<Vec<u8>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectStorageStats {
    pub generation: u64,
    pub file_bytes: u64,
    pub live_bytes: u64,
    pub stale_bytes: u64,
    pub stale_ratio: f64,
    pub blob_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_only: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovered: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovery_source: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_item_json() -> serde_json::Value {
        serde_json::json!({
            "id": "a",
            "name": "shot",
            "sourceType": "file",
            "assetId": "abc",
            "posterAssetId": "poster",
            "mediaKind": "video",
            "durationSec": 1.5,
            "muted": true,
            "loop": false,
            "naturalWidth": 10,
            "naturalHeight": 10,
            "x": 0,
            "y": 0,
            "width": 10,
            "height": 10,
            "rotation": 0,
            "flipX": false,
            "flipY": false,
            "opacity": 1,
            "zIndex": 1,
            "locked": false,
            "hidden": false,
            "grayscale": true,
            "grayscaleContrast": 1.4,
            "tags": ["ref"],
            "groupId": "g1",
            "crop": { "x": 0, "y": 0, "width": 10, "height": 10 }
        })
    }

    #[test]
    fn image_item_roundtrip_keeps_frontend_optional_fields() {
        let item: ImageItem = serde_json::from_value(sample_item_json()).expect("deserialize ImageItem");
        assert_eq!(item.grayscale_contrast, Some(1.4));
        let out = serde_json::to_value(&item).expect("serialize ImageItem");
        for key in [
            "posterAssetId",
            "mediaKind",
            "durationSec",
            "muted",
            "loop",
            "grayscale",
            "grayscaleContrast",
            "hidden",
            "tags",
            "groupId",
        ] {
            assert!(out.get(key).is_some(), "missing {key} after Rust scene roundtrip");
        }
        assert_eq!(out["grayscaleContrast"], 1.4);
        assert_eq!(out["loop"], false);
        assert_eq!(out["posterAssetId"], "poster");
    }
}
