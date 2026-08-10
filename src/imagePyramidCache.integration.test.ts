import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { createImageCachePathResolver } from '../electron/services/image-cache-paths.js';
import {
  isImagePyramidManifestCompatible, readImagePyramidManifest,
} from '../electron/services/image-pyramid-manifest.js';
import { buildImagePyramidCache } from '../electron/workers/mip-generator.js';
import type { AssetRecord } from './types';

const assetId = 'b'.repeat(64);

describe('disk image pyramid integration', () => {
  it('imports atomically, reopens from cache, survives source deletion, and migrates by root', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'refcanvas-pyramid-'));
    try {
      let root = path.join(parent, 'old');
      const source = path.join(parent, 'source.png');
      const encoded = await sharp({
        create: { width: 96, height: 48, channels: 4, background: { r: 20, g: 40, b: 60, alpha: 0.5 } },
      }).png().toBuffer();
      await fs.writeFile(source, encoded);
      const stat = await fs.stat(source);
      const record: AssetRecord = {
        id: assetId, assetId, hash: assetId, contentHash: assetId,
        mimeType: 'image/png', byteLength: stat.size, sourceSize: stat.size, sourceMtimeMs: stat.mtimeMs,
        naturalWidth: 96, naturalHeight: 48, orientation: 1, hasAlpha: true, cacheVersion: 3,
        originalName: 'source.png', sourcePath: source,
      };
      const progress: string[] = [];
      await buildImagePyramidCache({
        cacheRoot: root, assetId, input: source, record,
        report: (stage) => progress.push(stage),
      });
      const paths = createImageCachePathResolver(() => root);
      const first = await readImagePyramidManifest(paths, record);
      expect(first.levels).toHaveLength(1);
      expect(progress).toContain('commit');

      await fs.rm(source);
      const reopened = await readImagePyramidManifest(paths, record);
      await expect(fs.readFile(path.join(paths.assetRoot(assetId), reopened.levels[0].file))).resolves.not.toHaveLength(0);

      const newRoot = path.join(parent, 'new');
      await fs.mkdir(path.dirname(path.join(newRoot, 'image-cache')), { recursive: true });
      await fs.cp(path.join(root, 'image-cache'), path.join(newRoot, 'image-cache'), { recursive: true });
      root = newRoot;
      expect((await readImagePyramidManifest(paths, record)).assetId).toBe(assetId);
      expect(paths.manifestPath(assetId)).toContain(path.join('new', 'image-cache'));
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  it('invalidates on source signature, content hash, cache version, and algorithm version changes', () => {
    const record: AssetRecord = {
      id: assetId, assetId, hash: assetId, contentHash: assetId,
      mimeType: 'image/png', byteLength: 10, sourceSize: 10, sourceMtimeMs: 20,
      naturalWidth: 100, naturalHeight: 50, orientation: 1, hasAlpha: false,
      originalName: 'a.png', cacheVersion: 3,
    };
    const manifest = {
      assetId, contentHash: assetId, sourceSize: 10, sourceMtimeMs: 20,
      width: 100, height: 50, orientation: 1, hasAlpha: false,
      cacheVersion: 3, mipAlgorithmVersion: 2, tileSize: 512,
      createdAt: new Date().toISOString(),
      levels: [{ edge: 100, width: 100, height: 50, file: 'level-100.webp', byteLength: 1 }],
      tileLevels: [],
    };
    expect(isImagePyramidManifestCompatible(manifest, record)).toBe(true);
    expect(isImagePyramidManifestCompatible(manifest, { ...record, sourceSize: 11 })).toBe(false);
    expect(isImagePyramidManifestCompatible(manifest, { ...record, sourceMtimeMs: 21 })).toBe(true);
    expect(isImagePyramidManifestCompatible(manifest, { ...record, contentHash: undefined, sourceMtimeMs: 21 })).toBe(false);
    expect(isImagePyramidManifestCompatible(manifest, { ...record, contentHash: 'c'.repeat(64) })).toBe(false);
    expect(isImagePyramidManifestCompatible({ ...manifest, cacheVersion: 2 }, record)).toBe(false);
    expect(isImagePyramidManifestCompatible({ ...manifest, mipAlgorithmVersion: 1 }, record)).toBe(false);
  });

  it('does not commit a deleted or obsolete asset after cancellation', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'refcanvas-pyramid-cancel-'));
    try {
      const source = path.join(root, 'source.png');
      await sharp({ create: { width: 640, height: 480, channels: 3, background: '#446688' } }).png().toFile(source);
      const stat = await fs.stat(source);
      const record: AssetRecord = {
        id: assetId, assetId, hash: assetId, contentHash: assetId,
        mimeType: 'image/png', byteLength: stat.size, sourceSize: stat.size, sourceMtimeMs: stat.mtimeMs,
        naturalWidth: 640, naturalHeight: 480, orientation: 1, hasAlpha: false, cacheVersion: 3,
        originalName: 'source.png', sourcePath: source,
      };
      let canceled = false;
      await expect(buildImagePyramidCache({
        cacheRoot: root, assetId, input: source, record,
        report: (stage, progress) => { if (stage === 'mip' && progress > 0) canceled = true; },
        isCanceled: () => canceled,
      })).rejects.toMatchObject({ name: 'ImageJobCanceledError' });
      const paths = createImageCachePathResolver(() => root);
      await expect(fs.stat(paths.manifestPath(assetId))).rejects.toThrow();
      const temporary = await fs.readdir(path.join(paths.cacheRoot(), 'tmp')).catch(() => []);
      expect(temporary).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
