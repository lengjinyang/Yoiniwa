import type { ImageItem } from './types';
import { IMAGE_TILE_THRESHOLD_EDGE } from './shared/imagePipelineConfig';

export function shouldUseImagePyramid(item: Pick<ImageItem, 'naturalWidth' | 'naturalHeight'>) {
  return Math.max(item.naturalWidth, item.naturalHeight) > IMAGE_TILE_THRESHOLD_EDGE;
}

export function tileResourceUrl(assetId: string, level: number, column: number, row: number) {
  const params = new URLSearchParams({ variant: 'tile', level: String(level), column: String(column), row: String(row) });
  return `refcanvas-asset://asset/${encodeURIComponent(assetId)}?${params}`;
}
