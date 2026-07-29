import type { Scene, Viewport } from '../../types';
import { Camera } from '../camera/Camera';
import { CameraController } from '../camera/CameraController';
import { PixiRenderer } from '../renderer/PixiRenderer';
import { FrameScheduler } from './FrameScheduler';
import { RuntimeLifecycle } from './RuntimeLifecycle';
import { InputRouter } from '../interaction/InputRouter';
import { SceneStore } from '../scene/SceneStore';
import { SelectionController } from '../selection/SelectionController';
import type { AnnotationItem, AnnotationTool, ImageItem, PickedColor } from '../../types';
import { CommandManager } from '../commands/CommandManager';
import { PREFETCH_VIEWPORT_MARGIN } from '../textures/TextureConfig';
import { performanceMonitor } from '../../performanceMonitor';
import { AnnotationToolController, type AnnotationToolState } from '../interaction/AnnotationToolController';
import { ColorPickerController } from '../interaction/ColorPickerController';
import { topmostImageAtPoint } from '../selection/HitTestService';
import { WindowMoveController } from '../interaction/WindowMoveController';

export interface CanvasRuntimeOptions {
  background: string;
  viewport: Viewport;
  onViewportCommit?(viewport: Viewport): void;
  selectedIds?: string[];
  selectedAnnotationIds?: string[];
  selectedGroupId?: string;
  onSelectionChange?(ids: string[]): void;
  onAnnotationSelectionChange?(ids: string[]): void;
  onGroupSelectionChange?(id?: string): void;
  onItemsChanged?(changes: Array<Partial<ImageItem> & { id: string }>): void;
  onAnnotationsChanged?(changes: Array<{ id: string; deltaX: number; deltaY: number }>): void;
  onGroupMoved?(id: string, deltaX: number, deltaY: number): void;
  onGroupHeaderDragChange?(dragging: boolean): void;
  onGroupPreview?(id: string, x?: number, y?: number): void;
  onFocusItem?(item: ImageItem): void;
  onContextMenu?(position: { x: number; y: number }): void;
  annotationState?: AnnotationToolState;
  colorPickerHeld?: boolean;
  onColorPicked?(color: PickedColor): void;
  onAddAnnotation?(annotation: AnnotationItem): void;
  onEraseStart?(): void;
  onEraseAt?(x: number, y: number, radius: number): void;
  onEraseEnd?(): void;
  windowLocked?: boolean;
  onWindowMoveStart?(): void;
  onWindowMove?(): void;
  onWindowMoveEnd?(): void;
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
  private annotationState: AnnotationToolState;
  private colorPickerHeld = false;
  private windowLocked = false;

