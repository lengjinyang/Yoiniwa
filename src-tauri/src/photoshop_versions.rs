use std::{fs, path::PathBuf, time::Duration};

use anyhow::{anyhow, Result};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    project::BlobSource,
    state::AppState,
    types::{PhotoshopProjectMetadata, PhotoshopVersionRecord, ProjectCommitRequest, ProjectCommitResult, Scene},
};

pub struct CreatePhotoshopVersion {
    pub session_id: Option<String>,
    pub scene: Scene,
    pub metadata: PhotoshopProjectMetadata,
    pub name: String,
    pub note: Option<String>,
    pub revision: Option<u64>,
    pub preview: Option<Vec<u8>>,
}

pub(crate) fn normalized_version_name(name: &str) -> Option<String> {
    let name = name.trim().chars().take(160).collect::<String>();
    if name.is_empty() { None } else { Some(name) }
}

pub fn create_version(state: &AppState, request: CreatePhotoshopVersion) -> Result<ProjectCommitResult> {
    let CreatePhotoshopVersion { session_id, scene, metadata, name, note, revision, preview } = request;
    let Some(name) = normalized_version_name(&name) else {
        return Ok(ProjectCommitResult { canceled: Some(false), message: Some("请输入版本名称".into()), ..Default::default() });
    };
    let directory = state.temp_dir.join(format!("yoiniwa-photoshop-version-{}", Uuid::new_v4()));
    fs::create_dir_all(&directory)?;
    let version_id = Uuid::new_v4().to_string();
    let psd = directory.join(format!("{version_id}.psd"));
    let psb = directory.join(format!("{version_id}.psb"));
    let preview_path = directory.join(format!("{version_id}.jpg"));
    let capture = state.photoshop.run_document(&serde_json::json!({
        "kind": "capture-version",
        "archivePsdPath": psd,
        "archivePsbPath": psb,
        "previewPath": preview_path,
    }), Duration::from_secs(120));
    if !capture.ok {
        let _ = fs::remove_dir_all(&directory);
        return Ok(ProjectCommitResult { canceled: Some(false), message: capture.message, ..Default::default() });
    }
    let archive_path = capture.archive_path.clone().ok_or_else(|| anyhow!("Photoshop 版本缺少归档路径"))?;
    let archive_bytes = fs::read(&archive_path)?;
    let sha256 = format!("{:x}", Sha256::digest(&archive_bytes));
    let preview_bytes = fs::read(capture.preview_path.as_ref().unwrap_or(&preview_path.to_string_lossy().into_owned()))?;
    let preview_image = state.assets.register_bytes(format!("{name}.jpg"), &preview_bytes, None, "file")?;
    let version = PhotoshopVersionRecord {
        id: version_id, name: name.clone(),
        note: note.map(|value| value.trim().chars().take(4000).collect()).filter(|value: &String| !value.is_empty()),
        created_at: chrono::Utc::now().to_rfc3339(),
        document_name: capture.document_name.unwrap_or_else(|| name.clone()),
        width: capture.width.unwrap_or(0), height: capture.height.unwrap_or(0),
        color_mode: capture.color_mode.unwrap_or_else(|| "RGB".into()),
        bit_depth: capture.bit_depth.unwrap_or(8), layer_count: capture.layer_count.unwrap_or(0),
        format: capture.format.unwrap_or_else(|| "psd".into()),
        byte_length: archive_bytes.len() as u64, sha256: sha256.clone(), blob_id: Some(sha256.clone()), archive_entry: None,
        preview_asset_id: preview_image.asset_id.clone(), preview_asset: preview_image.asset.clone(),
    };
    let mut next_metadata = metadata;
    next_metadata.versions.push(version.clone());
    let commit = ProjectCommitRequest {
        session_id, scene, photoshop_project: next_metadata, renderer_revision: revision, preview, reason: "version-add".into(),
    };
    let source = BlobSource {
        id: sha256, source_path: PathBuf::from(archive_path), source_offset: 0,
        byte_length: archive_bytes.len() as u64, kind: "photoshop-version".into(),
        mime_type: Some("image/vnd.adobe.photoshop".into()),
    };
    let mut project = state.project.lock();
    let mut result = if project.current_session_id().is_some() {
        project.commit(commit, vec![source])?
    } else {
        let Some(path) = rfd::FileDialog::new().set_file_name(format!("{}.yoi", name)).add_filter("Yoiniwa 画板", &["yoi"]).save_file() else {
            return Ok(ProjectCommitResult { canceled: Some(true), ..Default::default() });
        };
        project.save_as_to(commit, &path.with_extension("yoi"), vec![source])?
    };
    result.version = Some(version);
    let _ = fs::remove_dir_all(directory);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_blank_version_names_and_trims_input() {
        assert_eq!(normalized_version_name("  Draft  "), Some("Draft".into()));
        assert!(normalized_version_name("   ").is_none());
        assert_eq!(normalized_version_name(&"x".repeat(200)).unwrap().chars().count(), 160);
    }
}
