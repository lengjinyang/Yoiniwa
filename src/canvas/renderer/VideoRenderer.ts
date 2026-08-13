import { CanvasSource, Graphics, Sprite, Texture, type Container } from 'pixi.js';
import { assetResourceUrl } from '../../assetResourceUrl';
import { isVideoItem } from '../../media';
import type { ImageItem, Scene, Viewport } from '../../types';
import {
  invalidateVideoScrubIndex,
  FfmpegFrameProvider,
  videoFrameAtTime,
  videoFrameSeekTime,
  type VideoScrubBackend,
  type VideoScrubIndex,
} from '../../videoScrub';
import {
  cachedVideoFrameCount,
  cachedVideoFps,
  invalidateVideoPlaybackUrl,
  isOriginalVideoPlayback,
  rejectOriginalVideoPlayback,
  rememberVideoTiming,
  resolveVideoPlaybackUrl,
} from '../../videoUrl';
import { resolveCanvasMipUrl } from '../assets/AssetPathResolver';
import type { TextureManager } from '../textures/TextureManager';
import { RenderObjectRegistry } from './RenderObjectRegistry';
import {
  chooseVideoFrameUploads,
  normalizeVideoFps,
  oldestPlaybackIntent,
  resolvedVideoDuration,
  VIDEO_DECODER_RELEASE_DELAY_MS,
  VIDEO_MAX_PLAYBACK_INTENTS,
  VIDEO_POSTER_RELEASE_DELAY_MS,
  VIDEO_SURFACE_DOWNSIZE_DELAY_MS,
  videoFrameSize,
  videoFrameScrubState,
  videoFrameTime,
  videoFramePhaseUploadable,
  videoFrameUploadDue,
  videoCloserScrubFrame,
  videoLiveScrubQueue,
  videoResponsiveSeekReady,
  VIDEO_SCRUB_LIVE_PREVIEW_RADIUS,
  videoScrubSeekTarget,
  videoSeekAlreadyAtTime,
  videoShouldCancelLiveDecode,
  videoVisibilityAction,
  shouldResizeVideoFrame,
  type VideoFrameSize,
} from './VideoPerformancePolicy';

type VideoPlaybackPhase = 'paused' | 'loading' | 'playing' | 'suspended' | 'proxy-pending' | 'error';

export interface VideoTransportState {
  id: string;
  phase: VideoPlaybackPhase;
  playing: boolean;
  loading: boolean;
  currentTime: number;
  duration: number;
  fps: number;
  frameCount?: number;
  displayedFrame: number;
  targetFrame: number;
  frameAccurate: boolean;
  scrubBackend: VideoScrubBackend;
  preparationStage?: string;
  preparationProgress: number;
  muted: boolean;
  rate: number;
  ready: boolean;
  scrubbing: boolean;
}

export interface VideoRuntimeStats {
  playbackIntents: number;
  activeDecoders: number;
  suspendedVideos: number;
  posterTextures: number;
  frameUploads: number;
  frameUploadBytes: number;
  droppedFrames: number;
  uploadFps: number;
  droppedFps: number;
}

interface VideoRenderObject {
  id: string;
  assetId?: string;
  sprite: Sprite;
  badge: Graphics;
  video?: HTMLVideoElement;
  surface?: HTMLCanvasElement;
  surfaceContext?: CanvasRenderingContext2D;
  videoSource?: CanvasSource;
  videoTexture?: Texture;
  videoFrameCallback?: number;
  frameSize?: VideoFrameSize;
  desiredFrameSize?: VideoFrameSize;
  surfaceResizeAt?: number;
  surfaceResizeTimer?: number;
  frameDirty: boolean;
  frameSequence: number;
  lastUploadedTime: number;
  lastUploadAt: number;
  lastPresentedFrames?: number;
  lastPresentedMediaTime?: number;
  presentedTime?: number;
  posterKey?: string;
  posterAssetId?: string;
  posterTexture?: Texture;
  posterEdge?: number;
  posterTargetEdge?: number;
  posterLoading: boolean;
  posterToken: number;
  posterReleaseTimer?: number;
  decoderReleaseTimer?: number;
  intent: boolean;
  intentOrder: number;
  phase: VideoPlaybackPhase;
  currentTime: number;
  pendingSeek?: number;
  scrubDesiredTime?: number;
  scrubIndex?: VideoScrubIndex;
  displayedFrame: number;
  targetFrame: number;
  frameAccurate: boolean;
  scrubBackend: VideoScrubBackend;
  frameProvider?: FfmpegFrameProvider;
  scrubIndexRefreshPending: boolean;
  scrubPreparePromise?: Promise<VideoScrubIndex | undefined>;
  scrubQueue: Array<{ frameIndex: number; sequential: boolean }>;
  scrubDecodeActive: boolean;
  scrubDecodingFrame?: number;
  scrubGeneration: number;
  scrubFinalizing: boolean;
  pinnedScrubFrameKey?: string;
  preparationStage?: string;
  preparationProgress: number;
  seekPreparing: boolean;
  seekInFlight: boolean;
  liveVideoPromise?: Promise<void>;
  seekFrame?: number;
  seekGeneration: number;
  pendingScrubFrame?: number;
  scrubbing: boolean;
  scrubEnding: boolean;
  playToken: number;
  loadToken: number;
  fps: number;
  frameCount?: number;
  rate: number;
  buffering: boolean;
  visible: boolean;
  prefetched: boolean;
  lastTransportAt: number;
  destroy(): void;
}

function updateTransform(sprite: Sprite, item: ImageItem, textureWidth: number, textureHeight: number) {
  sprite.visible = !item.hidden;
  sprite.position.set(item.x + item.width / 2, item.y + item.height / 2);
  sprite.anchor.set(0.5);
  const scaleX = Math.max(0.01, item.width) / Math.max(1, textureWidth);
  const scaleY = Math.max(0.01, item.height) / Math.max(1, textureHeight);
  sprite.scale.set(scaleX * (item.flipX ? -1 : 1), scaleY * (item.flipY ? -1 : 1));
  sprite.rotation = item.rotation * Math.PI / 180;
  sprite.alpha = item.opacity;
  sprite.zIndex = item.zIndex;
}

function bindVideoSprite(sprite: Sprite, item: ImageItem, texture?: Texture) {
  const next = texture && !texture.destroyed ? texture : Texture.EMPTY;
  sprite.texture = next;
  // Always scale from the texture actually bound to the sprite. Mixing a
  // high-res poster with a low-res canvas scale (or the reverse) after zoom
  // makes the video cover the rest of the board.
  updateTransform(sprite, item, next.width, next.height);
}

const VIDEO_BADGE_SCREEN_HEIGHT = 18;
const VIDEO_BADGE_MAX_ITEM_FRACTION = 0.9;

export function videoBadgeWorldSize(item: Pick<ImageItem, 'width' | 'height'>, viewportScale: number) {
  const scale = Math.max(0.001, viewportScale);
  const worldHeight = VIDEO_BADGE_SCREEN_HEIGHT / scale;
  const maxHeight = Math.min(item.width, item.height) * VIDEO_BADGE_MAX_ITEM_FRACTION;
  const badgeHeight = Math.max(1 / scale, Math.min(worldHeight, maxHeight));
  return { width: badgeHeight * 1.35, height: badgeHeight, inset: badgeHeight * 0.48 };
}

