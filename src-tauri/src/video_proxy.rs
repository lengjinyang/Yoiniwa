use std::{
    fs::{self, File, FileTimes, OpenOptions},
    io::{BufRead, BufReader, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        OnceLock,
    },
    time::{Duration, Instant, SystemTime},
};

use anyhow::{anyhow, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use wait_timeout::ChildExt;

static FFMPEG: OnceLock<Option<PathBuf>> = OnceLock::new();
pub const PROXY_CACHE_BUDGET: u64 = 8 * 1024 * 1024 * 1024;
pub const MAX_PACKET_BATCH_FRAMES: usize = 32;
pub const MAX_PACKET_BATCH_BYTES: u64 = 32 * 1024 * 1024;
const PROXY_MIN_TIMEOUT: Duration = Duration::from_secs(180);
const PROXY_POLL: Duration = Duration::from_millis(200);
const SOURCE_FRAME_DECODE_TIMEOUT: Duration = Duration::from_secs(15);
pub const MAX_SOURCE_FRAME_BYTES: u64 = 192 * 1024 * 1024;
const PROXY_FORMAT_VERSION: &str = "scrub-v4-frame-index";
const SOURCE_INDEX_VERSION: u32 = 1;
const SCRUB_INDEX_VERSION: u32 = 1;

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
struct StreamMetadata {
    codec_name: String,
    width: u32,
    height: u32,
    pix_fmt: String,
    fps: f64,
    duration_sec: Option<f64>,
    color_range: Option<String>,
    color_space: Option<String>,
    color_transfer: Option<String>,
    color_primaries: Option<String>,
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

pub fn ensure_source_frame_index(
    cache_root: &Path,
    asset_id: &str,
    source: &Path,
    canceled: &AtomicBool,
) -> Result<VideoScrubIndex> {
    ensure_source_index(cache_root, asset_id, source, canceled)
}

fn previous_keyframe_index(frames: &[VideoFrameIndexEntry], frame_index: u32) -> usize {
    if frames.is_empty() {
        return 0;
    }
    let last = (frame_index as usize).min(frames.len() - 1);
    frames[..=last]
        .iter()
        .rposition(|frame| frame.key_frame)
        .unwrap_or(0)
}

/// Seek the previous keyframe, then keep `start_frame` by index. Input `-ss`
/// alone returns that keyframe, which is why timeline drags looked quantized.
fn scrub_keyframe_skip(index: &VideoScrubIndex, start_frame: u32) -> (u64, u32) {
    let key = previous_keyframe_index(&index.frames, start_frame);
    let pts = index
        .frames
        .get(key)
        .map(|frame| frame.pts_us.max(0) as u64)
        .unwrap_or(0);
    let start = (start_frame as usize).min(index.frames.len().saturating_sub(1));
    (pts, start.saturating_sub(key) as u32)
}

pub fn decode_source_frame_rgba(
    _cache_root: &Path,
    source: &Path,
    index: Option<&VideoScrubIndex>,
    frame_index: u32,
    frame_count: u32,
    width: u32,
    height: u32,
    fallback_time_us: u64,
    canceled: &dyn Fn() -> bool,
) -> Result<Vec<u8>> {
    let frame_bytes = u64::from(width)
        .checked_mul(u64::from(height))
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| anyhow!("Scrub 帧尺寸溢出"))?;
    let frame_count = frame_count.clamp(1, 7);
    let expected_max = frame_bytes
        .checked_mul(u64::from(frame_count))
        .ok_or_else(|| anyhow!("Scrub 帧批次尺寸溢出"))?;
    if width < 2 || height < 2 || expected_max > MAX_SOURCE_FRAME_BYTES {
        return Err(anyhow!("Scrub 帧尺寸超出限制"));
    }
    let ffmpeg = find_ffmpeg().ok_or_else(|| anyhow!("未找到 FFmpeg 原片解码器"))?;
    let (input_ss_us, skip, output_ss_us) = match index {
        Some(index) if !index.frames.is_empty() => {
            let (pts, skip) = scrub_keyframe_skip(index, frame_index);
            (Some(pts), skip, None)
        }
        _ => (None, 0, Some(fallback_time_us)),
    };
    let last = skip + frame_count - 1;
    let filter = if skip > 0 {
        format!(
            "select=between(n\\,{skip}\\,{last}),setpts=N/TB,scale={width}:{height}:flags=lanczos,format=rgba"
        )
    } else {
        format!("scale={width}:{height}:flags=lanczos,format=rgba")
    };
    let mut command = Command::new(ffmpeg);
    command.args(["-y", "-hide_banner", "-loglevel", "error"]);
    if let Some(pts) = input_ss_us {
        command
            .args(["-noaccurate_seek", "-ss"])
            .arg(format!("{:.6}", pts as f64 / 1_000_000.0));
    }
    command.arg("-i").arg(source);
    if let Some(pts) = output_ss_us {
        command
            .args(["-accurate_seek", "-ss"])
            .arg(format!("{:.6}", pts as f64 / 1_000_000.0));
    }
    command
        .args(["-map", "0:v:0", "-an", "-sn", "-frames:v"])
        .arg(frame_count.to_string())
        .arg("-vf")
        .arg(filter)
        .args(["-pix_fmt", "rgba", "-fps_mode", "passthrough", "-f", "rawvideo", "pipe:1"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // BELOW_NORMAL_PRIORITY_CLASS | CREATE_NO_WINDOW
        command.creation_flags(0x0000_4000 | 0x0800_0000);
    }
    let mut child = command.spawn()?;
    let mut stdout = child.stdout.take().ok_or_else(|| anyhow!("FFmpeg Scrub 输出不可用"))?;
    let reader = std::thread::spawn(move || -> std::io::Result<Vec<u8>> {
        let mut bytes = Vec::with_capacity(expected_max as usize);
        stdout.read_to_end(&mut bytes)?;
        Ok(bytes)
    });
    let deadline = Instant::now() + SOURCE_FRAME_DECODE_TIMEOUT;
    let process_result: Result<()> = loop {
            if canceled() {
                let _ = child.kill();
                let _ = child.wait();
                break Err(anyhow!("Scrub 帧请求已过期"));
            }
            match child.try_wait() {
                Ok(Some(status)) => {
                    if status.success() { break Ok(()); }
                    break Err(anyhow!("FFmpeg 无法解码原片帧 {frame_index}"));
                }
                Ok(None) => {}
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break Err(error.into());
                }
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                break Err(anyhow!("FFmpeg 原片帧解码超时"));
            }
            std::thread::sleep(Duration::from_millis(5));
    };
    let bytes = reader.join()
        .map_err(|_| anyhow!("FFmpeg Scrub 输出线程异常"))??;
    process_result?;
    if bytes.is_empty() || bytes.len() as u64 % frame_bytes != 0
        || bytes.len() as u64 > expected_max
    {
        return Err(anyhow!("FFmpeg 原片帧数据不完整"));
    }
    Ok(bytes)
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

#[cfg(test)]
fn ensure_h264_proxy(
    cache_root: &Path,
    asset_id: &str,
    source: &Path,
    canceled: &AtomicBool,
) -> Result<PathBuf> {
    ensure_h264_proxy_with_progress(cache_root, asset_id, source, canceled, &|_, _| {})
}

pub fn ensure_h264_proxy_with_progress(
    cache_root: &Path,
    asset_id: &str,
    source: &Path,
    canceled: &AtomicBool,
    progress: &dyn Fn(&str, f64),
) -> Result<PathBuf> {
    if let Some(output) = ready_proxy_path(cache_root, asset_id) {
        return Ok(output);
    }
    if canceled.load(Ordering::SeqCst) {
        return Err(anyhow!("视频代理任务已取消"));
    }
    let output = proxy_path(cache_root, asset_id);
    let ffmpeg = find_ffmpeg().ok_or_else(|| anyhow!("未找到 ffmpeg，无法生成逐帧代理"))?;
    fs::create_dir_all(proxy_directory(cache_root))?;
    cleanup_temporary_files(cache_root, asset_id);

    progress("indexing", 0.02);
    let source_index = ensure_source_index(cache_root, asset_id, source, canceled)?;
    progress("index-ready", 0.18);
    if let Some(reason) = source_index.unsupported_reason.as_deref() {
        return Err(anyhow!("该视频不支持无损逐帧代理：{reason}"));
    }

    let temporary = output.with_file_name(format!(".{asset_id}-{}.tmp.mp4", Uuid::new_v4()));
    let progress_file = output.with_file_name(format!(".{asset_id}-{}.progress", Uuid::new_v4()));
    let mut command = Command::new(&ffmpeg);
    command
        .args(["-y", "-hide_banner", "-loglevel", "error", "-i"])
        .arg(source)
        .args([
            "-map",
            "0:v:0",
            "-map",
            "0:a?",
            "-c:v",
            "libx264",
            "-threads",
            "2",
            "-preset",
            "veryfast",
            "-crf",
            "8",
            "-g",
            "6",
            "-keyint_min",
            "6",
            "-sc_threshold",
            "0",
            "-bf",
            "0",
            "-pix_fmt",
            "yuv420p",
            "-fps_mode",
            "passthrough",
            "-c:a",
            "aac",
            "-ac",
            "2",
            "-movflags",
            "+faststart",
            "-sn",
            "-nostats",
            "-progress",
        ]);
    command.arg(&progress_file);
    append_color_args(&mut command, &source_index);
    command
        .arg(&temporary)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0000_4000);
    }
    progress("transcoding", 0.20);
    let mut child = command.spawn()?;
    // Long 4K sources must not fail just because the old fixed three-minute
    // timeout expires. Allow roughly ten times source duration, capped at two
    // hours, while retaining the short-file safety floor.
    let duration_timeout = Duration::from_secs(
        (source_index.duration_us / 100_000).clamp(PROXY_MIN_TIMEOUT.as_secs(), 2 * 60 * 60),
    );
    let deadline = Instant::now() + duration_timeout;
    loop {
        if canceled.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = fs::remove_file(&temporary);
            let _ = fs::remove_file(&progress_file);
            return Err(anyhow!("视频代理任务已取消"));
        }
        if let Some(fraction) = read_ffmpeg_progress(&progress_file, source_index.duration_us) {
            progress("transcoding", 0.20 + fraction * 0.60);
        }
        match child.wait_timeout(PROXY_POLL)? {
            Some(status) if status.success() => break,
            Some(status) => {
                let _ = fs::remove_file(&temporary);
                let _ = fs::remove_file(&progress_file);
                return Err(anyhow!("ffmpeg 转码失败 ({status})"));
            }
            None if Instant::now() < deadline => continue,
            None => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = fs::remove_file(&temporary);
                let _ = fs::remove_file(&progress_file);
                return Err(anyhow!("ffmpeg 转码超时"));
            }
        }
    }
    let _ = fs::remove_file(&progress_file);
    progress("validating", 0.82);
    if !temporary.is_file() {
        return Err(anyhow!("代理文件未生成"));
    }
    let proxy_index = build_proxy_index(asset_id, &temporary, &source_index, canceled)?;
    let temporary_index = proxy_index_path(cache_root, asset_id)
        .with_file_name(format!(".{asset_id}-{}.tmp.json", Uuid::new_v4()));
    write_index(&temporary_index, &proxy_index)?;
    if output.exists() {
        fs::remove_file(&output)?;
    }
    fs::rename(&temporary, &output)?;
    let final_index = proxy_index_path(cache_root, asset_id);
    if final_index.exists() {
        fs::remove_file(&final_index)?;
    }
    fs::rename(&temporary_index, &final_index)?;
    trim_proxy_cache_with_budget(cache_root, PROXY_CACHE_BUDGET, Some(asset_id))?;
    progress("ready", 1.0);
    Ok(output)
}

