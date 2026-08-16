import { Application } from 'pixi.js';
import type { PickedColor, Scene, Viewport, VisualNotesState } from '../../types';
import { boundedDevicePixelRatio } from '../runtime/CanvasConfig';
import { ImageRenderer } from './ImageRenderer';
import { VideoRenderer, type VideoTransportState } from './VideoRenderer';
import { RenderLayers } from './RenderLayers';
import { SelectionOverlay, type TransformHandle } from '../selection/SelectionOverlay';
import type { LassoPoint } from '../selection/SelectionController';
import type { SceneItem } from '../../types';
import { TextureManager } from '../textures/TextureManager';
import { performanceMonitor } from '../../runtime/performanceMonitor';
import { GroupRenderer } from './GroupRenderer';
import { GroupResizeOverlay } from '../selection/GroupResizeOverlay';
import type { GroupResizeHandle } from '../selection/GroupResizeController';
import type { GroupHeaderAction } from '../selection/HitTestService';
import { VisualNotesRenderer } from './VisualNotesRenderer';
import type { VisualMark } from '../../types';
import { compositeDisplayedColor } from '../interaction/colorSampling';
import type { VideoPlaybackHost } from '../video/videoPlaybackHost';
import type { ImageResourceBoost } from '../textures/imageResourceBoost';

interface PendingColorReadback {
  buffer: WebGLBuffer;
  fence: WebGLSync;
  startedAt: number;
  premultipliedAlpha: boolean;
}

export class PixiRenderer {
  private readonly app = new Application();
  private layers?: RenderLayers;
  private images?: ImageRenderer;
  private videos?: VideoRenderer;
  private selection?: SelectionOverlay;
  private groupResize?: GroupResizeOverlay;
  private textures?: TextureManager;
  private groups?: GroupRenderer;
  private visualNotes?: VisualNotesRenderer;
  private contextDisposer?: () => void;
  private pendingScene?: Scene;
  private selectedImages = 0;
  private selectedGroupId?: string;
  private viewportScale = 1;
  private previewSampleBlockedUntil = 0;
  private lastStageRenderAt = 0;
  private pendingColorReadback?: PendingColorReadback;
  private previewSampleMap?: {
    left: number; top: number; width: number; height: number;
    parentLeft: number; parentTop: number; until: number;
  };

  constructor(
    private readonly requestRender: () => void,
    private readonly videoPlayback?: VideoPlaybackHost,
    private readonly boostImageResource?: ImageResourceBoost,
  ) {}

