import { Application } from 'pixi.js';
import type { Scene, Viewport } from '../../types';
import { boundedDevicePixelRatio } from '../runtime/CanvasConfig';
import { ImageRenderer } from './ImageRenderer';
import { RenderLayers } from './RenderLayers';
import { SelectionOverlay, type TransformHandle } from '../selection/SelectionOverlay';
import type { ImageItem } from '../../types';

export class PixiRenderer {
  private readonly app = new Application();
  private layers?: RenderLayers;
  private images?: ImageRenderer;
  private selection?: SelectionOverlay;
  private pendingScene?: Scene;

  constructor(private readonly requestRender: () => void) {}

  async start(container: HTMLElement, background: string) {
    await this.app.init({
      background, antialias: true, autoDensity: true,
      resolution: boundedDevicePixelRatio(), preference: 'webgl', powerPreference: 'high-performance',
      resizeTo: container,
    });
    this.app.canvas.className = 'pixi-canvas';
    container.appendChild(this.app.canvas);
    this.layers = new RenderLayers(this.app.stage);
    this.images = new ImageRenderer(this.layers.images, this.requestRender);
    this.selection = new SelectionOverlay(this.layers.overlay);
    if (this.pendingScene) this.images.sync(this.pendingScene);
  }

  setScene(scene: Scene) { this.pendingScene = scene; this.images?.sync(scene); }
  drawSelection(items: ImageItem[], scale: number, box?: { x: number; y: number; width: number; height: number }) {
    this.selection?.draw(items, scale, box);
    this.requestRender();
  }
  hitSelectionHandle(point: { x: number; y: number }): TransformHandle | undefined { return this.selection?.hit(point); }

  render(viewport: Viewport) {
    if (!this.layers) return;
    this.layers.world.position.set(viewport.x, viewport.y);
    this.layers.world.scale.set(viewport.scale);
    this.layers.overlay.position.set(viewport.x, viewport.y);
    this.layers.overlay.scale.set(viewport.scale);
  }

  setBackground(background: string) {
    if (this.app.renderer) this.app.renderer.background.color = background;
  }

  destroy() {
    this.images?.destroy();
    this.selection?.destroy();
    this.app.destroy({ removeView: true }, { children: true, texture: false, textureSource: false });
    this.images = undefined;
    this.selection = undefined;
    this.layers = undefined;
  }
}
