use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

use anyhow::{anyhow, Result};

use super::{
    find_ffmpeg, VideoFrameIndexEntry, VideoScrubIndex, MAX_PACKET_BATCH_BYTES, MAX_PACKET_BATCH_FRAMES,
    MAX_SOURCE_FRAME_BYTES, SOURCE_FRAME_DECODE_TIMEOUT,
};

pub(crate) fn previous_keyframe_index(frames: &[VideoFrameIndexEntry], frame_index: u32) -> usize {
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
pub(crate) fn scrub_keyframe_skip(index: &VideoScrubIndex, start_frame: u32) -> (u64, u32) {
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