function drawVideoBadge(badge: Graphics, item: ImageItem, viewportScale: number, hide = false) {
  badge.clear();
  badge.visible = !item.hidden && !hide;
  if (!badge.visible) return;
  const { width: badgeWidth, height: badgeHeight, inset } = videoBadgeWorldSize(item, viewportScale);
  const localX = -item.width / 2 + badgeWidth / 2 + inset;
  const localY = -item.height / 2 + badgeHeight / 2 + inset;
  const rotation = item.rotation * Math.PI / 180;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  badge.position.set(
    item.x + item.width / 2 + localX * cos - localY * sin,
    item.y + item.height / 2 + localX * sin + localY * cos,
  );
  badge.rotation = rotation;
  badge.alpha = item.opacity;
  badge.zIndex = item.zIndex + 0.5;
  badge.roundRect(-badgeWidth / 2, -badgeHeight / 2, badgeWidth, badgeHeight, badgeHeight * 0.24)
    .fill({ color: 0x11141a, alpha: 0.72 });
  const frameWidth = badgeWidth * 0.46;
  const frameHeight = badgeHeight * 0.52;
  const scale = Math.max(0.001, viewportScale);
  badge.roundRect(-frameWidth * 0.58, -frameHeight / 2, frameWidth, frameHeight, badgeHeight * 0.08)
    .stroke({ color: 0xf4f6f8, alpha: 0.92, width: Math.max(1 / scale, badgeHeight * 0.07) });
  badge.moveTo(frameWidth * 0.18, -frameHeight * 0.28)
    .lineTo(frameWidth * 0.55, -frameHeight * 0.48)
    .lineTo(frameWidth * 0.55, frameHeight * 0.48)
    .lineTo(frameWidth * 0.18, frameHeight * 0.28)
    .closePath()
    .fill({ color: 0xf4f6f8, alpha: 0.92 });
}

function ensureVideoHost(): HTMLElement {
  const existing = document.getElementById('yoiniwa-video-host');
  if (existing) return existing;
  const host = document.createElement('div');
  host.id = 'yoiniwa-video-host';
  host.setAttribute('aria-hidden', 'true');
  Object.assign(host.style, {
    position: 'fixed', width: '16px', height: '16px', opacity: '1', pointerEvents: 'none',
    overflow: 'hidden', left: '-32px', top: '0', zIndex: '-1',
  });
  document.body.appendChild(host);
  return host;
}

function videoPosterUrl(assetId: string, edge: number, priority: number) {
  return assetResourceUrl(assetId, new URLSearchParams({
    variant: 'video-poster', edge: String(edge), priority: String(priority),
  }));
}

export class VideoRenderer {
  private readonly objects = new RenderObjectRegistry<VideoRenderObject>();
  private readonly items = new Map<string, ImageItem>();
  private scene?: Scene;
  private transportListener?: (state: VideoTransportState) => void;
  private selectedId?: string;
  private hoveredVideoId?: string;
  private intentSequence = 0;
  private frameSequence = 0;
  private uploadRoundRobinAfterId?: string;
  private counters = { frameUploads: 0, frameUploadBytes: 0, droppedFrames: 0 };
  private readonly recentUploadTimes: number[] = [];
  private readonly recentDroppedTimes: number[] = [];
  private readonly retiredTextures: Texture[] = [];
  private maxTextureSize = 8192;
  private viewportScale = 1;

  constructor(
    private readonly layer: Container,
    private readonly textures: TextureManager,
    private readonly requestRender: () => void,
  ) {
    layer.sortableChildren = true;
  }

  setMaxTextureSize(value: number) {
    if (Number.isFinite(value) && value >= 256) this.maxTextureSize = Math.round(value);
  }

  onTransportChange(listener?: (state: VideoTransportState) => void) {
    this.transportListener = listener;
  }

  setSelected(id?: string) {
    this.selectedId = id;
    if (id) this.emitTransport(id, true);
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
    return this.hoveredVideoId === object.id || object.scrubbing;
  }

