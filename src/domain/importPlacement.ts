import { applyLayout } from './layout';
import { sceneBounds } from './scene';
import type { ImageItem, Viewport } from './types';

export function arrangeImportedItems(
  items: ImageItem[], viewport: Viewport, screenX: number, screenY: number,
  tightlyPack: boolean, padding: number, targetAspect: number,
) {
  const arranged = tightlyPack && items.length > 1
    ? applyLayout(items, 'pack', padding, targetAspect)
    : items.map((item) => ({ ...item }));
  const bounds = sceneBounds(arranged);
  const worldX = (screenX - viewport.x) / viewport.scale;
  const worldY = (screenY - viewport.y) / viewport.scale;
  const offsetX = worldX - bounds.x - bounds.width / 2;
  const offsetY = worldY - bounds.y - bounds.height / 2;
  return arranged.map((item) => ({ ...item, x: item.x + offsetX, y: item.y + offsetY }));
}
