import { CanvasSource, Graphics, Sprite, Texture, type Container } from 'pixi.js';
import { isVideoItem } from '../../domain/media';
import type { VideoItem, Scene, Viewport } from '../../types';
import {
  cachedVideoFrameCount,
  cachedVideoFps,
} from '../../runtime/videoUrl';
import type { TextureManager } from '../textures/TextureManager';
import type { VideoPlaybackHost } from '../video/videoPlaybackHost';
import { RenderObjectRegistry } from './RenderObjectRegistry';
import { VideoDecoderLifecycle } from './VideoDecoderLifecycle';
import { VideoFrameUploader } from './VideoFrameUploader';
import { VideoPlaybackController } from './VideoPlaybackController';
import { VideoPosterController } from './VideoPosterController';
import {
  bindVideoSprite,
  drawVideoBadge,
} from './VideoPresentation';
import { VideoStatsTracker } from './VideoStatsTracker';
import type { VideoRenderObject, VideoRuntimeStats, VideoSeekInteractionKind, VideoTransportState } from './VideoTypes';
import {
  resolvedVideoDuration,
  VIDEO_SURFACE_DOWNSIZE_DELAY_MS,
  videoFrameTime,
  videoFrameSize,
  videoHasDecodedFrame,
  videoShouldBindPosterFallback,
  videoVisibilityAction,
  shouldResizeVideoFrame,
  type VideoFrameSize,
} from './VideoPerformancePolicy';

export type { VideoRuntimeStats, VideoTransportState } from './VideoTypes';
export { videoBadgeWorldSize } from './VideoPresentation';

export class VideoRenderer {
  private readonly objects = new RenderObjectRegistry<VideoRenderObject>();
  private readonly items = new Map<string, VideoItem>();
  private scene?: Scene;
  private transportListener?: (state: VideoTransportState) => void;
  private selectedId?: string;
  private hoveredVideoId?: string;
  private intentSequence = 0;
  private frameSequence = 0;
  private uploadRoundRobinAfterId?: string;
  private readonly statsTracker = new VideoStatsTracker();
  private readonly retiredTextures: Texture[] = [];
  private maxTextureSize = 8192;
  private viewportScale = 1;
  private readonly uploader: VideoFrameUploader;
  private readonly playback: VideoPlaybackController;
  private readonly decoder: VideoDecoderLifecycle;
  private readonly poster: VideoPosterController;

  constructor(
    private readonly layer: Container,
    textures: TextureManager,
    private readonly requestRender: () => void,
    videoPlayback?: VideoPlaybackHost,
  ) {
    layer.sortableChildren = true;
    this.decoder = new VideoDecoderLifecycle({
      requestRender,
      videoPlayback,
      objects: this.objects,
      bindObjectSprite: (object, texture) => this.bindObjectSprite(object, texture),
      fallbackVideoTexture: (object) => this.fallbackVideoTexture(object),
      textureUnusable: (texture) => this.textureUnusable(texture),
      retireTexture: (texture) => this.retireTexture(texture),
    });
    this.poster = new VideoPosterController({
      requestRender,
      scene: () => this.scene,
      items: this.items,
      textures,
      bindObjectSprite: (object, texture) => this.bindObjectSprite(object, texture),
    });
    this.playback = new VideoPlaybackController({
      emitTransport: (id, force) => this.emitTransport(id, force),
      requestRender,
      videoPlayback,
      paintBadge: (object, item) => this.paintBadge(object, item),
      ensureVideoSurface: (object, item) => this.ensureVideoSurface(object, item),
      objects: this.objects,
      items: this.items,
      nextIntentOrder: () => ++this.intentSequence,
      nextFrameSequence: () => ++this.frameSequence,
      ensureDecoderCapacity: (id) => this.decoder.ensureCapacity(id),
      cancelDecoderRelease: (object) => this.decoder.cancelRelease(object),
      releaseDecoder: (object, keepFrame) => this.decoder.release(object, keepFrame),
      scheduleDecoderRelease: (object) => this.decoder.scheduleRelease(object),
    });
    this.uploader = new VideoFrameUploader({
      objects: this.objects,
      items: this.items,
      selectedId: () => this.selectedId,
      stats: this.statsTracker,
      getRoundRobinAfterId: () => this.uploadRoundRobinAfterId,
      setRoundRobinAfterId: (id) => { this.uploadRoundRobinAfterId = id; },
      videoSurfaceIntact: (object) => this.videoSurfaceIntact(object),
      ensureVideoSurface: (object, item) => this.ensureVideoSurface(object, item),
      emitTransport: (id, force) => this.emitTransport(id, force),
    });
  }

