import type { Viewport } from '../../types';
import { Camera } from '../camera/Camera';
import { CameraController } from '../camera/CameraController';
import { PixiRenderer } from '../renderer/PixiRenderer';
import { FrameScheduler } from './FrameScheduler';
import { RuntimeLifecycle } from './RuntimeLifecycle';

export interface CanvasRuntimeOptions {
  background: string;
  viewport: Viewport;
  onViewportCommit?(viewport: Viewport): void;
}

export class CanvasRuntime {
  private readonly lifecycle = new RuntimeLifecycle();
  private readonly frames = new FrameScheduler();
  private readonly renderer = new PixiRenderer();
  private readonly camera: Camera;
  private started = false;

  constructor(private readonly container: HTMLElement, private readonly options: CanvasRuntimeOptions) {
    this.camera = new Camera(options.viewport);
  }

  async start() {
    if (this.started) return;
    this.started = true;
    await this.renderer.start(this.container, this.options.background);
    if (!this.started) {
      this.renderer.destroy();
      return;
    }
    const cameraController = new CameraController(this.container, this.camera, this.lifecycle, (committed) => {
      this.scheduleRender();
      if (committed) this.options.onViewportCommit?.(this.camera.snapshot());
    });
    cameraController.start();
    const observer = new ResizeObserver(() => this.scheduleRender());
    observer.observe(this.container);
    this.lifecycle.add(() => observer.disconnect());
    this.scheduleRender();
  }

  setViewport(viewport: Viewport) { this.camera.set(viewport); this.scheduleRender(); }
  setBackground(background: string) { this.renderer.setBackground(background); }
  getViewport() { return this.camera.snapshot(); }

  private scheduleRender() {
    this.frames.request(() => this.renderer.render(this.camera.snapshot()));
  }

  destroy() {
    this.lifecycle.destroy();
    this.frames.destroy();
    this.renderer.destroy();
    this.started = false;
  }
}