  async start(container: HTMLElement, background: string, backgroundOpacity: number) {
    await this.app.init({
      // Create an alpha-capable context up front; Pixi cannot add alpha support
      // after initialization when the user later lowers background opacity.
      background, backgroundAlpha: 0, antialias: true, autoDensity: true,
      // Eyedropper preview reads the last presented frame instead of forcing a
      // full scene render on every sample. Without this the buffer is discarded
      // after compositing and each preview hitch-renders the stage.
      preserveDrawingBuffer: true,
      resolution: boundedDevicePixelRatio(), preference: 'webgl', powerPreference: 'high-performance',
      resizeTo: container,
      // Canvas input is owned by InputRouter. Pixi's EventSystem preventDefault
      // on pointerdown capture suppresses Windows Ink / WebView2 contacts.
      eventFeatures: { click: false, move: false, wheel: false, globalMove: false },
    });
    this.app.renderer.background.alpha = backgroundOpacity;
    this.app.stage.eventMode = 'none';
    const events = (this.app.renderer as typeof this.app.renderer & { events?: { autoPreventDefault: boolean } }).events;
    if (events) events.autoPreventDefault = false;
    this.app.stop();
    const gl = (this.app.renderer as typeof this.app.renderer & { gl?: WebGL2RenderingContext }).gl;
    if (gl) {
      // ImageBitmap already performs color conversion and premultiplication;
      // repeating either during upload causes dark alpha edges and mip color shifts.
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    }
    this.app.canvas.className = 'pixi-canvas';
    container.appendChild(this.app.canvas);
    const lost = (event: Event) => {
      event.preventDefault();
      // WebGL objects from the lost context must never be polled after restore.
      this.pendingColorReadback = undefined;
      this.advanceTextureGeneration();
    };
    const restored = () => {
      if (this.pendingScene) {
        this.images?.sync(this.pendingScene);
        this.videos?.sync(this.pendingScene);
      }
      this.videos?.restoreTextures();
      this.requestRender();
    };
    this.app.canvas.addEventListener('webglcontextlost', lost);
    this.app.canvas.addEventListener('webglcontextrestored', restored);
    this.contextDisposer = () => {
      this.app.canvas.removeEventListener('webglcontextlost', lost);
      this.app.canvas.removeEventListener('webglcontextrestored', restored);
    };
    this.layers = new RenderLayers(this.app.stage);
    this.textures = new TextureManager(this.app.renderer, this.requestRender, {
      deviceMemoryGb: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
      boostImageResource: this.boostImageResource,
    });
    this.images = new ImageRenderer(this.layers.images, this.textures, this.requestRender);
    this.videos = new VideoRenderer(this.layers.images, this.textures, this.requestRender, this.videoPlayback);
    if (gl) this.videos.setMaxTextureSize(gl.getParameter(gl.MAX_TEXTURE_SIZE) as number);
    this.groups = new GroupRenderer(this.layers.groups, this.layers.groupHeaderSurfaces, this.layers.groupHeaders, container);
    this.visualNotes = new VisualNotesRenderer(this.layers.marks);
    this.selection = new SelectionOverlay(this.layers.overlay);
    this.groupResize = new GroupResizeOverlay(this.layers.overlay);
    if (this.pendingScene) this.setScene(this.pendingScene);
  }

