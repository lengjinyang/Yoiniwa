import type { VideoItem } from '../../types';
import { cachedVideoFrameAtTime } from '../../runtime/videoUrl';
import { bindVideoSprite } from './VideoPresentation';
import type { RenderObjectRegistry } from './RenderObjectRegistry';
import type { VideoStatsTracker } from './VideoStatsTracker';
import type { VideoRenderObject } from './VideoTypes';
import {
  chooseVideoFrameUploads,
  resolvedVideoDuration,
  videoFramePhaseUploadable,
  videoPresentedFrameIsNew,
  videoFrameState,
  videoFrameUploadDue,
  videoHasDecodedFrame,
} from './VideoPerformancePolicy';

export class VideoFrameUploader {
  constructor(private readonly host: {
    objects: RenderObjectRegistry<VideoRenderObject>;
    items: Map<string, VideoItem>;
    selectedId: () => string | undefined;
    stats: VideoStatsTracker;
    getRoundRobinAfterId: () => string | undefined;
    setRoundRobinAfterId: (id?: string) => void;
    videoSurfaceIntact: (object: VideoRenderObject) => boolean;
    ensureVideoSurface: (object: VideoRenderObject, item: VideoItem) => void;
    emitTransport: (id: string, force?: boolean) => void;
  }) {}

  process(now: number) {
    const candidates: Array<{ object: VideoRenderObject; item: VideoItem }> = [];
    this.host.objects.forEach((object, id) => {
      const item = this.host.items.get(id);
      if (!item || !videoFramePhaseUploadable(object.phase) || !object.video || !object.frameDirty || !object.frameSize) return;
      candidates.push({ object, item });
    });
    let playingCount = 0;
    this.host.objects.forEach((object) => { if (object.phase === 'playing') playingCount += 1; });
    const selectedId = this.host.selectedId();
    const eligible = candidates.filter(({ object }) => {
      if (object.phase === 'paused'
        || videoFrameUploadDue(now, object.lastUploadAt, playingCount, object.id === selectedId)) return true;
      object.frameDirty = false;
      this.host.stats.recordDrop(now);
      return false;
    });
    const chosen = chooseVideoFrameUploads(eligible.map(({ object }) => ({
      id: object.id,
      bytes: object.frameSize!.bytes,
      selected: object.id === selectedId,
      sequence: object.frameSequence,
    })), undefined, this.host.getRoundRobinAfterId());
    this.host.setRoundRobinAfterId(chosen.nextRoundRobinAfterId);
    const chosenIds = new Set(chosen.selected);
    eligible.forEach(({ object, item }) => {
      if (!chosenIds.has(object.id)) {
        object.frameDirty = false;
        this.host.stats.recordDrop(now);
        return;
      }
      if (this.upload(object, item, now)) {
        this.host.stats.recordUpload(now, object.frameSize?.bytes ?? 0);
      }
    });
  }

  upload(object: VideoRenderObject, item: VideoItem, now: number, force = false) {
    object.frameDirty = false;
    if (!object.video || !videoHasDecodedFrame(object.video.videoWidth, object.video.videoHeight, object.video.readyState)) {
      return false;
    }
    if (!this.host.videoSurfaceIntact(object)) this.host.ensureVideoSurface(object, item);
    const { video, videoSource: source, surface, surfaceContext, videoTexture } = object;
    if (!video || !source || !surface || !surfaceContext || source.destroyed || videoTexture?.destroyed) return false;
    try {
      const presentedTime = object.presentedTime ?? video.currentTime;
      if (!force && !videoPresentedFrameIsNew(presentedTime, object.lastUploadedTime)) return false;
      const mappedFrame = (item.assetId ? cachedVideoFrameAtTime(item.assetId, presentedTime) : undefined)
        ?? videoFrameState(
          presentedTime,
          resolvedVideoDuration(item.durationSec, video.duration),
          object.fps,
          object.frameCount,
        ).currentFrame;
      // Blit through a 2D canvas. Pixi VideoSource does not refresh from a
      // hidden decoder element, and destroying it mid-batch crashes WebGL.
      surfaceContext.drawImage(video, 0, 0, surface.width, surface.height);
      source.update();
      bindVideoSprite(object.sprite, item, videoTexture);
      object.currentTime = presentedTime;
      object.displayedFrame = mappedFrame;
      object.lastUploadedTime = presentedTime;
      object.lastUploadAt = now;
      // During Timeline Scrub / Canvas Jog, including the final paused upload
      // after release, the counter must follow the texture that was actually
      // uploaded instead of the seek target set earlier.
      this.host.emitTransport(item.id, Boolean(object.seekInteraction) || object.phase === 'paused');
      return true;
    } catch {
      return false;
    }
  }
}
