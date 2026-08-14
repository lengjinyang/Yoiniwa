import { Texture } from 'pixi.js';
import { invalidateVideoPlaybackUrl } from '../../runtime/videoUrl';
import type { VideoPlaybackHost } from '../video/videoPlaybackHost';
import type { RenderObjectRegistry } from './RenderObjectRegistry';
import type { VideoRenderObject } from './VideoTypes';
import { VIDEO_DECODER_RELEASE_DELAY_MS, VIDEO_MAX_PLAYBACK_INTENTS } from './VideoPerformancePolicy';

export interface VideoDecoderHost {
  requestRender(): void;
  readonly videoPlayback?: VideoPlaybackHost;
  objects: RenderObjectRegistry<VideoRenderObject>;
  bindObjectSprite(object: VideoRenderObject, texture?: Texture): void;
  fallbackVideoTexture(object: VideoRenderObject): Texture;
  textureUnusable(texture?: Texture): boolean;
  retireTexture(texture?: Texture): void;
}

export class VideoDecoderLifecycle {
  constructor(private readonly host: VideoDecoderHost) {}

  scheduleRelease(object: VideoRenderObject) {
    this.cancelRelease(object);
    object.decoderReleaseTimer = window.setTimeout(() => {
      object.decoderReleaseTimer = undefined;
      if (!object.intent && object.phase === 'paused') {
        this.release(object, object.visible || object.prefetched);
        this.host.requestRender();
      }
    }, VIDEO_DECODER_RELEASE_DELAY_MS);
  }

  cancelRelease(object: VideoRenderObject) {
    if (object.decoderReleaseTimer !== undefined) window.clearTimeout(object.decoderReleaseTimer);
    object.decoderReleaseTimer = undefined;
  }

  release(object: VideoRenderObject, keepFrame: boolean) {
    const video = object.video;
    if (video && object.videoFrameCallback !== undefined && typeof video.cancelVideoFrameCallback === 'function') {
      try { video.cancelVideoFrameCallback(object.videoFrameCallback); } catch { /* */ }
    }
    if (keepFrame && video && object.surface && object.surfaceContext && object.videoSource
      && !object.videoSource.destroyed && video.videoWidth > 0 && video.videoHeight > 0) {
      try {
        object.surfaceContext.drawImage(video, 0, 0, object.surface.width, object.surface.height);
        object.videoSource.update();
        if (object.videoTexture && !object.videoTexture.destroyed) {
          this.host.bindObjectSprite(object, object.videoTexture);
        }
      } catch { /* retain the last uploaded canvas frame */ }
    }
    if (this.host.textureUnusable(object.sprite.texture)) {
      this.host.bindObjectSprite(
        object,
        object.videoTexture && !object.videoTexture.destroyed ? object.videoTexture : this.host.fallbackVideoTexture(object),
      );
    }
    object.video = undefined;
    object.videoFrameCallback = undefined;
    object.lastPresentedFrames = undefined;
    object.lastPresentedMediaTime = undefined;
    object.presentedTime = undefined;
    object.buffering = false;
    object.frameDirty = false;
    if (video) {
      video.onwaiting = null;
      video.onstalled = null;
      video.onplaying = null;
      video.oncanplay = null;
      video.onended = null;
      video.onerror = null;
      try { video.pause(); } catch { /* */ }
      video.removeAttribute('src');
      try { video.load(); } catch { /* */ }
      video.remove();
    }
    if (keepFrame) return;
    if (object.surfaceResizeTimer !== undefined) window.clearTimeout(object.surfaceResizeTimer);
    object.surfaceResizeTimer = undefined;
    object.surfaceResizeAt = undefined;
    const texture = object.videoTexture;
    object.videoTexture = undefined;
    object.videoSource = undefined;
    object.surface = undefined;
    object.surfaceContext = undefined;
    object.frameSize = undefined;
    this.host.bindObjectSprite(
      object,
      object.posterTexture && !object.posterTexture.destroyed ? object.posterTexture : Texture.EMPTY,
    );
    this.host.retireTexture(texture);
  }

  ensureCapacity(exceptId: string) {
    const decoders: VideoRenderObject[] = [];
    this.host.objects.forEach((object) => { if (object.video && object.id !== exceptId) decoders.push(object); });
    const available = VIDEO_MAX_PLAYBACK_INTENTS - 1;
    if (decoders.length <= available) return;
    decoders.sort((left, right) => Number(left.intent) - Number(right.intent) || left.intentOrder - right.intentOrder);
    for (const candidate of decoders.slice(0, decoders.length - available)) {
      this.release(candidate, candidate.visible || candidate.prefetched);
    }
  }

  cancelProxyIfUnused(assetId?: string) {
    if (!assetId) return;
    let used = false;
    this.host.objects.forEach((object) => {
      if (object.assetId === assetId && object.intent) used = true;
    });
    if (!used) {
      invalidateVideoPlaybackUrl(assetId);
      this.host.videoPlayback?.cancelPlayback?.(assetId);
    }
  }
}