fn append_color_args(command: &mut Command, index: &VideoScrubIndex) {
    if let Some(value) = index
        .color_primaries
        .as_deref()
        .filter(|value| *value != "unknown")
    {
        command.args(["-color_primaries", value]);
    }
    if let Some(value) = index
        .color_transfer
        .as_deref()
        .filter(|value| *value != "unknown")
    {
        command.args(["-color_trc", value]);
    }
    if let Some(value) = index
        .color_space
        .as_deref()
        .filter(|value| *value != "unknown")
    {
        command.args(["-colorspace", value]);
    }
    if let Some(value) = index
        .color_range
        .as_deref()
        .filter(|value| matches!(*value, "tv" | "pc"))
    {
        command.args(["-color_range", value]);
    }
}

fn read_ffmpeg_progress(path: &Path, duration_us: u64) -> Option<f64> {
    if duration_us == 0 {
        return None;
    }
    let text = fs::read_to_string(path).ok()?;
    let out_time = text.lines().rev().find_map(|line| {
        let (key, value) = line.split_once('=')?;
        matches!(key, "out_time_us" | "out_time_ms")
            .then(|| value.parse::<u64>().ok())
            .flatten()
    })?;
    Some((out_time as f64 / duration_us as f64).clamp(0.0, 1.0))
}

