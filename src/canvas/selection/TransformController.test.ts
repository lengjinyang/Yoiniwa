import { describe, expect, it } from 'vitest';
import type { ImageItem } from '../../types';
import { transformImageSelection } from './TransformController';

const item = { id: 'one', x: 0, y: 0, width: 100, height: 50, rotation: 0 } as ImageItem;

describe('transformImageSelection', () => {
  it('scales selected objects together around the opposite corner', () => {
    const [change] = transformImageSelection({
      start: { x: 100, y: 50 }, current: { x: 200, y: 100 }, originals: [item],
      bounds: { x: 0, y: 0, width: 100, height: 50 }, handle: 'south-east',
    });
    expect(change).toMatchObject({ id: 'one', x: 0, y: 0, width: 200, height: 100 });
  });

  it('rotates around the shared selection center', () => {
    const [change] = transformImageSelection({
      start: { x: 100, y: 25 }, current: { x: 50, y: 75 }, originals: [item],
      bounds: { x: 0, y: 0, width: 100, height: 50 }, handle: 'rotate',
    });
    expect(change.rotation).toBeCloseTo(90);
  });
});
