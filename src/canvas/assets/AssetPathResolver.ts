import type { ImageItem, Scene } from '../../types';
import { assetResourceUrl } from '../../assetResourceUrl';

export type CanvasImageVariant = 'thumb128' | 'thumb256' | 'thumb512' | 'thumb1024' | 'original';

export function resolveCanvasImageUrl(scene: Scene, item: ImageItem, variant: CanvasImageVariant) {
  if (item.dataUrl) return item.dataUrl;
  if (!item.assetId) return undefined;
  const version = scene.assets[item.assetId]?.cacheVersion ?? 0;
  const query = new URLSearchParams({ variant });
  if (version > 0) query.set('v', String(version));
  return assetResourceUrl(item.assetId, query);
}

export function resolveCanvasMipUrl(scene: Scene, item: ImageItem, mip: number, priority = 100) {
  if (item.dataUrl) return item.dataUrl;
  if (!item.assetId) return undefined;
  const version = scene.assets[item.assetId]?.cacheVersion ?? 0;
  const query = new URLSearchParams({ variant: 'mip', edge: String(mip), priority: String(priority) });
  if (version > 0) query.set('v', String(version));
  return assetResourceUrl(item.assetId, query);
}

export function resolveCanvasTileUrl(item: ImageItem, level: number, column: number, row: number, priority = 100) {
  if (!item.assetId) return undefined;
  const query = new URLSearchParams({
    variant: 'tile', level: String(level), column: String(column), row: String(row), priority: String(priority),
  });
  return assetResourceUrl(item.assetId, query);
}
