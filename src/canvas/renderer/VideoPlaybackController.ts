import {
  cachedVideoFrameAtTime,
  cachedVideoFrameCount,
  cachedVideoFps,
  isOriginalVideoPlayback,
  rejectOriginalVideoPlayback,
  resolveVideoPlaybackUrl,
} from '../../runtime/videoUrl';
import type { VideoItem } from '../../types';
import type { VideoPlaybackHost } from '../video/videoPlaybackHost';
import type { RenderObjectRegistry } from './RenderObjectRegistry';
import { ensureVideoHost } from './VideoPresentation';
import type { VideoRenderObject } from './VideoTypes';
import {
  normalizeVideoFps,
  oldestPlaybackIntent,
  VIDEO_MAX_PLAYBACK_INTENTS,
} from './VideoPerformancePolicy';

export interface VideoPlaybackControllerHost {
  emitTransport(id: string, force?: boolean): void;
  requestRender(): void;
  readonly videoPlayback?: VideoPlaybackHost;
  paintBadge(object: VideoRenderObject, item: VideoItem): void;
  ensureVideoSurface(object: VideoRenderObject, item: VideoItem): void;
  objects: RenderObjectRegistry<VideoRenderObject>;
  items: Map<string, VideoItem>;
  nextIntentOrder(): number;
  nextFrameSequence(): number;
  ensureDecoderCapacity(id: string): void;
  cancelDecoderRelease(object: VideoRenderObject): void;
  releaseDecoder(object: VideoRenderObject, keepFrame: boolean): void;
  scheduleDecoderRelease(object: VideoRenderObject): void;
}

export class VideoPlaybackController {
  constructor(private readonly host: VideoPlaybackControllerHost) {}

  startIntent(object: VideoRenderObject, item: VideoItem) {
    if (object.intent) return;
    const active: Array<{ object: VideoRenderObject; item: VideoItem }> = [];
    this.host.objects.forEach((candidate, id) => {
      const candidateItem = this.host.items.get(id);
      if (candidate.intent && candidateItem) active.push({ object: candidate, item: candidateItem });
    });
    if (active.length >= VIDEO_MAX_PLAYBACK_INTENTS) {
      const evicted = oldestPlaybackIntent(active.map((value) => ({ ...value, intentOrder: value.object.intentOrder })))!;
      this.pauseObject(evicted.object, evicted.item, true);
      window.dispatchEvent(new CustomEvent('refcanvas-status', {
        detail: `最多同时播放 ${VIDEO_MAX_PLAYBACK_INTENTS} 个视频，已暂停「${evicted.item.name}」`,
      }));
    }
    object.intent = true;
    object.intentOrder = this.host.nextIntentOrder();
    this.host.paintBadge(object, item);
    if (object.visible) void this.activateObject(object, item);
    else {
      object.phase = 'suspended';
      this.host.emitTransport(item.id);
      this.host.requestRender();
    }
  }

  async activateObject(object: VideoRenderObject, item: VideoItem) {
    if (!object.intent || object.phase === 'loading' || object.phase === 'playing' || object.phase === 'proxy-pending') return;
    const playToken = ++object.playToken;
    object.phase = 'loading';
    this.host.ensureDecoderCapacity(object.id);
    this.host.cancelDecoderRelease(object);
    this.host.emitTransport(item.id, true);
    this.host.requestRender();
    try {
      await this.ensureLiveVideo(object, item);
      let video = object.video;
      if (!video) throw new Error('视频未就绪');
      const alignedTime = object.currentTime;
      if (alignedTime > 0 && Math.abs(video.currentTime - alignedTime) > 0.01) {
        await this.alignVideoBeforePlayback(video, alignedTime);
      }
      try {
        await video.play();
      } catch (error) {
        if (!item.assetId || !isOriginalVideoPlayback(item.assetId)) throw error;
        rejectOriginalVideoPlayback(item.assetId);
        this.host.releaseDecoder(object, false);
        await this.ensureLiveVideo(object, item, false);
        video = object.video;
        if (!video) throw new Error('视频未就绪');
        if (alignedTime > 0) await this.alignVideoBeforePlayback(video, alignedTime);
        await video.play();
      }
      if (object.playToken !== playToken || !object.intent || !object.visible) {
        video.pause();
        if (object.intent) this.suspendObject(object, item);
        return;
      }
      this.watchVideoState(object, item, video);
      object.buffering = false;
      object.phase = 'playing';
      object.frameDirty = true;
      object.frameSequence = this.host.nextFrameSequence();
      this.host.ensureVideoSurface(object, item);
      this.host.paintBadge(object, item);
      this.host.emitTransport(item.id, true);
      this.host.requestRender();
    } catch (error) {
      if (object.playToken !== playToken) return;
      const message = error instanceof Error ? error.message : '';
      if (message === 'stale') return;
      this.host.releaseDecoder(object, false);
      if (message === 'playback-pending') {
        object.phase = 'proxy-pending';
        window.dispatchEvent(new CustomEvent('refcanvas-video-preparing', {
          detail: { id: item.id, assetId: item.assetId },
        }));
      } else {
        object.intent = false;
        object.phase = 'error';
        window.dispatchEvent(new CustomEvent('refcanvas-status', {
          detail: message ? `视频播放失败：${message}` : '视频播放失败',
        }));
      }
      this.host.paintBadge(object, item);
      this.host.emitTransport(item.id, true);
      this.host.requestRender();
    }
  }