fn ensure_source_index(
    cache_root: &Path,
    asset_id: &str,
    source: &Path,
    canceled: &AtomicBool,
) -> Result<VideoScrubIndex> {
    if let Some(index) = ready_source_index(cache_root, asset_id) {
        return Ok(index);
    }
    let metadata = probe_stream(source)?;
    let frames = probe_frames(source, metadata.fps, canceled)?;
    let unsupported_reason = unsupported_source_reason(&metadata);
    let duration_us = frames
        .last()
        .map(|frame| (frame.pts_us.max(0) as u64).saturating_add(frame.duration_us))
        .or_else(|| metadata.duration_sec.map(seconds_to_us))
        .unwrap_or(0);
    let index = VideoScrubIndex {
        version: SCRUB_INDEX_VERSION,
        asset_id: asset_id.to_string(),
        codec: metadata.codec_name.clone(),
        description_base64: String::new(),
        width: metadata.width,
        height: metadata.height,
        fps: metadata.fps,
        frame_count: u32::try_from(frames.len()).map_err(|_| anyhow!("视频帧数过大"))?,
        duration_us,
        vfr: is_vfr(&frames),
        pix_fmt: metadata.pix_fmt,
        color_range: metadata.color_range,
        color_space: metadata.color_space,
        color_transfer: metadata.color_transfer,
        color_primaries: metadata.color_primaries,
        proxy_ready: false,
        frame_accurate: !frames.is_empty(),
        unsupported_reason,
        frames,
        packets: Vec::new(),
    };
    write_index(&source_index_path(cache_root, asset_id), &index)?;
    Ok(index)
}

