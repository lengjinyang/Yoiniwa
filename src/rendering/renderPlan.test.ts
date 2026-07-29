import { describe, expect, it } from 'vitest';
import { createImageRenderPlan } from './renderPlan';
import type { ImageItem } from '../types';

const image = (id: string, x: number, zIndex: number): ImageItem => ({
  id, name: id, sourceType: 'file', naturalWidth: 1000, naturalHeight: 500,
  x, y: 0, width: 100, height: 50, rotation: 0, flipX: false, flipY: false,
  opacity: 1, zIndex, locked: false, crop: { x: 10, y: 20, width: 900, height: 400 },
});

describe('image render plan', () => {
  it('culls hidden and out-of-viewport images while retaining z order', () => {
    const visibleBack = image('back', 0, 1);
    const visibleFront = image('front', 40, 3);
    const hidden = { ...image('hidden', 20, 2), hidden: true };
    const outside = image('outside', 1000, 0);
    const plan = createImageRenderPlan([visibleFront, outside, hidden, visibleBack], { x: -10, y: -10, width: 200, height: 100 });
    expect(plan.map((command) => command.id)).toEqual(['back', 'front']);
    expect(plan[0].sourceRect).toEqual(visibleBack.crop);
  });

  it('respects group visibility supplied by the caller', () => {
    const plan = createImageRenderPlan([image('a', 0, 0), image('b', 20, 1)], { x: 0, y: 0, width: 200, height: 100 }, new Set(['b']));
    expect(plan.map((command) => command.id)).toEqual(['a']);
  });
});
