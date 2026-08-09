use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{anyhow, Context, Result};
use brotli::{CompressorWriter, Decompressor};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use zip::ZipArchive;

use crate::{
    assets::{atomic_write, PackageAssetSource, SharedAssets},
    types::{
        PhotoshopProjectMetadata, ProjectCommitRequest, ProjectCommitResult,
        ProjectStorageStats, Scene,
    },
};

const STORAGE_VERSION: u32 = 4;
const HEADER_SIZE: u64 = 8192;
const SUPERBLOCK_SIZE: usize = 256;
const SUPERBLOCK_OFFSETS: [u64; 2] = [512, 768];
const SEGMENT_HEADER_SIZE: u64 = 96;
const MAX_PREVIEW_BYTES: usize = 4 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES: usize = 64 * 1024 * 1024;
const MAX_LEGACY_ASSET_BYTES: u64 = 200 * 1024 * 1024;
const MAX_LEGACY_TOTAL_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_LEGACY_ASSETS: usize = 10_000;
const FILE_MAGIC: &[u8; 8] = b"YOINIWA\0";
const SLOT_MAGIC: &[u8; 8] = b"YOISLOT\0";
const SEGMENT_MAGIC: &[u8; 8] = b"YOISEG4\0";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
enum SegmentType { Blob = 1, Snapshot = 2, Preview = 3 }

