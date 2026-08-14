import { describe, expect, it } from 'vitest';
import { arrangeImportedItems } from './importPlacement';
import { itemBounds, sceneBounds } from './scene';
import type { ImageItem } from '../types';

const image = (id: string, width: number, height: number): ImageItem => ({
  id, name: id, sourceType: 'drop', dataUrl: '', naturalWidth: width, naturalHeight: height,
  x: 0, y: 0, width, height, rotation: 0, flipX: false, flipY: false, opacity: 1,
  zIndex: Number(id), locked: false, crop: { x: 0, y: 0, width, height },
});

describe('drop placement', () => {
  it('centers a single dropped image on the pointer in world coordinates', () => {
    const [result] = arrangeImportedItems([image('1', 100, 60)], { x: 40, y: -20, scale: 2 }, 340, 180, false, 20, 1.6);
    expect(result).toMatchObject({ x: 100, y: 70 });
  });

  it('tightly packs a batch without overlap and centers the batch on the pointer', () => {
    const result = arrangeImportedItems(
      [image('1', 100, 60), image('2', 80, 120), image('3', 50, 50)],
      { x: 0, y: 0, scale: 1 }, 500, 300, true, 20, 1.6,
    );
    const bounds = sceneBounds(result);
    expect(bounds.x + bounds.width / 2).toBeCloseTo(500);
    expect(bounds.y + bounds.height / 2).toBeCloseTo(300);
    const visual = result.map(itemBounds);
    for (let left = 0; left < visual.length; left += 1) for (let right = left + 1; right < visual.length; right += 1) {
      const a = visual[left]; const b = visual[right];
      expect(a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y).toBe(false);
    }
  });
});
