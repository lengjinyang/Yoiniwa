import { describe, expect, it, vi } from 'vitest';
import { videoPlaybackHostFromApi } from './videoPlaybackHost';
import type { VideoPreparationResult } from '../../types';

const result: VideoPreparationResult = {
  assetId: 'abc',
  fps: 24,
  ready: true,
  indexReady: true,
  playbackReady: true,
  vfr: false,
  state: 'ready',
};

describe('videoPlaybackHostFromApi', () => {
  it('returns nothing when the desktop video commands are missing', () => {
    expect(videoPlaybackHostFromApi(undefined)).toBeUndefined();
    expect(videoPlaybackHostFromApi({} as Window['refCanvas'])).toBeUndefined();
  });

  it('forwards playback and proxy events from the desktop API', async () => {
    const ensureVideoPlayback = vi.fn(async () => result);
    const onVideoProxyReady = vi.fn(() => () => undefined);
    const host = videoPlaybackHostFromApi({
      ensureVideoPlayback,
      cancelVideoPlayback: vi.fn(),
      onVideoProxyReady,
    } as unknown as Window['refCanvas']);
    expect(host).toBeDefined();
    await expect(host?.ensurePlayback?.('abc')).resolves.toEqual(result);
    expect(ensureVideoPlayback).toHaveBeenCalledWith('abc');
    host?.cancelPlayback?.('abc');
    const ready = vi.fn();
    host?.onProxyReady(ready);
    expect(onVideoProxyReady).toHaveBeenCalledWith(ready);
  });
});
