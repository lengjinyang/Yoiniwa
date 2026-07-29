import { IMAGE_TILE_GUTTER, IMAGE_TILE_SIZE } from './shared/imagePipelineConfig';

interface PyramidLevel {
  level: number;
  width: number;
  height: number;
  columns: number;
  rows: number;
}

export interface ImagePyramid {
  tileSize: number;
  gutter: number;
  levels: PyramidLevel[];
}

export function createImagePyramid(width: number, height: number, tileSize = IMAGE_TILE_SIZE): ImagePyramid {
  const levels: PyramidLevel[] = [];
  let levelWidth = Math.max(1, Math.round(width));
  let levelHeight = Math.max(1, Math.round(height));
  let level = 0;
  while (true) {
    levels.push({
      level,
      width: levelWidth,
      height: levelHeight,
      columns: Math.ceil(levelWidth / tileSize),
      rows: Math.ceil(levelHeight / tileSize),
    });
    if (levelWidth <= tileSize && levelHeight <= tileSize) break;
    levelWidth = Math.max(1, Math.ceil(levelWidth / 2));
    levelHeight = Math.max(1, Math.ceil(levelHeight / 2));
    level += 1;
  }
  return { tileSize, gutter: IMAGE_TILE_GUTTER, levels };
}

export function pyramidLevelForScale(pyramid: ImagePyramid, sourcePixelsPerScreenPixel: number, previousLevel?: number) {
  const ideal = Math.max(1, sourcePixelsPerScreenPixel);
  // Select the coarsest level that still carries 1.5 source texels per device
  // pixel. This keeps normal wheel input screen-pixel lossless without forcing
  // the original level at overview scale.
  const target = Math.max(0, Math.min(pyramid.levels.length - 1, Math.floor(Math.log2(ideal / 1.5))));
  if (previousLevel === undefined || previousLevel === target) return target;
  const previousCoverage = ideal / 2 ** previousLevel;
  if (target < previousLevel) return previousCoverage < 1.25 ? target : previousLevel;
  const nextCoarserCoverage = ideal / 2 ** (previousLevel + 1);
  return nextCoarserCoverage >= 1.8 ? Math.min(target, previousLevel + 1) : previousLevel;
}
