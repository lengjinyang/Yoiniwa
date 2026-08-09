use std::{
    ffi::{c_char, c_int, c_void, CStr, CString},
    path::Path,
    ptr,
    sync::OnceLock,
    time::Instant,
};

use anyhow::{anyhow, Context, Result};
use parking_lot::Mutex;

use crate::types::ImagePipelinePerformanceStats;

#[repr(C)]
struct VipsImageOpaque { _private: [u8; 0] }

#[link(name = "vips")]
extern "C" {
    fn vips_init(argv0: *const c_char) -> c_int;
    fn vips_shutdown();
    fn vips_concurrency_set(concurrency: c_int);
    fn vips_error_buffer() -> *const c_char;
    fn vips_error_clear();
    fn vips_image_new_from_file(name: *const c_char, ...) -> *mut VipsImageOpaque;
    fn vips_image_new_from_buffer(data: *const c_void, size: usize, option_string: *const c_char, ...) -> *mut VipsImageOpaque;
    fn vips_image_get_width(image: *const VipsImageOpaque) -> c_int;
    fn vips_image_get_height(image: *const VipsImageOpaque) -> c_int;
    fn vips_image_get_bands(image: *const VipsImageOpaque) -> c_int;
    fn vips_image_get_orientation(image: *const VipsImageOpaque) -> c_int;
    fn vips_image_hasalpha(image: *const VipsImageOpaque) -> c_int;
    fn vips_image_write_to_memory(image: *mut VipsImageOpaque, size: *mut usize) -> *mut c_void;
    fn vips_thumbnail(filename: *const c_char, output: *mut *mut VipsImageOpaque, width: c_int, ...) -> c_int;
    fn vips_thumbnail_image(input: *mut VipsImageOpaque, output: *mut *mut VipsImageOpaque, width: c_int, ...) -> c_int;
    fn vips_autorot(input: *mut VipsImageOpaque, output: *mut *mut VipsImageOpaque, ...) -> c_int;
    fn vips_extract_area(input: *mut VipsImageOpaque, output: *mut *mut VipsImageOpaque, left: c_int, top: c_int, width: c_int, height: c_int, ...) -> c_int;
    fn vips_pngsave_buffer(input: *mut VipsImageOpaque, output: *mut *mut c_void, size: *mut usize, ...) -> c_int;
    fn vips_webpsave_buffer(input: *mut VipsImageOpaque, output: *mut *mut c_void, size: *mut usize, ...) -> c_int;
}

#[link(name = "glib-2.0")]
extern "C" { fn g_free(pointer: *mut c_void); }
#[link(name = "gobject-2.0")]
extern "C" { fn g_object_unref(object: *mut c_void); }

static VIPS_READY: OnceLock<()> = OnceLock::new();
static VIPS_LOCK: Mutex<()> = Mutex::new(());

struct VipsImage(*mut VipsImageOpaque);
impl Drop for VipsImage { fn drop(&mut self) { if !self.0.is_null() { unsafe { g_object_unref(self.0.cast()) }; } } }

#[derive(Clone, Debug)]
pub struct ImageMetadata { pub width: u32, pub height: u32, pub orientation: i32, pub has_alpha: bool }

fn initialize() -> Result<()> {
    if VIPS_READY.get().is_some() { return Ok(()); }
    let name = CString::new("yoiniwa")?;
    if unsafe { vips_init(name.as_ptr()) } != 0 { return Err(vips_error("libvips 初始化失败")); }
    unsafe { vips_concurrency_set(1) };
    let _ = VIPS_READY.set(());
    Ok(())
}

fn vips_error(context: &str) -> anyhow::Error {
    unsafe {
        let pointer = vips_error_buffer();
        let detail = if pointer.is_null() { String::new() } else { CStr::from_ptr(pointer).to_string_lossy().into_owned() };
        vips_error_clear();
        anyhow!("{context}: {detail}")
    }
}

fn c_path(path: &Path) -> Result<CString> { CString::new(path.to_string_lossy().as_bytes()).map_err(Into::into) }
fn option(value: &str) -> CString { CString::new(value).unwrap() }
fn terminator() -> *const c_char { ptr::null() }

fn load(path: &Path) -> Result<VipsImage> {
    initialize()?; let path = c_path(path)?;
    let image = unsafe { vips_image_new_from_file(path.as_ptr(), terminator()) };
    if image.is_null() { Err(vips_error("图片无法解码")) } else { Ok(VipsImage(image)) }
}