#[derive(Clone, Debug)]
struct Superblock {
    generation: u64,
    snapshot_offset: u64,
    snapshot_length: u64,
    preview_offset: u64,
    preview_length: u64,
    end_offset: u64,
    committed_at: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredBlobRef {
    pub payload_offset: u64,
    pub byte_length: u64,
    pub sha256: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotEnvelope {
    pub storage_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<u64>,
    pub committed_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compacted_at_generation: Option<u64>,
    pub scene: Scene,
    pub photoshop_project: PhotoshopProjectMetadata,
    pub blobs: HashMap<String, StoredBlobRef>,
}

#[derive(Clone, Debug)]
pub struct BlobSource {
    pub id: String,
    pub source_path: PathBuf,
    pub source_offset: u64,
    pub byte_length: u64,
    pub kind: String,
    pub mime_type: Option<String>,
}

#[derive(Clone, Debug)]
pub struct YoiRepository {
    pub file_path: PathBuf,
    head: Superblock,
    pub snapshot: SnapshotEnvelope,
    file_id: String,
    pub recovered: bool,
    initialized_without_commit: bool,
}

struct CommitInput {
    scene: Scene,
    metadata: PhotoshopProjectMetadata,
    revision: Option<u64>,
    compacted_at_generation: Option<u64>,
    preview: Option<Vec<u8>>,
    blob_sources: Vec<BlobSource>,
}

struct CommitOutput { generation: u64, bytes_appended: u64 }

pub struct CompactionPlan {
    file_path: PathBuf,
    temporary_path: PathBuf,
    expected_file_id: String,
    expected_generation: u64,
    input: CommitInput,
}

pub struct CompactionCandidate {
    file_path: PathBuf,
    temporary_path: PathBuf,
    expected_file_id: String,
    expected_generation: u64,
}

impl Drop for CompactionCandidate {
    fn drop(&mut self) { let _ = fs::remove_file(&self.temporary_path); }
}

impl YoiRepository {
    pub fn open(path: &Path) -> Result<Self> {
        let (heads, file_id) = read_head(path)?;
        let file_size = fs::metadata(path)?.len();
        let mut file = File::open(path)?;
        let mut last_error = None;
        for head in heads {
            let attempt = (|| -> Result<Self> {
                let compressed = read_segment(&mut file, head.snapshot_offset, head.snapshot_length, SegmentType::Snapshot)?;
                let mut decoder = Decompressor::new(compressed.as_slice(), 64 * 1024);
                let mut decoded = Vec::new();
                decoder.read_to_end(&mut decoded)?;
                let snapshot: SnapshotEnvelope = serde_json::from_slice(&decoded).context("YoiStorage 快照无效")?;
                if snapshot.storage_version != STORAGE_VERSION { return Err(anyhow!("YoiStorage 快照版本无效")); }
                for id in reachable_blob_ids(&snapshot.scene, &snapshot.photoshop_project) {
                    let blob = snapshot.blobs.get(&id).ok_or_else(|| anyhow!("YoiStorage 快照缺少内容块: {id}"))?;
                    if blob.sha256 != id || blob.byte_length == 0 { return Err(anyhow!("YoiStorage 内容块索引无效: {id}")); }
                }
                Ok(Self {
                    file_path: path.to_path_buf(),
                    recovered: file_size > head.end_offset,
                    head, snapshot, file_id: file_id.clone(), initialized_without_commit: false,
                })
            })();
            match attempt { Ok(repository) => return Ok(repository), Err(error) => last_error = Some(error) }
        }
        Err(last_error.unwrap_or_else(|| anyhow!("YoiStorage 没有可恢复的完整提交")))
    }

    fn create(path: &Path, input: CommitInput, initial_generation: u64) -> Result<Self> {
        if path.exists() { return Err(anyhow!("临时工程文件已存在")); }
        if let Some(parent) = path.parent() { fs::create_dir_all(parent)?; }
        let file_id = Uuid::new_v4().to_string();
        let mut header = vec![0_u8; HEADER_SIZE as usize];
        header[..8].copy_from_slice(FILE_MAGIC);
        put_u32(&mut header, 8, STORAGE_VERSION);
        put_u32(&mut header, 12, HEADER_SIZE as u32);
        header[32..68].copy_from_slice(file_id.as_bytes());
        let mut file = OpenOptions::new().write(true).read(true).create_new(true).open(path)?;
        file.write_all(&header)?;
        file.sync_all()?;
        let mut repository = Self {
            file_path: path.to_path_buf(), file_id, recovered: false, initialized_without_commit: true,
            head: Superblock {
                generation: initial_generation.saturating_sub(1), snapshot_offset: 0, snapshot_length: 0,
                preview_offset: 0, preview_length: 0, end_offset: HEADER_SIZE, committed_at: 0,
            },
            snapshot: SnapshotEnvelope {
                storage_version: STORAGE_VERSION, revision: None, committed_at: "1970-01-01T00:00:00.000Z".into(),
                compacted_at_generation: None, scene: input.scene.clone(), photoshop_project: input.metadata.clone(), blobs: HashMap::new(),
            },
        };
        repository.commit(input)?;
        Ok(repository)
    }

    fn commit(&mut self, input: CommitInput) -> Result<CommitOutput> {
        if self.head.generation > 0 && !self.initialized_without_commit {
            let current = Self::open(&self.file_path)?;
            if current.file_id != self.file_id || current.head.generation != self.head.generation || current.head.end_offset != self.head.end_offset {
                return Err(anyhow!("工程已被其他会话修改，请另存为后继续"));
            }
        }
        let original_end = self.head.end_offset;
        let generation = self.head.generation + 1;
        let reachable = reachable_blob_ids(&input.scene, &input.metadata);
        let mut blobs: HashMap<String, StoredBlobRef> = self.snapshot.blobs.iter()
            .filter(|(id, _)| reachable.contains(*id)).map(|(id, value)| (id.clone(), value.clone())).collect();
        let mut file = OpenOptions::new().read(true).write(true).open(&self.file_path)?;
        file.set_len(original_end)?;
        file.seek(SeekFrom::Start(original_end))?;
        let mut position = original_end;
        let result = (|| -> Result<CommitOutput> {
            for source in &input.blob_sources {
                if !reachable.contains(&source.id) || blobs.contains_key(&source.id) { continue; }
                validate_hash(&source.id)?;
                if source.byte_length == 0 { return Err(anyhow!("待写入内容块无效")); }
                let payload_offset = position + SEGMENT_HEADER_SIZE;
                let header = segment_header(SegmentType::Blob, source.byte_length, generation, &source.id, Some(&source.id))?;
                file.write_all(&header)?;
                position = payload_offset;
                let mut source_file = File::open(&source.source_path)?;
                source_file.seek(SeekFrom::Start(source.source_offset))?;
                let mut limited = source_file.take(source.byte_length);
                let mut hasher = Sha256::new();
                let mut copied = 0_u64;
                let mut buffer = vec![0_u8; 1024 * 1024];
                loop {
                    let read = limited.read(&mut buffer)?;
                    if read == 0 { break; }
                    file.write_all(&buffer[..read])?;
                    hasher.update(&buffer[..read]);
                    copied += read as u64;
                    position += read as u64;
                }
                if copied != source.byte_length || format!("{:x}", hasher.finalize()) != source.id {
                    return Err(anyhow!("内容块校验失败: {}", source.id));
                }
                blobs.insert(source.id.clone(), StoredBlobRef {
                    payload_offset, byte_length: source.byte_length, sha256: source.id.clone(),
                    kind: source.kind.clone(), mime_type: source.mime_type.clone(),
                });
            }
            for id in &reachable { if !blobs.contains_key(id) { return Err(anyhow!("工程缺少被引用的内容块: {id}")); } }
            let snapshot = SnapshotEnvelope {
                storage_version: STORAGE_VERSION,
                revision: input.revision,
                committed_at: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                compacted_at_generation: input.compacted_at_generation.or(self.snapshot.compacted_at_generation),
                scene: input.scene,
                photoshop_project: input.metadata,
                blobs,
            };
            let encoded = serde_json::to_vec(&snapshot)?;
            let mut compressed = Vec::new();
            {
                let mut encoder = CompressorWriter::new(&mut compressed, 64 * 1024, 4, 22);
                encoder.write_all(&encoded)?;
            }
            if compressed.len() > MAX_SNAPSHOT_BYTES { return Err(anyhow!("工程快照超过大小限制")); }
            let snapshot_segment = write_buffer_segment(&mut file, position, SegmentType::Snapshot, generation, &compressed)?;
            position = snapshot_segment.1;
            let mut preview_offset = self.head.preview_offset;
            let mut preview_length = self.head.preview_length;
            if input.preview.as_deref().is_some_and(valid_png) {
                let preview = input.preview.as_ref().unwrap();
                let segment = write_buffer_segment(&mut file, position, SegmentType::Preview, generation, preview)?;
                preview_offset = segment.0;
                preview_length = preview.len() as u64;
                position = segment.1;
            }
            file.sync_all()?;
            let head = Superblock {
                generation, snapshot_offset: snapshot_segment.0, snapshot_length: compressed.len() as u64,
                preview_offset, preview_length, end_offset: position, committed_at: now_ms(),
            };
            let slot = serialize_superblock(&head);
            file.seek(SeekFrom::Start(SUPERBLOCK_OFFSETS[((generation - 1) % 2) as usize]))?;
            file.write_all(&slot)?;
            file.sync_all()?;
            self.head = head;
            self.snapshot = snapshot;
            self.initialized_without_commit = false;
            Ok(CommitOutput { generation, bytes_appended: position - original_end })
        })();
        if result.is_err() {
            let _ = file.set_len(original_end);
            let _ = file.sync_all();
        }
        result
    }

    pub fn blob_source(&self, id: &str) -> Result<BlobSource> {
        let blob = self.snapshot.blobs.get(id).ok_or_else(|| anyhow!("工程缺少内容块: {id}"))?;
        Ok(BlobSource {
            id: id.to_string(), source_path: self.file_path.clone(), source_offset: blob.payload_offset,
            byte_length: blob.byte_length, kind: blob.kind.clone(), mime_type: blob.mime_type.clone(),
        })
    }

    pub fn read_preview(&self) -> Result<Option<Vec<u8>>> {
        if self.head.preview_length == 0 { return Ok(None); }
        let mut file = File::open(&self.file_path)?;
        Ok(Some(read_segment(&mut file, self.head.preview_offset, self.head.preview_length, SegmentType::Preview)?))
    }

    pub fn extract_blob(&self, id: &str, target: &Path) -> Result<()> {
        let blob = self.snapshot.blobs.get(id).ok_or_else(|| anyhow!("工程缺少内容块: {id}"))?;
        validate_blob_header(&self.file_path, blob, id)?;
        let source = PackageAssetSource {
            package_path: self.file_path.clone(), payload_offset: blob.payload_offset,
            byte_length: blob.byte_length, sha256: id.to_string(),
        };
        materialize_blob(&source, target)
    }

    pub fn stats(&self, read_only: bool, recovery_source: Option<String>) -> Result<ProjectStorageStats> {
        let file_bytes = fs::metadata(&self.file_path)?.len();
        let blob_bytes: u64 = self.snapshot.blobs.values().map(|blob| SEGMENT_HEADER_SIZE + blob.byte_length).sum();
        let live_bytes = file_bytes.min(HEADER_SIZE + blob_bytes + SEGMENT_HEADER_SIZE + self.head.snapshot_length
            + if self.head.preview_length > 0 { SEGMENT_HEADER_SIZE + self.head.preview_length } else { 0 });
        let stale_bytes = file_bytes.saturating_sub(live_bytes);
        Ok(ProjectStorageStats {
            generation: self.head.generation, file_bytes, live_bytes, stale_bytes,
            stale_ratio: if file_bytes == 0 { 0.0 } else { stale_bytes as f64 / file_bytes as f64 },
            blob_count: self.snapshot.blobs.len(), read_only: Some(read_only), recovered: Some(self.recovered), recovery_source,
        })
    }

    pub fn recover_tail(&mut self) -> Result<bool> {
        let current = Self::open(&self.file_path)?;
        if current.file_id != self.file_id || current.head.generation != self.head.generation || current.head.end_offset != self.head.end_offset {
            return Err(anyhow!("工程已被其他会话修改，请另存为后继续"));
        }
        if fs::metadata(&self.file_path)?.len() <= self.head.end_offset { return Ok(false); }
        let file = OpenOptions::new().write(true).open(&self.file_path)?;
        file.set_len(self.head.end_offset)?;
        file.sync_all()?;
        Ok(true)
    }

    pub fn compact(&mut self) -> Result<ProjectStorageStats> {
        let temporary = PathBuf::from(format!("{}.compact.tmp", self.file_path.display()));
        let _ = fs::remove_file(&temporary);
        let sources = self.snapshot.blobs.keys().map(|id| self.blob_source(id)).collect::<Result<Vec<_>>>()?;
        Self::create(&temporary, CommitInput {
            scene: self.snapshot.scene.clone(), metadata: self.snapshot.photoshop_project.clone(), revision: self.snapshot.revision,
            compacted_at_generation: Some(self.head.generation), preview: self.read_preview()?, blob_sources: sources,
        }, self.head.generation)?;
        let backup = PathBuf::from(format!("{}.bak", self.file_path.display()));
        let _ = fs::remove_file(&backup);
        fs::rename(&self.file_path, &backup)?;
        if let Err(error) = fs::rename(&temporary, &self.file_path) {
            let _ = fs::rename(&backup, &self.file_path);
            return Err(error.into());
        }
        let _ = fs::remove_file(&backup);
        *self = Self::open(&self.file_path)?;
        self.stats(false, None)
    }
}

#[derive(Debug)]
struct WriteLease { path: PathBuf, token: String }

#[derive(Debug)]
struct ProjectSession {
    display_path: PathBuf,
    repository: Option<YoiRepository>,
    legacy_path: Option<PathBuf>,
    metadata: PhotoshopProjectMetadata,
    session_id: String,
    recovered: bool,
    recovery_source: Option<String>,
    read_only: bool,
    lease: Option<WriteLease>,
}

#[derive(Debug)]
pub struct ProjectService {
    assets: SharedAssets,
    current: Option<ProjectSession>,
}

impl ProjectService {
    pub fn new(assets: SharedAssets) -> Self { Self { assets, current: None } }
    pub fn current_session_id(&self) -> Option<String> { self.current.as_ref().map(|session| session.session_id.clone()) }
    pub fn current_metadata(&self) -> Option<PhotoshopProjectMetadata> { self.current.as_ref().map(|session| session.metadata.clone()) }

    pub fn open(&mut self, path: &Path) -> Result<ProjectCommitResult> {
        self.close(None)?;
        let candidates = find_candidates(path)?;
        if let Some((selected, _, _)) = candidates.first() {
            return self.open_v4(path, selected);
        }
        self.open_legacy(path)
    }

    fn open_v4(&mut self, display_path: &Path, selected_path: &Path) -> Result<ProjectCommitResult> {
        let lease = acquire_lease(display_path)?;
        let mut physical_path = selected_path.to_path_buf();
        let mut recovery_source = None;
        if selected_path != display_path && lease.is_some() {
            let temporary = PathBuf::from(format!("{}.{}.recover.tmp", display_path.display(), Uuid::new_v4()));
            fs::copy(selected_path, &temporary)?;
            let _ = YoiRepository::open(&temporary)?;
            let previous = PathBuf::from(format!("{}.bak", display_path.display()));
            let _ = fs::remove_file(&previous);
            if display_path.exists() { fs::rename(display_path, &previous)?; }
            fs::rename(&temporary, display_path)?;
            physical_path = display_path.to_path_buf();
            recovery_source = Some(selected_path.to_string_lossy().into_owned());
        } else if selected_path != display_path {
            recovery_source = Some(selected_path.to_string_lossy().into_owned());
        }
        let repository = YoiRepository::open(&physical_path)?;
        self.register_repository_assets(&repository)?;
        let session_id = Uuid::new_v4().to_string();
        let scene = repository.snapshot.scene.clone();
        self.retain_scene_assets(&scene);
        let metadata = repository.snapshot.photoshop_project.clone();
        let recovered = repository.recovered || recovery_source.is_some();
        let generation = repository.head.generation;
        let read_only = lease.is_none();
        self.current = Some(ProjectSession {
            display_path: display_path.to_path_buf(), repository: Some(repository), legacy_path: None,
            metadata: metadata.clone(), session_id: session_id.clone(), recovered,
            recovery_source: recovery_source.clone(), read_only, lease,
        });
        Ok(ProjectCommitResult {
            canceled: Some(false), path: Some(display_path.to_string_lossy().into_owned()), session_id: Some(session_id),
            scene: Some(scene), metadata: Some(metadata), generation: Some(generation), recovered: Some(recovered),
            recovery_source, read_only: Some(read_only), ..Default::default()
        })
    }

    fn open_legacy(&mut self, path: &Path) -> Result<ProjectCommitResult> {
        let (scene, metadata) = read_legacy_project(path, &self.assets)?;
        self.retain_scene_assets(&scene);
        let session_id = Uuid::new_v4().to_string();
        self.current = Some(ProjectSession {
            display_path: path.to_path_buf(), repository: None, legacy_path: Some(path.to_path_buf()),
            metadata: metadata.clone(), session_id: session_id.clone(), recovered: false,
            recovery_source: None, read_only: false, lease: None,
        });
        Ok(ProjectCommitResult {
            canceled: Some(false), path: Some(path.to_string_lossy().into_owned()), session_id: Some(session_id),
            scene: Some(scene), metadata: Some(metadata), read_only: Some(false), ..Default::default()
        })
    }

    pub fn import(&self, path: &Path) -> Result<(Scene, PhotoshopProjectMetadata)> {
        let candidates = find_candidates(path)?;
        if let Some((selected, _, _)) = candidates.first() {
            let repository = YoiRepository::open(selected)?;
            self.register_repository_assets(&repository)?;
            Ok((repository.snapshot.scene, repository.snapshot.photoshop_project))
        } else { read_legacy_project(path, &self.assets) }
    }

    pub fn commit(&mut self, request: ProjectCommitRequest, extra_sources: Vec<BlobSource>) -> Result<ProjectCommitResult> {
        let session = match self.current.as_mut() {
            Some(session) => session,
            None if request.reason == "autosave" => return Ok(ProjectCommitResult { skipped: Some(true), ..Default::default() }),
            None => return Ok(ProjectCommitResult { canceled: Some(false), skipped: Some(true), ..Default::default() }),
        };
        if request.session_id.as_deref().is_some_and(|id| id != session.session_id) { return Err(anyhow!("画板会话已切换，请重新打开后保存")); }
        if session.read_only { return Err(anyhow!("当前工程由其他实例打开，请另存为")); }
        if session.repository.is_none() {
            if request.reason == "autosave" { return Ok(ProjectCommitResult { skipped: Some(true), session_id: Some(session.session_id.clone()), ..Default::default() }); }
            let target = if extension_eq(&session.display_path, "refcanvas") {
                session.display_path.with_extension("yoi")
            } else { session.display_path.clone() };
            let upgraded = if extension_eq(&session.display_path, "refcanvas") { "refcanvas" } else { "legacy-yoi" };
            let mut result = self.save_as_to(request, &target, extra_sources)?;
            result.upgraded = Some(upgraded.into());
            return Ok(result);
        }
        let path = session.display_path.clone();
        let scene = prepare_scene(request.scene, &request.photoshop_project, &path);
        let repository = session.repository.as_mut().unwrap();
        let mut sources = collect_sources(&scene, &request.photoshop_project, Some(repository), &self.assets)?;
        merge_sources(&mut sources, extra_sources);
        let output = repository.commit(CommitInput {
            scene: scene.clone(), metadata: normalize_metadata(request.photoshop_project), revision: request.renderer_revision,
            compacted_at_generation: None, preview: request.preview, blob_sources: sources,
        })?;
        session.metadata = repository.snapshot.photoshop_project.clone();
        let compaction_scheduled = repository_needs_compaction(repository)?;
        let result = ProjectCommitResult {
            canceled: Some(false), path: Some(path.to_string_lossy().into_owned()), session_id: Some(session.session_id.clone()),
            scene: Some(scene), metadata: Some(session.metadata.clone()), generation: Some(output.generation),
            committed_revision: request.renderer_revision, bytes_appended: Some(output.bytes_appended),
            compaction_scheduled: Some(compaction_scheduled), recovered: Some(session.recovered), ..Default::default()
        };
        self.retain_scene_assets(result.scene.as_ref().unwrap());
        Ok(result)
    }

    pub fn save_as_to(&mut self, request: ProjectCommitRequest, target: &Path, extra_sources: Vec<BlobSource>) -> Result<ProjectCommitResult> {
        let legacy_path = self.current.as_ref().and_then(|session| session.legacy_path.clone());
        let migration_root = legacy_path.as_ref().map(|_| {
            target.parent().unwrap_or_else(|| Path::new(".")).join(format!(".yoiniwa-migrate-{}", Uuid::new_v4()))
        });
        if let Some(root) = &migration_root { fs::create_dir_all(root)?; }

        let result = (|| {
            let mut metadata = request.photoshop_project;
            let mut migrated_sources = Vec::new();
            if let (Some(legacy), Some(root)) = (legacy_path.as_deref(), migration_root.as_deref()) {
                migrated_sources = materialize_legacy_metadata(legacy, &mut metadata, root)?;
            }
            let metadata = normalize_metadata(metadata);
            let scene = prepare_scene(request.scene, &metadata, target);
            let source_repo = self.current.as_ref().and_then(|session| session.repository.as_ref());
            let mut sources = collect_sources(&scene, &metadata, source_repo, &self.assets)?;
            merge_sources(&mut sources, migrated_sources);
            merge_sources(&mut sources, extra_sources);

            let preserve_legacy = legacy_path.as_deref() == Some(target) && extension_eq(target, "yoi");
            if legacy_path.as_ref().is_some_and(|path| extension_eq(path, "refcanvas")) && target.exists() {
                return Err(anyhow!("迁移目标已存在，请使用另存为: {}", target.display()));
            }
            let lease = acquire_lease(target)?.ok_or_else(|| anyhow!("目标工程已被其他实例写入，请另存为其他文件"))?;
            let temporary = PathBuf::from(format!("{}.{}.create.tmp", target.display(), Uuid::new_v4()));
            let repository = match YoiRepository::create(&temporary, CommitInput {
                scene: scene.clone(), metadata: metadata.clone(), revision: request.renderer_revision,
                compacted_at_generation: None, preview: request.preview, blob_sources: sources,
            }, 1) {
                Ok(repository) => repository,
                Err(error) => { release_lease(&lease); return Err(error); }
            };
            if let Err(error) = install_project_file(&temporary, target, preserve_legacy) {
                release_lease(&lease);
                let _ = fs::remove_file(&temporary);
                return Err(error);
            }
            let repository = YoiRepository::open(target).unwrap_or(repository);
            self.register_repository_assets(&repository)?;
            self.retain_scene_assets(&scene);
            if let Some(old) = self.current.take() { if let Some(lease) = old.lease { release_lease(&lease); } }
            let session_id = Uuid::new_v4().to_string();
            let generation = repository.head.generation;
            let bytes = fs::metadata(target)?.len();
            self.current = Some(ProjectSession {
                display_path: target.to_path_buf(), repository: Some(repository), legacy_path: None,
                metadata: metadata.clone(), session_id: session_id.clone(), recovered: false,
                recovery_source: None, read_only: false, lease: Some(lease),
            });
            Ok(ProjectCommitResult {
                canceled: Some(false), path: Some(target.to_string_lossy().into_owned()), session_id: Some(session_id),
                scene: Some(scene), metadata: Some(metadata), generation: Some(generation), committed_revision: request.renderer_revision,
                bytes_appended: Some(bytes), ..Default::default()
            })
        })();
        if let Some(root) = migration_root { let _ = fs::remove_dir_all(root); }
        result
    }

    pub fn close(&mut self, session_id: Option<&str>) -> Result<()> {
        if self.current.as_ref().is_some_and(|session| session_id.is_some_and(|id| id != session.session_id)) { return Ok(()); }
        if let Some(session) = self.current.take() { if let Some(lease) = session.lease { release_lease(&lease); } }
        self.assets.unregister_missing(&HashSet::new());
        Ok(())
    }

    pub fn stats(&self, session_id: Option<&str>) -> Result<ProjectStorageStats> {
        let session = self.require_session(session_id)?;
        match &session.repository {
            Some(repository) => repository.stats(session.read_only, session.recovery_source.clone()),
            None => Ok(ProjectStorageStats {
                generation: 0, file_bytes: 0, live_bytes: 0, stale_bytes: 0, stale_ratio: 0.0,
                blob_count: 0, read_only: Some(session.read_only), recovered: Some(false), recovery_source: None,
            }),
        }
    }

    pub fn recover(&mut self, session_id: Option<&str>) -> Result<(bool, String)> {
        let session = self.require_session_mut(session_id)?;
        if session.read_only { return Err(anyhow!("当前工程为只读，请先另存为")); }
        let recovered = session.repository.as_mut().map(YoiRepository::recover_tail).transpose()?.unwrap_or(false);
        Ok((recovered, session.session_id.clone()))
    }

    pub fn compact(&mut self, session_id: Option<&str>) -> Result<Option<ProjectStorageStats>> {
        let session = self.require_session_mut(session_id)?;
        if session.read_only || session.repository.is_none() { return Ok(None); }
        Ok(Some(session.repository.as_mut().unwrap().compact()?))
    }

    pub fn compaction_plan(&self, session_id: &str, generation: u64) -> Result<Option<CompactionPlan>> {
        let session = self.require_session(Some(session_id))?;
        let Some(repository) = session.repository.as_ref() else { return Ok(None); };
        if session.read_only || repository.head.generation != generation || !repository_needs_compaction(repository)? { return Ok(None); }
        let temporary_path = PathBuf::from(format!("{}.compact.tmp", repository.file_path.display()));
        let _ = fs::remove_file(&temporary_path);
        let sources = repository.snapshot.blobs.keys().map(|id| repository.blob_source(id)).collect::<Result<Vec<_>>>()?;
        Ok(Some(CompactionPlan {
            file_path: repository.file_path.clone(), temporary_path,
            expected_file_id: repository.file_id.clone(), expected_generation: repository.head.generation,
            input: CommitInput {
                scene: repository.snapshot.scene.clone(), metadata: repository.snapshot.photoshop_project.clone(),
                revision: repository.snapshot.revision, compacted_at_generation: Some(repository.head.generation),
                preview: repository.read_preview()?, blob_sources: sources,
            },
        }))
    }

    pub fn activate_compaction(&mut self, session_id: &str, candidate: CompactionCandidate) -> Result<Option<ProjectStorageStats>> {
        let session = self.require_session_mut(Some(session_id))?;
        let Some(repository) = session.repository.as_mut() else { return Ok(None); };
        let current = YoiRepository::open(&candidate.file_path)?;
        if session.read_only || repository.file_id != candidate.expected_file_id
            || repository.head.generation != candidate.expected_generation
            || current.file_id != candidate.expected_file_id || current.head.generation != candidate.expected_generation {
            let _ = fs::remove_file(&candidate.temporary_path);
            return Ok(None);
        }
        replace_project_file(&candidate.temporary_path, &candidate.file_path)?;
        *repository = YoiRepository::open(&candidate.file_path)?;
        Ok(Some(repository.stats(false, None)?))
    }

    pub fn extract_photoshop_version(&self, session_id: Option<&str>, blob_id: &str, target: &Path) -> Result<()> {
        let session = self.require_session(session_id)?;
        if let Some(repository) = &session.repository { repository.extract_blob(blob_id, target) }
        else { extract_legacy_entry(session.legacy_path.as_ref().unwrap(), blob_id, target, &session.metadata) }
    }

    fn register_repository_assets(&self, repository: &YoiRepository) -> Result<()> {
        for record in repository.snapshot.scene.assets.values() {
            if let Some(blob) = repository.snapshot.blobs.get(&record.id) {
                validate_blob_header(&repository.file_path, blob, &record.id)?;
                self.assets.register_packaged(record.clone(), PackageAssetSource {
                    package_path: repository.file_path.clone(), payload_offset: blob.payload_offset,
                    byte_length: blob.byte_length, sha256: record.id.clone(),
                });
            }
        }
        Ok(())
    }

    fn retain_scene_assets(&self, scene: &Scene) {
        self.assets.unregister_missing(&scene.assets.keys().cloned().collect());
    }

    fn require_session(&self, id: Option<&str>) -> Result<&ProjectSession> {
        self.current.as_ref().filter(|session| id.is_none_or(|id| id == session.session_id)).ok_or_else(|| anyhow!("没有有效的工程会话"))
    }
    fn require_session_mut(&mut self, id: Option<&str>) -> Result<&mut ProjectSession> {
        self.current.as_mut().filter(|session| id.is_none_or(|id| id == session.session_id)).ok_or_else(|| anyhow!("没有有效的工程会话"))
    }
}

pub fn build_compaction_candidate(plan: CompactionPlan) -> Result<CompactionCandidate> {
    YoiRepository::create(&plan.temporary_path, plan.input, plan.expected_generation)?;
    let candidate = YoiRepository::open(&plan.temporary_path)?;
    if candidate.head.generation != plan.expected_generation { return Err(anyhow!("工程整理候选 generation 无效")); }
    Ok(CompactionCandidate {
        file_path: plan.file_path, temporary_path: plan.temporary_path,
        expected_file_id: plan.expected_file_id, expected_generation: plan.expected_generation,
    })
}

fn repository_needs_compaction(repository: &YoiRepository) -> Result<bool> {
    let stats = repository.stats(false, None)?;
    let compacted_at = repository.snapshot.compacted_at_generation.unwrap_or(0);
    Ok((stats.stale_bytes >= 512 * 1024 * 1024 && stats.stale_ratio >= 0.25)
        || repository.head.generation.saturating_sub(compacted_at) >= 200)
}

fn collect_sources(scene: &Scene, metadata: &PhotoshopProjectMetadata, repository: Option<&YoiRepository>, assets: &SharedAssets) -> Result<Vec<BlobSource>> {
    let mut sources = HashMap::new();
    for record in scene.assets.values() {
        if let Some(repository) = repository {
            if repository.snapshot.blobs.contains_key(&record.id) {
                sources.insert(record.id.clone(), repository.blob_source(&record.id)?);
                continue;
            }
        }
        let path = assets.ensure_file(&record.id)?;
        sources.insert(record.id.clone(), BlobSource {
            id: record.id.clone(), source_path: path, source_offset: 0, byte_length: record.byte_length,
            kind: "asset".into(), mime_type: Some(record.mime_type.clone()),
        });
    }
    for version in &metadata.versions {
        let id = version.blob_id.as_ref().unwrap_or(&version.sha256);
        if sources.contains_key(id) { continue; }
        if let Some(repository) = repository {
            if repository.snapshot.blobs.contains_key(id) { sources.insert(id.clone(), repository.blob_source(id)?); }
        }
    }
    Ok(sources.into_values().collect())
}

fn merge_sources(target: &mut Vec<BlobSource>, extras: Vec<BlobSource>) {
    let mut map: HashMap<String, BlobSource> = target.drain(..).map(|source| (source.id.clone(), source)).collect();
    for source in extras { map.insert(source.id.clone(), source); }
    target.extend(map.into_values());
}

fn prepare_scene(mut scene: Scene, metadata: &PhotoshopProjectMetadata, path: &Path) -> Scene {
    for version in &metadata.versions { scene.assets.entry(version.preview_asset_id.clone()).or_insert_with(|| version.preview_asset.clone()); }
    let used: HashSet<String> = scene.items.iter().filter_map(|item| item.asset_id.clone())
        .chain(metadata.versions.iter().map(|version| version.preview_asset_id.clone())).collect();
    scene.assets.retain(|id, _| used.contains(id));
    for item in &mut scene.items { item.data_url = None; }
    scene.version = 3;
    scene.name = path.file_stem().and_then(|name| name.to_str()).unwrap_or("未命名画板").to_string();
    scene.saved_at = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    scene
}

fn normalize_metadata(mut metadata: PhotoshopProjectMetadata) -> PhotoshopProjectMetadata {
    for version in &mut metadata.versions {
        if version.blob_id.is_none() { version.blob_id = Some(version.sha256.clone()); }
        version.archive_entry = None;
    }
    metadata
}

fn materialize_legacy_metadata(path: &Path, metadata: &mut PhotoshopProjectMetadata, root: &Path) -> Result<Vec<BlobSource>> {
    let mut sources = HashMap::new();
    for version in &mut metadata.versions {
        let blob_id = version.blob_id.clone().unwrap_or_else(|| version.sha256.clone());
        validate_hash(&blob_id)?;
        if !sources.contains_key(&blob_id) {
            let target = root.join(format!("{}.{}", blob_id, version.format));
            extract_legacy_version(path, version, &target)?;
            sources.insert(blob_id.clone(), BlobSource {
                id: blob_id.clone(), source_path: target, source_offset: 0, byte_length: version.byte_length,
                kind: "photoshop-version".into(), mime_type: Some("image/vnd.adobe.photoshop".into()),
            });
        }
        version.blob_id = Some(blob_id);
    }
    Ok(sources.into_values().collect())
}

fn read_legacy_project(path: &Path, assets: &SharedAssets) -> Result<(Scene, PhotoshopProjectMetadata)> {
    let file = File::open(path).context("该文件不是 Yoiniwa 画板")?;
    let mut archive = ZipArchive::new(file).context("该文件不是新版 Yoiniwa 画板，旧版场景格式已不受支持")?;
    let mut manifest = String::new();
    {
        let mut entry = archive.by_name("manifest.json").context("场景包缺少 manifest.json")?;
        if entry.size() > 64 * 1024 * 1024 { return Err(anyhow!("场景清单超过大小限制")); }
        entry.read_to_string(&mut manifest)?;
    }
    let mut value: serde_json::Value = serde_json::from_str(&manifest).context("场景清单不是有效的 JSON")?;
    normalize_scene_json(&mut value)?;
    let metadata: PhotoshopProjectMetadata = value.get("photoshopProject").cloned()
        .map(serde_json::from_value).transpose()?.unwrap_or_default();
    value.as_object_mut().map(|object| object.remove("photoshopProject"));
    let scene: Scene = serde_json::from_value(value)?;
    if scene.assets.len() > MAX_LEGACY_ASSETS { return Err(anyhow!("场景资源数量超过限制")); }
    let mut total_bytes = 0_u64;
    for record in scene.assets.values() {
        validate_hash(&record.id)?;
        if record.id != record.hash || record.byte_length == 0 || record.byte_length > MAX_LEGACY_ASSET_BYTES {
            return Err(anyhow!("场景包含无效资源: {}", record.id));
        }
        total_bytes = total_bytes.checked_add(record.byte_length).ok_or_else(|| anyhow!("场景资源总大小超过限制"))?;
        if total_bytes > MAX_LEGACY_TOTAL_BYTES { return Err(anyhow!("场景资源总大小超过限制")); }
        let entry_name = format!("assets/{}{}", record.id, extension_for_mime(&record.mime_type));
        let mut entry = archive.by_name(&entry_name).with_context(|| format!("场景包缺少资源: {}", record.id))?;
        if entry.size() != record.byte_length { return Err(anyhow!("场景资源大小不匹配: {}", record.id)); }
        let cache_path = assets.asset_cache_dir().join(format!("{}{}", record.id, extension_for_mime(&record.mime_type)));
        let temporary = cache_path.with_extension(format!("{}.tmp", Uuid::new_v4()));
        if let Some(parent) = temporary.parent() { fs::create_dir_all(parent)?; }
        let mut output = File::create(&temporary)?;
        let mut hasher = Sha256::new();
        let mut copied = 0_u64;
        let mut buffer = vec![0_u8; 1024 * 1024];
        loop {
            let read = entry.read(&mut buffer)?;
            if read == 0 { break; }
            output.write_all(&buffer[..read])?;
            hasher.update(&buffer[..read]); copied += read as u64;
        }
        output.sync_all()?;
        if copied != record.byte_length || format!("{:x}", hasher.finalize()) != record.hash {
            let _ = fs::remove_file(&temporary); return Err(anyhow!("场景资源校验失败: {}", record.id));
        }
        if cache_path.exists() { fs::remove_file(&cache_path)?; }
        fs::rename(temporary, &cache_path)?;
        assets.register_existing(record.clone(), cache_path);
    }
    if metadata.versions.len() > 10_000 { return Err(anyhow!("Photoshop 版本数量超过限制")); }
    for version in &metadata.versions {
        let preview = scene.assets.get(&version.preview_asset_id).ok_or_else(|| anyhow!("场景包缺少 Photoshop 版本预览: {}", version.name))?;
        if preview.hash != version.preview_asset.hash || preview.byte_length != version.preview_asset.byte_length
            || preview.mime_type != version.preview_asset.mime_type {
            return Err(anyhow!("场景包缺少 Photoshop 版本预览: {}", version.name));
        }
        let entry_name = version.archive_entry.as_ref().ok_or_else(|| anyhow!("场景包缺少 Photoshop 版本条目: {}", version.name))?;
        let entry = archive.by_name(entry_name).with_context(|| format!("场景包缺少 Photoshop 版本: {}", version.name))?;
        if entry.size() != version.byte_length { return Err(anyhow!("Photoshop 版本大小不匹配: {}", version.name)); }
    }
    Ok((scene, metadata))
}

fn normalize_scene_json(value: &mut serde_json::Value) -> Result<()> {
    let object = value.as_object_mut().ok_or_else(|| anyhow!("场景清单无效"))?;
    if object.get("format").and_then(|value| value.as_str()) != Some("refcanvas") { return Err(anyhow!("该场景版本不受支持")); }
    let version = object.get("version").and_then(|value| value.as_u64()).unwrap_or(0);
    if !(1..=3).contains(&version) { return Err(anyhow!("该场景版本不受支持")); }
    object.insert("version".into(), 3.into());
    object.entry("name").or_insert_with(|| "未命名画板".into());
    object.entry("savedAt").or_insert_with(|| "1970-01-01T00:00:00.000Z".into());
    object.entry("viewport").or_insert_with(|| serde_json::json!({ "x": 0, "y": 0, "scale": 1 }));
    object.entry("canvas").or_insert_with(|| serde_json::json!({
        "background": "#1D1D1D", "backgroundOpacity": 1, "padding": 20,
        "snap": true, "includeBackgroundOnExport": true,
    }));
    object.entry("assets").or_insert_with(|| serde_json::json!({}));
    object.entry("items").or_insert_with(|| serde_json::json!([]));
    object.entry("groups").or_insert_with(|| serde_json::json!([]));
    object.entry("visualNotes").or_insert_with(|| serde_json::json!({ "visible": true, "nextNumber": 1, "marks": [] }));
    if let Some(canvas) = object.get_mut("canvas").and_then(|value| value.as_object_mut()) {
        canvas.entry("background").or_insert_with(|| "#1D1D1D".into());
        canvas.entry("backgroundOpacity").or_insert_with(|| 1.into());
        canvas.entry("padding").or_insert_with(|| 20.into());
        canvas.entry("snap").or_insert_with(|| true.into());
        canvas.entry("includeBackgroundOnExport").or_insert_with(|| true.into());
    }
    if let Some(items) = object.get_mut("items").and_then(|value| value.as_array_mut()) {
        for item in items {
            if let Some(item) = item.as_object_mut() {
                if !item.contains_key("crop") {
                    let width = item.get("naturalWidth").and_then(|value| value.as_f64()).unwrap_or(1.0);
                    let height = item.get("naturalHeight").and_then(|value| value.as_f64()).unwrap_or(1.0);
                    item.insert("crop".into(), serde_json::json!({ "x": 0, "y": 0, "width": width, "height": height }));
                }
                item.entry("flipX").or_insert_with(|| false.into());
                item.entry("flipY").or_insert_with(|| false.into());
                item.entry("opacity").or_insert_with(|| 1.into());
                item.entry("locked").or_insert_with(|| false.into());
                item.entry("sourceType").or_insert_with(|| "file".into());
            }
        }
    }
    let items = object.get("items").and_then(|value| value.as_array()).cloned().unwrap_or_default();
    if let Some(groups) = object.get_mut("groups").and_then(|value| value.as_array_mut()) {
        for group in groups {
            let Some(group) = group.as_object_mut() else { continue; };
            let group_id = group.get("id").and_then(|value| value.as_str()).unwrap_or_default().to_string();
            if !group.contains_key("members") {
                let members = items.iter().filter(|item| item.get("groupId").and_then(|value| value.as_str()) == Some(group_id.as_str()))
                    .filter_map(|item| item.get("id").and_then(|value| value.as_str()))
                    .map(|id| serde_json::json!({ "type": "image", "id": id })).collect::<Vec<_>>();
                let bounds = legacy_scene_bounds(items.iter().filter(|item| item.get("groupId").and_then(|value| value.as_str()) == Some(group_id.as_str())));
                group.insert("headerLayoutVersion".into(), 2.into());
                group.insert("x".into(), (bounds.0 - 8.0).into());
                group.insert("y".into(), (bounds.1 - 8.0).into());
                group.insert("width".into(), (bounds.2 + 16.0).max(96.0).into());
                group.insert("height".into(), (bounds.3 + 16.0).max(48.0).into());
                group.insert("members".into(), members.into());
            }
            group.entry("x").or_insert_with(|| 0.into());
            group.entry("y").or_insert_with(|| 0.into());
            group.entry("width").or_insert_with(|| 140.into());
            group.entry("height").or_insert_with(|| 80.into());
            group.entry("color").or_insert_with(|| "#3a4955".into());
            group.entry("opacity").or_insert_with(|| 0.2.into());
            group.entry("titleColor").or_insert_with(|| "#e7f6ff".into());
            group.entry("titleOpacity").or_insert_with(|| 1.into());
            group.entry("collapsed").or_insert_with(|| false.into());
            let locked = group.get("locked").and_then(|value| value.as_bool()).unwrap_or(false);
            let hidden = group.get("hidden").and_then(|value| value.as_bool()).unwrap_or(false);
            group.entry("sizeLocked").or_insert_with(|| locked.into());
            group.entry("contentsHidden").or_insert_with(|| hidden.into());
            group.entry("autoFit").or_insert_with(|| true.into());
        }
    }
    if let Some(notes) = object.get_mut("visualNotes").and_then(|value| value.as_object_mut()) {
        notes.entry("visible").or_insert_with(|| true.into());
        notes.entry("nextNumber").or_insert_with(|| 1.into());
        notes.entry("marks").or_insert_with(|| serde_json::json!([]));
    }
    Ok(())
}

fn legacy_scene_bounds<'a>(items: impl Iterator<Item = &'a serde_json::Value>) -> (f64, f64, f64, f64) {
    let mut bounds: Option<(f64, f64, f64, f64)> = None;
    for item in items {
        let x = item.get("x").and_then(|value| value.as_f64()).unwrap_or(0.0);
        let y = item.get("y").and_then(|value| value.as_f64()).unwrap_or(0.0);
        let width = item.get("width").and_then(|value| value.as_f64()).unwrap_or(1.0);
        let height = item.get("height").and_then(|value| value.as_f64()).unwrap_or(1.0);
        let radians = item.get("rotation").and_then(|value| value.as_f64()).unwrap_or(0.0).to_radians();
        let rotated_width = (width * radians.cos()).abs() + (height * radians.sin()).abs();
        let rotated_height = (width * radians.sin()).abs() + (height * radians.cos()).abs();
        let left = x + width / 2.0 - rotated_width / 2.0;
        let top = y + height / 2.0 - rotated_height / 2.0;
        let right = left + rotated_width;
        let bottom = top + rotated_height;
        bounds = Some(match bounds {
            Some((old_left, old_top, old_width, old_height)) => {
                let old_right = old_left + old_width;
                let old_bottom = old_top + old_height;
                let next_left = old_left.min(left);
                let next_top = old_top.min(top);
                (next_left, next_top, old_right.max(right) - next_left, old_bottom.max(bottom) - next_top)
            }
            None => (left, top, rotated_width, rotated_height),
        });
    }
    bounds.unwrap_or((0.0, 0.0, 240.0, 160.0))
}

fn extract_legacy_entry(path: &Path, blob_id: &str, target: &Path, metadata: &PhotoshopProjectMetadata) -> Result<()> {
    let version = metadata.versions.iter().find(|version| version.blob_id.as_deref() == Some(blob_id) || version.sha256 == blob_id)
        .ok_or_else(|| anyhow!("画板缺少 Photoshop 版本"))?;
    extract_legacy_version(path, version, target)
}

fn extract_legacy_version(path: &Path, version: &crate::types::PhotoshopVersionRecord, target: &Path) -> Result<()> {
    let entry_name = version.archive_entry.as_ref().ok_or_else(|| anyhow!("旧版工程缺少 Photoshop ZIP 条目"))?;
    let mut archive = ZipArchive::new(File::open(path)?)?;
    let mut entry = archive.by_name(entry_name).with_context(|| format!("画板缺少 Photoshop 版本: {}", version.name))?;
    if entry.size() != version.byte_length { return Err(anyhow!("Photoshop 版本大小不匹配: {}", version.name)); }
    if let Some(parent) = target.parent() { fs::create_dir_all(parent)?; }
    let temporary = target.with_extension(format!("{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let mut output = File::create(&temporary)?;
        let mut hasher = Sha256::new();
        let mut copied = 0_u64;
        let mut buffer = vec![0_u8; 1024 * 1024];
        loop {
            let read = entry.read(&mut buffer)?;
            if read == 0 { break; }
            copied += read as u64;
            if copied > version.byte_length { return Err(anyhow!("Photoshop 版本大小超过记录: {}", version.name)); }
            hasher.update(&buffer[..read]);
            output.write_all(&buffer[..read])?;
        }
        output.sync_all()?;
        if copied != version.byte_length || format!("{:x}", hasher.finalize()) != version.sha256 {
            return Err(anyhow!("Photoshop 版本校验失败: {}", version.name));
        }
        if target.exists() { fs::remove_file(target)?; }
        fs::rename(&temporary, target)?;
        Ok(())
    })();
    if result.is_err() { let _ = fs::remove_file(&temporary); }
    result
}

fn find_candidates(path: &Path) -> Result<Vec<(PathBuf, u64, SystemTime)>> {
    let mut values = Vec::new();
    for candidate in [path.to_path_buf(), PathBuf::from(format!("{}.bak", path.display())), PathBuf::from(format!("{}.compact.tmp", path.display()))] {
        if !is_v4(&candidate) { continue; }
        if let Ok(repository) = YoiRepository::open(&candidate) {
            values.push((candidate.clone(), repository.head.generation, fs::metadata(candidate)?.modified().unwrap_or(UNIX_EPOCH)));
        }
    }
    values.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| right.2.cmp(&left.2)));
    Ok(values)
}