  setMaxTextureSize(value: number) {
    if (Number.isFinite(value) && value >= 256) this.maxTextureSize = Math.round(value);
  }

  onTransportChange(listener?: (state: VideoTransportState) => void) {
    this.transportListener = listener;
  }

  setSelected(id?: string) {
    this.selectedId = id;
    if (!id) return;
    this.emitTransport(id, true);
  }

  setHoveredVideo(id?: string) {
    if (id === this.hoveredVideoId) return false;
    const previous = this.hoveredVideoId;
    this.hoveredVideoId = id;
    this.refreshBadge(previous);
    this.refreshBadge(id);
    return true;
  }

  private badgeHidden(object: VideoRenderObject) {
    return this.hoveredVideoId === object.id;
  }

  private paintBadge(object: VideoRenderObject, item: VideoItem) {
    drawVideoBadge(object.badge, item, this.viewportScale, this.badgeHidden(object));
  }

  private refreshBadge(id?: string) {
    if (!id) return;
    const object = this.objects.get(id);
    const item = this.items.get(id);
    if (object && item) this.paintBadge(object, item);
  }

  sync(scene: Scene) {
    this.scene = scene;
    const next = new Map(scene.items.filter((item) => isVideoItem(item, scene.assets)).map((item) => [item.id, item]));
    this.objects.retain(new Set(next.keys()));
    this.items.clear();
    next.forEach((item, id) => this.items.set(id, item));
    this.items.forEach((item) => this.syncItem(item));
  }

  updateQuality(options: {
    visible: ReadonlySet<string>;
    prefetch: ReadonlySet<string>;
    viewport: Viewport;
    devicePixelRatio: number;
    cameraMoving: boolean;
    now: number;
  }) {
    let needsFallbackFrames = false;
    const nextScale = Math.max(0.001, options.viewport.scale);
    const scaleChanged = Math.abs(nextScale - this.viewportScale) > 0.0001;
    this.viewportScale = nextScale;
    this.objects.forEach((object, id) => {
      const item = this.items.get(id);
      if (!item || item.hidden) {
        object.sprite.renderable = false;
        object.badge.renderable = false;
        if (object.intent || object.video) this.pauseObject(object, item, false);
        this.releasePoster(object);
        if (item && scaleChanged) this.paintBadge(object, item);
        return;
      }
      object.visible = options.visible.has(id);
      object.prefetched = options.prefetch.has(id);
      const relevant = object.visible || object.prefetched;
      object.sprite.renderable = relevant;
      object.badge.renderable = relevant;

      if (relevant) {
        if (object.posterReleaseTimer !== undefined) {
          window.clearTimeout(object.posterReleaseTimer);
          object.posterReleaseTimer = undefined;
        }
        const desiredFrameSize = videoFrameSize(item, options.viewport, options.devicePixelRatio, this.maxTextureSize);
        object.desiredFrameSize = desiredFrameSize;
        this.updateSurfaceSize(object, item, desiredFrameSize, options.cameraMoving, options.now);
        const posterEdge = object.visible ? desiredFrameSize.edge : 128;
        this.ensurePoster(object, item, posterEdge, object.visible ? 90 : 15, options.cameraMoving);
      } else {
        this.schedulePosterRelease(object);
      }

      if (scaleChanged) this.paintBadge(object, item);

      const visibilityAction = videoVisibilityAction(object.intent, object.phase, object.visible, object.prefetched);
      if (visibilityAction === 'resume') void this.activateObject(object, item);
      else if (visibilityAction === 'suspend') {
        this.suspendObject(object, item);
      }

      if (object.phase === 'playing' && object.video
        && typeof object.video.requestVideoFrameCallback !== 'function') {
        object.frameDirty = true;
        object.frameSequence = ++this.frameSequence;
        needsFallbackFrames = true;
      }
    });
    this.uploader.process(options.now);
    if (needsFallbackFrames) this.requestRender();
  }

