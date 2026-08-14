use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

use anyhow::{anyhow, Result};
use uuid::Uuid;
use wait_timeout::ChildExt;

use super::index::{build_proxy_index, ensure_source_index};
use super::{
    cleanup_temporary_files, find_ffmpeg, proxy_directory, proxy_index_path, proxy_path,
    ready_proxy_path, trim_proxy_cache_with_budget, write_index, VideoScrubIndex, PROXY_CACHE_BUDGET,
    PROXY_MIN_TIMEOUT, PROXY_POLL,
};

#[cfg(test)]
pub(crate) fn ensure_h264_proxy(
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

pub(crate) fn append_color_args(command: &mut Command, index: &VideoScrubIndex) {
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

pub(crate) fn read_ffmpeg_progress(path: &Path, duration_us: u64) -> Option<f64> {
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
