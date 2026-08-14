import type { VideoRenderObject, VideoRuntimeStats } from './VideoTypes';

export class VideoStatsTracker {
  private counters = { frameUploads: 0, frameUploadBytes: 0, droppedFrames: 0 };
  private readonly recentUploadTimes: number[] = [];
  private readonly recentDroppedTimes: number[] = [];

  recordUpload(now: number, bytes: number) {
    this.counters.frameUploads += 1;
    this.counters.frameUploadBytes += bytes;
    this.recentUploadTimes.push(now);
  }

  recordDrop(now: number) {
    this.counters.droppedFrames += 1;
    this.recentDroppedTimes.push(now);
  }

  snapshot(forEachObject: (callback: (object: VideoRenderObject) => void) => void): VideoRuntimeStats {
    let playbackIntents = 0;
    let activeDecoders = 0;
    let suspendedVideos = 0;
    let posterTextures = 0;
    forEachObject((object) => {
      if (object.intent) playbackIntents += 1;
      if (object.video) activeDecoders += 1;
      if (object.phase === 'suspended') suspendedVideos += 1;
      if (object.posterTexture) posterTextures += 1;
    });
    const cutoff = performance.now() - 1000;
    while ((this.recentUploadTimes[0] ?? Infinity) < cutoff) this.recentUploadTimes.shift();
    while ((this.recentDroppedTimes[0] ?? Infinity) < cutoff) this.recentDroppedTimes.shift();
    return {
      ...this.counters,
      playbackIntents,
      activeDecoders,
      suspendedVideos,
      posterTextures,
      uploadFps: this.recentUploadTimes.length,
      droppedFps: this.recentDroppedTimes.length,
    };
  }
}