  transportState(id: string): VideoTransportState | undefined {
    const object = this.objects.get(id);
    const item = this.items.get(id);
    if (!object || !item) return undefined;
    const video = object.video;
    return {
      id,
      phase: object.phase,
      playing: object.intent,
      loading: object.phase === 'loading' || object.phase === 'proxy-pending' || object.buffering,
      currentTime: video?.currentTime ?? object.currentTime,
      duration: resolvedVideoDuration(
        item.durationSec,
        video?.duration,
        item.assetId ? this.scene?.assets[item.assetId]?.durationSec : undefined,
      ),
      fps: object.fps,
      preparationStage: object.preparationStage,
      preparationProgress: object.preparationProgress,
      muted: object.video ? object.video.muted : item.muted !== false,
      rate: object.rate || 1,
      ready: Boolean(video && video.readyState >= 2) || Boolean(object.posterTexture),
    };
  }

  stats(): VideoRuntimeStats {
    return this.statsTracker.snapshot((callback) => this.objects.forEach((object) => callback(object)));
  }

  togglePlayback(id: string) {
    const object = this.objects.get(id);
    const item = this.items.get(id);
    if (!object || !item || item.hidden) return false;
    if (object.intent || object.phase === 'loading' || object.phase === 'proxy-pending') this.pauseObject(object, item, true);
    else this.startIntent(object, item);
    return true;
  }

  async play(id: string) {
    const object = this.objects.get(id);
    const item = this.items.get(id);
    if (!object || !item) return false;
    this.startIntent(object, item);
    return object.intent;
  }

  pause(id: string) {
    const object = this.objects.get(id);
    const item = this.items.get(id);
    if (!object || !item) return false;
    this.pauseObject(object, item, true);
    return true;
  }

  beginTimelineSeek(id: string) {
    return this.beginSeekInteraction(id, 'timeline');
  }

  seekTimeline(id: string, time: number) {
    const object = this.objects.get(id);
    const item = this.items.get(id);
    if (!object || !item) return false;
    if (object.seekInteraction?.kind !== 'timeline' && !this.beginSeekInteraction(id, 'timeline')) return false;
    this.queueInteractionSeek(object, item, time);
    return true;
  }

  endTimelineSeek(id: string) {
    return this.endSeekInteraction(id, 'timeline');
  }

  beginCanvasJog(id: string) {
    return this.beginSeekInteraction(id, 'canvas-jog');
  }

  jogCanvasFrames(id: string, frameOffset: number) {
    const object = this.objects.get(id);
    const item = this.items.get(id);
    const interaction = object?.seekInteraction;
    if (!object || !item || interaction?.kind !== 'canvas-jog') return false;
    const fps = Math.max(1, object.fps || cachedVideoFps(item.assetId ?? id));
    const duration = resolvedVideoDuration(
      item.durationSec,
      object.video?.duration,
      item.assetId ? this.scene?.assets[item.assetId]?.durationSec : undefined,
    );
    const frame = interaction.originFrame + Math.trunc(frameOffset);
    const time = duration > 0
      ? videoFrameTime(frame, duration, fps, object.frameCount)
      : Math.max(0, (frame + 0.5) / fps);
    this.queueInteractionSeek(object, item, time);
    return true;
  }

  endCanvasJog(id: string) {
    return this.endSeekInteraction(id, 'canvas-jog');
  }

  /**
   * Adopt freshly indexed timing. Objects activated before the index landed hold
   * the 30 fps fallback, and jogCanvasFrames prefers object.fps over the cache,
   * so frame math stays wrong until this overwrites them.
   */
  refreshTiming(assetId: string) {
    this.objects.forEach((object, id) => {
      const item = this.items.get(id);
      if (!item || item.assetId !== assetId) return;
      object.fps = cachedVideoFps(assetId);
      object.frameCount = cachedVideoFrameCount(assetId);
    });
  }

  resumeWhenProxyReady(assetId: string) {
    this.refreshTiming(assetId);
    this.objects.forEach((object, id) => {
      const item = this.items.get(id);
      if (!item || item.assetId !== assetId) return;
      if (object.phase !== 'proxy-pending') return;
      if (object.pendingSeekTime !== undefined) {
        this.scheduleInteractionSeek(object, item);
        return;
      }
      if (object.intent && object.visible) {
        void this.activateObject(object, item);
      } else if (object.intent) {
        object.phase = 'suspended';
        this.emitTransport(id, true);
      }
    });
  }

