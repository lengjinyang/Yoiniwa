import type { AssetRecord, ImageItem, MediaKind } from './types';

export const IMAGE_FILE_PATTERN = /\.(png|jpe?g|webp|bmp|gif)$/i;
export const VIDEO_FILE_PATTERN = /\.(mp4|webm|mov|m4v)$/i;
export const MEDIA_FILE_PATTERN = /\.(png|jpe?g|webp|bmp|gif|mp4|webm|mov|m4v)$/i;

export function isVideoMime(mimeType: string | undefined) {
  return Boolean(mimeType?.toLowerCase().startsWith('video/'));
}

export function isVideoAsset(asset: AssetRecord | undefined) {
  return asset?.kind === 'video' || isVideoMime(asset?.mimeType);
}

export function isVideoItem(item: Pick<ImageItem, 'mediaKind' | 'assetId'>, assets?: Record<string, AssetRecord>) {
  if (item.mediaKind === 'video') return true;
  if (item.mediaKind === 'image') return false;
  if (!assets || !item.assetId) return false;
  return isVideoAsset(assets[item.assetId]);
}

export function mediaKindOf(item: Pick<ImageItem, 'mediaKind' | 'assetId'>, assets?: Record<string, AssetRecord>): MediaKind {
  return isVideoItem(item, assets) ? 'video' : 'image';
}

/** Asset used for still display (board LOD / outline / export). */
export function displayAssetId(item: Pick<ImageItem, 'assetId' | 'posterAssetId' | 'mediaKind'>) {
  if (item.mediaKind === 'video' && item.posterAssetId) return item.posterAssetId;
  return item.assetId;
}

export function isSupportedMediaFile(file: Pick<File, 'name' | 'type'>) {
  if (file.type.startsWith('image/') || file.type.startsWith('video/')) return true;
  return MEDIA_FILE_PATTERN.test(file.name);
}

export function isSupportedVideoFile(file: Pick<File, 'name' | 'type'>) {
  if (file.type.startsWith('video/')) return true;
  return VIDEO_FILE_PATTERN.test(file.name);
}
