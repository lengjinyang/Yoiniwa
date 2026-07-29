import path from 'node:path';
import {
  IMAGE_CACHE_DIRECTORY, IMAGE_CACHE_FORMAT_VERSION, MIP_ALGORITHM_VERSION,
} from '../../src/shared/imagePipelineConfig.js';

const ASSET_ID = /^[a-f\d]{64}$/i;

export interface ImageCacheAddress {
  assetId: string;
  mip: number;
  tileX?: number;
  tileY?: number;
}

function assertAssetId(assetId: string) {
  if (!ASSET_ID.test(assetId)) throw new Error('图片 Asset ID 无效');
  return assetId.toLowerCase();
}

export function imageCacheKey(address: ImageCacheAddress) {
  const assetId = assertAssetId(address.assetId);
  if (!Number.isInteger(address.mip) || address.mip < 1) throw new Error('图片 Mip 无效');
  const tile = address.tileX === undefined && address.tileY === undefined
    ? 'full'
    : `${address.tileX}:${address.tileY}`;
  if ((address.tileX === undefined) !== (address.tileY === undefined)
    || (address.tileX !== undefined && (!Number.isInteger(address.tileX) || address.tileX < 0))
    || (address.tileY !== undefined && (!Number.isInteger(address.tileY) || address.tileY < 0))) {
    throw new Error('图片 Tile 坐标无效');
  }
  return `${assetId}:v${IMAGE_CACHE_FORMAT_VERSION}:a${MIP_ALGORITHM_VERSION}:m${address.mip}:${tile}`;
}

/** Resolves every path from the current root; no path survives a root migration. */
export function createImageCachePathResolver(currentRoot: () => string) {
  const cacheRoot = () => path.join(currentRoot(), IMAGE_CACHE_DIRECTORY);
  const assetsRoot = () => path.join(cacheRoot(), 'assets');
  const assetRoot = (assetId: string) => path.join(assetsRoot(), assertAssetId(assetId));
  return {
    cacheRoot,
    assetsRoot,
    assetRoot,
    manifestPath: (assetId: string) => path.join(assetRoot(assetId), 'manifest.json'),
    levelPath: (assetId: string, edge: number, extension = '.webp') => {
      if (!Number.isInteger(edge) || edge < 1) throw new Error('图片 Mip 无效');
      return path.join(assetRoot(assetId), `level-${edge}${extension}`);
    },
    tileDirectory: (assetId: string, edge: number) => path.join(assetRoot(assetId), `level-${edge}`),
    tilePath: (assetId: string, edge: number, x: number, y: number, extension = '.webp') => {
      imageCacheKey({ assetId, mip: edge, tileX: x, tileY: y });
      return path.join(assetRoot(assetId), `level-${edge}`, `${x}-${y}${extension}`);
    },
    temporaryAssetRoot: (assetId: string, nonce: string) => path.join(
      cacheRoot(), 'tmp', `${assertAssetId(assetId)}-${nonce}`,
    ),
  };
}
