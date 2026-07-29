import type { Scene, Viewport } from '../../types';
import { Camera } from '../camera/Camera';
import { CameraController } from '../camera/CameraController';
import { PixiRenderer } from '../renderer/PixiRenderer';
import { FrameScheduler } from './FrameScheduler';
import { RuntimeLifecycle } from './RuntimeLifecycle';
import { InputRouter } from '../interaction/InputRouter';
import { SceneStore } from '../scene/SceneStore';
import { SelectionController } from '../selection/SelectionController';
import type { ImageItem } from '../../types';
import { CommandManager } from '../commands/CommandManager';
import { PREFETCH_VIEWPORT_MARGIN } from '../textures/TextureConfig';
import { performanceMonitor } from '../../performanceMonitor';

export interface CanvasRuntimeOptions {
  background: string;
  viewport: Viewport;
  onViewportCommit?(viewport: Viewport): void;
  selectedIds?: string[];
  onSelectionChange?(ids: string[]): void;
  onItemsChanged?(changes: Array<Partial<ImageItem> & { id: string }>): void;
}

export class CanvasRuntime {
  private readonly lifecycle = new RuntimeLifecycle();
  private readonly frames = new FrameScheduler();
  private readonly renderer = new PixiRenderer(() => this.scheduleRender());
  private readonly camera: Camera;
  private started = false;
  private sceneStore?: SceneStore;
  private selectionController?: SelectionController;
  private readonly commands = new CommandManager();
  private projectEpoch = 0;
  private cameraChangedAt = 0;

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
    const input = new InputRouter(this.container, this.lifecycle);
    const cameraController = new CameraController(this.container, input, this.camera, this.lifecycle, (committed) => {
      this.cameraChangedAt = performance.now();
      this.scheduleRender();
      this.selectionController?.refresh();
      if (committed) this.options.onViewportCommit?.(this.camera.snapshot());
    });
    cameraController.start();
    this.selectionController = new SelectionController({
      element: this.container, input, camera: this.camera, lifecycle: this.lifecycle,
      scene: () => this.sceneStore,
      preview: (changes) => {
        this.sceneStore?.previewImageChanges(changes);
        if (this.sceneStore) this.renderer.setScene(this.sceneStore.snapshot());
        this.selectionController?.refresh();
        this.scheduleRender();
      },
      commit: (changes) => {
        const scene = this.commands.commitImageChanges(changes);
        if (scene) {
          this.sceneStore?.replace(scene);
          this.renderer.setScene(scene);
        }
        this.options.onItemsChanged?.(changes);
      },
      selectionChanged: (ids) => this.options.onSelectionChange?.(ids),
      drawOverlay: (items, scale, box) => this.renderer.drawSelection(items, scale, box),
      hitHandle: (point) => this.renderer.hitSelectionHandle(point),
    });
    this.selectionController.start();
    this.selectionController.setSelection(this.options.selectedIds ?? []);
    const observer = new ResizeObserver(() => this.scheduleRender());
    observer.observe(this.container);
    this.lifecycle.add(() => observer.disconnect());
    this.scheduleRender();
  }

  setViewport(viewport: Viewport) { this.camera.set(viewport); this.scheduleRender(); }
  setScene(scene: Scene) {
    if (this.sceneStore) this.sceneStore.replace(scene); else this.sceneStore = new SceneStore(scene);
    this.commands.sync(scene);
    this.renderer.setScene(scene);
    this.selectionController?.refresh();
    this.scheduleRender();
  }
  setSelection(ids: string[]) { this.selectionController?.setSelection(ids); }
  setProjectEpoch(epoch: number) {
    if (epoch === this.projectEpoch) return;
    this.projectEpoch = epoch;
    this.commands.reset(this.sceneStore?.snapshot());
    this.renderer.advanceTextureGeneration();
  }
  setBackground(background: string) { this.renderer.setBackground(background); }
  getViewport() { return this.camera.snapshot(); }

  private scheduleRender() {
    this.frames.request((now) => {
      const viewport = this.camera.snapshot();
      const width = this.container.clientWidth / viewport.scale;
      const height = this.container.clientHeight / viewport.scale;
      const visibleBounds = { x: -viewport.x / viewport.scale, y: -viewport.y / viewport.scale, width, height };
      const marginX = width * PREFETCH_VIEWPORT_MARGIN;
      const marginY = height * PREFETCH_VIEWPORT_MARGIN;
      const prefetchBounds = {
        x: visibleBounds.x - marginX, y: visibleBounds.y - marginY,
        width: width + marginX * 2, height: height + marginY * 2,
      };
      const queryStartedAt = performance.now();
      const visible = this.sceneStore?.queryImages(visibleBounds) ?? new Set<string>();
      const prefetch = this.sceneStore?.queryImages(prefetchBounds) ?? new Set<string>();
      performanceMonitor.recordSpatialQuery(performance.now() - queryStartedAt);
      this.renderer.render(viewport, {
        visible, prefetch, visibleBounds, prefetchBounds,
        cameraMoving: now - this.cameraChangedAt < 160, now,
      });
    });
  }

  destroy() {
    this.lifecycle.destroy();
    this.frames.destroy();
    this.renderer.destroy();
    this.started = false;
  }
}
