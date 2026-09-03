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

  it('handles enormous viewports and objects without enumerating unbounded cells', () => {
    const index = new SpatialIndex();
    index.rebuild([
      { id: 'large', x: 0, y: 0, width: 1e12, height: 1e12, rotation: 0 } as ImageItem,
      { id: 'far', x: 1e20, y: 1e20, width: 100, height: 100, rotation: 0 } as ImageItem,
    ]);
    expect([...index.query({ x: -1, y: -1, width: 1280 / 1e-9, height: 820 / 1e-9 })]).toEqual(['large']);
    expect([...index.query({ x: 1e20, y: 1e20, width: 0, height: 0 })]).toEqual(['far']);
    index.rebuild([{ id: 'near', x: 0, y: 0, width: 100, height: 100, rotation: 0 } as ImageItem]);
    expect([...index.query({ x: -1, y: -1, width: 1e12, height: 1e12 })]).toEqual(['near']);
  });
});