fn load_buffer(bytes: &[u8]) -> Result<VipsImage> {
    initialize()?; let options = option("");
    let image = unsafe { vips_image_new_from_buffer(bytes.as_ptr().cast(), bytes.len(), options.as_ptr(), terminator()) };
    if image.is_null() { Err(vips_error("图片无法解码")) } else { Ok(VipsImage(image)) }
}

fn autorot(source: &VipsImage) -> Result<VipsImage> {
    let mut output = ptr::null_mut();
    let status = unsafe { vips_autorot(source.0, &mut output, terminator()) };
    if status != 0 || output.is_null() { Err(vips_error("图片方向修正失败")) } else { Ok(VipsImage(output)) }
}

fn dimensions(image: &VipsImage) -> (i32, i32) { unsafe { (vips_image_get_width(image.0), vips_image_get_height(image.0)) } }
fn bands(image: &VipsImage) -> usize { unsafe { vips_image_get_bands(image.0).max(1) as usize } }

pub fn metadata(path: &Path, stats: &Mutex<ImagePipelinePerformanceStats>) -> Result<ImageMetadata> {
    let started = Instant::now(); let _guard = VIPS_LOCK.lock(); let image = load(path)?;
    let (raw_width, raw_height) = dimensions(&image); if raw_width < 1 || raw_height < 1 { return Err(anyhow!("图片尺寸无效")); }
    let orientation = unsafe { vips_image_get_orientation(image.0) }; let swaps = matches!(orientation, 5 | 6 | 7 | 8);
    let mut current = stats.lock(); current.metadata_count += 1; current.metadata_ms += started.elapsed().as_secs_f64() * 1000.0;
    Ok(ImageMetadata {
        width: if swaps { raw_height } else { raw_width } as u32,
        height: if swaps { raw_width } else { raw_height } as u32,
        orientation, has_alpha: unsafe { vips_image_hasalpha(image.0) != 0 },
    })
}

fn thumbnail_file(path: &Path, width: i32, height: i32, allow_upsize: bool) -> Result<VipsImage> {
    initialize()?; let path = c_path(path)?; let mut output = ptr::null_mut();
    let height_name = option("height"); let size_name = option("size");
    let size = if allow_upsize { 0 } else { 2 };
    let status = unsafe { vips_thumbnail(path.as_ptr(), &mut output, width, height_name.as_ptr(), height, size_name.as_ptr(), size, terminator()) };
    if status != 0 || output.is_null() { Err(vips_error("缩略图生成失败")) } else { Ok(VipsImage(output)) }
}

fn thumbnail_loaded(source: &VipsImage, width: i32, height: i32) -> Result<VipsImage> {
    let mut output = ptr::null_mut(); let height_name = option("height"); let size_name = option("size");
    let status = unsafe { vips_thumbnail_image(source.0, &mut output, width, height_name.as_ptr(), height, size_name.as_ptr(), 3 as c_int, terminator()) };
    if status != 0 || output.is_null() { Err(vips_error("Tile 缩放失败")) } else { Ok(VipsImage(output)) }
}

fn extract(source: &VipsImage, left: i32, top: i32, width: i32, height: i32) -> Result<VipsImage> {
    let mut output = ptr::null_mut();
    let status = unsafe { vips_extract_area(source.0, &mut output, left, top, width, height, terminator()) };
    if status != 0 || output.is_null() { Err(vips_error("图片区域读取失败")) } else { Ok(VipsImage(output)) }
}

fn png(image: &VipsImage) -> Result<Vec<u8>> {
    let mut output = ptr::null_mut(); let mut length = 0_usize; let compression = option("compression"); let filter = option("filter");
    let status = unsafe { vips_pngsave_buffer(image.0, &mut output, &mut length, compression.as_ptr(), 3 as c_int, filter.as_ptr(), 8 as c_int, terminator()) };
    copy_buffer(status, output, length, "PNG 编码失败")
}

fn webp(image: &VipsImage) -> Result<Vec<u8>> {
    let mut output = ptr::null_mut(); let mut length = 0_usize;
    let q = option("Q"); let alpha_q = option("alpha_q"); let smart = option("smart_subsample"); let effort = option("effort");
    let status = unsafe { vips_webpsave_buffer(image.0, &mut output, &mut length,
        q.as_ptr(), 88 as c_int, alpha_q.as_ptr(), 100 as c_int, smart.as_ptr(), 1 as c_int, effort.as_ptr(), 4 as c_int, terminator()) };
    copy_buffer(status, output, length, "WebP 编码失败")
}

fn copy_buffer(status: i32, pointer: *mut c_void, length: usize, context: &str) -> Result<Vec<u8>> {
    if status != 0 || pointer.is_null() { return Err(vips_error(context)); }
    let bytes = unsafe { std::slice::from_raw_parts(pointer.cast::<u8>(), length).to_vec() };
    unsafe { g_free(pointer) }; Ok(bytes)
}