fn build_proxy_index(
    asset_id: &str,
    proxy: &Path,
    source: &VideoScrubIndex,
    canceled: &AtomicBool,
) -> Result<VideoScrubIndex> {
    let metadata = probe_stream(proxy)?;
    let frames = probe_frames(proxy, metadata.fps, canceled)?;
    if frames.len() != source.frames.len() {
        return Err(anyhow!(
            "逐帧代理验证失败：源帧 {}，代理帧 {}",
            source.frames.len(),
            frames.len()
        ));
    }
    validate_monotonic_frames(&frames)?;
    validate_frame_correspondence(&source.frames, &frames)?;
    if metadata.width != source.width || metadata.height != source.height {
        return Err(anyhow!("逐帧代理验证失败：分辨率发生变化"));
    }
    validate_color_metadata(source, &metadata)?;
    let packets = probe_packets(proxy, canceled)?;
    if packets.len() != frames.len() {
        return Err(anyhow!("逐帧代理验证失败：packet 与帧数不一致"));
    }
    validate_packet_correspondence(&frames, &packets)?;
    validate_gop(&packets, 6)?;
    let description = read_avcc(proxy)?;
    let codec = format!(
        "avc1.{:02X}{:02X}{:02X}",
        description[1], description[2], description[3]
    );
    Ok(VideoScrubIndex {
        version: SCRUB_INDEX_VERSION,
        asset_id: asset_id.to_string(),
        codec,
        description_base64: BASE64.encode(description),
        width: metadata.width,
        height: metadata.height,
        fps: source.fps,
        frame_count: source.frame_count,
        duration_us: source.duration_us,
        vfr: source.vfr,
        pix_fmt: metadata.pix_fmt,
        color_range: metadata.color_range,
        color_space: metadata.color_space,
        color_transfer: metadata.color_transfer,
        color_primaries: metadata.color_primaries,
        proxy_ready: true,
        frame_accurate: true,
        unsupported_reason: None,
        frames,
        packets,
    })
}