  failProxy(assetId: string) {
    this.objects.forEach((object, id) => {
      const item = this.items.get(id);
      if (item?.assetId !== assetId || object.phase !== 'proxy-pending') return;
      object.intent = false;
      object.pendingSeekTime = undefined;
      object.seekInteraction = undefined;
      object.interactionEnding = false;
      object.seekGeneration += 1;
      if (object.seekFrame !== undefined) window.cancelAnimationFrame(object.seekFrame);
      object.seekFrame = undefined;
      object.phase = 'error';
      this.paintBadge(object, item);
      this.emitTransport(id, true);
    });
    this.requestRender();
  }

  setPreparation(assetId: string, stage: string, fraction: number) {
    this.objects.forEach((object, id) => {
      if (object.assetId !== assetId) return;
      object.preparationStage = stage;
      object.preparationProgress = Math.max(0, Math.min(1, fraction));
      this.emitTransport(id, true);
    });
  }

  setRate(id: string, rate: number) {
    const object = this.objects.get(id);
    if (!object) return false;
    object.rate = Math.max(0.25, Math.min(4, rate));
    if (object.video) object.video.playbackRate = object.rate;
    this.emitTransport(id, true);
    return true;
  }

  setMuted(id: string, muted: boolean) {
    const object = this.objects.get(id);
    const item = this.items.get(id);
    if (!object || !item) return false;
    if (object.video) {
      object.video.defaultMuted = muted;
      object.video.muted = muted;
      object.video.volume = muted ? 0 : 1;
    }
    this.emitTransport(id, true);
    return true;
  }

  isPlaying(id: string) { return Boolean(this.objects.get(id)?.intent); }

  pauseAll() {
    this.objects.forEach((object, id) => this.pauseObject(object, this.items.get(id), false));
  }

  invalidateTextures() {
    this.objects.forEach((object) => {
      this.releaseDecoder(object, false);
      this.releasePoster(object);
      object.phase = object.intent ? 'suspended' : 'paused';
    });
  }

  restoreTextures() {
    this.objects.forEach((object) => this.bindObjectSprite(object, object.posterTexture));
  }

  recoverAfterRenderError() {
    this.objects.forEach((object, id) => {
      this.detachDestroyedVideoTextures(object, this.items.get(id));
    });
  }

  afterRender() {
    const pending = this.retiredTextures.splice(0);
    for (const texture of pending) {
      try { if (!texture.destroyed) texture.destroy(true); } catch { /* GPU resource already gone */ }
    }
  }

  destroy() {
    this.pauseAll();
    this.objects.destroy();
    this.afterRender();
  }

  private startIntent(object: VideoRenderObject, item: VideoItem) {
    this.playback.startIntent(object, item);
  }

  private activateObject(object: VideoRenderObject, item: VideoItem) {
    return this.playback.activateObject(object, item);
  }

  private suspendObject(object: VideoRenderObject, item: VideoItem) {
    this.playback.suspendObject(object, item);
    this.bindObjectSprite(object, object.posterTexture);
  }

  private pauseObject(object: VideoRenderObject, item: VideoItem | undefined, keepFrame: boolean) {
    this.playback.pauseObject(object, item, keepFrame);
  }

  private beginSeekInteraction(id: string, kind: VideoSeekInteractionKind) {
    const object = this.objects.get(id);
    const item = this.items.get(id);
    if (!object || !item || item.hidden) return false;
    if (object.seekInteraction?.kind === kind) return true;
    const originTime = object.video?.currentTime ?? object.currentTime;
    const fps = Math.max(1, object.fps || cachedVideoFps(item.assetId ?? id));
    const originFrame = Math.max(0, Math.floor(originTime * fps + 1e-4));
    const resumeAfter = kind === 'timeline' && object.intent;
    if (object.intent) this.pauseObject(object, item, true);
    this.cancelDecoderRelease(object);
    object.seekInteraction = { kind, originFrame, resumeAfter };
    object.interactionEnding = false;
    object.pendingSeekTime = undefined;
    this.emitTransport(id, true);
    return true;
  }

  private endSeekInteraction(id: string, kind: VideoSeekInteractionKind) {
    const object = this.objects.get(id);
    if (!object || object.seekInteraction?.kind !== kind) return false;
    object.interactionEnding = true;
    this.finishSeekInteractionIfSettled(object);
    return true;
  }

