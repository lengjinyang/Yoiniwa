import type { AssetRecord, BoardItem, MediaKind, SceneItem, VideoClipFields, VideoItem } from '../types';

export const MEDIA_FILE_PATTERN = /\.(png|jpe?g|webp|bmp|gif|mp4|webm|mov|m4v)$/i;

function isVideoMime(mimeType: string | undefined) {
  return Boolean(mimeType?.toLowerCase().startsWith('video/'));
}

export function isVideoAsset(asset: AssetRecord | undefined) {
  return asset?.kind === 'video' || isVideoMime(asset?.mimeType);
}

export function isVideoItem(item: SceneItem, assets?: Record<string, AssetRecord>): item is VideoItem;
export function isVideoItem(
  item: { mediaKind?: MediaKind; assetId?: string },
  assets?: Record<string, AssetRecord>,
): boolean;
export function isVideoItem(
  item: { mediaKind?: MediaKind; assetId?: string },
  assets?: Record<string, AssetRecord>,
): item is VideoItem {
  if (item.mediaKind === 'video') return true;
  if (item.mediaKind === 'image') return false;
  if (!assets || !item.assetId) return false;
  return isVideoAsset(assets[item.assetId]);
}

/** Asset used for still display (board LOD / outline / export). */
export function displayAssetId(item: { assetId?: string; mediaKind?: MediaKind; posterAssetId?: string }) {
  if (item.mediaKind === 'video' && item.posterAssetId) return item.posterAssetId;
  return item.assetId;
}

/** Stamp mediaKind and drop video-only fields from still images. JSON shape stays Scene v3. */
export function toSceneItem(
  item: BoardItem & Partial<VideoClipFields> & { mediaKind?: MediaKind },
  assets?: Record<string, AssetRecord>,
): SceneItem {
  const { posterAssetId, durationSec, muted, loop, mediaKind, ...board } = item;
  if (isVideoItem(item, assets)) {
    return { ...board, mediaKind: 'video', posterAssetId, durationSec, muted, loop } satisfies VideoItem;
  }
  return mediaKind === 'image' ? { ...board, mediaKind: 'image' } : board;
}

export function isSupportedMediaFile(file: Pick<File, 'name' | 'type'>) {
  if (file.type.startsWith('image/') || file.type.startsWith('video/')) return true;
  return MEDIA_FILE_PATTERN.test(file.name);
}
