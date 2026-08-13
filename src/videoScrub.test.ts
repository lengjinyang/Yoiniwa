import { describe, expect, it } from 'vitest';
import {
  boundedVideoFrameCacheBudget,
  VideoFrameBitmapCache,
  videoFrameAtTime,
  videoFrameSeekTime,
  type VideoScrubIndex,
} from './videoScrub';

function index(pts: number[]): VideoScrubIndex {
  return {
    version: 1, assetId: 'a'.repeat(64), codec: 'avc1.640028', descriptionBase64: '',
    width: 1920, height: 1080, fps: 30, frameCount: pts.length,
    durationUs: pts.at(-1)! + 33_333, vfr: true, pixFmt: 'yuv420p',
    proxyReady: false, frameAccurate: true,
    frames: pts.map((ptsUs, frameIndex) => ({
      frameIndex, ptsUs, durationUs: pts[frameIndex + 1] ? pts[frameIndex + 1] - ptsUs : 33_333,
      keyFrame: frameIndex === 0,
    })),
  };
}

describe('videoScrub', () => {
  it('maps CFR and VFR presentation times to exact display-order frame indexes', () => {
    const vfr = index([0, 16_667, 50_000, 66_667]);
    expect(videoFrameAtTime(vfr, 0)).toBe(0);
    expect(videoFrameAtTime(vfr, 0.049)).toBe(1);
    expect(videoFrameAtTime(vfr, 0.050)).toBe(2);
    expect(videoFrameSeekTime(vfr, 2)).toBeCloseTo((50_000 + 8_333.5) / 1_000_000);
    expect(videoFrameSeekTime(vfr, 999)).toBeCloseTo((66_667 + 16_666.5) / 1_000_000);
  });

  it('bounds the decoded frame cache to 64-192 MiB based on device memory', () => {
    expect(boundedVideoFrameCacheBudget(1)).toBe(64 * 1024 * 1024);
    expect(boundedVideoFrameCacheBudget(8)).toBe(Math.round(8 * 1024 * 1024 * 1024 * 0.02));
    expect(boundedVideoFrameCacheBudget(64)).toBe(192 * 1024 * 1024);
  });

  it('closes unpinned bitmaps on LRU eviction and retains the pinned current frame', () => {
    const closed: number[] = [];
    const bitmap = (id: number) => ({ close: () => closed.push(id) }) as ImageBitmap;
    const cache = new VideoFrameBitmapCache(32);
    const first = cache.set({ assetId: 'a', frameIndex: 0, width: 2, height: 2, bitmap: bitmap(0) });
    cache.pin(first.cacheKey);
    cache.set({ assetId: 'a', frameIndex: 1, width: 2, height: 2, bitmap: bitmap(1) });
    cache.set({ assetId: 'a', frameIndex: 2, width: 2, height: 2, bitmap: bitmap(2) });
    expect(closed).toEqual([1]);
    expect(cache.get('a', 0, 2, 2)).toBeDefined();
    cache.unpin(first.cacheKey);
    cache.clear();
    expect(closed.sort()).toEqual([0, 1, 2]);
  });

  it('keeps one oversized current-frame candidate alive for upload', () => {
    let closed = false;
    const cache = new VideoFrameBitmapCache(8);
    const frame = cache.set({
      assetId: '8k', frameIndex: 9, width: 2, height: 2,
      bitmap: { close: () => { closed = true; } } as ImageBitmap,
    });
    expect(cache.get('8k', 9, 2, 2)).toBe(frame);
    expect(closed).toBe(false);
  });

  it('returns an exact cached frame, then the nearest neighbor within two frames', () => {
    const cache = new VideoFrameBitmapCache(1024);
    cache.set({ assetId: 'a', frameIndex: 10, width: 2, height: 2, bitmap: { close() {} } as ImageBitmap });
    cache.set({ assetId: 'a', frameIndex: 14, width: 2, height: 2, bitmap: { close() {} } as ImageBitmap });
    expect(cache.nearest('a', 10, 2, 2)?.frameIndex).toBe(10);
    expect(cache.nearest('a', 12, 2, 2)?.frameIndex).toBe(10);
    expect(cache.nearest('a', 20, 2, 2)).toBeUndefined();
  });
});