  setScene(scene: Scene) {
    this.pendingScene = scene;
    this.images?.sync(scene);
    this.videos?.sync(scene);
    this.groups?.sync(scene.groups);
    this.visualNotes?.sync(scene.visualNotes, scene.items);
    this.syncGroupResizeOverlay();
  }
  previewVisualNotes(notes: VisualNotesState, images: SceneItem[]) {
    if (this.pendingScene) this.pendingScene = { ...this.pendingScene, visualNotes: notes };
    this.visualNotes?.sync(notes, images);
    this.requestRender();
  }
  setSelectedImageCount(count: number) { this.selectedImages = count; }
  setSelectedVideo(id?: string) { this.videos?.setSelected(id); }
  setHoveredVideo(id?: string) { return this.videos?.setHoveredVideo(id) ?? false; }
  setSelectedGroup(id?: string) {
    this.selectedGroupId = id;
    this.groups?.setSelected(id);
    if (this.pendingScene) this.groups?.sync(this.pendingScene.groups);
    this.syncGroupResizeOverlay();
    this.requestRender();
  }
  setGroupHeaderHover(id?: string, action?: GroupHeaderAction) { return this.groups?.setHover(id, action) ?? false; }
  setGroupControlsMuted(muted: boolean) {
    this.groupResize?.setMuted(muted);
    this.requestRender();
  }
  setTransformOverlaysHidden(hidden: boolean) {
    this.selection?.setHidden(hidden);
    this.groupResize?.setHidden(hidden);
    this.requestRender();
  }
  setGroupDropTarget(id?: string) { return this.groups?.setDropTarget(id) ?? false; }
  setVisualNotesTemporaryHidden(hidden: boolean) { this.visualNotes?.setTemporaryHidden(hidden); this.requestRender(); }
  setVisualNotePreview(mark?: VisualMark) { this.visualNotes?.setPreview(mark); this.requestRender(); }
  setVisualNoteEraserCursor(point?: { x: number; y: number }, radiusScreen?: number) {
    this.visualNotes?.setEraserCursor(point, radiusScreen); this.requestRender();
  }
  setSelectedVisualNote(id?: string) { this.visualNotes?.setSelection(id); this.requestRender(); }
  drawSelection(items: SceneItem[], scale: number, box?: { x: number; y: number; width: number; height: number }, lasso?: LassoPoint[], controlsVisible = true) {
    this.selection?.draw(items, scale, box, lasso, controlsVisible);
    this.requestRender();
  }
  toggleVideoPlayback(id: string) {
    const toggled = this.videos?.togglePlayback(id) ?? false;
    if (toggled) this.requestRender();
    return toggled;
  }
  isVideoPlaying(id: string) {
    return this.videos?.isPlaying(id) ?? false;
  }
  getVideoTransport(id: string) {
    return this.videos?.transportState(id);
  }
  onVideoTransportChange(listener?: (state: VideoTransportState) => void) {
    this.videos?.onTransportChange(listener);
  }
  playVideo(id: string) { return this.videos?.play(id) ?? Promise.resolve(false); }
  pauseVideo(id: string) { return this.videos?.pause(id) ?? false; }
  beginVideoTimelineSeek(id: string) { return this.videos?.beginTimelineSeek(id) ?? false; }
  seekVideoTimeline(id: string, time: number) { return this.videos?.seekTimeline(id, time) ?? false; }
  endVideoTimelineSeek(id: string) { return this.videos?.endTimelineSeek(id) ?? false; }
  beginCanvasVideoJog(id: string) { return this.videos?.beginCanvasJog(id) ?? false; }
  jogCanvasVideoFrames(id: string, frameOffset: number) { return this.videos?.jogCanvasFrames(id, frameOffset) ?? false; }
  endCanvasVideoJog(id: string) { return this.videos?.endCanvasJog(id) ?? false; }
  setVideoRate(id: string, rate: number) { return this.videos?.setRate(id, rate) ?? false; }
  setVideoMuted(id: string, muted: boolean) { return this.videos?.setMuted(id, muted) ?? false; }
  resumeVideoWhenProxyReady(assetId: string) { this.videos?.resumeWhenProxyReady(assetId); }
  refreshVideoTiming(assetId: string) { this.videos?.refreshTiming(assetId); }
  failVideoProxy(assetId: string) { this.videos?.failProxy(assetId); }
  setVideoPreparation(assetId: string, stage: string, fraction: number) {
    this.videos?.setPreparation(assetId, stage, fraction);
  }
  hitSelectionHandle(point: { x: number; y: number }): TransformHandle | undefined { return this.selection?.hit(point); }
  hitGroupResizeHandle(point: { x: number; y: number }): GroupResizeHandle | undefined { return this.groupResize?.hit(point); }
  render(viewport: Viewport, workset?: {
    visible: ReadonlySet<string>; prefetch: ReadonlySet<string>;
    visibleBounds: { x: number; y: number; width: number; height: number };
    prefetchBounds: { x: number; y: number; width: number; height: number };
    cameraMoving: boolean; now: number;
  }) {
    if (!this.layers) return;
    const startedAt = performance.now();
    this.viewportScale = viewport.scale;
    this.visualNotes?.setViewportScale(viewport.scale);
    this.groups?.setViewport(viewport);
    this.syncGroupResizeOverlay();
    this.textures?.processFrame();
    if (workset) {
      this.images?.updateQuality({
        viewport, visible: workset.visible, prefetch: workset.prefetch,
        visibleBounds: workset.visibleBounds, prefetchBounds: workset.prefetchBounds,
        cameraMoving: workset.cameraMoving, now: workset.now,
        devicePixelRatio: boundedDevicePixelRatio(),
      });
      try {
        this.videos?.updateQuality({
          visible: workset.visible,
          prefetch: workset.prefetch,
          viewport,
          cameraMoving: workset.cameraMoving,
          now: workset.now,
          devicePixelRatio: boundedDevicePixelRatio(),
        });
      } catch {
        this.videos?.recoverAfterRenderError();
      }
    }
    this.images?.commitPendingSwaps();
    this.layers.world.position.set(viewport.x, viewport.y);
    this.layers.world.scale.set(viewport.scale);
    this.layers.overlay.position.set(viewport.x, viewport.y);
    this.layers.overlay.scale.set(viewport.scale);
    try {
      this.app.render();
      this.lastStageRenderAt = performance.now();
      this.videos?.afterRender();
    } catch {
      this.videos?.recoverAfterRenderError();
      try {
        this.app.render();
        this.lastStageRenderAt = performance.now();
        this.videos?.afterRender();
      } catch { /* keep the last good frame instead of freezing the canvas */ }
    }
    const textureStats = this.textures?.stats();
    if (textureStats) performanceMonitor.setImageRuntimeStats({
      cpuImageBytes: textureStats.cpuBytes,
      preloadImages: workset ? Math.max(0, workset.prefetch.size - workset.visible.size) : 0,
      decodeQueueLength: textureStats.decodeQueueLength,
      uploadQueueLength: textureStats.uploadQueueLength,
      frameUploadBytes: textureStats.uploadedBytesThisFrame,
      cacheHitRate: textureStats.cacheHits + textureStats.cacheMisses
        ? textureStats.cacheHits / (textureStats.cacheHits + textureStats.cacheMisses) : 0,
      currentMip: this.images?.displayedMips() ?? '-',
    });
    if (textureStats) performanceMonitor.setCanvasGpuStats(textureStats.gpuTextures, textureStats.gpuBytes);
    const videoStats = this.videos?.stats();
    if (videoStats) performanceMonitor.setVideoRuntimeStats(videoStats);
    performanceMonitor.setSceneCounts(workset?.visible.size ?? 0, this.pendingScene?.items.length ?? 0, 'pixi-v8');
    performanceMonitor.recordCanvasRuntimeFrame(performance.now() - startedAt, 'pixi-v8');
    this.app.canvas.dataset.totalImages = String(this.pendingScene?.items.length ?? 0);
    this.app.canvas.dataset.visibleImages = String(workset?.visible.size ?? 0);
    this.app.canvas.dataset.renderedImages = String(workset?.visible.size ?? 0);
    this.app.canvas.dataset.renderCommands = String(workset?.visible.size ?? 0);
    this.app.canvas.dataset.loadedCommands = String(
      textureStats?.decodeQueueLength || textureStats?.uploadQueueLength ? 0 : workset?.visible.size ?? 0,
    );
    this.app.canvas.dataset.selectedImages = String(this.selectedImages);
    this.app.canvas.dataset.videoPlaybackIntents = String(videoStats?.playbackIntents ?? 0);
    this.app.canvas.dataset.videoActiveDecoders = String(videoStats?.activeDecoders ?? 0);
    this.app.canvas.dataset.renderBackend = 'pixi-webgl';
    this.app.canvas.dataset.viewportX = String(viewport.x);
    this.app.canvas.dataset.viewportY = String(viewport.y);
    this.app.canvas.dataset.viewportScale = String(viewport.scale);
    this.app.canvas.dataset.renderedViewportX = String(viewport.x);
    this.app.canvas.dataset.renderedViewportY = String(viewport.y);
    this.app.canvas.dataset.renderedViewportScale = String(viewport.scale);
    this.app.canvas.dataset.gpuTextures = String(textureStats?.gpuTextures ?? 0);
    this.app.canvas.dataset.gpuBytes = String(textureStats?.gpuBytes ?? 0);
    this.app.canvas.dataset.cpuImageBytes = String(textureStats?.cpuBytes ?? 0);
    this.app.canvas.dataset.frameUploadBytes = String(textureStats?.uploadedBytesThisFrame ?? 0);
    this.app.canvas.dataset.peakGpuBytes = String(textureStats?.peakGpuBytes ?? 0);
    this.app.canvas.dataset.peakCpuImageBytes = String(textureStats?.peakCpuBytes ?? 0);
    this.app.canvas.dataset.peakDecodeQueue = String(textureStats?.peakDecodeQueueLength ?? 0);
    this.app.canvas.dataset.peakUploadQueue = String(textureStats?.peakUploadQueueLength ?? 0);
    this.app.canvas.dataset.peakFrameUploadBytes = String(textureStats?.peakFrameUploadBytes ?? 0);
    this.app.canvas.dataset.decodeQueue = String(textureStats?.decodeQueueLength ?? 0);
    this.app.canvas.dataset.uploadQueue = String(textureStats?.uploadQueueLength ?? 0);
    this.app.canvas.dataset.cacheMisses = String(textureStats?.cacheMisses ?? 0);
    this.app.canvas.dataset.cacheHitRate = String(textureStats && textureStats.cacheHits + textureStats.cacheMisses
      ? textureStats.cacheHits / (textureStats.cacheHits + textureStats.cacheMisses) : 0);
    this.app.canvas.dataset.textureError = textureStats?.lastError ?? '';
  }

