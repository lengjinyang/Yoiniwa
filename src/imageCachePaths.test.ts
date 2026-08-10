import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { createImageCachePathResolver, imageCacheKey } from '../electron/services/image-cache-paths.js';
import { WorkerGeneration } from '../electron/services/worker-generation.js';

const assetId = 'a'.repeat(64);

describe('image cache identity and migration generation', () => {
  it('resolves paths from the current root after migration', () => {
    let root = path.resolve('old-root');
    const paths = createImageCachePathResolver(() => root);
    expect(paths.manifestPath(assetId)).toContain(path.join('old-root', 'image-cache', 'v3'));
    root = path.resolve('new-root');
    expect(paths.manifestPath(assetId)).toContain(path.join('new-root', 'image-cache', 'v3'));
    expect(paths.manifestPath(assetId)).not.toContain(path.join('old-root', 'image-cache', 'v3'));
  });

  it('versions cache keys and rejects malformed tile coordinates', () => {
    expect(imageCacheKey({ assetId, mip: 512, tileX: 1, tileY: 2 })).toContain(':v3:a2:m512:1:2');
    expect(() => imageCacheKey({ assetId, mip: 512, tileX: 1 })).toThrow('Tile');
  });

  it('drops results produced by an obsolete worker generation', () => {
    const generation = new WorkerGeneration();
    const old = generation.stamp({ assetId });
    generation.advance();
    expect(generation.accepts(old)).toBe(false);
    expect(generation.accepts(generation.stamp({ assetId }))).toBe(true);
  });
});