fn validate_color_metadata(source: &VideoScrubIndex, proxy: &StreamMetadata) -> Result<()> {
    let pairs = [
        (
            "color_range",
            source.color_range.as_deref(),
            proxy.color_range.as_deref(),
        ),
        (
            "color_space",
            source.color_space.as_deref(),
            proxy.color_space.as_deref(),
        ),
        (
            "color_transfer",
            source.color_transfer.as_deref(),
            proxy.color_transfer.as_deref(),
        ),
        (
            "color_primaries",
            source.color_primaries.as_deref(),
            proxy.color_primaries.as_deref(),
        ),
    ];
    for (name, expected, actual) in pairs {
        if let Some(expected) = expected.filter(|value| *value != "unknown") {
            if actual != Some(expected) {
                return Err(anyhow!("逐帧代理验证失败：{name} 未保留"));
            }
        }
    }
    Ok(())
}

fn unsupported_source_reason(metadata: &StreamMetadata) -> Option<String> {
    if !matches!(metadata.codec_name.as_str(), "h264" | "hevc" | "vp9") {
        return Some(format!("暂不支持 {} 编码", metadata.codec_name));
    }
    let pix = metadata.pix_fmt.to_ascii_lowercase();
    if pix.contains('a') && !pix.starts_with("yuv") {
        return Some("Alpha 视频".into());
    }
    if pix.starts_with("yuva") || pix.contains("rgba") || pix.contains("bgra") {
        return Some("Alpha 视频".into());
    }
    if pix.contains("10")
        || pix.contains("12")
        || pix.contains("16")
        || pix.contains("422")
        || pix.contains("444")
    {
        return Some(format!("{} 像素格式", metadata.pix_fmt));
    }
    if !matches!(pix.as_str(), "yuv420p" | "yuvj420p") {
        return Some(format!("{} 像素格式", metadata.pix_fmt));
    }
    if matches!(
        metadata.color_transfer.as_deref(),
        Some("smpte2084" | "arib-std-b67")
    ) || metadata.color_primaries.as_deref() == Some("bt2020")
    {
        return Some("HDR/BT.2020 视频".into());
    }
    None
}