  private queueInteractionSeek(object: VideoRenderObject, item: VideoItem, time: number) {
    const duration = resolvedVideoDuration(
      item.durationSec,
      object.video?.duration,
      item.assetId ? this.scene?.assets[item.assetId]?.durationSec : undefined,
    );
    const target = Math.max(0, Math.min(duration || Math.max(0, time), time));
    object.pendingSeekTime = target;
    object.currentTime = target;
    object.phase = object.video ? 'paused' : 'loading';
    this.emitTransport(item.id, true);
    this.requestRender();
    this.scheduleInteractionSeek(object, item);
  }

  private scheduleInteractionSeek(object: VideoRenderObject, item: VideoItem) {
    if (object.seekFrame !== undefined) return;
    object.seekFrame = requestAnimationFrame(() => {
      object.seekFrame = undefined;
      void this.applyInteractionSeek(object, item);
    });
  }

  private async applyInteractionSeek(object: VideoRenderObject, item: VideoItem) {
    if (object.pendingSeekTime === undefined) {
      this.finishSeekInteractionIfSettled(object);
      return;
    }
    try {
      await this.playback.ensureLiveVideo(object, item);
    } catch (error) {
      if (error instanceof Error && error.message === 'playback-pending') {
        object.phase = 'proxy-pending';
        this.emitTransport(item.id, true);
        window.dispatchEvent(new CustomEvent('refcanvas-video-preparing', {
          detail: { id: item.id, assetId: item.assetId },
        }));
      }
      return;
    }
    const video = object.video;
    const target = object.pendingSeekTime;
    if (!video || target === undefined) return;
    object.pendingSeekTime = undefined;
    const generation = ++object.seekGeneration;
    video.pause();
    object.phase = 'paused';
    const finish = () => {
      video.removeEventListener('seeked', finish);
      if (object.video !== video || object.seekGeneration !== generation) return;
      object.currentTime = video.currentTime;
      object.presentedTime = video.currentTime;
      object.frameDirty = true;
      object.frameSequence = ++this.frameSequence;
      this.emitTransport(item.id, true);
      this.requestRender();
      if (object.pendingSeekTime !== undefined) this.scheduleInteractionSeek(object, item);
      else this.finishSeekInteractionIfSettled(object);
    };
    video.addEventListener('seeked', finish, { once: true });
    video.currentTime = target;
    if (!video.seeking && Math.abs(video.currentTime - target) < 0.001 && video.readyState >= 2) finish();
  }

  private finishSeekInteractionIfSettled(object: VideoRenderObject) {
    if (!object.interactionEnding || object.pendingSeekTime !== undefined || object.seekFrame !== undefined
      || object.video?.seeking) return;
    const interaction = object.seekInteraction;
    object.seekInteraction = undefined;
    object.interactionEnding = false;
    const item = this.items.get(object.id);
    if (interaction?.resumeAfter && item && object.visible) this.startIntent(object, item);
    else {
      if (item && object.video) this.decoder.scheduleRelease(object);
      this.emitTransport(object.id, true);
    }
  }

  private videoSurfaceIntact(object: VideoRenderObject) {
    return Boolean(
      object.surface
      && object.surfaceContext
      && object.videoSource
      && !object.videoSource.destroyed
      && object.videoTexture
      && !object.videoTexture.destroyed,
    );
  }

  private fallbackVideoTexture(object: VideoRenderObject) {
    const poster = object.posterTexture;
    return poster && !poster.destroyed ? poster : Texture.EMPTY;
  }

  private retireTexture(texture?: Texture) {
    if (!texture || texture.destroyed || texture === Texture.EMPTY) return;
    if (this.retiredTextures.includes(texture)) return;
    this.retiredTextures.push(texture);
  }

  private bindObjectSprite(object: VideoRenderObject, texture?: Texture) {
    const item = this.items.get(object.id);
    if (item) bindVideoSprite(object.sprite, item, texture);
    else object.sprite.texture = texture && !texture.destroyed ? texture : Texture.EMPTY;
  }

  private textureUnusable(texture?: Texture) {
    return Boolean(texture?.destroyed || texture?.source?.destroyed);
  }

  private detachDestroyedVideoTextures(object: VideoRenderObject, item?: VideoItem) {
    const spriteTexture = object.sprite.texture;
    const videoDead = this.textureUnusable(object.videoTexture) || Boolean(object.videoSource?.destroyed);
    if (this.textureUnusable(spriteTexture) || (spriteTexture === object.videoTexture && videoDead)) {
      if (item) bindVideoSprite(object.sprite, item, this.fallbackVideoTexture(object));
      else object.sprite.texture = this.fallbackVideoTexture(object);
    }
    if (videoDead) {
      object.videoTexture = undefined;
      object.videoSource = undefined;
      object.surface = undefined;
      object.surfaceContext = undefined;
      object.frameSize = undefined;
    }
  }