  setBackground(background: string, opacity: number) {
    if (this.app.renderer) {
      this.app.renderer.background.color = background;
      this.app.renderer.background.alpha = opacity;
    }
  }

  sampleColor(point: { x: number; y: number }, final = true): PickedColor | undefined {
    const gl = (this.app.renderer as typeof this.app.renderer & { gl?: WebGL2RenderingContext }).gl;
    if (!gl || !this.app.canvas.isConnected) return undefined;
    const now = performance.now();
    const mapped = this.previewSampleMap;
    const reuse = !final && mapped && now < mapped.until && mapped.width > 0 && mapped.height > 0;
    let left: number; let top: number; let width: number; let height: number;
    let parentLeft: number; let parentTop: number;
    if (reuse && mapped) {
      left = mapped.left; top = mapped.top; width = mapped.width; height = mapped.height;
      parentLeft = mapped.parentLeft; parentTop = mapped.parentTop;
    } else {
      const canvasBounds = this.app.canvas.getBoundingClientRect();
      if (!canvasBounds.width || !canvasBounds.height) return undefined;
      const parentBounds = this.app.canvas.parentElement?.getBoundingClientRect();
      left = canvasBounds.left; top = canvasBounds.top;
      width = canvasBounds.width; height = canvasBounds.height;
      parentLeft = parentBounds?.left ?? left;
      parentTop = parentBounds?.top ?? top;
      if (!final) {
        this.previewSampleMap = { left, top, width, height, parentLeft, parentTop, until: now + 250 };
      }
    }
    const canvasX = point.x + parentLeft - left;
    const canvasY = point.y + parentTop - top;
    const x = Math.max(0, Math.min(gl.drawingBufferWidth - 1,
      Math.floor(canvasX * gl.drawingBufferWidth / width)));
    const y = Math.max(0, Math.min(gl.drawingBufferHeight - 1,
      gl.drawingBufferHeight - 1 - Math.floor(canvasY * gl.drawingBufferHeight / height)));
    if (final) {
      this.discardPendingColorReadback(gl);
      return this.readColorSynchronously(gl, x, y);
    }

    const completed = this.consumePendingColorReadback(gl);
    if (!this.pendingColorReadback && now >= this.previewSampleBlockedUntil) {
      if (!this.beginAsyncColorReadback(gl, x, y)) {
        // WebGL 1 and uncommon drivers without pixel-pack buffers retain the
        // limited synchronous fallback. In-flight PBO is the only GPU throttle.
        return completed ?? this.readColorSynchronously(gl, x, y, false);
      }
    }
    return completed;
  }

