import { describe, expect, it } from 'vitest';
import { applyLayout } from './layout';
import { applyNonDestructiveCrop, createScene, itemBounds, resetNonDestructiveCrop, sceneBounds, validateScene } from './scene';
import type { ImageItem } from './types';

const item = (id: string, x: number, y: number, width: number, height: number): ImageItem => ({
  id, name: id, sourceType: 'file', dataUrl: 'data:image/png;base64,', naturalWidth: width, naturalHeight: height,
  x, y, width, height, rotation: 0, flipX: false, flipY: false, opacity: 1, zIndex: Number(id), locked: false,
  crop: { x: 0, y: 0, width, height },
});

describe('layout operations', () => {
  it('aligns items to the left-most edge', () => {
    const result = applyLayout([item('1', 20, 0, 100, 80), item('2', 70, 50, 40, 30)], 'align-left', 10);
    expect(result.map((value) => value.x)).toEqual([20, 20]);
    expect(result[1].y).toBe(90);
  });

  it('distributes items into a horizontal row using configured padding', () => {
    const result = applyLayout([
      item('1', 0, 0, 20, 20), item('2', 25, 0, 20, 20), item('3', 100, 0, 20, 20),
    ], 'distribute-horizontal', 10);
    expect(result[0].x).toBe(0);
    expect(result[1].x).toBe(30);
    expect(result[2].x).toBe(60);
  });

  it('aligns rotated items by their visible edges', () => {
    const rotated = item('1', 0, 0, 100, 50);
    rotated.rotation = 90;
    const result = applyLayout([rotated, item('2', 200, 0, 40, 30)], 'align-left', 10);
    expect(itemBounds(result[0]).x).toBeCloseTo(itemBounds(result[1]).x);
  });

  it.each([
    ['align-right', 'right'],
    ['align-top', 'top'],
    ['align-bottom', 'bottom'],
  ] as const)('aligns visible bounds for %s', (action, edge) => {
    const result = applyLayout([item('1', 10, 20, 80, 40), item('2', 180, 120, 30, 70)], action, 10);
    const bounds = result.map(itemBounds);
    const values = edge === 'right' ? bounds.map((value) => value.x + value.width)
      : edge === 'top' ? bounds.map((value) => value.y)
        : bounds.map((value) => value.y + value.height);
    expect(values[0]).toBeCloseTo(values[1]);
  });

  it('distributes items into a vertical column using configured padding', () => {
    const result = applyLayout([item('1', 0, 0, 20, 30), item('2', 0, 100, 20, 40)], 'distribute-vertical', 7);
    expect(result.map((value) => value.y)).toEqual([0, 37]);
  });

  it('normalizes width while preserving aspect ratio', () => {
    const result = applyLayout([item('1', 0, 0, 100, 50), item('2', 200, 100, 200, 200)], 'normalize-width', 10);
    expect(result[1].width).toBe(100);
    expect(result[1].height).toBe(100);
    expect({ x: result[1].x, y: result[1].y }).toEqual({ x: 250, y: 150 });
  });

  it('normalizes height and longest-side size from the first selected item', () => {
    const heightResult = applyLayout([item('1', 0, 0, 100, 50), item('2', 0, 0, 40, 100)], 'normalize-height', 10);
    expect({ width: heightResult[1].width, height: heightResult[1].height }).toEqual({ width: 20, height: 50 });
    const sizeResult = applyLayout([item('1', 0, 0, 120, 60), item('2', 0, 0, 40, 80)], 'normalize-size', 10);
    expect({ width: sizeResult[1].width, height: sizeResult[1].height }).toEqual({ width: 60, height: 120 });
  });

  it('packs all items without overlap', () => {
    const result = applyLayout(Array.from({ length: 20 }, (_, index) => item(String(index), 0, 0, 100 + index, 80 + index)), 'pack', 12);
    result.forEach((left, index) => result.slice(index + 1).forEach((right) => {
      const leftBounds = itemBounds(left);
      const rightBounds = itemBounds(right);
      const overlaps = leftBounds.x < rightBounds.x + rightBounds.width && leftBounds.x + leftBounds.width > rightBounds.x
        && leftBounds.y < rightBounds.y + rightBounds.height && leftBounds.y + leftBounds.height > rightBounds.y;
      expect(overlaps).toBe(false);
    }));
  });

  it('packs adjacent images edge-to-edge without adding spacing', () => {
    const result = applyLayout([item('1', 0, 0, 100, 100), item('2', 300, 0, 100, 100)], 'pack', 40, 1.6);
    const [first, second] = result.map(itemBounds).sort((a, b) => a.y - b.y || a.x - b.x);
    const touchesHorizontally = Math.abs(second.x - (first.x + first.width)) < 0.001;
    const touchesVertically = Math.abs(second.y - (first.y + first.height)) < 0.001;
    expect(touchesHorizontally || touchesVertically).toBe(true);
  });
});

describe('scene format', () => {
  it('creates and validates a versioned scene', () => {
    const scene = createScene();
    expect(validateScene(scene)).toBe(true);
    expect(validateScene({ ...scene, version: 1 })).toBe(false);
  });
});

describe('scene bounds', () => {
  it('includes the full corners of rotated images', () => {
    const image = item('1', 0, 0, 100, 50);
    image.rotation = 90;
    const bounds = sceneBounds([image]);
    expect(bounds.x).toBeCloseTo(25);
    expect(bounds.y).toBeCloseTo(-25);
    expect(bounds.width).toBeCloseTo(50);
    expect(bounds.height).toBeCloseTo(100);
  });
});

describe('non-destructive crop', () => {
  it('preserves the opposite edge and does not stretch the remaining image', () => {
    const image = item('1', 0, 0, 100, 100);
    applyNonDestructiveCrop(image, { x: 20, y: 0, width: 80, height: 100 });
    expect(image.x).toBe(20);
    expect(image.width).toBe(80);
    applyNonDestructiveCrop(image, { x: 20, y: 0, width: 60, height: 100 });
    expect(image.x).toBe(20);
    expect(image.width).toBe(60);
    expect(image.crop).toEqual({ x: 20, y: 0, width: 60, height: 100 });
  });

  it('restores the original displayed bounds after resetting crop', () => {
    const image = item('1', 0, 0, 100, 100);
    applyNonDestructiveCrop(image, { x: 20, y: 10, width: 60, height: 80 });
    resetNonDestructiveCrop(image);
    expect({ x: image.x, y: image.y, width: image.width, height: image.height }).toEqual({ x: 0, y: 0, width: 100, height: 100 });
  });
});
