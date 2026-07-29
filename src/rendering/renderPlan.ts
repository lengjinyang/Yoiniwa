import type { ImageItem } from '../types';
import { itemBounds } from '../scene';
import type { Bounds } from '../scene';

export interface ImageRenderCommand {
  id: string;
  imageId?: string;
  source: Pick<ImageItem, 'assetId' | 'dataUrl'>;
  resourceUrl?: string;
  sourceRect: ImageItem['crop'];
  naturalWidth: number;
  naturalHeight: number;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  flipX: boolean;
  flipY: boolean;
  opacity: number;
  grayscale: boolean;
  zIndex: number;
}

function intersects(left: Bounds, right: Bounds) {
  return left.x <= right.x + right.width && left.x + left.width >= right.x
    && left.y <= right.y + right.height && left.y + left.height >= right.y;
}

export function createImageRenderPlan(
  items: readonly ImageItem[],
  worldBounds: Bounds,
  hiddenIds = new Set<string>(),
): ImageRenderCommand[] {
  return items
    .filter((item) => !item.hidden && !hiddenIds.has(item.id) && intersects(itemBounds(item), worldBounds))
    .sort((left, right) => left.zIndex - right.zIndex)
    .map((item) => ({
      id: item.id,
      source: { assetId: item.assetId, dataUrl: item.dataUrl },
      sourceRect: { ...item.crop },
      naturalWidth: item.naturalWidth,
      naturalHeight: item.naturalHeight,
      x: item.x,
      y: item.y,
      width: item.width,
      height: item.height,
      rotation: item.rotation,
      flipX: item.flipX,
      flipY: item.flipY,
      opacity: item.opacity,
      grayscale: Boolean(item.grayscale),
      zIndex: item.zIndex,
    }));
}
