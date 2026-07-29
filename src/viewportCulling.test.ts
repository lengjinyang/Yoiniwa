import { describe, expect, it } from 'vitest';
import { SpatialIndex, viewportWorldBounds } from './viewportCulling';

describe('viewport culling', () => {
  it('converts a screen viewport to world bounds with overscan', () => {
    expect(viewportWorldBounds({ x: 100, y: 50, scale: 2 }, { width: 800, height: 600 }, 100))
      .toEqual({ x: -100, y: -75, width: 500, height: 400 });
  });

  it('queries only intersecting spatial entries without duplicates', () => {
    const index = new SpatialIndex([
      { id: 'inside', x: 20, y: 30, width: 100, height: 100 },
      { id: 'edge', x: 490, y: 490, width: 40, height: 40 },
      { id: 'outside', x: 9000, y: 9000, width: 10, height: 10 },
    ], 128);
    expect(new Set(index.query({ x: 0, y: 0, width: 500, height: 500 }))).toEqual(new Set(['inside', 'edge']));
  });

  it('falls back to a bounded full scan for an extremely zoomed-out viewport', () => {
    const index = new SpatialIndex([
      { id: 'origin', x: 0, y: 0, width: 10, height: 10 },
      { id: 'far', x: 1e8, y: 1e8, width: 10, height: 10 },
    ]);
    expect(index.query({ x: -1e12, y: -1e12, width: 2e12, height: 2e12 })).toEqual(['origin', 'far']);
  });
});
