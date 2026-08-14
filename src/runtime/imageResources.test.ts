import { describe, expect, it } from 'vitest';
import { boundedPreviewSize, chooseImageVariant, cropForResource, deleteCacheEntryIfCurrent, imageSource, imageVariantCandidates, releaseCacheEntryReference } from './imageResources';

describe('image resource levels', () => {
  it('uses derived resources only for distant images', () => {
    expect(chooseImageVariant({ width: 50, height: 40 }, 1, 1)).toBe('thumb128');
    expect(chooseImageVariant({ width: 100, height: 50 }, 1, 1)).toBe('thumb128');
    expect(chooseImageVariant({ width: 250, height: 140 }, 1, 1)).toBe('thumb256');
    expect(chooseImageVariant({ width: 500, height: 300 }, 1, 1)).toBe('thumb512');
    expect(chooseImageVariant({ width: 600, height: 300 }, 1, 1)).toBe('thumb1024');
    expect(chooseImageVariant({ width: 1000, height: 800 }, 1, 1)).toBe('thumb1024');
    expect(chooseImageVariant({ width: 1000, height: 800, naturalWidth: 4000, naturalHeight: 3200 }, 1, 1)).toBe('original');
  });

  it('builds an asset URL while retaining fixture data URLs', () => {
    expect(imageSource({ assetId: 'abc' }, 'thumb256')).toContain('abc?variant=thumb256');
    expect(imageSource({ assetId: 'abc' }, 'thumb1024')).toContain('abc?variant=thumb1024');
    expect(imageSource({ dataUrl: 'data:image/png;base64,x' })).toBe('data:image/png;base64,x');
  });

  it('maps original crop coordinates into each derived resource without changing display size', () => {
    expect(cropForResource({ naturalWidth: 1156, naturalHeight: 651, crop: { x: 0, y: 0, width: 1156, height: 651 } }, 256, 144))
      .toEqual({ x: 0, y: 0, width: 256, height: 144 });
    const crop = cropForResource({ naturalWidth: 1000, naturalHeight: 500, crop: { x: 100, y: 50, width: 600, height: 300 } }, 250, 125);
    expect(crop).toEqual({ x: 25, y: 12.5, width: 150, height: 75 });
  });

  it('does not duplicate the safety preview under an exact detail command', () => {
    expect(imageVariantCandidates(false, 'thumb512', 'thumb512')).toEqual(['thumb512']);
    expect(imageVariantCandidates(false, 'thumb512')).toEqual(['thumb128', 'thumb512']);
  });

  it('keeps browser-generated emergency previews inside the permanent atlas budget', () => {
    expect(boundedPreviewSize(4096, 2048)).toEqual({ width: 128, height: 64 });
    expect(boundedPreviewSize(320, 1280)).toEqual({ width: 32, height: 128 });
    expect(boundedPreviewSize(64, 32)).toEqual({ width: 64, height: 32 });
  });

  it('does not let an obsolete failed request delete its replacement cache entry', () => {
    const listener = () => undefined;
    const oldEntry = { refs: 1, listeners: new Set([listener]), errorListeners: new Set<() => void>(), lastUsed: 0 };
    const replacement = { refs: 2, listeners: new Set([listener]), errorListeners: new Set<() => void>(), lastUsed: 0 };
    const entries = new Map([['asset', replacement]]);
    expect(deleteCacheEntryIfCurrent(entries, 'asset', oldEntry)).toBe(false);
    expect(entries.get('asset')).toBe(replacement);
    releaseCacheEntryReference(oldEntry, listener, undefined, 10);
    expect(oldEntry.refs).toBe(0);
    expect(replacement.refs).toBe(2);
    expect(deleteCacheEntryIfCurrent(entries, 'asset', replacement)).toBe(true);
    expect(entries.has('asset')).toBe(false);
  });
});