fn is_v4(path: &Path) -> bool {
    let mut prefix = [0_u8; 16];
    File::open(path).and_then(|mut file| file.read_exact(&mut prefix)).is_ok()
        && &prefix[..8] == FILE_MAGIC && u32_at(&prefix, 8) == STORAGE_VERSION
}

fn read_head(path: &Path) -> Result<(Vec<Superblock>, String)> {
    let mut file = File::open(path)?;
    let file_size = file.metadata()?.len();
    let mut header = vec![0_u8; HEADER_SIZE as usize];
    file.read_exact(&mut header)?;
    if &header[..8] != FILE_MAGIC || u32_at(&header, 8) != STORAGE_VERSION || u32_at(&header, 12) != HEADER_SIZE as u32 {
        return Err(anyhow!("该文件不是 YoiStorage v4 工程"));
    }
    let file_id = String::from_utf8_lossy(&header[32..68]).to_string();
    Uuid::parse_str(&file_id).context("YoiStorage 文件标识无效")?;
    let mut heads = SUPERBLOCK_OFFSETS.iter().filter_map(|offset| {
        parse_superblock(&header[*offset as usize..*offset as usize + SUPERBLOCK_SIZE])
    }).filter(|head| head.end_offset <= file_size).collect::<Vec<_>>();
    heads.sort_by(|left, right| right.generation.cmp(&left.generation));
    if heads.is_empty() { return Err(anyhow!("YoiStorage 没有有效提交")); }
    Ok((heads, file_id))
}

