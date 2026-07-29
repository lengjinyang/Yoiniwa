import type { ImageItem } from '../../types';
import { IMAGE_TILE_SIZE } from '../../shared/imagePipelineConfig';
import type { SceneBounds } from '../scene/SceneNode';

export interface TileAddress { level: number; column: number; row: number }

function clamp(value: number, min: number, max: number) { return Math.max(min, Math.min(max, value)); }

function localPoint(item: ImageItem, point: { x: number; y: number }) {
  const centerX = item.x + item.width / 2;
  const centerY = item.y + item.height / 2;
  const radians = -item.rotation * Math.PI / 180;
  const dx = point.x - centerX;
  const dy = point.y - centerY;
  const rotatedX = dx * Math.cos(radians) - dy * Math.sin(radians);
  const rotatedY = dx * Math.sin(radians) + dy * Math.cos(radians);
  return {
    x: (rotatedX * (item.flipX ? -1 : 1) + item.width / 2) / Math.max(1, item.width),
    y: (rotatedY * (item.flipY ? -1 : 1) + item.height / 2) / Math.max(1, item.height),
  };
}

export function selectVisibleTiles(item: ImageItem, worldBounds: SceneBounds, requiredEdge: number) {
  const sourceEdge = Math.max(item.naturalWidth, item.naturalHeight);
  const maxLevel = Math.ceil(Math.log2(sourceEdge / IMAGE_TILE_SIZE));
  const level = clamp(Math.floor(Math.log2(sourceEdge / Math.max(1, requiredEdge))), 0, maxLevel);
  const divisor = 2 ** level;
  const levelWidth = Math.ceil(item.naturalWidth / divisor);
  const levelHeight = Math.ceil(item.naturalHeight / divisor);
  const points = [
    localPoint(item, { x: worldBounds.x, y: worldBounds.y }),
    localPoint(item, { x: worldBounds.x + worldBounds.width, y: worldBounds.y }),
    localPoint(item, { x: worldBounds.x, y: worldBounds.y + worldBounds.height }),
    localPoint(item, { x: worldBounds.x + worldBounds.width, y: worldBounds.y + worldBounds.height }),
  ];
  const local = {
    left: clamp(Math.min(...points.map((point) => point.x)), 0, 1),
    top: clamp(Math.min(...points.map((point) => point.y)), 0, 1),
    right: clamp(Math.max(...points.map((point) => point.x)), 0, 1),
    bottom: clamp(Math.max(...points.map((point) => point.y)), 0, 1),
  };
  const cropLeft = item.crop.x / item.naturalWidth;
  const cropTop = item.crop.y / item.naturalHeight;
  const cropRight = (item.crop.x + item.crop.width) / item.naturalWidth;
  const cropBottom = (item.crop.y + item.crop.height) / item.naturalHeight;
  const source = {
    left: cropLeft + (cropRight - cropLeft) * local.left,
    top: cropTop + (cropBottom - cropTop) * local.top,
    right: cropLeft + (cropRight - cropLeft) * local.right,
    bottom: cropTop + (cropBottom - cropTop) * local.bottom,
  };
  const columns = Math.ceil(levelWidth / IMAGE_TILE_SIZE);
  const rows = Math.ceil(levelHeight / IMAGE_TILE_SIZE);
  const left = clamp(Math.floor(source.left * levelWidth / IMAGE_TILE_SIZE), 0, columns - 1);
  const top = clamp(Math.floor(source.top * levelHeight / IMAGE_TILE_SIZE), 0, rows - 1);
  const right = clamp(Math.floor(Math.max(0, source.right * levelWidth - 1) / IMAGE_TILE_SIZE), 0, columns - 1);
  const bottom = clamp(Math.floor(Math.max(0, source.bottom * levelHeight - 1) / IMAGE_TILE_SIZE), 0, rows - 1);
  const tiles: TileAddress[] = [];
  for (let row = top; row <= bottom; row += 1) for (let column = left; column <= right; column += 1) tiles.push({ level, column, row });
  return { level, levelWidth, levelHeight, tiles };
}
