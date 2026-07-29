import { describe, expect, it } from 'vitest';
import type { ImageItem } from '../../types';
import { pointInImage, topmostImageAtPoint } from './HitTestService';

const item = (id: string, zIndex: number, rotation = 0) => ({
  id, x: 0, y: 0, width: 100, height: 40, rotation, zIndex,
  hidden: false,
} as ImageItem);

describe('HitTestService', () => {
  it('honors rotation and returns the topmost visible image', () => {
    expect(pointInImage(item('rotated', 1, 90), { x: 50, y: -20 })).toBe(true);
    expect(pointInImage(item('rotated', 1, 90), { x: 100, y: 20 })).toBe(false);
    expect(topmostImageAtPoint([item('low', 1), item('high', 2)], { x: 20, y: 20 })?.id).toBe('high');
  });
});
