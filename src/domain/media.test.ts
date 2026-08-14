import { describe, expect, it } from 'vitest';
import { displayAssetId, isSupportedMediaFile, isVideoAsset, isVideoItem } from './media';
import type { AssetRecord, ImageItem } from './types';

describe('media helpers', () => {
  it('detects video files by extension and mime', () => {
    expect(isSupportedMediaFile({ name: 'clip.mp4', type: '' })).toBe(true);
    expect(isSupportedMediaFile({ name: 'clip.webm', type: 'video/webm' })).toBe(true);
    expect(isSupportedMediaFile({ name: 'photo.png', type: 'image/png' })).toBe(true);
    expect(isSupportedMediaFile({ name: 'notes.txt', type: 'text/plain' })).toBe(false);
  });

  it('resolves display asset to poster for videos', () => {
    const item = {
      assetId: 'video-id',
      posterAssetId: 'poster-id',
      mediaKind: 'video',
    } as Pick<ImageItem, 'assetId' | 'posterAssetId' | 'mediaKind'>;
    expect(displayAssetId(item)).toBe('poster-id');
    expect(displayAssetId({ assetId: 'image-id', mediaKind: 'image' })).toBe('image-id');
  });

  it('detects video items from mediaKind or asset mime', () => {
    const asset: AssetRecord = {
      id: 'a', hash: 'a', mimeType: 'video/mp4', byteLength: 1,
      naturalWidth: 10, naturalHeight: 10, originalName: 'a.mp4', kind: 'video',
    };
    expect(isVideoAsset(asset)).toBe(true);
    expect(isVideoItem({ mediaKind: 'video', assetId: 'a' })).toBe(true);
    expect(isVideoItem({ mediaKind: 'image', assetId: 'a' }, { a: asset })).toBe(false);
    expect(isVideoItem({ assetId: 'a' }, { a: asset })).toBe(true);
  });
});
