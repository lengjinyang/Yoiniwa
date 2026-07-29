import type { CropRect, ImageItem } from './types';
import type { Bounds } from './scene';
import { pyramidLevelForScale, type ImagePyramid } from './imagePyramid';

export interface TileAddress {
  level: number;
  column: number;
  row: number;
}

export interface TileSelection {
  level: number;
  visible: TileAddress[];
  prefetch: TileAddress[];
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function imageLocalPoint(item: Pick<ImageItem, 'x' | 'y' | 'width' | 'height' | 'rotation' | 'flipX' | 'flipY'>, worldX: number, worldY: number) {
  const radians = -item.rotation * Math.PI / 180;
  const centerX = item.x + item.width / 2;
  const centerY = item.y + item.height / 2;
  const translatedX = worldX - centerX;
  const translatedY = worldY - centerY;
  const x = translatedX * Math.cos(radians) - translatedY * Math.sin(radians);
  const y = translatedX * Math.sin(radians) + translatedY * Math.cos(radians);
  return {
    x: (x * (item.flipX ? -1 : 1) + item.width / 2) / item.width,
    y: (y * (item.flipY ? -1 : 1) + item.height / 2) / item.height,
  };
}

function boundsToLocalCrop(item: Pick<ImageItem, 'x' | 'y' | 'width' | 'height' | 'rotation' | 'flipX' | 'flipY' | 'crop'>, world: Bounds) {
  const points = [
    imageLocalPoint(item, world.x, world.y),
    imageLocalPoint(item, world.x + world.width, world.y),
    imageLocalPoint(item, world.x, world.y + world.height),
    imageLocalPoint(item, world.x + world.width, world.y + world.height),
  ];
  const left = clamp(Math.min(...points.map((point) => point.x)), 0, 1);
  const top = clamp(Math.min(...points.map((point) => point.y)), 0, 1);
  const right = clamp(Math.max(...points.map((point) => point.x)), 0, 1);
  const bottom = clamp(Math.max(...points.map((point) => point.y)), 0, 1);
  return { left, top, right, bottom };
}

function tileRange(level: ImagePyramid['levels'][number], tileSize: number, region: { left: number; top: number; right: number; bottom: number }, margin: number) {
  const left = clamp(Math.floor(region.left * level.width / tileSize) - margin, 0, level.columns - 1);
  const top = clamp(Math.floor(region.top * level.height / tileSize) - margin, 0, level.rows - 1);
  const right = clamp(Math.floor(Math.max(0, region.right * level.width - 1) / tileSize) + margin, 0, level.columns - 1);
  const bottom = clamp(Math.floor(Math.max(0, region.bottom * level.height - 1) / tileSize) + margin, 0, level.rows - 1);
  return { left, top, right, bottom };
}

function enumerate(level: number, range: { left: number; top: number; right: number; bottom: number }) {
  const tiles: TileAddress[] = [];
  for (let row = range.top; row <= range.bottom; row += 1) {
    for (let column = range.left; column <= range.right; column += 1) tiles.push({ level, column, row });
  }
  return tiles;
}

export function selectImageTiles(
  item: Pick<ImageItem, 'x' | 'y' | 'width' | 'height' | 'rotation' | 'flipX' | 'flipY' | 'crop' | 'naturalWidth' | 'naturalHeight'>,
  pyramid: ImagePyramid,
  worldBounds: Bounds,
  viewportScale: number,
  devicePixelRatio = 1,
  previousLevel?: number,
): TileSelection {
  const displayedPixels = Math.max(item.width, item.height) * viewportScale * devicePixelRatio;
  const sourcePixels = Math.max(item.crop.width, item.crop.height);
  const sourcePixelsPerScreenPixel = sourcePixels / Math.max(1, displayedPixels);
  const level = pyramidLevelForScale(pyramid, sourcePixelsPerScreenPixel, previousLevel);
  const selectedLevel = pyramid.levels[level];
  const local = boundsToLocalCrop(item, worldBounds);
  const crop: CropRect = item.crop;
  const cropLeft = crop.x / item.naturalWidth;
  const cropTop = crop.y / item.naturalHeight;
  const cropRight = (crop.x + crop.width) / item.naturalWidth;
  const cropBottom = (crop.y + crop.height) / item.naturalHeight;
  const region = {
    left: clamp(local.left, 0, 1),
    top: clamp(local.top, 0, 1),
    right: clamp(local.right, 0, 1),
    bottom: clamp(local.bottom, 0, 1),
  };
  const sourceRegion = {
    left: cropLeft + (cropRight - cropLeft) * region.left,
    top: cropTop + (cropBottom - cropTop) * region.top,
    right: cropLeft + (cropRight - cropLeft) * region.right,
    bottom: cropTop + (cropBottom - cropTop) * region.bottom,
  };
  const visibleRange = tileRange(selectedLevel, pyramid.tileSize, sourceRegion, 0);
  const prefetchRange = tileRange(selectedLevel, pyramid.tileSize, sourceRegion, 1);
  const visible = enumerate(level, visibleRange);
  const visibleKeys = new Set(visible.map((tile) => `${tile.column}:${tile.row}`));
  return {
    level,
    visible,
    prefetch: enumerate(level, prefetchRange).filter((tile) => !visibleKeys.has(`${tile.column}:${tile.row}`)),
  };
}
