import { describe, expect, it } from 'vitest';
import type { ImageItem } from '../../types';
import { selectVisibleTiles, shouldUseTiledImage } from './TileSelector';

describe('selectVisibleTiles', () => {
  it('selects only the tile workset intersecting the visible image region', () => {
    const item = {
      x: 0, y: 0, width: 1600, height: 800, rotation: 0, flipX: false, flipY: false,
      naturalWidth: 16000, naturalHeight: 8000, crop: { x: 0, y: 0, width: 16000, height: 8000 },
    } as ImageItem;
    const result = selectVisibleTiles(item, { x: 0, y: 0, width: 400, height: 400 }, 8000);
    expect(result.level).toBe(1);
    expect(result.tiles.length).toBeGreaterThan(0);
    expect(result.tiles.length).toBeLessThan(128);
  });

  it('routes high-resolution display requests through bounded tile uploads', () => {
    const large = { naturalWidth: 3840, naturalHeight: 2160 } as ImageItem;
    expect(shouldUseTiledImage(large, 1024)).toBe(false);
    expect(shouldUseTiledImage(large, 1025)).toBe(true);
    expect(shouldUseTiledImage({ naturalWidth: 2048, naturalHeight: 2048 }, 2048)).toBe(false);
  });
});