fn probe_stream(source: &Path) -> Result<StreamMetadata> {
    let ffprobe = ffprobe_path()?;
    let output = Command::new(ffprobe)
        .args(["-v", "error", "-select_streams", "v:0", "-show_entries",
            "stream=codec_name,width,height,pix_fmt,avg_frame_rate,duration,color_range,color_space,color_transfer,color_primaries",
            "-of", "default=noprint_wrappers=1"])
        .arg(source).output()?;
    if !output.status.success() {
        return Err(anyhow!("ffprobe 无法读取视频流"));
    }
    let mut values = std::collections::HashMap::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        if let Some((key, value)) = line.trim().split_once('=') {
            values.insert(key.to_string(), value.to_string());
        }
    }
    let width = parse_value::<u32>(&values, "width")?;
    let height = parse_value::<u32>(&values, "height")?;
    let fps = values
        .get("avg_frame_rate")
        .and_then(|value| parse_rate(value))
        .unwrap_or(30.0);
    Ok(StreamMetadata {
        codec_name: values
            .remove("codec_name")
            .unwrap_or_else(|| "unknown".into()),
        width,
        height,
        pix_fmt: values.remove("pix_fmt").unwrap_or_else(|| "unknown".into()),
        fps,
        duration_sec: values.get("duration").and_then(|value| value.parse().ok()),
        color_range: clean_metadata(values.remove("color_range")),
        color_space: clean_metadata(values.remove("color_space")),
        color_transfer: clean_metadata(values.remove("color_transfer")),
        color_primaries: clean_metadata(values.remove("color_primaries")),
    })
}

fn clean_metadata(value: Option<String>) -> Option<String> {
    value.filter(|value| !value.is_empty() && value != "unknown" && value != "N/A")
}

fn parse_value<T: std::str::FromStr>(
    values: &std::collections::HashMap<String, String>,
    key: &str,
) -> Result<T> {
    values
        .get(key)
        .ok_or_else(|| anyhow!("视频缺少 {key}"))?
        .parse()
        .map_err(|_| anyhow!("视频 {key} 无效"))
}

fn probe_frames(
    source: &Path,
    fps: f64,
    canceled: &AtomicBool,
) -> Result<Vec<VideoFrameIndexEntry>> {
    let mut child = Command::new(ffprobe_path()?)
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_frames",
            "-show_entries",
            "frame=key_frame,best_effort_timestamp_time,pkt_duration_time",
            "-of",
            "compact=p=0:nk=0",
        ])
        .arg(source)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("ffprobe stdout 不可用"))?;
    let mut raw = Vec::<(i64, Option<u64>, bool)>::new();
    for line in BufReader::new(stdout).lines() {
        if canceled.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(anyhow!("视频代理任务已取消"));
        }
        let line = line?;
        let values = parse_compact_line(&line);
        let Some(pts) = values
            .get("best_effort_timestamp_time")
            .and_then(|value| value.parse::<f64>().ok())
        else {
            continue;
        };
        let duration = values
            .get("pkt_duration_time")
            .and_then(|value| value.parse::<f64>().ok())
            .map(seconds_to_us);
        raw.push((
            seconds_to_i64_us(pts),
            duration,
            values.get("key_frame").is_some_and(|value| value == "1"),
        ));
    }
    let status = child.wait()?;
    if !status.success() || raw.is_empty() {
        return Err(anyhow!("ffprobe 未返回视频帧"));
    }
    let origin = raw[0].0;
    let fallback = (1_000_000.0 / fps.max(1.0)).round().max(1.0) as u64;
    let mut frames = Vec::with_capacity(raw.len());
    for index in 0..raw.len() {
        let pts = raw[index].0 - origin;
        let next_duration = raw
            .get(index + 1)
            .map(|next| (next.0 - raw[index].0).max(1) as u64);
        let duration = raw[index]
            .1
            .filter(|value| *value > 0)
            .or(next_duration)
            .unwrap_or(fallback);
        frames.push(VideoFrameIndexEntry {
            frame_index: index as u32,
            pts_us: pts,
            duration_us: duration,
            key_frame: raw[index].2,
        });
    }
    validate_monotonic_frames(&frames)?;
    Ok(frames)
}