  private ensureVideoSurface(object: VideoRenderObject, item: VideoItem, previousSurface?: HTMLCanvasElement) {
    if (this.videoSurfaceIntact(object)) return;
    const retainedSurface = previousSurface ?? object.surface;
    this.detachDestroyedVideoTextures(object, item);
    const desired = object.desiredFrameSize ?? {
      width: Math.max(2, item.naturalWidth), height: Math.max(2, item.naturalHeight),
      edge: Math.max(item.naturalWidth, item.naturalHeight),
      bytes: Math.max(2, item.naturalWidth) * Math.max(2, item.naturalHeight) * 4,
    };
    const surface = document.createElement('canvas');
    surface.width = desired.width;
    surface.height = desired.height;
    const context = surface.getContext('2d', { alpha: false, colorSpace: 'srgb' });
    if (!context) throw new Error('无法创建视频帧表面');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    const copied = this.copyPausedVideoSurface(context, surface, retainedSurface);
    const source = new CanvasSource({
      resource: surface,
      autoDensity: false,
      resolution: 1,
      transparent: false,
      alphaMode: 'no-premultiply-alpha',
      scaleMode: 'linear',
    });
    const texture = new Texture({ source });
    const oldTexture = object.videoTexture;
    object.surface = surface;
    object.surfaceContext = context;
    object.videoSource = source;
    object.videoTexture = texture;
    object.frameSize = desired;
    object.frameDirty = !copied;
    if (oldTexture && oldTexture !== object.sprite.texture) this.retireTexture(oldTexture);
    // Keep the poster (or previous pixels) on screen until a decoded frame is
    // actually blitted. Binding the empty canvas here is what made first play black.
    this.paintCurrentVideoFrame(object, item, copied);
  }

  private copyPausedVideoSurface(
    context: CanvasRenderingContext2D,
    target: HTMLCanvasElement,
    previous?: HTMLCanvasElement,
  ) {
    if (!previous || previous === target || previous.width < 2 || previous.height < 2) return false;
    try {
      context.drawImage(previous, 0, 0, target.width, target.height);
      return true;
    } catch {
      return false;
    }
  }

  private paintCurrentVideoFrame(object: VideoRenderObject, item: VideoItem, copiedPausedFrame = false) {
    if (copiedPausedFrame && object.phase !== 'playing') {
      object.videoSource?.update();
      bindVideoSprite(object.sprite, item, object.videoTexture);
      return;
    }
    const hasLiveVideo = Boolean(object.video && videoHasDecodedFrame(
      object.video.videoWidth, object.video.videoHeight, object.video.readyState,
    ));
    if (hasLiveVideo) {
      object.frameDirty = true;
      this.uploader.upload(object, item, performance.now());
      return;
    }
    if (!videoShouldBindPosterFallback(false, false, object.displayedFrame)) {
      object.videoSource?.update();
      return;
    }
    const fallback = this.fallbackVideoTexture(object);
    if (fallback !== Texture.EMPTY && object.phase !== 'playing') {
      bindVideoSprite(object.sprite, item, fallback);
    }
  }

  private rebuildVideoSurface(object: VideoRenderObject, item: VideoItem, desired: VideoFrameSize) {
    const previousSurface = object.surface;
    const oldTexture = object.videoTexture;
    object.videoTexture = undefined;
    object.videoSource = undefined;
    object.surface = undefined;
    object.surfaceContext = undefined;
    object.frameSize = undefined;
    object.desiredFrameSize = desired;
    this.ensureVideoSurface(object, item, previousSurface);
    if (oldTexture && oldTexture !== object.sprite.texture) this.retireTexture(oldTexture);
  }