fn parse_superblock(bytes: &[u8]) -> Option<Superblock> {
    if bytes.len() != SUPERBLOCK_SIZE || &bytes[..8] != SLOT_MAGIC || crc32fast::hash(&bytes[..64]) != u32_at(bytes, 64) { return None; }
    let head = Superblock {
        generation: u64_at(bytes, 8), snapshot_offset: u64_at(bytes, 16), snapshot_length: u64_at(bytes, 24),
        preview_offset: u64_at(bytes, 32), preview_length: u64_at(bytes, 40), end_offset: u64_at(bytes, 48), committed_at: u64_at(bytes, 56),
    };
    if head.generation < 1 || head.snapshot_offset < HEADER_SIZE + SEGMENT_HEADER_SIZE || head.snapshot_length == 0
        || head.snapshot_length > MAX_SNAPSHOT_BYTES as u64 || head.snapshot_offset > head.end_offset
        || head.snapshot_length > head.end_offset - head.snapshot_offset || head.preview_length > MAX_PREVIEW_BYTES as u64
        || (head.preview_length > 0 && (head.preview_offset < HEADER_SIZE + SEGMENT_HEADER_SIZE
            || head.preview_offset > head.end_offset || head.preview_length > head.end_offset - head.preview_offset)) { return None; }
    Some(head)
}

