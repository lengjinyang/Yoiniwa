use std::{fs::File, io::{Read, Seek, SeekFrom}, path::Path};

use anyhow::{anyhow, Result};

#[derive(Clone, Debug, Default)]
pub struct VideoMetadata {
    pub width: u32,
    pub height: u32,
    pub duration_sec: Option<f64>,
}

/// Best-effort container metadata for MP4 / QuickTime (no codec decode).
pub fn read_video_metadata(path: &Path) -> Result<VideoMetadata> {
    let mut file = File::open(path)?;
    let length = file.seek(SeekFrom::End(0))?;
    file.seek(SeekFrom::Start(0))?;
    let mut meta = VideoMetadata::default();
    walk_boxes(&mut file, 0, length, &mut meta, 0)?;
    if meta.width == 0 || meta.height == 0 {
        return Err(anyhow!("无法从视频容器读取尺寸"));
    }
    Ok(meta)
}

fn walk_boxes(file: &mut File, start: u64, end: u64, meta: &mut VideoMetadata, depth: u8) -> Result<()> {
    if depth > 12 || start >= end { return Ok(()); }
    let mut offset = start;
    while offset + 8 <= end {
        file.seek(SeekFrom::Start(offset))?;
        let mut header = [0_u8; 8];
        file.read_exact(&mut header)?;
        let mut size = u32::from_be_bytes(header[0..4].try_into()?) as u64;
        let kind = &header[4..8];
        let mut header_len = 8_u64;
        if size == 1 {
            if offset + 16 > end { break; }
            let mut large = [0_u8; 8];
            file.read_exact(&mut large)?;
            size = u64::from_be_bytes(large);
            header_len = 16;
        } else if size == 0 {
            size = end.saturating_sub(offset);
        }
        if size < header_len || offset + size > end { break; }
        let content_start = offset + header_len;
        let content_end = offset + size;
        match kind {
            b"moov" | b"trak" | b"mdia" | b"minf" | b"stbl" => {
                walk_boxes(file, content_start, content_end, meta, depth + 1)?;
            }
            b"mvhd" => {
                if let Ok(duration) = read_mvhd(file, content_start, content_end) {
                    if meta.duration_sec.is_none() { meta.duration_sec = Some(duration); }
                }
            }
            b"tkhd" => {
                if let Ok((width, height)) = read_tkhd(file, content_start, content_end) {
                    if width > 0 && height > 0 && (meta.width == 0 || width * height > meta.width * meta.height) {
                        meta.width = width;
                        meta.height = height;
                    }
                }
            }
            _ => {}
        }
        offset = content_end;
    }
    Ok(())
}

fn read_mvhd(file: &mut File, start: u64, end: u64) -> Result<f64> {
    file.seek(SeekFrom::Start(start))?;
    let mut version = [0_u8; 1];
    file.read_exact(&mut version)?;
    let (timescale, duration) = if version[0] == 1 {
        if end.saturating_sub(start) < 1 + 3 + 8 + 8 + 4 + 8 { return Err(anyhow!("mvhd v1 truncated")); }
        let mut skip = [0_u8; 19]; // flags(3)+creation(8)+modification(8)
        file.read_exact(&mut skip)?;
        let mut values = [0_u8; 12];
        file.read_exact(&mut values)?;
        let timescale = u32::from_be_bytes(values[0..4].try_into()?) as u64;
        let duration = u64::from_be_bytes(values[4..12].try_into()?);
        (timescale, duration)
    } else {
        if end.saturating_sub(start) < 1 + 3 + 4 + 4 + 4 + 4 { return Err(anyhow!("mvhd v0 truncated")); }
        let mut skip = [0_u8; 11]; // flags(3)+creation(4)+modification(4)
        file.read_exact(&mut skip)?;
        let mut values = [0_u8; 8];
        file.read_exact(&mut values)?;
        let timescale = u32::from_be_bytes(values[0..4].try_into()?) as u64;
        let duration = u32::from_be_bytes(values[4..8].try_into()?) as u64;
        (timescale, duration)
    };
    if timescale == 0 { return Err(anyhow!("mvhd timescale 无效")); }
    Ok(duration as f64 / timescale as f64)
}

fn read_tkhd(file: &mut File, start: u64, end: u64) -> Result<(u32, u32)> {
    file.seek(SeekFrom::Start(start))?;
    let mut version = [0_u8; 1];
    file.read_exact(&mut version)?;
    // width/height are the last 8 bytes of tkhd as 16.16 fixed point.
    if end < start + 8 { return Err(anyhow!("tkhd truncated")); }
    file.seek(SeekFrom::Start(end - 8))?;
    let mut tail = [0_u8; 8];
    file.read_exact(&mut tail)?;
    let width = u32::from_be_bytes(tail[0..4].try_into()?) >> 16;
    let height = u32::from_be_bytes(tail[4..8].try_into()?) >> 16;
    Ok((width, height))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_sample_hevc_mp4_if_present() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tmp/sample-hevc.mp4");
        if !path.exists() { return; }
        let meta = read_video_metadata(&path).expect("metadata");
        assert_eq!(meta.width, 2560);
        assert_eq!(meta.height, 1440);
        assert!(meta.duration_sec.unwrap_or(0.0) > 19.0);
    }
}