fn memory(image: &VipsImage) -> Result<Vec<u8>> {
    let mut length = 0_usize; let pointer = unsafe { vips_image_write_to_memory(image.0, &mut length) };
    if pointer.is_null() { return Err(vips_error("图片像素读取失败")); }
    let bytes = unsafe { std::slice::from_raw_parts(pointer.cast::<u8>(), length).to_vec() };
    unsafe { g_free(pointer) }; Ok(bytes)
}

pub fn thumbnail_png(path: &Path, edge: u32, stats: &Mutex<ImagePipelinePerformanceStats>) -> Result<Vec<u8>> {
    let started = Instant::now(); let _guard = VIPS_LOCK.lock(); let image = thumbnail_file(path, edge as i32, edge as i32, true)?; let encoded = png(&image)?;
    let mut current = stats.lock(); current.thumbnail_count += 1; current.thumbnail_ms += started.elapsed().as_secs_f64() * 1000.0; Ok(encoded)
}

pub fn mip_webp(path: &Path, edge: u32) -> Result<Vec<u8>> { let _guard = VIPS_LOCK.lock(); webp(&thumbnail_file(path, edge as i32, edge as i32, false)?) }

pub fn tile_webp(path: &Path, natural_width: u32, natural_height: u32, level: u32, column: u32, row: u32, tile_size: u32, gutter: u32) -> Result<Vec<u8>> {
    let _guard = VIPS_LOCK.lock(); let source = autorot(&load(path)?)?;
    let denominator = 2_u32.checked_pow(level).unwrap_or(u32::MAX).max(1);
    let width = natural_width.div_ceil(denominator).max(1); let height = natural_height.div_ceil(denominator).max(1);
    let resized = thumbnail_loaded(&source, width as i32, height as i32)?;
    let left = column.saturating_mul(tile_size).saturating_sub(gutter).min(width); let top = row.saturating_mul(tile_size).saturating_sub(gutter).min(height);
    let right = ((column + 1).saturating_mul(tile_size) + gutter).min(width); let bottom = ((row + 1).saturating_mul(tile_size) + gutter).min(height);
    if left >= right || top >= bottom { return Err(anyhow!("分块坐标无效")); }
    webp(&extract(&resized, left as i32, top as i32, (right - left) as i32, (bottom - top) as i32)?)
}

pub fn sample_pixel(path: &Path, x: u32, y: u32) -> Result<[u8; 4]> {
    let _guard = VIPS_LOCK.lock(); let image = autorot(&load(path)?)?; let (width, height) = dimensions(&image);
    if x >= width as u32 || y >= height as u32 { return Err(anyhow!("像素坐标超出图片范围")); }
    let pixel = extract(&image, x as i32, y as i32, 1, 1)?; let band_count = bands(&pixel); let bytes = memory(&pixel)?;
    Ok(match band_count { 1 => [bytes[0], bytes[0], bytes[0], 255], 2 => [bytes[0], bytes[0], bytes[0], bytes[1]], 3 => [bytes[0], bytes[1], bytes[2], 255], _ => [bytes[0], bytes[1], bytes[2], bytes[3]] })
}

pub fn dimensions_for_file(path: &Path) -> Result<(u32, u32)> {
    let _guard = VIPS_LOCK.lock(); let image = autorot(&load(path).with_context(|| format!("无法读取 {}", path.display()))?)?;
    let (width, height) = dimensions(&image); Ok((width as u32, height as u32))
}

pub fn decode_rgba(bytes: &[u8]) -> Result<(Vec<u8>, u32, u32)> {
    let _guard = VIPS_LOCK.lock(); let image = autorot(&load_buffer(bytes)?)?; let (width, height) = dimensions(&image); let band_count = bands(&image); let input = memory(&image)?;
    let pixels = width as usize * height as usize; let mut output = Vec::with_capacity(pixels * 4);
    for index in 0..pixels { let offset = index * band_count; match band_count { 1 => output.extend_from_slice(&[input[offset], input[offset], input[offset], 255]), 2 => output.extend_from_slice(&[input[offset], input[offset], input[offset], input[offset + 1]]), 3 => output.extend_from_slice(&[input[offset], input[offset + 1], input[offset + 2], 255]), _ => output.extend_from_slice(&input[offset..offset + 4]) } }
    Ok((output, width as u32, height as u32))
}

#[allow(dead_code)]
pub fn shutdown() { if VIPS_READY.get().is_some() { unsafe { vips_shutdown() }; } }