  private paintBadge(object: VideoRenderObject, item: ImageItem) {
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

      if (object.phase === 'playing' && object.video) {
        object.frameDirty = true;
        object.frameSequence = ++this.frameSequence;
        needsFallbackFrames = true;
      }
    });
    this.processVideoFrames(options.now);
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
      currentTime: object.scrubbing ? object.currentTime : (video?.currentTime ?? object.currentTime),
      duration: resolvedVideoDuration(
        item.durationSec,
        video?.duration,
        item.assetId ? this.scene?.assets[item.assetId]?.durationSec : undefined,
      ),
      fps: item.assetId ? cachedVideoFps(item.assetId) : object.fps,
      frameCount: object.frameCount ?? cachedVideoFrameCount(item.assetId ?? id),
      displayedFrame: object.displayedFrame,
      targetFrame: object.targetFrame,
      frameAccurate: object.frameAccurate,
      scrubBackend: object.scrubBackend,
      preparationStage: object.preparationStage,
      preparationProgress: object.preparationProgress,
      muted: object.video ? object.video.muted : item.muted !== false,
      rate: object.rate || 1,
      ready: Boolean(video && video.readyState >= 2) || Boolean(object.posterTexture),
      scrubbing: object.scrubbing,
    };
  }

  stats(): VideoRuntimeStats {
    let playbackIntents = 0;
    let activeDecoders = 0;
    let suspendedVideos = 0;
    let posterTextures = 0;
    this.objects.forEach((object) => {
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

  beginScrub(id: string) {
    const object = this.objects.get(id);
    const item = this.items.get(id);
    if (!object || !item) return false;
    if (object.intent) {
      object.intent = false;
      object.playToken += 1;
      try { object.video?.pause(); } catch { /* already paused */ }
    }
    object.scrubbing = true;
    object.scrubEnding = false;
    object.scrubFinalizing = false;
    object.scrubQueue.length = 0;
    object.pendingScrubFrame = undefined;
    object.targetFrame = object.displayedFrame;
    object.frameAccurate = false;
    object.frameProvider?.cancelPending();
    this.cancelDecoderRelease(object);
    this.cancelScheduledSeek(object);
    this.ensureVideoSurface(object, item);
    object.frameProvider ??= new FfmpegFrameProvider();
    const assetId = item.assetId;
    if (assetId && window.refCanvas?.ensureVideoScrub) {
      void window.refCanvas.ensureVideoScrub(assetId).then((result) => {
        rememberVideoTiming(assetId, result.fps || 30, result.frameCount ?? undefined);
        object.fps = result.fps || object.fps;
        object.frameCount = result.frameCount ?? object.frameCount;
        if (result.indexReady) this.refreshSourceIndex(assetId);
      }).catch(() => {});
    }
    void this.ensureLiveVideo(object, item).catch(() => {});
    void this.prepareScrub(object, item);
    this.paintBadge(object, item);
    this.emitTransport(id, true);
    return true;
  }

  endScrub(id: string) {
    const object = this.objects.get(id);
    if (!object || !object.scrubbing) return false;
    object.scrubEnding = true;
    object.scrubFinalizing = true;
    this.seekFrame(object.id, object.targetFrame, false, true);
    return true;
  }

  resumeWhenProxyReady(assetId: string) {
    this.refreshScrubIndex(assetId, true);
  }

  refreshSourceIndex(assetId: string) {
    this.refreshScrubIndex(assetId, false);
  }

  private refreshScrubIndex(assetId: string, playbackProxyReady: boolean) {
    invalidateVideoScrubIndex(assetId);
    this.objects.forEach((object, id) => {
      const item = this.items.get(id);
      if (!item || item.assetId !== assetId) return;
      object.fps = cachedVideoFps(assetId);
      object.frameCount = cachedVideoFrameCount(assetId);
      if (object.scrubbing || object.seekInFlight || object.seekPreparing) {
        object.scrubIndexRefreshPending = true;
        this.emitTransport(id, true);
        return;
      }
      object.scrubIndex = undefined;
      object.frameProvider?.release();
      object.frameProvider = undefined;
      object.scrubIndexRefreshPending = false;
      if (!playbackProxyReady) {
        this.emitTransport(id, true);
        return;
      }
      if (object.phase === 'paused' && object.video) {
        object.currentTime = object.video.currentTime;
        this.releaseDecoder(object, true);
        if (object.pendingSeek !== undefined) this.scheduleSeek(object, item);
        return;
      }
      if (object.phase !== 'proxy-pending') return;
      if (object.pendingSeek !== undefined && !object.intent) {
        this.scheduleSeek(object, item);
      } else if (object.intent && object.visible) {
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
      object.phase = 'error';
      object.pendingSeek = undefined;
      this.cancelScheduledSeek(object);
      this.paintBadge(object, item);
      this.emitTransport(id, true);
    });
    this.requestRender();
  }

  seek(id: string, time: number) {
    const object = this.objects.get(id);
    const item = this.items.get(id);
    if (!object || !item) return false;
    const duration = resolvedVideoDuration(item.durationSec, object.video?.duration);
    const target = Math.max(0, Math.min(duration || time, time));
    object.pendingSeek = target;
    if (object.scrubbing) object.scrubDesiredTime = target;
    // The range thumb already has local feedback while scrubbing. Avoid a
    // forced React update and a wasted canvas render for every pointer event;
    // the decoded frame will update both when it is actually ready.
    if (!object.scrubbing) {
      object.currentTime = target;
      this.emitTransport(id, true);
      this.requestRender();
    }
    this.scheduleSeek(object, item);
    return true;
  }

  seekFrame(id: string, frameIndex: number, sequential = false, final = false) {
    const object = this.objects.get(id);
    const item = this.items.get(id);
    if (!object || !item) return false;
    const frameCount = object.scrubIndex?.frameCount ?? object.frameCount
      ?? cachedVideoFrameCount(item.assetId ?? id) ?? 1;
    const target = Math.max(0, Math.min(frameCount - 1, Math.round(frameIndex)));
    object.targetFrame = target;
    if (final) object.scrubFinalizing = true;
    this.previewCachedScrubFrame(object, item, target);
    object.pendingScrubFrame = sequential ? undefined : target;
    object.frameAccurate = Boolean(object.scrubIndex) && object.displayedFrame === target;
    this.emitTransport(id, true);
    object.scrubQueue = videoLiveScrubQueue(object.scrubQueue, target, sequential);
    if (!sequential) {
      if (videoShouldCancelLiveDecode(object.scrubDecodingFrame, target)) {
        object.frameProvider?.cancelPending();
      }
      if (Math.abs(object.displayedFrame - target) > 0) void this.paintLiveScrubPreview(object, item);
    }
    void this.processScrubQueue(object, item);
    return true;
  }

  setPreparation(assetId: string, stage: string, fraction: number) {
    this.objects.forEach((object, id) => {
      if (object.assetId !== assetId) return;
      object.preparationStage = stage;
      object.preparationProgress = Math.max(0, Math.min(1, fraction));
      this.emitTransport(id, true);
    });
  }

  private async prepareScrub(object: VideoRenderObject, item: ImageItem) {
    if (object.scrubPreparePromise) return object.scrubPreparePromise;
    const assetId = item.assetId;
    if (!assetId) return undefined;
    const pending = (async () => {
      object.preparationStage = object.scrubIndex ? 'ready' : 'indexing';
      const client = object.frameProvider ?? new FfmpegFrameProvider();
      object.frameProvider = client;
      const duration = resolvedVideoDuration(item.durationSec, object.video?.duration);
      const index = await client.prepare(assetId, duration, object.fps, object.frameCount);
      if (index) {
        object.scrubIndex = index;
        object.fps = index.fps;
        object.frameCount = index.frameCount;
        if (!object.scrubbing && !object.scrubDecodeActive && !object.frameAccurate) {
          const mappedFrame = videoFrameAtTime(index, object.currentTime);
          object.displayedFrame = mappedFrame;
          object.targetFrame = mappedFrame;
        }
        object.preparationStage = 'ready';
        object.preparationProgress = 1;
      } else if (client.activeBackend === 'ffmpeg-source') {
        object.preparationStage = 'indexing';
      }
      object.scrubBackend = client.activeBackend;
      this.emitTransport(item.id, true);
      return index;
    })().catch(() => {
        object.scrubBackend = 'html-video';
        this.emitTransport(item.id, true);
        return undefined;
      }).finally(() => { object.scrubPreparePromise = undefined; });
    object.scrubPreparePromise = pending;
    return pending;
  }

  private previewCachedScrubFrame(object: VideoRenderObject, item: ImageItem, frameIndex: number) {
    const size = object.frameSize;
    if (!item.assetId || !size) return;
    const cached = object.frameProvider?.cache.nearest(
      item.assetId, frameIndex, size.width, size.height, object.scrubIndex?.version ?? 0,
      VIDEO_SCRUB_LIVE_PREVIEW_RADIUS,
    );
    if (cached && videoCloserScrubFrame(cached.frameIndex, object.displayedFrame, frameIndex)) {
      this.displayScrubFrame(object, item, cached);
    }
  }

  private scrubFrameTime(object: VideoRenderObject, item: ImageItem, frameIndex: number) {
    const duration = resolvedVideoDuration(item.durationSec, object.video?.duration);
    return object.scrubIndex
      ? videoFrameSeekTime(object.scrubIndex, frameIndex)
      : videoFrameTime(frameIndex, duration, object.fps, object.frameCount);
  }

  private async paintLiveScrubPreview(object: VideoRenderObject, item: ImageItem) {
    if (!videoResponsiveSeekReady(object.seekInFlight || object.seekPreparing, object.pendingScrubFrame)) return;
    const requested = object.pendingScrubFrame!;
    object.seekPreparing = true;
    try {
      await this.ensureLiveVideo(object, item);
    } catch {
      object.seekPreparing = false;
      return;
    }
    object.seekPreparing = false;
    if (object.seekInFlight) return;
    const frame = object.pendingScrubFrame ?? requested;
    const video = object.video;
    if (!video) return;
    try { video.pause(); } catch { /* already paused */ }
    const time = this.scrubFrameTime(object, item, frame);
    if (videoSeekAlreadyAtTime(video.currentTime, time, object.fps)) {
      this.blitLivePreview(object, item);
      if (object.pendingScrubFrame !== undefined && object.pendingScrubFrame !== frame) {
        void this.paintLiveScrubPreview(object, item);
      }
      return;
    }
    const generation = ++object.seekGeneration;
    object.seekInFlight = true;
    let timeout = 0;
    const finish = () => {
      window.clearTimeout(timeout);
      video.removeEventListener('seeked', finish);
      video.removeEventListener('error', failed);
      if (object.video !== video || object.seekGeneration !== generation) return;
      object.seekInFlight = false;
      this.blitLivePreview(object, item);
      if (object.pendingScrubFrame !== undefined && object.pendingScrubFrame !== frame) {
        void this.paintLiveScrubPreview(object, item);
      }
    };
    const failed = () => {
      window.clearTimeout(timeout);
      video.removeEventListener('seeked', finish);
      video.removeEventListener('error', failed);
      if (object.seekGeneration !== generation) return;
      object.seekInFlight = false;
    };
    timeout = window.setTimeout(finish, 2000);
    video.addEventListener('seeked', finish, { once: true });
    video.addEventListener('error', failed, { once: true });
    video.currentTime = time;
    if (!video.seeking && video.readyState >= 2) finish();
  }

  private blitLivePreview(object: VideoRenderObject, item: ImageItem) {
    const video = object.video;
    if (!video) return;
    object.presentedTime = video.currentTime;
    object.phase = 'paused';
    this.ensureVideoSurface(object, item);
    if (this.uploadVideoFrame(object, item, performance.now())) {
      this.cachePresentedScrubFrame(object, item, object.displayedFrame);
      this.requestRender();
    }
  }

  private cachePresentedScrubFrame(object: VideoRenderObject, item: ImageItem, frameIndex: number) {
    const assetId = item.assetId;
    const size = object.frameSize;
    const surface = object.surface;
    const provider = object.frameProvider;
    if (!assetId || !size || !surface || !provider) return;
    if (provider.cache.get(assetId, frameIndex, size.width, size.height, object.scrubIndex?.version ?? 0)) return;
    void createImageBitmap(surface).then((bitmap) => {
      if (object.frameProvider !== provider) { bitmap.close(); return; }
      provider.cache.set({
        assetId, frameIndex, width: size.width, height: size.height,
        indexVersion: object.scrubIndex?.version ?? 0, bitmap,
      });
    }).catch(() => { /* capture can fail while the decoder is replacing the surface */ });
  }

  private async processScrubQueue(object: VideoRenderObject, item: ImageItem) {
    if (object.scrubDecodeActive) return;
    object.scrubDecodeActive = true;
    try {
      await this.prepareScrub(object, item);
      while (object.scrubQueue.length > 0) {
        const live = !object.scrubFinalizing && object.scrubQueue.every((request) => !request.sequential);
        if (live && object.scrubQueue.length > 1) {
          object.scrubQueue = [object.scrubQueue.at(-1)!];
        }
        const request = object.scrubQueue.shift()!;
        const target = request.frameIndex;
        const generation = object.scrubGeneration;
        object.scrubDecodingFrame = target;
        this.ensureVideoSurface(object, item);
        const provider = object.frameProvider;
        const size = object.frameSize;
        if (provider?.activeBackend === 'ffmpeg-source' && size) {
          try {
            const frame = await provider.requestFrame(
              target, size.width, size.height,
              !request.sequential,
              request.sequential || object.scrubFinalizing,
            );
            if (frame.frameIndex === object.targetFrame
              || videoCloserScrubFrame(frame.frameIndex, object.displayedFrame, object.targetFrame)) {
              this.displayScrubFrame(object, item, frame);
              if (object.pendingScrubFrame === frame.frameIndex) object.pendingScrubFrame = undefined;
            }
          } catch (error) {
            if (error instanceof Error && error.message === 'stale') continue;
            if (request.sequential || object.scrubFinalizing) {
              await this.seekFallbackFrame(object, item, target, generation, live);
            }
          }
        } else if (provider?.activeBackend === 'html-video') {
          await this.seekFallbackFrame(object, item, target, generation, live);
        }
        if (request.sequential && object.scrubQueue.length > 0 && object.scrubGeneration === generation) {
          await new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()); });
        }
      }
    } catch (error) {
      object.frameAccurate = false;
      if (object.scrubFinalizing) {
        object.scrubbing = false;
        object.scrubEnding = false;
        object.scrubFinalizing = false;
      }
      console.warn('Video frame scrub failed', item.assetId ?? item.id, error);
    } finally {
      object.scrubDecodeActive = false;
      object.scrubDecodingFrame = undefined;
      const targetDisplayed = object.displayedFrame === object.targetFrame;
      object.frameAccurate = Boolean(object.scrubIndex) && targetDisplayed;
      if (object.scrubFinalizing && (targetDisplayed || object.scrubQueue.length === 0)) {
        object.scrubbing = false;
        object.scrubEnding = false;
        object.scrubFinalizing = false;
        object.pendingScrubFrame = undefined;
        if (!object.intent && object.phase === 'paused' && object.video) this.scheduleDecoderRelease(object);
      }
      if (!object.scrubbing && object.scrubIndexRefreshPending) {
        object.scrubIndexRefreshPending = false;
        object.scrubIndex = undefined;
        object.frameProvider?.release();
        object.frameProvider = undefined;
        void this.prepareScrub(object, item);
      } else if (!object.scrubbing && targetDisplayed && object.frameSize) {
        void object.frameProvider?.prefetchNearby(
          object.displayedFrame, object.frameSize.width, object.frameSize.height,
        );
      }
      this.paintBadge(object, item);
      this.emitTransport(item.id, true);
      this.requestRender();
      if (object.scrubQueue.length > 0) void this.processScrubQueue(object, item);
    }
  }

  private displayScrubFrame(
    object: VideoRenderObject,
    item: ImageItem,
    frame: { frameIndex: number; bitmap: ImageBitmap; cacheKey: string; width: number; height: number },
  ) {
    this.ensureVideoSurface(object, item);
    const { surface, surfaceContext, videoSource, videoTexture } = object;
    if (!surface || !surfaceContext || !videoSource || videoSource.destroyed) return;
    surfaceContext.drawImage(frame.bitmap, 0, 0, surface.width, surface.height);
    videoSource.update();
    object.frameProvider?.cache.unpin(object.pinnedScrubFrameKey);
    object.pinnedScrubFrameKey = frame.cacheKey;
    object.frameProvider?.cache.pin(frame.cacheKey);
    bindVideoSprite(object.sprite, item, videoTexture);
    object.displayedFrame = frame.frameIndex;
    object.currentTime = object.scrubIndex
      ? videoFrameSeekTime(object.scrubIndex, frame.frameIndex)
      : videoFrameTime(frame.frameIndex, resolvedVideoDuration(item.durationSec, object.video?.duration), object.fps, object.frameCount);
    object.frameAccurate = Boolean(object.scrubIndex) && frame.frameIndex === object.targetFrame;
    object.phase = 'paused';
    this.emitTransport(item.id, true);
    this.requestRender();
  }

  private async seekFallbackFrame(
    object: VideoRenderObject,
    item: ImageItem,
    frameIndex: number,
    generation: number,
    live = false,
  ) {
    await this.ensureLiveVideo(object, item);
    const video = object.video;
    if (!video) throw new Error('视频未就绪');
    const duration = resolvedVideoDuration(item.durationSec, video.duration);
    const time = object.scrubIndex
      ? videoFrameSeekTime(object.scrubIndex, frameIndex)
      : videoFrameTime(frameIndex, duration, object.fps, object.frameCount);
    const presentedTime = await new Promise<number>((resolve, reject) => {
      const timeout = window.setTimeout(() => { cleanup(); reject(new Error('逐帧 seek 超时')); }, 4000);
      let frameCallback: number | undefined;
      let watching = false;
      const cleanup = () => {
        window.clearTimeout(timeout);
        video.removeEventListener('seeked', finish);
        video.removeEventListener('error', failed);
        if (frameCallback !== undefined) video.cancelVideoFrameCallback?.(frameCallback);
      };
      const watchPresentedFrame = () => {
        if (!video.requestVideoFrameCallback) {
          cleanup();
          resolve(video.currentTime);
          return;
        }
        frameCallback = video.requestVideoFrameCallback((_now, metadata) => {
          frameCallback = undefined;
          const actualFrame = object.scrubIndex
            ? videoFrameAtTime(object.scrubIndex, metadata.mediaTime)
            : frameIndex;
          if (live || actualFrame === frameIndex) {
            cleanup();
            resolve(metadata.mediaTime);
          } else {
            watchPresentedFrame();
          }
        });
      };
      const finish = () => {
        if (watching) return;
        watching = true;
        watchPresentedFrame();
      };
      const failed = () => { cleanup(); reject(new Error('逐帧 seek 失败')); };
      video.addEventListener('seeked', finish, { once: true });
      video.addEventListener('error', failed, { once: true });
      video.currentTime = time;
      if (!video.seeking && video.readyState >= 2) finish();
    });
    if (!live && object.scrubIndex && videoFrameAtTime(object.scrubIndex, presentedTime) !== frameIndex) {
      throw new Error(`逐帧校验失败：目标 ${frameIndex}`);
    }
    if (object.scrubGeneration !== generation) return;
    const shownFrame = object.scrubIndex
      ? videoFrameAtTime(object.scrubIndex, presentedTime)
      : frameIndex;
    if (!videoCloserScrubFrame(shownFrame, object.displayedFrame, object.targetFrame)) return;
    object.presentedTime = presentedTime;
    object.frameDirty = true;
    this.uploadVideoFrame(object, item, performance.now());
    object.displayedFrame = shownFrame;
    object.frameAccurate = Boolean(object.scrubIndex) && shownFrame === object.targetFrame;
    if (object.pendingScrubFrame === shownFrame) object.pendingScrubFrame = undefined;
    this.cachePresentedScrubFrame(object, item, shownFrame);
    this.requestRender();
  }

  stepFrames(id: string, frames: number) {
    const object = this.objects.get(id);
    const item = this.items.get(id);
    if (!object || !item) return false;
    if (!object.scrubbing && !this.beginScrub(id)) return false;
    return this.seekFrame(id, object.targetFrame + frames, true, true);
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
    this.objects.forEach((object, id) => {
      const item = this.items.get(id);
      const size = object.desiredFrameSize;
      const index = object.scrubIndex;
      if (!item || object.intent || !object.frameAccurate || !size || !item.assetId) return;
      const cached = object.frameProvider?.cache.get(
        item.assetId, object.displayedFrame, size.width, size.height, index?.version ?? 0,
      );
      if (cached) {
        this.displayScrubFrame(object, item, cached);
        return;
      }
      object.scrubbing = true;
      object.scrubFinalizing = true;
      object.targetFrame = object.displayedFrame;
      this.seekFrame(id, object.displayedFrame, false, true);
    });
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

  private startIntent(object: VideoRenderObject, item: ImageItem) {
    if (object.intent) return;
    object.scrubbing = false;
    object.scrubEnding = false;
    object.scrubFinalizing = false;
    object.scrubQueue.length = 0;
    object.scrubGeneration += 1;
    object.frameProvider?.cancelPending();
    const active: Array<{ object: VideoRenderObject; item: ImageItem }> = [];
    this.objects.forEach((candidate, id) => {
      const candidateItem = this.items.get(id);
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
    object.intentOrder = ++this.intentSequence;
    object.pendingSeek = undefined;
    this.cancelScheduledSeek(object);
    this.paintBadge(object, item);
    if (object.visible) void this.activateObject(object, item);
    else {
      object.phase = 'suspended';
      this.emitTransport(item.id);
      this.requestRender();
    }
  }

  private async activateObject(object: VideoRenderObject, item: ImageItem) {
    if (!object.intent || object.phase === 'loading' || object.phase === 'playing' || object.phase === 'proxy-pending') return;
    const playToken = ++object.playToken;
    object.phase = 'loading';
    this.ensureDecoderCapacity(object.id);
    this.cancelDecoderRelease(object);
    this.emitTransport(item.id, true);
    this.requestRender();
    try {
      await this.ensureLiveVideo(object, item);
      let video = object.video;
      if (!video) throw new Error('视频未就绪');
      const alignedTime = object.scrubIndex
        ? videoFrameSeekTime(object.scrubIndex, object.displayedFrame)
        : object.currentTime;
      if (alignedTime > 0 && Math.abs(video.currentTime - alignedTime) > 0.01) {
        await this.alignVideoBeforePlayback(video, alignedTime);
      }
      try {
        await video.play();
      } catch (error) {
        if (!item.assetId || !isOriginalVideoPlayback(item.assetId)) throw error;
        rejectOriginalVideoPlayback(item.assetId);
        this.releaseDecoder(object, false);
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
      object.frameSequence = ++this.frameSequence;
      this.paintBadge(object, item);
      this.emitTransport(item.id, true);
      this.requestRender();
    } catch (error) {
      if (object.playToken !== playToken) return;
      const message = error instanceof Error ? error.message : '';
      if (message === 'stale') return;
      this.releaseDecoder(object, false);
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
      this.paintBadge(object, item);
      this.emitTransport(item.id, true);
      this.requestRender();
    }
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

  private scheduleSeek(object: VideoRenderObject, item: ImageItem) {
    // Keep one decode in flight and coalesce pointer movement to the newest
    // target. Replacing currentTime while Chromium is decoding can starve
    // requestVideoFrameCallback, leaving the canvas frozen for the whole drag.
    if (object.seekInFlight || object.seekFrame !== undefined) return;
    object.seekFrame = requestAnimationFrame(() => {
      object.seekFrame = undefined;
      void this.applyLatestSeek(object, item);
    });
  }

  private cancelScheduledSeek(object: VideoRenderObject) {
    if (object.seekFrame !== undefined) cancelAnimationFrame(object.seekFrame);
    object.seekFrame = undefined;
    object.seekInFlight = false;
    object.seekGeneration += 1;
  }

  private finishScrubIfSettled(object: VideoRenderObject) {
    if (!object.scrubEnding || object.pendingSeek !== undefined || object.pendingScrubFrame !== undefined
      || object.seekInFlight || object.seekPreparing || object.seekFrame !== undefined || object.frameDirty) return;
    object.scrubbing = false;
    object.scrubEnding = false;
    object.scrubFinalizing = false;
    if (!object.intent && object.phase === 'paused' && object.video) this.scheduleDecoderRelease(object);
    this.emitTransport(object.id, true);
  }

  private async applyLatestSeek(object: VideoRenderObject, item: ImageItem) {
    if (object.seekPreparing || videoScrubSeekTarget(object.seekInFlight, object.pendingSeek) === undefined) return;
    object.seekPreparing = true;
    try {
      await this.ensureLiveVideo(object, item);
    } catch (error) {
      if (error instanceof Error && error.message === 'playback-pending') {
        object.phase = 'proxy-pending';
        this.emitTransport(item.id, true);
        window.dispatchEvent(new CustomEvent('refcanvas-video-preparing', {
          detail: { id: item.id, assetId: item.assetId },
        }));
      }
      return;
    } finally {
      object.seekPreparing = false;
    }
    const video = object.video;
    const requestedTarget = videoScrubSeekTarget(object.seekInFlight, object.pendingSeek);
    if (!video || requestedTarget === undefined) return;
    const target = requestedTarget;
    object.pendingSeek = undefined;
    const generation = ++object.seekGeneration;
    object.seekInFlight = true;
    const finish = () => {
      video.removeEventListener('seeked', finish);
      if (object.video !== video || object.seekGeneration !== generation) return;
      object.seekInFlight = false;
      object.presentedTime = video.currentTime;
      object.frameDirty = true;
      object.frameSequence = ++this.frameSequence;
      if (!object.intent) {
        video.pause();
        object.phase = 'paused';
        if (!object.scrubbing) this.scheduleDecoderRelease(object);
      }
      if (object.scrubbing && object.scrubDesiredTime !== undefined) {
        const duration = resolvedVideoDuration(item.durationSec, video.duration);
        const current = videoFrameScrubState(video.currentTime, duration, object.fps, object.frameCount);
        const desired = videoFrameScrubState(object.scrubDesiredTime, duration, object.fps, object.frameCount);
        if (current.currentFrame !== desired.currentFrame) {
          const adjacentFrame = current.currentFrame + Math.sign(desired.currentFrame - current.currentFrame);
          object.pendingSeek = videoFrameTime(adjacentFrame, duration, current.fps, current.frameCount);
        } else {
          object.pendingSeek = undefined;
          object.scrubDesiredTime = undefined;
        }
      }
      this.requestRender();
      // Render the decoded adjacent frame before asking for the next one. This
      // prevents an in-flight seek from being replaced by a farther target.
      if (object.pendingSeek !== undefined) this.scheduleSeek(object, item);
    };
    video.addEventListener('seeked', finish, { once: true });
    video.currentTime = target;
    if (!video.seeking && Math.abs(video.currentTime - target) < 0.001 && video.readyState >= 2) finish();
  }

  private async ensureLiveVideo(
    object: VideoRenderObject,
    item: ImageItem,
    allowOriginalFallback = true,
  ): Promise<void> {
    if (object.video) return;
    object.liveVideoPromise ??= this.openLiveVideo(object, item, allowOriginalFallback)
      .finally(() => { object.liveVideoPromise = undefined; });
    return object.liveVideoPromise;
  }

  private async openLiveVideo(
    object: VideoRenderObject,
    item: ImageItem,
    allowOriginalFallback = true,
  ): Promise<void> {
    if (object.video) return;
    if (!item.assetId) throw new Error('缺少视频资源');
    const token = ++object.loadToken;
    const src = await resolveVideoPlaybackUrl(item.assetId, window.refCanvas);
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
    // Local range-backed media benefits from letting WebView2 keep decoder and
    // demux buffers warm, especially while chasing adjacent scrub targets.
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
        this.releaseDecoder(object, false);
        return this.openLiveVideo(object, item, false);
      }
      this.releaseDecoder(object, false);
      throw new Error('视频无法解码');
    }
    if (object.loadToken !== token) {
      this.releaseDecoder(object, false);
      throw new Error('stale');
    }
    this.ensureVideoSurface(object, item);
    this.watchVideoFrames(object, video);
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

  private detachDestroyedVideoTextures(object: VideoRenderObject, item?: ImageItem) {
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

  private ensureVideoSurface(object: VideoRenderObject, item: ImageItem) {
    if (this.videoSurfaceIntact(object)) return;
    this.detachDestroyedVideoTextures(object, item);
    const desired = object.desiredFrameSize ?? {
      width: Math.max(2, item.naturalWidth), height: Math.max(2, item.naturalHeight),
      edge: Math.max(item.naturalWidth, item.naturalHeight),
      bytes: Math.max(2, item.naturalWidth) * Math.max(2, item.naturalHeight) * 4,
    };
    const surface = document.createElement('canvas');
    surface.width = desired.width;
    surface.height = desired.height;
    const context = surface.getContext('2d', { alpha: false });
    if (!context) throw new Error('无法创建视频帧表面');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
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
    object.frameDirty = true;
    bindVideoSprite(object.sprite, item, texture);
    if (oldTexture && oldTexture !== object.sprite.texture) this.retireTexture(oldTexture);
    this.paintCurrentVideoFrame(object, item);
  }

  private paintCurrentVideoFrame(object: VideoRenderObject, item: ImageItem) {
    if (object.video && object.video.videoWidth > 0 && object.video.videoHeight > 0) {
      object.frameDirty = true;
      this.uploadVideoFrame(object, item, performance.now());
      return;
    }
    const fallback = this.fallbackVideoTexture(object);
    if (fallback !== Texture.EMPTY && object.phase !== 'playing') {
      bindVideoSprite(object.sprite, item, fallback);
    }
  }

  private rebuildVideoSurface(object: VideoRenderObject, item: ImageItem, desired: VideoFrameSize) {
    const oldTexture = object.videoTexture;
    object.videoTexture = undefined;
    object.videoSource = undefined;
    object.surface = undefined;
    object.surfaceContext = undefined;
    object.frameSize = undefined;
    object.desiredFrameSize = desired;
    this.ensureVideoSurface(object, item);
    if (oldTexture && oldTexture !== object.sprite.texture) this.retireTexture(oldTexture);
  }

  private updateSurfaceSize(
    object: VideoRenderObject,
    item: ImageItem,
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

  private watchVideoFrames(object: VideoRenderObject, video: HTMLVideoElement) {
    if (typeof video.requestVideoFrameCallback !== 'function') return;
    const next = () => {
      object.videoFrameCallback = video.requestVideoFrameCallback((_now, metadata) => {
        if (object.video !== video) return;
        if (!object.scrubbing && object.phase === 'playing' && object.frameCount === undefined
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
        object.presentedTime = metadata.mediaTime;
        object.frameDirty = true;
        object.frameSequence = ++this.frameSequence;
        this.requestRender();
        next();
      });
    };
    next();
  }

  private watchVideoState(object: VideoRenderObject, item: ImageItem, video: HTMLVideoElement) {
    const setBuffering = () => {
      if (object.video !== video || !object.intent || object.phase !== 'playing' || object.buffering) return;
      object.buffering = true;
      this.emitTransport(item.id, true);
    };
    const setPlaying = () => {
      if (object.video !== video || !object.intent) return;
      const changed = object.buffering || object.phase !== 'playing';
      object.buffering = false;
      object.phase = 'playing';
      if (changed) this.emitTransport(item.id, true);
    };
    video.onwaiting = setBuffering;
    video.onstalled = setBuffering;
    video.onplaying = setPlaying;
    video.oncanplay = () => {
      if (object.video !== video || !object.buffering) return;
      object.buffering = false;
      this.emitTransport(item.id, true);
    };
    video.onended = () => {
      if (object.video !== video || video.loop) return;
      object.currentTime = Number.isFinite(video.duration) ? video.duration : video.currentTime;
      object.intent = false;
      object.buffering = false;
      object.phase = 'paused';
      this.paintBadge(object, item);
      this.scheduleDecoderRelease(object);
      this.emitTransport(item.id, true);
      this.requestRender();
    };
    video.onerror = () => {
      if (object.video !== video) return;
      object.currentTime = video.currentTime;
      object.intent = false;
      object.buffering = false;
      object.phase = 'error';
      object.playToken += 1;
      object.loadToken += 1;
      this.releaseDecoder(object, true);
      this.paintBadge(object, item);
      this.emitTransport(item.id, true);
      this.requestRender();
      window.dispatchEvent(new CustomEvent('refcanvas-status', { detail: '视频播放中断，请重试' }));
    };
  }

  private processVideoFrames(now: number) {
    const candidates: Array<{ object: VideoRenderObject; item: ImageItem }> = [];
    this.objects.forEach((object, id) => {
      const item = this.items.get(id);
      if (!item || !videoFramePhaseUploadable(object.phase) || !object.video || !object.frameDirty || !object.frameSize) return;
      candidates.push({ object, item });
    });
    let playingCount = 0;
    this.objects.forEach((object) => { if (object.phase === 'playing') playingCount += 1; });
    const eligible = candidates.filter(({ object }) => {
      if (object.phase === 'paused'
        || videoFrameUploadDue(now, object.lastUploadAt, playingCount, object.id === this.selectedId)) return true;
      object.frameDirty = false;
      this.counters.droppedFrames += 1;
      this.recentDroppedTimes.push(now);
      return false;
    });
    const chosen = chooseVideoFrameUploads(eligible.map(({ object }) => ({
      id: object.id,
      bytes: object.frameSize!.bytes,
      selected: object.id === this.selectedId,
      sequence: object.frameSequence,
    })), undefined, this.uploadRoundRobinAfterId);
    this.uploadRoundRobinAfterId = chosen.nextRoundRobinAfterId;
    const chosenIds = new Set(chosen.selected);
    eligible.forEach(({ object, item }) => {
      if (!chosenIds.has(object.id)) {
        object.frameDirty = false;
        this.counters.droppedFrames += 1;
        this.recentDroppedTimes.push(now);
        return;
      }
      if (this.uploadVideoFrame(object, item, now)) {
        this.counters.frameUploads += 1;
        this.counters.frameUploadBytes += object.frameSize?.bytes ?? 0;
        this.recentUploadTimes.push(now);
      }
    });
  }

  private uploadVideoFrame(object: VideoRenderObject, item: ImageItem, now: number) {
    object.frameDirty = false;
    if (!object.video || !object.video.videoWidth || !object.video.videoHeight) return false;
    if (!this.videoSurfaceIntact(object)) this.ensureVideoSurface(object, item);
    const { video, videoSource: source, surface, surfaceContext, videoTexture } = object;
    if (!video || !source || !surface || !surfaceContext || source.destroyed || videoTexture?.destroyed) return false;
    try {
      const presentedTime = object.presentedTime ?? video.currentTime;
      const mappedFrame = object.scrubIndex
        ? videoFrameAtTime(object.scrubIndex, presentedTime)
        : videoFrameScrubState(
          presentedTime,
          resolvedVideoDuration(item.durationSec, video.duration),
          object.fps,
          object.frameCount,
        ).currentFrame;
      if (object.scrubbing && !videoCloserScrubFrame(mappedFrame, object.displayedFrame, object.targetFrame)) {
        return false;
      }
      // Blit through a 2D canvas. Pixi VideoSource does not refresh from a
      // hidden decoder element, and destroying it mid-batch crashes WebGL.
      surfaceContext.drawImage(video, 0, 0, surface.width, surface.height);
      source.update();
      bindVideoSprite(object.sprite, item, videoTexture);
      object.currentTime = presentedTime;
      object.displayedFrame = mappedFrame;
      if (!object.scrubbing) {
        object.targetFrame = mappedFrame;
        object.frameAccurate = Boolean(object.scrubIndex);
      } else {
        object.frameAccurate = mappedFrame === object.targetFrame;
      }
      object.lastUploadedTime = presentedTime;
      object.lastUploadAt = now;
      this.emitTransport(item.id, object.scrubbing);
      this.finishScrubIfSettled(object);
      return true;
    } catch {
      return false;
    }
  }

  private syncItem(item: ImageItem) {
    let object = this.objects.get(item.id);
    if (!object) {
      const sprite = new Sprite(Texture.EMPTY);
      const badge = new Graphics();
      this.layer.addChild(sprite, badge);
      object = {
        id: item.id, assetId: item.assetId, sprite, badge,
        frameDirty: false, frameSequence: 0, lastUploadedTime: -1, lastUploadAt: 0,
        posterLoading: false, posterToken: 0, intent: false, intentOrder: 0, phase: 'paused', currentTime: 0,
        seekPreparing: false, seekInFlight: false, seekGeneration: 0, scrubbing: false, scrubEnding: false,
        displayedFrame: 0, targetFrame: 0, frameAccurate: false, scrubBackend: 'unavailable',
        scrubQueue: [], scrubDecodeActive: false, scrubGeneration: 0, scrubFinalizing: false,
        scrubIndexRefreshPending: false,
        preparationProgress: 0,
        playToken: 0, loadToken: 0, fps: cachedVideoFps(item.assetId ?? item.id),
        frameCount: cachedVideoFrameCount(item.assetId ?? item.id), rate: 1, buffering: false,
        visible: false, prefetched: false, lastTransportAt: 0,
        destroy: () => {
          object!.intent = false;
          object!.playToken += 1;
          object!.loadToken += 1;
          object!.posterToken += 1;
          this.cancelScheduledSeek(object!);
          this.cancelDecoderRelease(object!);
          object!.frameProvider?.release();
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

  private ensurePoster(
    object: VideoRenderObject,
    item: ImageItem,
    edge: number,
    priority: number,
    cameraMoving = false,
  ) {
    if (!this.scene || object.posterLoading || !item.assetId) return;
    if (object.posterTexture && !object.posterTexture.destroyed && (object.posterEdge ?? 0) >= edge) {
      if (object.phase !== 'playing' && !object.videoTexture) bindVideoSprite(object.sprite, item, object.posterTexture);
      return;
    }
    if (cameraMoving && object.posterTexture && !object.posterTexture.destroyed) return;
    if (object.posterTargetEdge === edge) return;
    const legacyPosterId = item.posterAssetId;
    const posterAssetId = legacyPosterId ?? item.assetId;
    const url = legacyPosterId
      ? resolveCanvasMipUrl(this.scene, { ...item, assetId: legacyPosterId, mediaKind: 'image', posterAssetId: undefined }, edge, priority)
      : videoPosterUrl(item.assetId, edge, priority);
    if (!url) return;
    object.posterLoading = true;
    object.posterTargetEdge = edge;
    const token = ++object.posterToken;
    void this.textures.request({ assetId: posterAssetId, mip: edge, url, priority }).then((entry) => {
      object.posterLoading = false;
      object.posterTargetEdge = undefined;
      if (object.posterToken !== token || !this.items.has(item.id)) {
        this.textures.release(entry.key);
        return;
      }
      if (object.posterKey && object.posterKey !== entry.key) this.textures.release(object.posterKey);
      object.posterKey = entry.key;
      object.posterAssetId = posterAssetId;
      object.posterTexture = entry.texture;
      object.posterEdge = edge;
      if (object.phase !== 'playing' && !object.videoTexture) {
        bindVideoSprite(object.sprite, item, entry.texture);
      }
      this.requestRender();
    }).catch(() => {
      if (object.posterToken === token) {
        object.posterLoading = false;
        object.posterTargetEdge = undefined;
      }
    });
  }

  private schedulePosterRelease(object: VideoRenderObject) {
    if (object.posterReleaseTimer !== undefined || !object.posterTexture) return;
    object.posterReleaseTimer = window.setTimeout(() => {
      object.posterReleaseTimer = undefined;
      if (!object.visible && !object.prefetched) {
        this.releasePoster(object);
        if (!object.videoTexture) this.bindObjectSprite(object, Texture.EMPTY);
        this.requestRender();
      }
    }, VIDEO_POSTER_RELEASE_DELAY_MS);
  }

  private releasePoster(object: VideoRenderObject) {
    if (object.posterReleaseTimer !== undefined) window.clearTimeout(object.posterReleaseTimer);
    object.posterReleaseTimer = undefined;
    object.posterToken += 1;
    object.posterLoading = false;
    object.posterTargetEdge = undefined;
    if (object.posterKey) this.textures.release(object.posterKey);
    object.posterKey = undefined;
    object.posterAssetId = undefined;
    object.posterTexture = undefined;
    object.posterEdge = undefined;
  }

  private suspendObject(object: VideoRenderObject, item: ImageItem) {
    if (!object.intent) return;
    object.currentTime = object.video?.currentTime ?? object.currentTime;
    object.playToken += 1;
    object.loadToken += 1;
    object.buffering = false;
    object.phase = 'suspended';
    this.releaseDecoder(object, false);
    this.bindObjectSprite(object, object.posterTexture);
    this.paintBadge(object, item);
    this.emitTransport(item.id, true);
    this.requestRender();
  }

  private pauseObject(object: VideoRenderObject, item: ImageItem | undefined, keepFrame: boolean) {
    object.currentTime = object.video?.currentTime ?? object.currentTime;
    object.intent = false;
    object.scrubbing = false;
    object.scrubEnding = false;
    object.scrubDesiredTime = undefined;
    object.pendingSeek = undefined;
    object.pendingScrubFrame = undefined;
    this.cancelScheduledSeek(object);
    object.playToken += 1;
    object.loadToken += 1;
    object.buffering = false;
    object.phase = 'paused';
    object.video?.pause();
    if (keepFrame && (object.visible || object.prefetched)) this.scheduleDecoderRelease(object);
    else this.releaseDecoder(object, false);
    if (item) this.paintBadge(object, item);
    this.emitTransport(object.id, true);
    this.requestRender();
  }

  private scheduleDecoderRelease(object: VideoRenderObject) {
    this.cancelDecoderRelease(object);
    object.decoderReleaseTimer = window.setTimeout(() => {
      object.decoderReleaseTimer = undefined;
      if (!object.intent && object.phase === 'paused') {
        this.releaseDecoder(object, object.visible || object.prefetched);
        this.requestRender();
      }
    }, VIDEO_DECODER_RELEASE_DELAY_MS);
  }

  private cancelDecoderRelease(object: VideoRenderObject) {
    if (object.decoderReleaseTimer !== undefined) window.clearTimeout(object.decoderReleaseTimer);
    object.decoderReleaseTimer = undefined;
  }

  private releaseDecoder(object: VideoRenderObject, keepFrame: boolean) {
    this.cancelScheduledSeek(object);
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
          this.bindObjectSprite(object, object.videoTexture);
        }
      } catch { /* retain the last uploaded canvas frame */ }
    }
    if (this.textureUnusable(object.sprite.texture)) {
      this.bindObjectSprite(
        object,
        object.videoTexture && !object.videoTexture.destroyed ? object.videoTexture : this.fallbackVideoTexture(object),
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
    this.bindObjectSprite(
      object,
      object.posterTexture && !object.posterTexture.destroyed ? object.posterTexture : Texture.EMPTY,
    );
    this.retireTexture(texture);
  }

  private ensureDecoderCapacity(exceptId: string) {
    const decoders: VideoRenderObject[] = [];
    this.objects.forEach((object) => { if (object.video && object.id !== exceptId) decoders.push(object); });
    const available = VIDEO_MAX_PLAYBACK_INTENTS - 1;
    if (decoders.length <= available) return;
    decoders.sort((left, right) => Number(left.intent) - Number(right.intent) || left.intentOrder - right.intentOrder);
    for (const candidate of decoders.slice(0, decoders.length - available)) {
      this.releaseDecoder(candidate, candidate.visible || candidate.prefetched);
    }
  }

  private cancelProxyIfUnused(assetId?: string) {
    if (!assetId) return;
    let used = false;
    this.objects.forEach((object) => { if (object.assetId === assetId && (object.intent || object.pendingSeek !== undefined)) used = true; });
    if (!used) {
      invalidateVideoPlaybackUrl(assetId);
      window.refCanvas?.cancelVideoPlayback?.(assetId);
    }
  }

  private emitTransport(id: string, force = false) {
    if (id !== this.selectedId) return;
    const object = this.objects.get(id);
    if (!object) return;
    const now = performance.now();
    if (!force && now - object.lastTransportAt < 100) return;
    object.lastTransportAt = now;
    const state = this.transportState(id);
    if (state) this.transportListener?.(state);
  }
}