fn probe_packets(source: &Path, canceled: &AtomicBool) -> Result<Vec<VideoPacketIndexEntry>> {
    let mut child = Command::new(ffprobe_path()?)
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_packets",
            "-show_entries",
            "packet=pts_time,duration_time,pos,size,flags",
            "-of",
            "compact=p=0:nk=0",
        ])
        .arg(source)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("ffprobe stdout 不可用"))?;
    let mut raw = Vec::<(i64, u64, u64, u32, bool)>::new();
    for line in BufReader::new(stdout).lines() {
        if canceled.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(anyhow!("视频代理任务已取消"));
        }
        let values = parse_compact_line(&line?);
        let Some(pts) = values
            .get("pts_time")
            .and_then(|value| value.parse::<f64>().ok())
        else {
            continue;
        };
        let duration = values
            .get("duration_time")
            .and_then(|value| value.parse::<f64>().ok())
            .map(seconds_to_us)
            .unwrap_or(0);
        let offset = values
            .get("pos")
            .and_then(|value| value.parse::<u64>().ok())
            .ok_or_else(|| anyhow!("packet offset 无效"))?;
        let size = values
            .get("size")
            .and_then(|value| value.parse::<u32>().ok())
            .ok_or_else(|| anyhow!("packet size 无效"))?;
        let key = values.get("flags").is_some_and(|value| value.contains('K'));
        raw.push((seconds_to_i64_us(pts), duration, offset, size, key));
    }
    let status = child.wait()?;
    if !status.success() || raw.is_empty() {
        return Err(anyhow!("ffprobe 未返回视频 packet"));
    }
    let origin = raw[0].0;
    Ok(raw
        .into_iter()
        .enumerate()
        .map(|(index, value)| VideoPacketIndexEntry {
            frame_index: index as u32,
            pts_us: value.0 - origin,
            duration_us: value.1,
            offset: value.2,
            size: value.3,
            key_frame: value.4,
        })
        .collect())
}

fn parse_compact_line(line: &str) -> std::collections::HashMap<String, String> {
    line.split('|')
        .filter_map(|field| field.split_once('='))
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect()
}

fn validate_monotonic_frames(frames: &[VideoFrameIndexEntry]) -> Result<()> {
    if frames.is_empty() {
        return Err(anyhow!("视频没有可索引帧"));
    }
    for pair in frames.windows(2) {
        if pair[1].pts_us <= pair[0].pts_us {
            return Err(anyhow!("视频帧 PTS 非单调递增"));
        }
    }
    Ok(())
}

fn validate_frame_correspondence(
    source: &[VideoFrameIndexEntry],
    proxy: &[VideoFrameIndexEntry],
) -> Result<()> {
    if source.len() != proxy.len() {
        return Err(anyhow!("代理帧数与源视频不一致"));
    }
    for (source_frame, proxy_frame) in source.iter().zip(proxy) {
        if source_frame.frame_index != proxy_frame.frame_index
            || source_frame.pts_us.abs_diff(proxy_frame.pts_us) > 250
        {
            return Err(anyhow!(
                "代理 PTS 未保持源视频展示顺序：frame {}",
                source_frame.frame_index
            ));
        }
    }
    Ok(())
}

fn validate_packet_correspondence(
    frames: &[VideoFrameIndexEntry],
    packets: &[VideoPacketIndexEntry],
) -> Result<()> {
    if frames.len() != packets.len() {
        return Err(anyhow!("代理 packet 数量与帧数不一致"));
    }
    for (frame, packet) in frames.iter().zip(packets) {
        if frame.frame_index != packet.frame_index || frame.pts_us.abs_diff(packet.pts_us) > 2 {
            return Err(anyhow!(
                "代理 packet 与展示帧不对应：frame {}",
                frame.frame_index
            ));
        }
    }
    Ok(())
}

fn validate_gop(packets: &[VideoPacketIndexEntry], max_gop: usize) -> Result<()> {
    let mut distance = max_gop + 1;
    for (index, packet) in packets.iter().enumerate() {
        if packet.key_frame {
            distance = 0;
        } else {
            distance += 1;
        }
        if index == 0 && !packet.key_frame {
            return Err(anyhow!("代理首帧不是关键帧"));
        }
        if distance >= max_gop {
            return Err(anyhow!("代理 GOP 超过 {max_gop} 帧"));
        }
    }
    Ok(())
}