  async ensureLiveVideo(
    object: VideoRenderObject,
    item: VideoItem,
    allowOriginalFallback = true,
  ): Promise<void> {
    if (object.video) return;
    object.liveVideoPromise ??= this.openLiveVideo(object, item, allowOriginalFallback)
      .finally(() => { object.liveVideoPromise = undefined; });
    return object.liveVideoPromise;
  }

  suspendObject(object: VideoRenderObject, item: VideoItem) {
    if (!object.intent) return;
    object.currentTime = object.video?.currentTime ?? object.currentTime;
    object.playToken += 1;
    object.loadToken += 1;
    object.buffering = false;
    object.phase = 'suspended';
    this.host.releaseDecoder(object, false);
    this.host.paintBadge(object, item);
    this.host.emitTransport(item.id, true);
    this.host.requestRender();
  }

  pauseObject(object: VideoRenderObject, item: VideoItem | undefined, keepFrame: boolean) {
    object.currentTime = object.video?.currentTime ?? object.currentTime;
    object.intent = false;
    object.playToken += 1;
    object.loadToken += 1;
    object.buffering = false;
    object.phase = 'paused';
    object.video?.pause();
    if (keepFrame && (object.visible || object.prefetched)) this.host.scheduleDecoderRelease(object);
    else this.host.releaseDecoder(object, false);
    if (item) this.host.paintBadge(object, item);
    this.host.emitTransport(object.id, true);
    this.host.requestRender();
  }

