import fs from 'node:fs/promises';
import type { AssetRecord } from '../../src/types.js';
import { IMAGE_CACHE_FORMAT_VERSION, MIP_ALGORITHM_VERSION } from '../../src/shared/imagePipelineConfig.js';
import type { createImageCachePathResolver } from './image-cache-paths.js';

export interface DiskMipLevel {
  edge: number;
  width: number;
  height: number;
  file: string;
  byteLength: number;
}

export interface DiskTileLevel {
  level: number;
  width: number;
  height: number;
  columns: number;
  rows: number;
  directory: string;
}

export interface ImagePyramidManifest {
  assetId: string;
  contentHash: string;
  sourceSize: number;
  sourceMtimeMs?: number;
  width: number;
  height: number;
  orientation: number;
  hasAlpha: boolean;
  cacheVersion: number;
  mipAlgorithmVersion: number;
  tileSize: number;
  createdAt: string;
  levels: DiskMipLevel[];
  tileLevels: DiskTileLevel[];
}

export function isImagePyramidManifestCompatible(manifest: ImagePyramidManifest, record: AssetRecord) {
  const assetId = record.assetId ?? record.id;
  const hasDefinitiveContentIdentity = typeof record.contentHash === 'string' && record.contentHash.length > 0;
  return manifest.assetId === assetId
    && manifest.contentHash === (record.contentHash ?? record.hash)
    && manifest.sourceSize === (record.sourceSize ?? record.byteLength)
    // mtime protects legacy path-based records. For content-addressed records,
    // an equal SHA-256 is stronger evidence and permits cross-project reuse.
    && (hasDefinitiveContentIdentity || record.sourceMtimeMs === undefined || manifest.sourceMtimeMs === undefined
      || manifest.sourceMtimeMs === record.sourceMtimeMs)
    && manifest.cacheVersion === IMAGE_CACHE_FORMAT_VERSION
    && manifest.mipAlgorithmVersion === MIP_ALGORITHM_VERSION
    && manifest.width === record.naturalWidth
    && manifest.height === record.naturalHeight
    && manifest.levels.length > 0;
}

export async function readImagePyramidManifest(
  paths: ReturnType<typeof createImageCachePathResolver>,
  record: AssetRecord,
) {
  const assetId = record.assetId ?? record.id;
  const parsed = JSON.parse(await fs.readFile(paths.manifestPath(assetId), 'utf8')) as ImagePyramidManifest;
  if (!isImagePyramidManifestCompatible(parsed, record)) throw new Error('图片金字塔缓存已过期');
  return parsed;
}

export function closestManifestLevel(manifest: ImagePyramidManifest, requestedEdge: number) {
  const ordered = [...manifest.levels].sort((left, right) => left.edge - right.edge);
  return ordered.find((level) => level.edge >= requestedEdge) ?? ordered.at(-1);
}
