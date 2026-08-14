use std::{
    fs::{self, File, FileTimes, OpenOptions},
    io::{BufReader, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::OnceLock,
    time::{Duration, SystemTime},
};

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

mod decode;
mod h264;
mod index;

pub use decode::{decode_source_frame_rgba, packet_batch};
pub use h264::ensure_h264_proxy_with_progress;
pub use index::ensure_source_frame_index;

static FFMPEG: OnceLock<Option<PathBuf>> = OnceLock::new();
pub const PROXY_CACHE_BUDGET: u64 = 8 * 1024 * 1024 * 1024;
pub const MAX_PACKET_BATCH_FRAMES: usize = 32;
pub const MAX_PACKET_BATCH_BYTES: u64 = 32 * 1024 * 1024;
pub(crate) const PROXY_MIN_TIMEOUT: Duration = Duration::from_secs(180);
pub(crate) const PROXY_POLL: Duration = Duration::from_millis(200);
pub(crate) const SOURCE_FRAME_DECODE_TIMEOUT: Duration = Duration::from_secs(15);
pub const MAX_SOURCE_FRAME_BYTES: u64 = 192 * 1024 * 1024;
const PROXY_FORMAT_VERSION: &str = "scrub-v4-frame-index";
const SOURCE_INDEX_VERSION: u32 = 1;
pub(crate) const SCRUB_INDEX_VERSION: u32 = 1;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoFrameIndexEntry {
    pub frame_index: u32,
    pub pts_us: i64,
    pub duration_us: u64,
    pub key_frame: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoPacketIndexEntry {
    pub frame_index: u32,
    pub offset: u64,
    pub size: u32,
    pub pts_us: i64,
    pub duration_us: u64,
    pub key_frame: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoScrubIndex {
    pub version: u32,
    pub asset_id: String,
    pub codec: String,
    pub description_base64: String,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub frame_count: u32,
    pub duration_us: u64,
    pub vfr: bool,
    pub pix_fmt: String,
    pub color_range: Option<String>,
    pub color_space: Option<String>,
    pub color_transfer: Option<String>,
    pub color_primaries: Option<String>,
    pub proxy_ready: bool,
    pub frame_accurate: bool,
    pub unsupported_reason: Option<String>,
    pub frames: Vec<VideoFrameIndexEntry>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub packets: Vec<VideoPacketIndexEntry>,
}

#[derive(Clone, Debug)]
pub(crate) struct StreamMetadata {
    pub codec_name: String,
    pub width: u32,
    pub height: u32,
    pub pix_fmt: String,
    pub fps: f64,
    pub duration_sec: Option<f64>,
    pub color_range: Option<String>,
    pub color_space: Option<String>,
    pub color_transfer: Option<String>,
    pub color_primaries: Option<String>,
}

pub fn find_ffmpeg() -> Option<PathBuf> {
    FFMPEG.get_or_init(discover_ffmpeg).clone()
}

pub fn source_decoder_available() -> bool {
    find_ffmpeg().is_some()
}

pub fn source_indexer_available() -> bool {
    find_ffmpeg().is_some_and(|ffmpeg| ffmpeg.with_file_name("ffprobe.exe").is_file())
}

fn discover_ffmpeg() -> Option<PathBuf> {
    if let Ok(path) = which("ffmpeg") {
        return Some(path);
    }
    let local_app = std::env::var_os("LOCALAPPDATA")?;
    let winget_root = PathBuf::from(local_app).join(r"Microsoft\WinGet\Packages");
    if let Ok(entries) = fs::read_dir(winget_root) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            if !name.contains("ffmpeg") {
                continue;
            }
            if let Some(found) = find_ffmpeg_under(&entry.path()) {
                return Some(found);
            }
        }
    }
    None
}

fn find_ffmpeg_under(root: &Path) -> Option<PathBuf> {
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let candidate = dir.join("ffmpeg.exe");
        if candidate.is_file() {
            return Some(candidate);
        }
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                if entry.file_type().ok()?.is_dir() {
                    stack.push(entry.path());
                }
            }
        }
    }
    None
}