  private alignVideoBeforePlayback(video: HTMLVideoElement, time: number) {
    if (Math.abs(video.currentTime - time) <= 0.001 && !video.seeking) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => { cleanup(); reject(new Error('播放帧对齐超时')); }, 4000);
      const cleanup = () => {
        window.clearTimeout(timeout);
        video.removeEventListener('seeked', ready);
        video.removeEventListener('error', failed);
      };
      const ready = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(new Error('播放帧对齐失败')); };
      video.addEventListener('seeked', ready, { once: true });
      video.addEventListener('error', failed, { once: true });
      video.currentTime = time;
      if (!video.seeking && video.readyState >= 2) ready();
    });
  }

  private async openLiveVideo(
    object: VideoRenderObject,
    item: VideoItem,
    allowOriginalFallback = true,
  ): Promise<void> {
    if (object.video) return;
    if (!item.assetId) throw new Error('缺少视频资源');
    const token = ++object.loadToken;
    const src = await resolveVideoPlaybackUrl(
      item.assetId,
      this.host.videoPlayback?.ensurePlayback
        ? { ensurePlayback: (assetId) => this.host.videoPlayback!.ensurePlayback!(assetId) }
        : undefined,
    );
    if (!src) throw new Error('playback-pending');
    if (object.loadToken !== token) throw new Error('stale');
    object.fps = cachedVideoFps(item.assetId);
    object.frameCount = cachedVideoFrameCount(item.assetId);
    const video = document.createElement('video');
    video.defaultMuted = item.muted !== false;
    video.muted = item.muted !== false;
    video.volume = item.muted === false ? 1 : 0;
    video.loop = item.loop !== false;
    video.playsInline = true;
    // Local range-backed media benefits from keeping decoder and demux buffers warm.
    video.preload = 'auto';
    video.crossOrigin = 'anonymous';
    video.playbackRate = object.rate;
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    Object.assign(video.style, { width: '16px', height: '16px', display: 'block' });
    ensureVideoHost().appendChild(video);
    object.video = video;
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => { cleanup(); reject(new Error('video-decode-failed')); }, 8000);
        const cleanup = () => {
          window.clearTimeout(timeout);
          video.removeEventListener('loadedmetadata', ready);
          video.removeEventListener('error', failed);
        };
        const ready = () => { cleanup(); resolve(); };
        const failed = () => { cleanup(); reject(new Error('video-decode-failed')); };
        video.addEventListener('loadedmetadata', ready, { once: true });
        video.addEventListener('error', failed, { once: true });
        video.src = src;
        video.load();
        if (video.readyState >= 1) ready();
      });
    } catch (error) {
      if (object.loadToken !== token) throw new Error('stale');
      if (allowOriginalFallback && error instanceof Error && error.message === 'video-decode-failed') {
        rejectOriginalVideoPlayback(item.assetId);
        this.host.releaseDecoder(object, false);
        return this.openLiveVideo(object, item, false);
      }
      this.host.releaseDecoder(object, false);
      throw new Error('视频无法解码');
    }
    if (object.loadToken !== token) {
      this.host.releaseDecoder(object, false);
      throw new Error('stale');
    }
    this.host.ensureVideoSurface(object, item);
    this.watchVideoFrames(object, video);
    video.addEventListener('loadeddata', () => {
      if (object.video !== video) return;
      object.frameDirty = true;
      const current = this.host.items.get(object.id);
      if (current) this.host.ensureVideoSurface(object, current);
      this.host.requestRender();
    }, { once: true });
  }

  private watchVideoFrames(object: VideoRenderObject, video: HTMLVideoElement) {
    if (typeof video.requestVideoFrameCallback !== 'function') return;
    const next = () => {
      object.videoFrameCallback = video.requestVideoFrameCallback((_now, metadata) => {
        if (object.video !== video) return;
        if (object.phase === 'playing' && object.frameCount === undefined
          && object.lastPresentedFrames !== undefined && object.lastPresentedMediaTime !== undefined) {
          const frames = metadata.presentedFrames - object.lastPresentedFrames;
          const seconds = metadata.mediaTime - object.lastPresentedMediaTime;
          const observedFps = frames > 0 && seconds > 0 ? frames / seconds : 0;
          if (observedFps >= 1 && observedFps <= 240) {
            object.fps = normalizeVideoFps(observedFps);
          }
        }
        object.lastPresentedFrames = metadata.presentedFrames;
        object.lastPresentedMediaTime = metadata.mediaTime;
        if (object.seekInteraction && object.interactionTargetTime !== undefined) {
          const indexedFrame = object.assetId ? cachedVideoFrameAtTime(object.assetId, metadata.mediaTime) : undefined;
          const wrongIndexedFrame = indexedFrame !== undefined && object.interactionTargetFrame !== undefined
            && indexedFrame !== object.interactionTargetFrame;
          const tolerance = 0.75 / Math.max(1, object.fps);
          if (wrongIndexedFrame || (indexedFrame === undefined
            && Math.abs(metadata.mediaTime - object.interactionTargetTime) > tolerance)) {
            next();
            return;
          }
        }
        object.presentedTime = metadata.mediaTime;
        // A paused video still presents decoded frames while Timeline Scrub or
        // Canvas Jog is active. Upload each presented preview immediately.
        if (!object.seekInteraction && !object.intent && object.phase !== 'playing' && object.phase !== 'loading') {
          next();
          return;
        }
        object.frameDirty = true;
        object.frameSequence = this.host.nextFrameSequence();
        this.host.requestRender();
        next();
      });
    };
    next();
  }

  private watchVideoState(object: VideoRenderObject, item: VideoItem, video: HTMLVideoElement) {
    const setBuffering = () => {
      if (object.video !== video || !object.intent || object.phase !== 'playing' || object.buffering) return;
      object.buffering = true;
      this.host.emitTransport(item.id, true);
    };
    const setPlaying = () => {
      if (object.video !== video || !object.intent) return;
      const changed = object.buffering || object.phase !== 'playing';
      object.buffering = false;
      object.phase = 'playing';
      if (changed) this.host.emitTransport(item.id, true);
    };
    video.onwaiting = setBuffering;
    video.onstalled = setBuffering;
    video.onplaying = setPlaying;
    video.oncanplay = () => {
      if (object.video !== video || !object.buffering) return;
      object.buffering = false;
      this.host.emitTransport(item.id, true);
    };
    video.onended = () => {
      if (object.video !== video || video.loop) return;
      object.currentTime = Number.isFinite(video.duration) ? video.duration : video.currentTime;
      object.intent = false;
      object.buffering = false;
      object.phase = 'paused';
      this.host.paintBadge(object, item);
      this.host.scheduleDecoderRelease(object);
      this.host.emitTransport(item.id, true);
      this.host.requestRender();
    };
    video.onerror = () => {
      if (object.video !== video) return;
      object.currentTime = video.currentTime;
      object.intent = false;
      object.buffering = false;
      object.phase = 'error';
      object.playToken += 1;
      object.loadToken += 1;
      this.host.releaseDecoder(object, true);
      this.host.paintBadge(object, item);
      this.host.emitTransport(item.id, true);
      this.host.requestRender();
      window.dispatchEvent(new CustomEvent('refcanvas-status', { detail: '视频播放中断，请重试' }));
    };
  }
}