fn serialize_superblock(head: &Superblock) -> Vec<u8> {
    let mut bytes = vec![0_u8; SUPERBLOCK_SIZE];
    bytes[..8].copy_from_slice(SLOT_MAGIC);
    put_u64(&mut bytes, 8, head.generation); put_u64(&mut bytes, 16, head.snapshot_offset);
    put_u64(&mut bytes, 24, head.snapshot_length); put_u64(&mut bytes, 32, head.preview_offset);
    put_u64(&mut bytes, 40, head.preview_length); put_u64(&mut bytes, 48, head.end_offset); put_u64(&mut bytes, 56, head.committed_at);
    let crc = crc32fast::hash(&bytes[..64]); put_u32(&mut bytes, 64, crc); bytes
}

fn segment_header(segment_type: SegmentType, length: u64, generation: u64, hash: &str, blob_id: Option<&str>) -> Result<Vec<u8>> {
    let mut bytes = vec![0_u8; SEGMENT_HEADER_SIZE as usize];
    bytes[..8].copy_from_slice(SEGMENT_MAGIC); put_u32(&mut bytes, 8, segment_type as u32);
    put_u32(&mut bytes, 12, SEGMENT_HEADER_SIZE as u32); put_u64(&mut bytes, 16, length); put_u64(&mut bytes, 24, generation);
    bytes[32..64].copy_from_slice(&hex_bytes(hash)?);
    if let Some(id) = blob_id { bytes[64..96].copy_from_slice(&hex_bytes(id)?); }
    Ok(bytes)
}