fn is_vfr(frames: &[VideoFrameIndexEntry]) -> bool {
    if frames.len() < 3 {
        return false;
    }
    let mut durations: Vec<u64> = frames
        .iter()
        .take(frames.len() - 1)
        .map(|frame| frame.duration_us)
        .collect();
    durations.sort_unstable();
    let median = durations[durations.len() / 2].max(1);
    durations
        .into_iter()
        .any(|duration| duration.abs_diff(median) > (median / 200).max(50))
}

fn read_avcc(path: &Path) -> Result<Vec<u8>> {
    let mut file = File::open(path)?;
    let limit = fs::metadata(path)?.len().min(8 * 1024 * 1024) as usize;
    let mut bytes = vec![0_u8; limit];
    file.read_exact(&mut bytes)?;
    for marker in 4..bytes.len().saturating_sub(8) {
        if &bytes[marker..marker + 4] != b"avcC" {
            continue;
        }
        let size = u32::from_be_bytes(bytes[marker - 4..marker].try_into()?) as usize;
        if !(12..=4096).contains(&size) || marker + size - 4 > bytes.len() {
            continue;
        }
        let payload = bytes[marker + 4..marker + size - 4].to_vec();
        if payload.len() >= 7 && payload[0] == 1 {
            return Ok(payload);
        }
    }
    Err(anyhow!("代理缺少有效 avcC decoder config"))
}

pub fn packet_batch(
    index: &VideoScrubIndex,
    proxy: &Path,
    start_frame: u32,
    count: usize,
) -> Result<Vec<u8>> {
    if !index.proxy_ready || index.packets.is_empty() {
        return Err(anyhow!("逐帧 packet 尚未就绪"));
    }
    if count == 0 || count > MAX_PACKET_BATCH_FRAMES {
        return Err(anyhow!("packet count 超出范围"));
    }
    let start = usize::try_from(start_frame).map_err(|_| anyhow!("frame 超出范围"))?;
    if start >= index.packets.len() {
        return Err(anyhow!("frame 超出范围"));
    }
    let selected = &index.packets[start..(start + count).min(index.packets.len())];
    let data_bytes = selected.iter().try_fold(0_u64, |sum, packet| {
        sum.checked_add(packet.size as u64)
            .ok_or_else(|| anyhow!("packet 大小溢出"))
    })?;
    let header_bytes = 8_u64 + selected.len() as u64 * 28;
    let total_bytes = header_bytes
        .checked_add(data_bytes)
        .ok_or_else(|| anyhow!("packet batch 溢出"))?;
    if total_bytes > MAX_PACKET_BATCH_BYTES {
        return Err(anyhow!("packet batch 超过 32 MiB"));
    }
    let capacity = usize::try_from(total_bytes).map_err(|_| anyhow!("packet batch 溢出"))?;
    let mut output = Vec::with_capacity(capacity);
    output.extend_from_slice(b"YSB1");
    output.extend_from_slice(&(selected.len() as u32).to_le_bytes());
    let mut file = File::open(proxy)?;
    for packet in selected {
        output.extend_from_slice(&packet.frame_index.to_le_bytes());
        output.push(u8::from(packet.key_frame));
        output.extend_from_slice(&[0_u8; 3]);
        output.extend_from_slice(&(packet.pts_us as f64).to_le_bytes());
        output.extend_from_slice(&(packet.duration_us as f64).to_le_bytes());
        output.extend_from_slice(&packet.size.to_le_bytes());
        file.seek(SeekFrom::Start(packet.offset))?;
        let start = output.len();
        output.resize(start + packet.size as usize, 0);
        file.read_exact(&mut output[start..])?;
    }
    Ok(output)
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
