import type { ImageItem, Scene } from '../../types';

export type CanvasImageVariant = 'thumb128' | 'thumb256' | 'thumb512' | 'thumb1024' | 'original';

export function resolveCanvasImageUrl(scene: Scene, item: ImageItem, variant: CanvasImageVariant) {
  if (item.dataUrl) return item.dataUrl;
  if (!item.assetId) return undefined;
  const version = scene.assets[item.assetId]?.cacheVersion ?? 0;
  const query = new URLSearchParams({ variant });
  if (version > 0) query.set('v', String(version));
  return `refcanvas-asset://asset/${encodeURIComponent(item.assetId)}?${query}`;
}