  private readColorSynchronously(gl: WebGL2RenderingContext, x: number, y: number, final = true) {
    const rgba = new Uint8Array(4);
    const startedAt = performance.now();
    // The default framebuffer may be discarded after compositing, so the final
    // release sample always renders immediately before its exact readback.
    this.app.render();
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    const duration = performance.now() - startedAt;
    performanceMonitor.recordColorSample(duration);
    if (!final && duration > 4) {
      this.previewSampleBlockedUntil = performance.now() + Math.min(80, Math.max(16, duration * 2));
    }
    return this.colorFromFramebuffer(gl, rgba);
  }

  private beginAsyncColorReadback(gl: WebGL2RenderingContext, x: number, y: number) {
    if (typeof gl.fenceSync !== 'function' || typeof gl.getBufferSubData !== 'function') return false;
    const buffer = gl.createBuffer();
    if (!buffer) return false;
    const startedAt = performance.now();
    // A preview read should not stall the tablet stroke. With a preserved
    // drawing buffer, reuse the last presented frame while the scene is still
    // fresh; otherwise render once, then pack a one-pixel PBO.
    if (startedAt - this.lastStageRenderAt > 48) {
      this.app.render();
      this.lastStageRenderAt = performance.now();
    }
    const previous = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING) as WebGLBuffer | null;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, 4, gl.STREAM_READ);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, previous);
    if (!fence) {
      gl.deleteBuffer(buffer);
      return false;
    }
    gl.flush();
    this.pendingColorReadback = {
      buffer, fence, startedAt,
      premultipliedAlpha: Boolean(gl.getContextAttributes()?.premultipliedAlpha),
    };
    performanceMonitor.recordColorSample(performance.now() - startedAt);
    return true;
  }

  private consumePendingColorReadback(gl: WebGL2RenderingContext): PickedColor | undefined {
    const pending = this.pendingColorReadback;
    if (!pending) return undefined;
    const status = gl.clientWaitSync(pending.fence, 0, 0);
    if (status === gl.TIMEOUT_EXPIRED) return undefined;
    if (status === gl.WAIT_FAILED) {
      this.discardPendingColorReadback(gl);
      this.previewSampleBlockedUntil = performance.now() + 50;
      return undefined;
    }
    const rgba = new Uint8Array(4);
    const previous = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING) as WebGLBuffer | null;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pending.buffer);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, rgba);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, previous);
    gl.deleteSync(pending.fence);
    gl.deleteBuffer(pending.buffer);
    this.pendingColorReadback = undefined;
    return compositeDisplayedColor(
      { r: rgba[0], g: rgba[1], b: rgba[2], a: rgba[3] },
      { r: 23, g: 25, b: 29 },
      pending.premultipliedAlpha,
    );
  }

  private colorFromFramebuffer(gl: WebGL2RenderingContext, rgba: Uint8Array) {
    return compositeDisplayedColor(
      { r: rgba[0], g: rgba[1], b: rgba[2], a: rgba[3] },
      { r: 23, g: 25, b: 29 },
      Boolean(gl.getContextAttributes()?.premultipliedAlpha),
    );
  }

  private discardPendingColorReadback(gl?: WebGL2RenderingContext) {
    const pending = this.pendingColorReadback;
    if (!pending || !gl) {
      this.pendingColorReadback = undefined;
      return;
    }
    gl.deleteSync(pending.fence);
    gl.deleteBuffer(pending.buffer);
    this.pendingColorReadback = undefined;
  }

  advanceTextureGeneration() {
    this.images?.invalidateTextures();
    this.videos?.invalidateTextures();
    this.textures?.advanceGeneration();
  }

  destroy() {
    const gl = (this.app.renderer as typeof this.app.renderer & { gl?: WebGL2RenderingContext }).gl;
    this.discardPendingColorReadback(gl);
    this.contextDisposer?.();
    this.contextDisposer = undefined;
    this.images?.destroy();
    this.videos?.destroy();
    this.selection?.destroy();
    this.groupResize?.destroy();
    this.textures?.destroy();
    this.groups?.destroy();
    this.visualNotes?.destroy();
    this.app.destroy({ removeView: true }, { children: true, texture: false, textureSource: false });
    this.images = undefined;
    this.videos = undefined;
    this.selection = undefined;
    this.groupResize = undefined;
    this.textures = undefined;
    this.groups = undefined;
    this.visualNotes = undefined;
    this.layers = undefined;
  }

  private syncGroupResizeOverlay() {
    const group = this.pendingScene?.groups.find((value) => value.id === this.selectedGroupId);
    this.groupResize?.draw(group, this.viewportScale);
  }
}
