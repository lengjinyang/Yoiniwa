import { describe, expect, it } from 'vitest';
import type { ImageItem } from '../../types';
import { SpatialIndex } from './SpatialIndex';

describe('SpatialIndex', () => {
  it('queries only images intersecting the viewport cells', () => {
    const index = new SpatialIndex();
    index.rebuild([
      { id: 'near', x: 0, y: 0, width: 100, height: 100, rotation: 0 } as ImageItem,
      { id: 'far', x: 5000, y: 5000, width: 100, height: 100, rotation: 0 } as ImageItem,
    ]);
    expect([...index.query({ x: -10, y: -10, width: 200, height: 200 })]).toEqual(['near']);
  });
});