fn which(name: &str) -> Result<PathBuf> {
    let output = Command::new("where.exe").arg(name).output()?;
    if !output.status.success() {
        return Err(anyhow!("not found"));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.lines().next().ok_or_else(|| anyhow!("empty"))?.trim();
    if line.is_empty() {
        return Err(anyhow!("empty"));
    }
    Ok(PathBuf::from(line))
}
pub fn proxy_path(cache_root: &Path, asset_id: &str) -> PathBuf {
    proxy_directory(cache_root).join(format!("{asset_id}-{PROXY_FORMAT_VERSION}.mp4"))
}

pub fn source_index_path(cache_root: &Path, asset_id: &str) -> PathBuf {
    proxy_directory(cache_root).join(format!(
        "{asset_id}-source-index-v{SOURCE_INDEX_VERSION}.json"
    ))
}

pub fn proxy_index_path(cache_root: &Path, asset_id: &str) -> PathBuf {
    proxy_directory(cache_root).join(format!("{asset_id}-{PROXY_FORMAT_VERSION}.json"))
}

fn proxy_directory(cache_root: &Path) -> PathBuf {
    cache_root.join("derived-cache").join("video-proxy")
}

pub fn ready_proxy_path(cache_root: &Path, asset_id: &str) -> Option<PathBuf> {
    let output = proxy_path(cache_root, asset_id);
    let index = proxy_index_path(cache_root, asset_id);
    if output.is_file()
        && index.is_file()
        && fs::metadata(&output)
            .map(|meta| meta.len() > 0)
            .unwrap_or(false)
        && load_index(&index).is_ok()
    {
        Some(output)
    } else {
        None
    }
}

pub fn ready_scrub_index(cache_root: &Path, asset_id: &str) -> Option<VideoScrubIndex> {
    load_index(&proxy_index_path(cache_root, asset_id))
        .ok()
        .filter(|index| index.asset_id == asset_id && index.proxy_ready && index.frame_accurate)
}

pub fn ready_source_index(cache_root: &Path, asset_id: &str) -> Option<VideoScrubIndex> {
    load_index(&source_index_path(cache_root, asset_id))
        .ok()
        .filter(|index| index.asset_id == asset_id && index.frame_accurate)
}

fn load_index(path: &Path) -> Result<VideoScrubIndex> {
    let index: VideoScrubIndex = serde_json::from_reader(BufReader::new(File::open(path)?))?;
    if index.version != SCRUB_INDEX_VERSION || index.frames.len() != index.frame_count as usize {
        return Err(anyhow!("视频帧索引版本或帧数无效"));
    }
    Ok(index)
}

pub fn touch_proxy(path: &Path) {
    if let Ok(file) = OpenOptions::new().read(true).open(path) {
        let _ = file.set_times(FileTimes::new().set_accessed(SystemTime::now()));
    }
}
pub fn cleanup_stale_proxy_temps(cache_root: &Path) {
    let directory = proxy_directory(cache_root);
    if let Ok(entries) = fs::read_dir(directory) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.')
                && (name.ends_with(".tmp.mp4")
                    || name.ends_with(".tmp.json")
                    || name.ends_with(".progress")
                    || (name.starts_with(".source-frame-") && name.ends_with(".rgba")))
            {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
}
fn write_index(path: &Path, index: &VideoScrubIndex) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temporary = path.with_file_name(format!(".{}.tmp.json", Uuid::new_v4()));
    let mut file = File::create(&temporary)?;
    serde_json::to_writer(&mut file, index)?;
    file.flush()?;
    file.sync_all()?;
    if path.exists() {
        fs::remove_file(path)?;
    }
    fs::rename(temporary, path)?;
    Ok(())
}

pub fn trim_proxy_cache_with_budget(
    cache_root: &Path,
    budget: u64,
    protected_asset_id: Option<&str>,
) -> Result<()> {
    let directory = proxy_directory(cache_root);
    if !directory.exists() {
        return Ok(());
    }
    let protected_prefix = protected_asset_id.map(|id| id.to_string());
    let mut files = Vec::new();
    for entry in fs::read_dir(&directory)? {
        let entry = entry?;
        let metadata = entry.metadata()?;
        if !metadata.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || !(name.ends_with(".mp4") || name.ends_with(".json")) {
            continue;
        }
        let used = metadata
            .accessed()
            .or_else(|_| metadata.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        files.push((entry.path(), name, metadata.len(), used));
    }
    let mut total = files.iter().map(|(_, _, bytes, _)| *bytes).sum::<u64>();
    files.sort_by_key(|(_, _, _, used)| *used);
    for (path, name, bytes, _) in files {
        if total <= budget {
            break;
        }
        if protected_prefix
            .as_ref()
            .is_some_and(|id| name.starts_with(id))
        {
            continue;
        }
        if fs::remove_file(path).is_ok() {
            total = total.saturating_sub(bytes);
        }
    }
    Ok(())
}

fn cleanup_temporary_files(cache_root: &Path, asset_id: &str) {
    let directory = proxy_directory(cache_root);
    let prefix = format!(".{asset_id}-");
    if let Ok(entries) = fs::read_dir(directory) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with(&prefix)
                && (name.ends_with(".tmp.mp4")
                    || name.ends_with(".tmp.json")
                    || name.ends_with(".progress"))
            {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
}

fn ffprobe_path() -> Result<PathBuf> {
    let path = find_ffmpeg()
        .map(|ffmpeg| ffmpeg.with_file_name("ffprobe.exe"))
        .ok_or_else(|| anyhow!("未找到 ffprobe"))?;
    if !path.is_file() {
        return Err(anyhow!("未找到 ffprobe"));
    }
    Ok(path)
}

fn parse_rate(value: &str) -> Option<f64> {
    if let Some((num, den)) = value.split_once('/') {
        let num: f64 = num.parse().ok()?;
        let den: f64 = den.parse().ok()?;
        if den == 0.0 {
            return None;
        }
        let rate = num / den;
        return (rate.is_finite() && rate > 0.0).then_some(rate);
    }
    let rate: f64 = value.parse().ok()?;
    (rate.is_finite() && rate > 0.0).then_some(rate)
}

fn seconds_to_i64_us(value: f64) -> i64 {
    (value * 1_000_000.0).round() as i64
}
fn seconds_to_us(value: f64) -> u64 {
    (value.max(0.0) * 1_000_000.0).round() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::decode::{previous_keyframe_index, scrub_keyframe_skip};
    use super::h264::ensure_h264_proxy;
    use super::index::{
        is_vfr, validate_frame_correspondence, validate_gop, validate_monotonic_frames,
        validate_packet_correspondence,
    };
    use std::{fs, path::Path, process::Command, sync::atomic::AtomicBool};

    #[test]
    fn scrubs_from_the_previous_keyframe_instead_of_the_target_pts() {
        let frames = (0..12)
            .map(|frame_index| VideoFrameIndexEntry {
                frame_index,
                pts_us: i64::from(frame_index) * 40_000,
                duration_us: 40_000,
                key_frame: frame_index % 4 == 0,
            })
            .collect::<Vec<_>>();
        let index = VideoScrubIndex {
            frames,
            ..test_index("asset")
        };
        assert_eq!(previous_keyframe_index(&index.frames, 0), 0);
        assert_eq!(previous_keyframe_index(&index.frames, 5), 4);
        assert_eq!(previous_keyframe_index(&index.frames, 11), 8);
        assert_eq!(scrub_keyframe_skip(&index, 5), (160_000, 1));
        assert_eq!(scrub_keyframe_skip(&index, 8), (320_000, 0));
    }

    #[test]
    fn detects_vfr_and_rejects_non_monotonic_pts() {
        let frames = vec![
            VideoFrameIndexEntry {
                frame_index: 0,
                pts_us: 0,
                duration_us: 16_667,
                key_frame: true,
            },
            VideoFrameIndexEntry {
                frame_index: 1,
                pts_us: 16_667,
                duration_us: 33_333,
                key_frame: false,
            },
            VideoFrameIndexEntry {
                frame_index: 2,
                pts_us: 50_000,
                duration_us: 16_667,
                key_frame: false,
            },
        ];
        assert!(is_vfr(&frames));
        let mut invalid = frames;
        invalid[2].pts_us = invalid[1].pts_us;
        assert!(validate_monotonic_frames(&invalid).is_err());
    }

    #[test]
    fn validates_gop_boundaries() {
        let packet = |index: u32, key_frame| VideoPacketIndexEntry {
            frame_index: index,
            offset: 0,
            size: 1,
            pts_us: index as i64,
            duration_us: 1,
            key_frame,
        };
        assert!(validate_gop(
            &(0..12)
                .map(|index| packet(index, index % 6 == 0))
                .collect::<Vec<_>>(),
            6
        )
        .is_ok());
        assert!(validate_gop(
            &(0..8)
                .map(|index| packet(index, index == 0))
                .collect::<Vec<_>>(),
            6
        )
        .is_err());
    }

    #[test]
    fn validates_proxy_frame_and_packet_pts_correspondence() {
        let frames = vec![
            VideoFrameIndexEntry {
                frame_index: 0,
                pts_us: 0,
                duration_us: 16_667,
                key_frame: true,
            },
            VideoFrameIndexEntry {
                frame_index: 1,
                pts_us: 16_667,
                duration_us: 33_333,
                key_frame: false,
            },
        ];
        let proxy = vec![
            VideoFrameIndexEntry {
                frame_index: 0,
                pts_us: 0,
                duration_us: 16_667,
                key_frame: true,
            },
            VideoFrameIndexEntry {
                frame_index: 1,
                pts_us: 16_668,
                duration_us: 33_333,
                key_frame: false,
            },
        ];
        assert!(validate_frame_correspondence(&frames, &proxy).is_ok());
        let packets = proxy
            .iter()
            .map(|frame| VideoPacketIndexEntry {
                frame_index: frame.frame_index,
                offset: 0,
                size: 1,
                pts_us: frame.pts_us,
                duration_us: frame.duration_us,
                key_frame: frame.key_frame,
            })
            .collect::<Vec<_>>();
        assert!(validate_packet_correspondence(&proxy, &packets).is_ok());
        let mut invalid = proxy;
        invalid[1].pts_us += 1_000;
        assert!(validate_frame_correspondence(&frames, &invalid).is_err());
    }

    #[test]
    fn bounds_packet_batches_and_serializes_header() {
        let root = std::env::temp_dir().join(format!("yoiniwa-packet-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let proxy = root.join("proxy.mp4");
        fs::write(&proxy, [1_u8, 2, 3, 4]).unwrap();
        let mut index = test_index("asset");
        index.proxy_ready = true;
        index.packets = vec![VideoPacketIndexEntry {
            frame_index: 0,
            offset: 1,
            size: 2,
            pts_us: 0,
            duration_us: 1,
            key_frame: true,
        }];
        let bytes = packet_batch(&index, &proxy, 0, 1).unwrap();
        assert_eq!(&bytes[..4], b"YSB1");
        assert_eq!(&bytes[bytes.len() - 2..], &[2, 3]);
        assert!(packet_batch(&index, &proxy, 0, 33).is_err());
        assert!(packet_batch(&index, &proxy, u32::MAX, 1).is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn trims_old_proxy_files_but_keeps_protected_group() {
        let root =
            std::env::temp_dir().join(format!("yoiniwa-video-proxy-test-{}", Uuid::new_v4()));
        let directory = proxy_directory(&root);
        fs::create_dir_all(&directory).unwrap();
        let protected_id = "a".repeat(64);
        let removable_id = "b".repeat(64);
        fs::write(
            directory.join(format!("{protected_id}-x.mp4")),
            vec![1_u8; 8],
        )
        .unwrap();
        fs::write(
            directory.join(format!("{removable_id}-x.mp4")),
            vec![2_u8; 8],
        )
        .unwrap();
        trim_proxy_cache_with_budget(&root, 8, Some(&protected_id)).unwrap();
        assert!(directory.join(format!("{protected_id}-x.mp4")).exists());
        assert!(!directory.join(format!("{removable_id}-x.mp4")).exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn startup_cleanup_removes_only_proxy_temp_files() {
        let root = std::env::temp_dir().join(format!(
            "yoiniwa-video-proxy-cleanup-test-{}",
            Uuid::new_v4()
        ));
        let directory = proxy_directory(&root);
        fs::create_dir_all(&directory).unwrap();
        let stale = directory.join(".asset-unique.tmp.mp4");
        let stale_frame = directory.join(".source-frame-stale.rgba");
        let cached = directory.join("asset.mp4");
        fs::write(&stale, [1_u8]).unwrap();
        fs::write(&stale_frame, [1_u8]).unwrap();
        fs::write(&cached, [2_u8]).unwrap();
        cleanup_stale_proxy_temps(&root);
        assert!(!stale.exists());
        assert!(!stale_frame.exists());
        assert!(cached.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn honors_cancellation_before_index_or_encode_and_writes_indexes_atomically() {
        let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tmp/sample-h264-proxy.mp4");
        if !source.exists() || find_ffmpeg().is_none() {
            return;
        }
        let root =
            std::env::temp_dir().join(format!("yoiniwa-video-cancel-test-{}", Uuid::new_v4()));
        let asset_id = "e".repeat(64);
        let canceled = AtomicBool::new(true);
        assert!(ensure_h264_proxy(&root, &asset_id, &source, &canceled).is_err());
        assert!(!proxy_path(&root, &asset_id).exists());
        assert!(!source_index_path(&root, &asset_id).exists());

        let target = source_index_path(&root, &asset_id);
        write_index(&target, &test_index(&asset_id)).expect("atomic index");
        assert!(load_index(&target).is_ok());
        let directory = target.parent().unwrap();
        assert!(!fs::read_dir(directory)
            .unwrap()
            .flatten()
            .any(|entry| { entry.file_name().to_string_lossy().starts_with('.') }));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn creates_validates_and_quality_checks_repository_video_samples() {
        let Some(ffmpeg) = find_ffmpeg() else {
            return;
        };
        let samples = [
            ("sample-h264-proxy.mp4", 120_u32, "c".repeat(64)),
            ("sample-hevc.mp4", 1_190_u32, "d".repeat(64)),
        ];
        for (name, expected_frames, asset_id) in samples {
            let source = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../tmp")
                .join(name);
            if !source.exists() {
                continue;
            }
            let root = std::env::temp_dir().join(format!(
                "yoiniwa-video-scrub-integration-{}",
                Uuid::new_v4()
            ));
            let canceled = AtomicBool::new(false);
            let source_index = ensure_source_frame_index(&root, &asset_id, &source, &canceled)
                .expect("source index");
            assert!(ready_proxy_path(&root, &asset_id).is_none(), "indexing must not create a proxy");
            let decoded = decode_source_frame_rgba(
                &root,
                &source,
                Some(&source_index),
                expected_frames / 2,
                3,
                320,
                180,
                0,
                &|| false,
            ).expect("decode source frame");
            assert_eq!(decoded.len(), 320 * 180 * 4 * 3, "{name}");
            let output = ensure_h264_proxy(&root, &asset_id, &source, &canceled).expect("proxy");
            let index = ready_scrub_index(&root, &asset_id).expect("index");
            assert!(output.exists());
            assert_eq!(index.frame_count, expected_frames, "{name}");
            assert_eq!((index.width, index.height), (2560, 1440), "{name}");
            assert!(index.description_base64.len() > 8);
            assert!(validate_gop(&index.packets, 6).is_ok());
            let ssim = measure_ssim(&ffmpeg, &source, &output).expect("ssim");
            assert!(ssim >= 0.995, "{name} SSIM {ssim} < 0.995");
            let _ = fs::remove_dir_all(root);
        }
    }

    fn measure_ssim(ffmpeg: &Path, source: &Path, proxy: &Path) -> Result<f64> {
        let output = Command::new(ffmpeg)
            .args(["-hide_banner", "-i"]).arg(source)
            .args(["-i"]).arg(proxy)
            .args(["-lavfi", "[0:v]setpts=PTS-STARTPTS[source];[1:v]setpts=PTS-STARTPTS[proxy];[source][proxy]ssim", "-an", "-f", "null", "-"])
            .output()?;
        if !output.status.success() {
            return Err(anyhow!("SSIM 检查失败"));
        }
        let text = String::from_utf8_lossy(&output.stderr);
        text.lines()
            .rev()
            .find_map(|line| {
                let value = line.split("All:").nth(1)?.split_whitespace().next()?;
                value.parse::<f64>().ok()
            })
            .ok_or_else(|| anyhow!("FFmpeg 未返回 SSIM"))
    }

    fn test_index(asset_id: &str) -> VideoScrubIndex {
        VideoScrubIndex {
            version: SCRUB_INDEX_VERSION,
            asset_id: asset_id.into(),
            codec: "avc1.640028".into(),
            description_base64: String::new(),
            width: 1,
            height: 1,
            fps: 30.0,
            frame_count: 1,
            duration_us: 1,
            vfr: false,
            pix_fmt: "yuv420p".into(),
            color_range: None,
            color_space: None,
            color_transfer: None,
            color_primaries: None,
            proxy_ready: false,
            frame_accurate: true,
            unsupported_reason: None,
            frames: vec![VideoFrameIndexEntry {
                frame_index: 0,
                pts_us: 0,
                duration_us: 1,
                key_frame: true,
            }],
            packets: Vec::new(),
        }
    }
}
