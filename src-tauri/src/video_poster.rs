use std::{io::Cursor, path::Path};

use anyhow::Result;
use png::{BitDepth, ColorType, Encoder};

/// Build a still poster for a video board item.
/// Prefers a Windows Shell thumbnail when available; otherwise draws a placeholder.
pub fn video_poster_png(path: &Path, edge: u32, width: u32, height: u32) -> Result<Vec<u8>> {
    #[cfg(windows)]
    if let Ok(bytes) = shell_thumbnail_png(path, edge) {
        if bytes.len() > 100 { return Ok(bytes); }
    }
    placeholder_poster_png(width.max(1), height.max(1), edge)
}

pub fn placeholder_poster_png(width: u32, height: u32, edge: u32) -> Result<Vec<u8>> {
    let edge = edge.max(64);
    let scale = (edge as f64) / (width.max(height).max(1) as f64);
    let out_w = ((width as f64) * scale).round().max(1.0) as u32;
    let out_h = ((height as f64) * scale).round().max(1.0) as u32;
    let mut pixels = vec![0_u8; (out_w * out_h * 4) as usize];
    for y in 0..out_h {
        for x in 0..out_w {
            let index = ((y * out_w + x) * 4) as usize;
            pixels[index] = 0x1a;
            pixels[index + 1] = 0x1d;
            pixels[index + 2] = 0x24;
            pixels[index + 3] = 0xff;
        }
    }
    let cx = out_w as i32 / 2;
    let cy = out_h as i32 / 2;
    let size = (out_w.min(out_h) as i32 / 6).max(8);
    for y in -size..=size {
        let max_x = ((size - y.abs()) * 5) / 6;
        for x in -(size / 4)..=max_x {
            let px = cx + x;
            let py = cy + y;
            if px < 0 || py < 0 || px >= out_w as i32 || py >= out_h as i32 { continue; }
            let index = ((py as u32 * out_w + px as u32) * 4) as usize;
            pixels[index] = 0xf2;
            pixels[index + 1] = 0xf4;
            pixels[index + 2] = 0xf8;
            pixels[index + 3] = 0xff;
        }
    }
    encode_rgba_png(out_w, out_h, &pixels)
}

fn encode_rgba_png(width: u32, height: u32, pixels: &[u8]) -> Result<Vec<u8>> {
    let mut encoded = Vec::new();
    {
        let mut encoder = Encoder::new(Cursor::new(&mut encoded), width, height);
        encoder.set_color(ColorType::Rgba);
        encoder.set_depth(BitDepth::Eight);
        let mut writer = encoder.write_header()?;
        writer.write_image_data(pixels)?;
    }
    Ok(encoded)
}

#[cfg(windows)]
fn shell_thumbnail_png(path: &Path, edge: u32) -> Result<Vec<u8>> {
    use std::mem::size_of;
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        core::{Interface, PCWSTR},
        Win32::{
            Foundation::SIZE,
            Graphics::Gdi::{
                CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, BITMAP, BITMAPINFO,
                BITMAPINFOHEADER, DIB_RGB_COLORS, HBITMAP, HGDIOBJ,
            },
            System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED},
            UI::Shell::{
                IShellItem, IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_BIGGERSIZEOK,
                SIIGBF_RESIZETOFIT,
            },
        },
    };

    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let edge = edge.clamp(128, 2048) as i32;
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let item: IShellItem = SHCreateItemFromParsingName(PCWSTR(wide.as_ptr()), None)?;
        let factory: IShellItemImageFactory = item.cast()?;
        let bitmap: HBITMAP = factory.GetImage(
            SIZE { cx: edge, cy: edge },
            SIIGBF_BIGGERSIZEOK | SIIGBF_RESIZETOFIT,
        )?;
        let mut info = BITMAP::default();
        if GetObjectW(HGDIOBJ(bitmap.0), size_of::<BITMAP>() as i32, Some((&mut info as *mut BITMAP).cast())) == 0 {
            let _ = DeleteObject(HGDIOBJ(bitmap.0));
            CoUninitialize();
            return Err(anyhow::anyhow!("GetObjectW 失败"));
        }
        let width = info.bmWidth.max(1) as u32;
        let height = info.bmHeight.abs().max(1) as u32;
        let mut header = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width as i32,
                biHeight: -(height as i32),
                biPlanes: 1,
                biBitCount: 32,
                biCompression: 0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut pixels = vec![0_u8; (width * height * 4) as usize];
        let hdc = CreateCompatibleDC(None);
        if hdc.is_invalid() {
            let _ = DeleteObject(HGDIOBJ(bitmap.0));
            CoUninitialize();
            return Err(anyhow::anyhow!("CreateCompatibleDC 失败"));
        }
        let copied = GetDIBits(hdc, bitmap, 0, height, Some(pixels.as_mut_ptr().cast()), &mut header, DIB_RGB_COLORS);
        let _ = DeleteDC(hdc);
        let _ = DeleteObject(HGDIOBJ(bitmap.0));
        CoUninitialize();
        if copied == 0 { return Err(anyhow::anyhow!("GetDIBits 失败")); }
        for chunk in pixels.as_chunks_mut::<4>().0 {
            chunk.swap(0, 2);
            chunk[3] = 0xff;
        }
        encode_rgba_png(width, height, &pixels)
    }
}