  private updateSurfaceSize(
    object: VideoRenderObject,
    item: VideoItem,
    desired: VideoFrameSize,
    cameraMoving: boolean,
    now: number,
  ) {
    if (!this.videoSurfaceIntact(object)) {
      if (object.surface || object.videoSource || object.videoTexture) this.ensureVideoSurface(object, item);
      return;
    }
    const current = object.frameSize;
    if (!current) return;
    if (!shouldResizeVideoFrame(current.edge, desired.edge, cameraMoving)) {
      object.surfaceResizeAt = undefined;
      if (object.surfaceResizeTimer !== undefined) window.clearTimeout(object.surfaceResizeTimer);
      object.surfaceResizeTimer = undefined;
      return;
    }
    if (desired.edge < current.edge) {
      object.surfaceResizeAt ??= now;
      const remaining = VIDEO_SURFACE_DOWNSIZE_DELAY_MS - (now - object.surfaceResizeAt);
      if (remaining > 0) {
        if (object.surfaceResizeTimer === undefined) {
          object.surfaceResizeTimer = window.setTimeout(() => {
            object.surfaceResizeTimer = undefined;
            this.requestRender();
          }, remaining);
        }
        return;
      }
    }
    if (object.surfaceResizeTimer !== undefined) window.clearTimeout(object.surfaceResizeTimer);
    object.surfaceResizeTimer = undefined;
    object.surfaceResizeAt = undefined;
    this.rebuildVideoSurface(object, item, desired);
  }
  private syncItem(item: VideoItem) {
    let object = this.objects.get(item.id);
    if (!object) {
      const sprite = new Sprite(Texture.EMPTY);
      const badge = new Graphics();
      this.layer.addChild(sprite, badge);
      object = {
        id: item.id, assetId: item.assetId, sprite, badge,
        frameDirty: false, frameSequence: 0, lastUploadedTime: -1, lastUploadAt: 0,
        posterLoading: false, posterToken: 0, intent: false, intentOrder: 0, phase: 'paused', currentTime: 0,
        displayedFrame: 0, seekGeneration: 0,
        preparationProgress: 0,
        playToken: 0, loadToken: 0, fps: cachedVideoFps(item.assetId ?? item.id),
        frameCount: cachedVideoFrameCount(item.assetId ?? item.id), rate: 1, buffering: false,
        visible: false, prefetched: false, lastTransportAt: 0,
        destroy: () => {
          object!.intent = false;
          object!.playToken += 1;
          object!.loadToken += 1;
          object!.posterToken += 1;
          object!.seekGeneration += 1;
          if (object!.seekFrame !== undefined) window.cancelAnimationFrame(object!.seekFrame);
          this.cancelDecoderRelease(object!);
          if (object!.surfaceResizeTimer !== undefined) window.clearTimeout(object!.surfaceResizeTimer);
          if (object!.posterReleaseTimer !== undefined) window.clearTimeout(object!.posterReleaseTimer);
          this.releaseDecoder(object!, false);
          this.releasePoster(object!);
          this.cancelProxyIfUnused(object!.assetId);
          sprite.destroy();
          badge.destroy();
        },
      };
      this.objects.set(item.id, object);
    }
    object.assetId = item.assetId;
    if (object.video) {
      object.video.defaultMuted = item.muted !== false;
      object.video.muted = item.muted !== false;
      object.video.volume = item.muted === false ? 1 : 0;
      object.video.loop = item.loop !== false;
      object.video.playbackRate = object.rate;
    }
    bindVideoSprite(object.sprite, item, object.sprite.texture);
    this.paintBadge(object, item);
  }

  private ensurePoster(object: VideoRenderObject, item: VideoItem, edge: number, priority: number, cameraMoving = false) {
    this.poster.ensure(object, item, edge, priority, cameraMoving);
  }

  private schedulePosterRelease(object: VideoRenderObject) {
    this.poster.scheduleRelease(object);
  }

  private releasePoster(object: VideoRenderObject) {
    this.poster.release(object);
  }

  private cancelDecoderRelease(object: VideoRenderObject) {
    this.decoder.cancelRelease(object);
  }

  private releaseDecoder(object: VideoRenderObject, keepFrame: boolean) {
    this.decoder.release(object, keepFrame);
  }

  private cancelProxyIfUnused(assetId?: string) {
    this.decoder.cancelProxyIfUnused(assetId);
  }

  private emitTransport(id: string, force = false) {
    if (id !== this.selectedId) return;
    const object = this.objects.get(id);
    if (!object) return;
    const now = performance.now();
    if (!force && now - object.lastTransportAt < 1000 / 30) return;
    object.lastTransportAt = now;
    const state = this.transportState(id);
    if (state) this.transportListener?.(state);
  }
}