  constructor(private readonly container: HTMLElement, private readonly options: CanvasRuntimeOptions) {
    this.camera = new Camera(options.viewport);
    this.annotationState = options.annotationState ?? { enabled: false, tool: 'pen', color: '#ffcc00', width: 4 };
    this.colorPickerHeld = Boolean(options.colorPickerHeld);
    this.windowLocked = Boolean(options.windowLocked);
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
    }, () => this.colorPickerHeld);
    cameraController.start();
    this.selectionController = new SelectionController({
      element: this.container, input, camera: this.camera, lifecycle: this.lifecycle,
      scene: () => this.sceneStore,
      preview: (changes) => {
        this.sceneStore?.previewImageChanges(changes);
        if (this.sceneStore) this.renderer.setScene(this.sceneStore.renderScene());
        this.selectionController?.refresh();
        this.scheduleRender();
      },
      commit: (changes) => {
        const scene = this.commands.commitImageChanges(changes);
        if (scene) {
          this.sceneStore?.replace(scene);
          this.renderer.setScene(this.sceneStore?.renderScene() ?? scene);
        }
        this.options.onItemsChanged?.(changes);
      },
      selectionChanged: (ids) => { this.renderer.setSelectedImageCount(ids.length); this.options.onSelectionChange?.(ids); },
      annotationSelectionChanged: (ids) => this.options.onAnnotationSelectionChange?.(ids),
      groupSelectionChanged: (id) => { this.renderer.setSelectedGroup(id); this.options.onGroupSelectionChange?.(id); },
      previewAnnotation: (ids, deltaX, deltaY) => {
        this.sceneStore?.previewAnnotationMove(ids, deltaX, deltaY);
        if (this.sceneStore) this.renderer.setScene(this.sceneStore.renderScene());
        this.scheduleRender();
      },
      commitAnnotation: (ids, deltaX, deltaY) => this.options.onAnnotationsChanged?.(ids.map((id) => ({ id, deltaX, deltaY }))),
      previewGroup: (id, deltaX, deltaY) => {
        this.sceneStore?.previewGroupMove(id, deltaX, deltaY);
        if (this.sceneStore) this.renderer.setScene(this.sceneStore.renderScene());
        const group = this.sceneStore?.groups().find((value) => value.id === id);
        this.options.onGroupPreview?.(id, group?.x, group?.y);
        this.scheduleRender();
      },
      commitGroup: (id, deltaX, deltaY) => this.options.onGroupMoved?.(id, deltaX, deltaY),
      groupDragChanged: (dragging) => this.options.onGroupHeaderDragChange?.(dragging),
      drawOverlay: (items, scale, box) => this.renderer.drawSelection(items, scale, box),
      hitHandle: (point) => this.renderer.hitSelectionHandle(point),
      interactionBlocked: () => this.annotationState.enabled || this.colorPickerHeld,
      cameraChanged: (committed) => {
        this.cameraChangedAt = performance.now(); this.scheduleRender();
        if (committed) this.options.onViewportCommit?.(this.camera.snapshot());
      },
    });
    this.selectionController.start();
    this.selectionController.setSelection(this.options.selectedIds ?? []);
    this.renderer.setSelectedImageCount(this.options.selectedIds?.length ?? 0);
    this.selectionController.setAnnotationSelection(this.options.selectedAnnotationIds ?? []);
    this.selectionController.setGroupSelection(this.options.selectedGroupId);
    this.renderer.setSelectedGroup(this.options.selectedGroupId);
    const annotationTools = new AnnotationToolController({
      element: this.container, input, camera: this.camera, lifecycle: this.lifecycle,
      layer: this.renderer.annotationLayer(), state: () => this.annotationState,
      add: (annotation) => this.options.onAddAnnotation?.(annotation),
      eraseStart: () => this.options.onEraseStart?.(), eraseAt: (x, y, radius) => this.options.onEraseAt?.(x, y, radius),
      eraseEnd: () => this.options.onEraseEnd?.(), requestRender: () => this.scheduleRender(),
    });
    annotationTools.start();
    const picker = new ColorPickerController({
      element: this.container, input, camera: this.camera, lifecycle: this.lifecycle,
      scene: () => this.sceneStore, enabled: () => this.colorPickerHeld,
      picked: (color) => this.options.onColorPicked?.(color),
    });
    picker.start();
    new WindowMoveController({
      input, lifecycle: this.lifecycle, locked: () => this.windowLocked,
      begin: () => this.options.onWindowMoveStart?.(), move: () => this.options.onWindowMove?.(), end: () => this.options.onWindowMoveEnd?.(),
    }).startListening();
    const disposeContext = input.onContextMenu((event) => this.options.onContextMenu?.({ x: event.clientX, y: event.clientY }));
    const disposeDouble = input.onDoubleClick((event) => {
      const bounds = this.container.getBoundingClientRect();
      const point = this.camera.screenToWorld({ x: event.clientX - bounds.left, y: event.clientY - bounds.top });
      const item = topmostImageAtPoint(this.sceneStore?.images() ?? [], point);
      if (item) this.options.onFocusItem?.(item);
    });
    this.lifecycle.add(() => { disposeContext(); disposeDouble(); });
    const observer = new ResizeObserver(() => this.scheduleRender());
    observer.observe(this.container);
    this.lifecycle.add(() => observer.disconnect());
    this.scheduleRender();
  }

  setViewport(viewport: Viewport) { this.camera.set(viewport); this.scheduleRender(); }
  setScene(scene: Scene) {
    if (this.sceneStore) this.sceneStore.replace(scene); else this.sceneStore = new SceneStore(scene);
    this.commands.sync(scene);
    this.renderer.setScene(this.sceneStore.renderScene());
    this.selectionController?.refresh();
    this.scheduleRender();
  }
  setSelection(ids: string[]) { this.selectionController?.setSelection(ids); this.renderer.setSelectedImageCount(ids.length); }
  setAnnotationSelection(ids: string[]) { this.selectionController?.setAnnotationSelection(ids); }
  setGroupSelection(id?: string) { this.selectionController?.setGroupSelection(id); this.renderer.setSelectedGroup(id); }
  setAnnotationState(state: { enabled: boolean; tool: AnnotationTool; color: string; width: number }) { this.annotationState = state; }
  setColorPickerHeld(held: boolean) { this.colorPickerHeld = held; }
  setWindowLocked(locked: boolean) { this.windowLocked = locked; }
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
