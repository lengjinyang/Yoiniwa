use std::{
    fs::{self, File},
    io::{BufRead, BufReader, Read},
    path::Path,
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
};

use anyhow::{anyhow, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};

use super::{
    ffprobe_path, parse_rate, ready_source_index, seconds_to_i64_us, seconds_to_us,
    source_index_path, write_index, StreamMetadata, VideoFrameIndexEntry, VideoPacketIndexEntry,
    VideoScrubIndex, SCRUB_INDEX_VERSION,
};

pub fn ensure_source_frame_index(
    cache_root: &Path,
    asset_id: &str,
    source: &Path,
    canceled: &AtomicBool,
) -> Result<VideoScrubIndex> {
    ensure_source_index(cache_root, asset_id, source, canceled)
}
pub(crate) fn ensure_source_index(
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

pub(crate) fn build_proxy_index(
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

pub(crate) fn validate_color_metadata(source: &VideoScrubIndex, proxy: &StreamMetadata) -> Result<()> {
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

pub(crate) fn unsupported_source_reason(metadata: &StreamMetadata) -> Option<String> {
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

pub(crate) fn probe_stream(source: &Path) -> Result<StreamMetadata> {
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

pub(crate) fn clean_metadata(value: Option<String>) -> Option<String> {
    value.filter(|value| !value.is_empty() && value != "unknown" && value != "N/A")
}

pub(crate) fn parse_value<T: std::str::FromStr>(
    values: &std::collections::HashMap<String, String>,
    key: &str,
) -> Result<T> {
    values
        .get(key)
        .ok_or_else(|| anyhow!("视频缺少 {key}"))?
        .parse()
        .map_err(|_| anyhow!("视频 {key} 无效"))
}

pub(crate) fn probe_frames(
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

pub(crate) fn probe_packets(source: &Path, canceled: &AtomicBool) -> Result<Vec<VideoPacketIndexEntry>> {
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

pub(crate) fn parse_compact_line(line: &str) -> std::collections::HashMap<String, String> {
    line.split('|')
        .filter_map(|field| field.split_once('='))
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect()
}

pub(crate) fn validate_monotonic_frames(frames: &[VideoFrameIndexEntry]) -> Result<()> {
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

pub(crate) fn validate_frame_correspondence(
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

pub(crate) fn validate_packet_correspondence(
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

pub(crate) fn validate_gop(packets: &[VideoPacketIndexEntry], max_gop: usize) -> Result<()> {
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

pub(crate) fn is_vfr(frames: &[VideoFrameIndexEntry]) -> bool {
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

pub(crate) fn read_avcc(path: &Path) -> Result<Vec<u8>> {
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
