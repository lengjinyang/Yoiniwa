import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { trimImagePyramidCache } from '../electron/services/image-cache-cleaner.js';

describe('image pyramid disk cleanup', () => {
  it('never removes current-project assets and trims old orphans in batches', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'refcanvas-image-clean-'));
    try {
      const assetsRoot = path.join(root, 'assets');
      await fs.mkdir(path.join(assetsRoot, 'active'), { recursive: true });
      await fs.mkdir(path.join(assetsRoot, 'orphan'), { recursive: true });
      await fs.writeFile(path.join(assetsRoot, 'active', 'level.webp'), Buffer.alloc(8));
      await fs.writeFile(path.join(assetsRoot, 'orphan', 'level.webp'), Buffer.alloc(8));
      const result = await trimImagePyramidCache({
        assetsRoot, protectedAssetIds: new Set(['active']), budgetBytes: 8, deleteBatchSize: 1,
      });
      expect(result).toEqual({ bytes: 8, removed: 1 });
      await expect(fs.stat(path.join(assetsRoot, 'active'))).resolves.toBeDefined();
      await expect(fs.stat(path.join(assetsRoot, 'orphan'))).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('removes orphan caches before assets referenced by recent projects', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'refcanvas-image-recent-'));
    try {
      const assetsRoot = path.join(root, 'assets');
      for (const id of ['current', 'recent', 'orphan']) {
        await fs.mkdir(path.join(assetsRoot, id), { recursive: true });
        await fs.writeFile(path.join(assetsRoot, id, 'level.webp'), Buffer.alloc(8));
      }
      const result = await trimImagePyramidCache({
        assetsRoot,
        protectedAssetIds: new Set(['current']),
        recentAssetIds: new Set(['recent']),
        budgetBytes: 16,
      });
      expect(result).toEqual({ bytes: 16, removed: 1 });
      await expect(fs.stat(path.join(assetsRoot, 'orphan'))).rejects.toThrow();
      await expect(fs.stat(path.join(assetsRoot, 'recent'))).resolves.toBeDefined();
      await expect(fs.stat(path.join(assetsRoot, 'current'))).resolves.toBeDefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
