export const IMAGE_CACHE_FORMAT_VERSION = 3;
export const MIP_ALGORITHM_VERSION = 2;
export const IMAGE_CACHE_DIRECTORY = `image-cache/v${IMAGE_CACHE_FORMAT_VERSION}`;

export const IMAGE_MIP_EDGES = [128, 256, 512, 1024, 2048, 4096, 8192, 16384] as const;
export const IMAGE_TILE_SIZE = 512;
export const IMAGE_TILE_GUTTER = 1;
// The atlas needs headroom for concurrent stable/target LODs. 2048 is the
// measured cross-device safe edge even when MAX_TEXTURE_SIZE is much larger.
export const IMAGE_TILE_THRESHOLD_EDGE = 2048;
export const LARGE_IMAGE_TILE_EDGE = 8192;
export const MIP_OVERSAMPLE = 1.25;

const CPU_IMAGE_CACHE_DEFAULT_BYTES = 512 * 1024 * 1024;
const CPU_IMAGE_CACHE_MIN_BYTES = 256 * 1024 * 1024;
const CPU_IMAGE_CACHE_MAX_BYTES = 1024 * 1024 * 1024;
export const GPU_IMAGE_CACHE_DEFAULT_BYTES = 512 * 1024 * 1024;
export const GPU_IMAGE_CACHE_HARD_MAX_BYTES = 1024 * 1024 * 1024;
export const DISK_IMAGE_CACHE_DEFAULT_BYTES = 10 * 1024 * 1024 * 1024;

export const GPU_UPLOAD_MAX_ITEMS_PER_FRAME = 4;
export const GPU_UPLOAD_MAX_BYTES_PER_FRAME = 8 * 1024 * 1024;
export const GPU_UPLOAD_MAX_MS_PER_FRAME = 2;

export const IMAGE_IMPORT_STAGE_WEIGHTS = {
  metadata: 0.05,
  hash: 0.10,
  decode: 0.20,
  mip: 0.50,
  commit: 0.10,
  scene: 0.05,
} as const;

export function imageRequestKey(assetId: string, mip: number, tileX?: number, tileY?: number) {
  const tile = tileX === undefined || tileY === undefined ? 'full' : `${tileX}:${tileY}`;
  return `${assetId}:v${IMAGE_CACHE_FORMAT_VERSION}:a${MIP_ALGORITHM_VERSION}:m${mip}:${tile}`;
}

export function boundedCpuImageBudget(deviceMemoryGb?: number) {
  if (!Number.isFinite(deviceMemoryGb)) return CPU_IMAGE_CACHE_DEFAULT_BYTES;
  const bytes = Math.round((deviceMemoryGb as number) * 1024 * 1024 * 1024 * 0.08);
  return Math.max(CPU_IMAGE_CACHE_MIN_BYTES, Math.min(CPU_IMAGE_CACHE_MAX_BYTES, bytes));
}
