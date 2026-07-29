import { Application } from 'pixi.js';
import type { Scene, Viewport } from '../../types';
import { boundedDevicePixelRatio } from '../runtime/CanvasConfig';
import { ImageRenderer } from './ImageRenderer';
import { RenderLayers } from './RenderLayers';
import { SelectionOverlay, type TransformHandle } from '../selection/SelectionOverlay';
import type { ImageItem } from '../../types';
import { TextureManager } from '../textures/TextureManager';
import { performanceMonitor } from '../../performanceMonitor';

export class PixiRenderer {
  private readonly app = new Application();
  private layers?: RenderLayers;
  private images?: ImageRenderer;
  private selection?: SelectionOverlay;
  private textures?: TextureManager;
  private contextDisposer?: () => void;
  private pendingScene?: Scene;

  constructor(private readonly requestRender: () => void) {}

  async start(container: HTMLElement, background: string) {
    await this.app.init({
      background, antialias: true, autoDensity: true,
      resolution: boundedDevicePixelRatio(), preference: 'webgl', powerPreference: 'high-performance',
      resizeTo: container,
    });
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
    const lost = (event: Event) => { event.preventDefault(); this.advanceTextureGeneration(); };
    const restored = () => { if (this.pendingScene) this.images?.sync(this.pendingScene); this.requestRender(); };
    this.app.canvas.addEventListener('webglcontextlost', lost);
    this.app.canvas.addEventListener('webglcontextrestored', restored);
    this.contextDisposer = () => {
      this.app.canvas.removeEventListener('webglcontextlost', lost);
      this.app.canvas.removeEventListener('webglcontextrestored', restored);
    };
    this.layers = new RenderLayers(this.app.stage);
    this.textures = new TextureManager(this.app.renderer, this.requestRender, {
      deviceMemoryGb: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
    });
    this.images = new ImageRenderer(this.layers.images, this.textures, this.requestRender);
    this.selection = new SelectionOverlay(this.layers.overlay);
    if (this.pendingScene) this.images.sync(this.pendingScene);
  }

  setScene(scene: Scene) { this.pendingScene = scene; this.images?.sync(scene); }
  drawSelection(items: ImageItem[], scale: number, box?: { x: number; y: number; width: number; height: number }) {
    this.selection?.draw(items, scale, box);
    this.requestRender();
  }
  hitSelectionHandle(point: { x: number; y: number }): TransformHandle | undefined { return this.selection?.hit(point); }

  render(viewport: Viewport, workset?: {
    visible: ReadonlySet<string>; prefetch: ReadonlySet<string>;
    visibleBounds: { x: number; y: number; width: number; height: number };
    prefetchBounds: { x: number; y: number; width: number; height: number };
    cameraMoving: boolean; now: number;
  }) {
    if (!this.layers) return;
    const startedAt = performance.now();
    this.textures?.processFrame();
    if (workset) this.images?.updateQuality({
      viewport, visible: workset.visible, prefetch: workset.prefetch,
      visibleBounds: workset.visibleBounds, prefetchBounds: workset.prefetchBounds,
      cameraMoving: workset.cameraMoving, now: workset.now,
      devicePixelRatio: boundedDevicePixelRatio(),
    });
    this.images?.commitPendingSwaps();
    this.layers.world.position.set(viewport.x, viewport.y);
    this.layers.world.scale.set(viewport.scale);
    this.layers.overlay.position.set(viewport.x, viewport.y);
    this.layers.overlay.scale.set(viewport.scale);
    this.app.render();
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
    performanceMonitor.setSceneCounts(workset?.visible.size ?? 0, this.pendingScene?.items.length ?? 0, 'pixi-v8');
    performanceMonitor.recordCanvasRuntimeFrame(performance.now() - startedAt, 'pixi-v8');
    this.app.canvas.dataset.totalImages = String(this.pendingScene?.items.length ?? 0);
    this.app.canvas.dataset.visibleImages = String(workset?.visible.size ?? 0);
    this.app.canvas.dataset.gpuTextures = String(textureStats?.gpuTextures ?? 0);
    this.app.canvas.dataset.decodeQueue = String(textureStats?.decodeQueueLength ?? 0);
    this.app.canvas.dataset.uploadQueue = String(textureStats?.uploadQueueLength ?? 0);
    this.app.canvas.dataset.cacheMisses = String(textureStats?.cacheMisses ?? 0);
    this.app.canvas.dataset.textureError = textureStats?.lastError ?? '';
  }

  setBackground(background: string) {
    if (this.app.renderer) this.app.renderer.background.color = background;
  }

  advanceTextureGeneration() { this.images?.invalidateTextures(); this.textures?.advanceGeneration(); }

  destroy() {
    this.contextDisposer?.();
    this.contextDisposer = undefined;
    this.images?.destroy();
    this.selection?.destroy();
    this.textures?.destroy();
    this.app.destroy({ removeView: true }, { children: true, texture: false, textureSource: false });
    this.images = undefined;
    this.selection = undefined;
    this.textures = undefined;
    this.layers = undefined;
  }
}
