import { describe, expect, it } from 'vitest';
import type { ImageItem, Scene } from '../../types';
import { resolveCanvasImageUrl } from './AssetPathResolver';

const item = { id: 'i', assetId: 'asset id' } as ImageItem;
const scene = { assets: { 'asset id': { cacheVersion: 3 } } } as unknown as Scene;

describe('resolveCanvasImageUrl', () => {
  it('resolves an asset identity at call time without persisting cache paths', () => {
    expect(resolveCanvasImageUrl(scene, item, 'thumb512')).toBe('refcanvas-asset://asset/asset%20id?variant=thumb512&v=3');
  });
});