fn write_buffer_segment(file: &mut File, position: u64, segment_type: SegmentType, generation: u64, payload: &[u8]) -> Result<(u64, u64)> {
    let hash = format!("{:x}", Sha256::digest(payload));
    let header = segment_header(segment_type, payload.len() as u64, generation, &hash, None)?;
    file.seek(SeekFrom::Start(position))?; file.write_all(&header)?;
    let payload_offset = position + SEGMENT_HEADER_SIZE; file.write_all(payload)?;
    Ok((payload_offset, payload_offset + payload.len() as u64))
}

fn read_segment(file: &mut File, payload_offset: u64, payload_length: u64, expected: SegmentType) -> Result<Vec<u8>> {
    if payload_offset < HEADER_SIZE + SEGMENT_HEADER_SIZE { return Err(anyhow!("YoiStorage 段偏移无效")); }
    file.seek(SeekFrom::Start(payload_offset - SEGMENT_HEADER_SIZE))?;
    let mut header = vec![0_u8; SEGMENT_HEADER_SIZE as usize]; file.read_exact(&mut header)?;
    if &header[..8] != SEGMENT_MAGIC || u32_at(&header, 8) != expected as u32 || u32_at(&header, 12) != SEGMENT_HEADER_SIZE as u32 || u64_at(&header, 16) != payload_length {
        return Err(anyhow!("YoiStorage 段头无效"));
    }
    let mut payload = vec![0_u8; payload_length as usize]; file.read_exact(&mut payload)?;
    if Sha256::digest(&payload).as_slice() != &header[32..64] { return Err(anyhow!("YoiStorage 段校验失败")); }
    Ok(payload)
}

