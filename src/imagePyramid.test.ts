import { describe, expect, it } from 'vitest';
import { createImagePyramid, pyramidLevelForScale } from './imagePyramid';
import { selectImageTiles } from './tileSelection';

const item = {
  x: 0, y: 0, width: 1000, height: 500, rotation: 0, flipX: false, flipY: false,
  crop: { x: 0, y: 0, width: 4000, height: 2000 }, naturalWidth: 4000, naturalHeight: 2000,
};

describe('image pyramid', () => {
  it('builds downsampled 512px tile levels', () => {
    const pyramid = createImagePyramid(4096, 2048);
    expect(pyramid.levels[0]).toMatchObject({ width: 4096, height: 2048, columns: 8, rows: 4 });
    expect(pyramid.levels.at(-1)).toMatchObject({ width: 512, height: 256, columns: 1, rows: 1 });
  });

  it('holds the current level within the LOD hysteresis window', () => {
    const pyramid = createImagePyramid(4096, 2048);
    expect(pyramidLevelForScale(pyramid, 1.1, 0)).toBe(0);
    expect(pyramidLevelForScale(pyramid, 2.1, 0)).toBe(0);
    expect(pyramidLevelForScale(pyramid, 3.7, 0)).toBe(1);
    expect(pyramidLevelForScale(pyramid, 1.68, 1)).toBe(0);
  });
});

describe('tile selection', () => {
  it('selects only tiles intersecting the world viewport and prefetches neighbours', () => {
    const pyramid = createImagePyramid(4000, 2000);
    const selection = selectImageTiles(item, pyramid, { x: 0, y: 0, width: 250, height: 250 }, 1, 1, 2);
    expect(selection.level).toBe(1);
    expect(selection.visible.length).toBeGreaterThan(0);
    expect(selection.prefetch.length).toBeGreaterThan(0);
  });

  it('clips selection to a non-destructive crop', () => {
    const pyramid = createImagePyramid(4000, 2000);
    const cropped = { ...item, width: 4000, height: 2000, crop: { x: 2000, y: 0, width: 2000, height: 2000 } };
    const selection = selectImageTiles(cropped, pyramid, { x: 0, y: 0, width: 4000, height: 2000 }, 1, 1, 0);
    expect(selection.visible.every((tile) => tile.column >= 2)).toBe(true);
  });

  it('keeps tiles inside valid bounds for rotated and flipped images', () => {
    const pyramid = createImagePyramid(4000, 2000);
    const transformed = { ...item, rotation: 45, flipX: true };
    const selection = selectImageTiles(transformed, pyramid, { x: -500, y: -500, width: 2000, height: 1500 }, 1, 1, 0);
    const level = pyramid.levels[selection.level];
    expect(selection.visible.every((tile) => tile.column >= 0 && tile.column < level.columns && tile.row >= 0 && tile.row < level.rows)).toBe(true);
  });
});
