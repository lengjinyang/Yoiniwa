import { describe, expect, it } from 'vitest';
import type { ImageItem } from '../types';
import { applyCompactGesture, applyImagePreview, compactGestureMatrix } from './previewTransforms';

const item: ImageItem = {
  id: 'item', name: 'item', sourceType: 'file', naturalWidth: 1000, naturalHeight: 500,
  x: 100, y: 200, width: 400, height: 200, rotation: 0,
  flipX: false, flipY: false, opacity: 0.8, zIndex: 0, locked: false,
  crop: { x: 0, y: 0, width: 1000, height: 500 },
};

const command = {
  id: 'item', source: {}, sourceRect: item.crop, naturalWidth: 1000, naturalHeight: 500,
  x: item.x, y: item.y, width: item.width, height: item.height,
  rotation: 0, flipX: false, flipY: false, opacity: 0.8, grayscale: false, zIndex: 0,
};

describe('pixel preview transforms', () => {
  it('uses the Konva proxy position and scale for a normal image command', () => {
    const result = applyImagePreview(command, item, { x: 350, y: 340, scaleX: 1.5, scaleY: 0.5, rotation: 30 });
    expect(result).toMatchObject({ x: 50, y: 290, width: 600, height: 100, rotation: 30 });
  });

  it('moves a tile around the full image center when the proxy is flipped and rotated', () => {
    const tile = { ...command, id: 'item:tile:0:0:0', imageId: 'item', x: 100, y: 200, width: 200, height: 100 };
    const result = applyImagePreview(tile, item, { x: 300, y: 300, scaleX: -1, scaleY: 1, rotation: 90 });
    expect(result.x).toBeCloseTo(250);
    expect(result.y).toBeCloseTo(350);
    expect(result.flipX).toBe(true);
    expect(result.rotation).toBe(90);
  });

  it('uses a preview opacity without changing the source command', () => {
    expect(applyImagePreview(command, item, { x: 300, y: 300, scaleX: 1, scaleY: 1, rotation: 0, opacity: 0.35 }).opacity).toBe(0.35);
    expect(command.opacity).toBe(0.8);
  });

  it('moves a whole selection with one compact gesture', () => {
    const result = applyCompactGesture(command, {
      kind: 'move', imageIds: new Set(['item']), deltaX: 45, deltaY: -12,
    });
    expect(result).toMatchObject({ x: 145, y: 188 });
    expect(command).toMatchObject({ x: 100, y: 200 });
  });

  it('scales tile commands around the shared selection center', () => {
    const tile = { ...command, id: 'item:tile:0:0:0', imageId: 'item', x: 200, y: 250, width: 100, height: 50 };
    const result = applyCompactGesture(tile, {
      kind: 'scale', imageIds: new Set(['item']), centerX: 300, centerY: 300, factor: 2,
    });
    expect(result).toMatchObject({ x: 100, y: 200, width: 200, height: 100 });
  });

  it('builds a column-major GPU matrix matching a move gesture', () => {
    const result = compactGestureMatrix({ kind: 'move', imageIds: new Set(['item']), deltaX: 45, deltaY: -12 });
    const [a, b, , c, d, , tx, ty] = result.matrix;
    expect({ x: a * 100 + c * 200 + tx, y: b * 100 + d * 200 + ty }).toEqual({ x: 145, y: 188 });
  });
});