fn validate_blob_header(path: &Path, blob: &StoredBlobRef, id: &str) -> Result<()> {
    let mut file = File::open(path)?; file.seek(SeekFrom::Start(blob.payload_offset - SEGMENT_HEADER_SIZE))?;
    let mut header = vec![0_u8; SEGMENT_HEADER_SIZE as usize]; file.read_exact(&mut header)?;
    let expected = hex_bytes(id)?;
    if &header[..8] != SEGMENT_MAGIC || u32_at(&header, 8) != SegmentType::Blob as u32 || u32_at(&header, 12) != SEGMENT_HEADER_SIZE as u32
        || u64_at(&header, 16) != blob.byte_length || header[32..64] != expected || header[64..96] != expected {
        return Err(anyhow!("内容块段头无效: {id}"));
    }
    Ok(())
}

fn materialize_blob(source: &PackageAssetSource, target: &Path) -> Result<()> {
    let mut input = File::open(&source.package_path)?; input.seek(SeekFrom::Start(source.payload_offset))?;
    let mut limited = input.take(source.byte_length); let mut bytes = Vec::with_capacity(source.byte_length.min(64 * 1024 * 1024) as usize);
    limited.read_to_end(&mut bytes)?;
    if bytes.len() as u64 != source.byte_length || format!("{:x}", Sha256::digest(&bytes)) != source.sha256 { return Err(anyhow!("内容块校验失败")); }
    atomic_write(target, &bytes)
}

