import { describe, expect, it } from 'vitest';
import { VideoStatsTracker } from './VideoStatsTracker';
import type { VideoRenderObject } from './VideoTypes';

function object(partial: Partial<VideoRenderObject>): VideoRenderObject {
  return {
    id: 'clip', frameDirty: false, frameSequence: 0, lastUploadedTime: -1, lastUploadAt: 0,
    posterLoading: false, posterToken: 0, intent: false, intentOrder: 0, phase: 'paused',
    currentTime: 0, displayedFrame: 0, interactionSeekInFlight: false, seekGeneration: 0,
    preparationProgress: 0, playToken: 0, loadToken: 0, fps: 24, rate: 1, buffering: false,
    visible: true, prefetched: false, lastTransportAt: 0, destroy() {},
    sprite: {} as VideoRenderObject['sprite'],
    badge: {} as VideoRenderObject['badge'],
    ...partial,
  };
}

describe('VideoStatsTracker', () => {
  it('counts playback objects and recent upload/drop rates', () => {
    const tracker = new VideoStatsTracker();
    const now = performance.now();
    tracker.recordUpload(now, 1024);
    tracker.recordDrop(now);
    const stats = tracker.snapshot((callback) => {
      callback(object({ intent: true, video: {} as HTMLVideoElement, phase: 'playing' }));
      callback(object({ id: 'idle', phase: 'suspended', posterTexture: {} as VideoRenderObject['posterTexture'] }));
    });
    expect(stats).toMatchObject({
      playbackIntents: 1,
      activeDecoders: 1,
      suspendedVideos: 1,
      posterTextures: 1,
      frameUploads: 1,
      frameUploadBytes: 1024,
      droppedFrames: 1,
      uploadFps: 1,
      droppedFps: 1,
    });
  });
});
