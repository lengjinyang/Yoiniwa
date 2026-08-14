import { describe, expect, it } from 'vitest';
import { displayAssetId, isSupportedMediaFile, isVideoAsset, isVideoItem, toSceneItem } from './media';
import type { AssetRecord } from '../types';

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
      mediaKind: 'video' as const,
    };
    expect(displayAssetId(item)).toBe('poster-id');
    expect(displayAssetId({ assetId: 'image-id', mediaKind: 'image' })).toBe('image-id');
  });

  it('stamps independent video nodes and strips clip fields from stills', () => {
    const still = toSceneItem({
      id: 'still', name: 'photo', sourceType: 'file', naturalWidth: 10, naturalHeight: 10,
      x: 0, y: 0, width: 10, height: 10, rotation: 0, flipX: false, flipY: false, opacity: 1,
      zIndex: 0, locked: false, crop: { x: 0, y: 0, width: 10, height: 10 },
      muted: true, loop: false, posterAssetId: 'poster',
    });
    expect(still).toEqual(expect.objectContaining({ id: 'still' }));
    expect(still).not.toHaveProperty('muted');
    expect(still).not.toHaveProperty('posterAssetId');
    expect(toSceneItem({
      id: 'clip', name: 'clip', sourceType: 'file', assetId: 'a', naturalWidth: 10, naturalHeight: 10,
      x: 0, y: 0, width: 10, height: 10, rotation: 0, flipX: false, flipY: false, opacity: 1,
      zIndex: 0, locked: false, crop: { x: 0, y: 0, width: 10, height: 10 },
      mediaKind: 'video', muted: false, loop: true, posterAssetId: 'poster', durationSec: 4,
    })).toMatchObject({ mediaKind: 'video', muted: false, loop: true, posterAssetId: 'poster', durationSec: 4 });
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