fn reachable_blob_ids(scene: &Scene, metadata: &PhotoshopProjectMetadata) -> HashSet<String> {
    scene.items.iter().filter_map(|item| item.asset_id.clone())
        .chain(metadata.versions.iter().flat_map(|version| [Some(version.preview_asset_id.clone()), Some(version.blob_id.clone().unwrap_or_else(|| version.sha256.clone()))].into_iter().flatten()))
        .collect()
}

fn acquire_lease(path: &Path) -> Result<Option<WriteLease>> {
    let lock_path = PathBuf::from(format!("{}.lock", path.display()));
    let token = Uuid::new_v4().to_string();
    let contents = serde_json::json!({ "pid": std::process::id(), "token": token, "openedAt": Utc::now().to_rfc3339() });
    match OpenOptions::new().write(true).create_new(true).open(&lock_path) {
        Ok(mut file) => { file.write_all(serde_json::to_string(&contents)?.as_bytes())?; Ok(Some(WriteLease { path: lock_path, token })) }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let stale = fs::read(&lock_path).ok().and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
                .and_then(|value| value.get("pid").and_then(|pid| pid.as_u64())).is_some_and(|pid| !process_alive(pid as u32));
            if !stale { return Ok(None); }
            fs::remove_file(&lock_path)?;
            acquire_lease(path)
        }
        Err(error) => Err(error.into()),
    }
}

fn release_lease(lease: &WriteLease) {
    let matches = fs::read(&lease.path).ok().and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|value| value.get("token").and_then(|token| token.as_str()).map(|token| token == lease.token)).unwrap_or(false);
    if matches { let _ = fs::remove_file(&lease.path); }
}

#[cfg(windows)]
fn process_alive(pid: u32) -> bool {
    use windows::Win32::{Foundation::CloseHandle, System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION}};
    unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).map(|handle| { let _ = CloseHandle(handle); true }).unwrap_or(false) }
}
#[cfg(not(windows))]
fn process_alive(_pid: u32) -> bool { false }

fn replace_project_file(temporary: &Path, target: &Path) -> Result<()> {
    let backup = PathBuf::from(format!("{}.bak", target.display())); let _ = fs::remove_file(&backup);
    let had_original = target.exists(); if had_original { fs::rename(target, &backup)?; }
    if let Err(error) = fs::rename(temporary, target) {
        if had_original { let _ = fs::rename(&backup, target); }
        return Err(error.into());
    }
    if had_original { let _ = fs::remove_file(backup); }
    Ok(())
}

fn install_project_file(temporary: &Path, target: &Path, preserve_legacy: bool) -> Result<()> {
    if !preserve_legacy { return replace_project_file(temporary, target); }
    let stem = target.file_stem().and_then(|value| value.to_str()).unwrap_or("project");
    let backup = target.with_file_name(format!("{stem}.legacy.yoi"));
    if backup.exists() { return Err(anyhow!("迁移备份已存在: {}", backup.display())); }
    fs::rename(target, &backup)?;
    if let Err(error) = fs::rename(temporary, target) {
        let _ = fs::rename(&backup, target);
        return Err(error.into());
    }
    Ok(())
}

fn extension_eq(path: &Path, extension: &str) -> bool { path.extension().and_then(|value| value.to_str()).is_some_and(|value| value.eq_ignore_ascii_case(extension)) }
fn extension_for_mime(mime: &str) -> &'static str { match mime { "image/png" => ".png", "image/jpeg" => ".jpg", "image/webp" => ".webp", "image/bmp" => ".bmp", "image/gif" => ".gif", _ => ".bin" } }
fn valid_png(bytes: &[u8]) -> bool { bytes.len() <= MAX_PREVIEW_BYTES && bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) }
fn validate_hash(value: &str) -> Result<()> { if value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) { Ok(()) } else { Err(anyhow!("SHA-256 标识无效")) } }
fn hex_bytes(value: &str) -> Result<[u8; 32]> { validate_hash(value)?; let mut bytes = [0_u8; 32]; for index in 0..32 { bytes[index] = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16)?; } Ok(bytes) }
fn now_ms() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64 }
fn u32_at(bytes: &[u8], offset: usize) -> u32 { u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap()) }
fn u64_at(bytes: &[u8], offset: usize) -> u64 { u64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap()) }
fn put_u32(bytes: &mut [u8], offset: usize, value: u32) { bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes()); }
fn put_u64(bytes: &mut [u8], offset: usize, value: u64) { bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes()); }
