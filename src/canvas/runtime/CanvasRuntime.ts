import type { Scene, Viewport, VisualNotesState } from '../../types';
import { Camera } from '../camera/Camera';
import { CameraController } from '../camera/CameraController';
import { PixiRenderer } from '../renderer/PixiRenderer';
import { FrameScheduler } from './FrameScheduler';
import { RuntimeLifecycle } from './RuntimeLifecycle';
import { InputRouter } from '../interaction/InputRouter';
import { SceneStore } from '../scene/SceneStore';
import { SelectionController } from '../selection/SelectionController';
import type { ImageItem, PickedColor } from '../../types';
import { ImageTransformCommand } from '../commands/ImageTransformCommand';
import { PREFETCH_VIEWPORT_MARGIN } from '../textures/TextureConfig';
import { performanceMonitor } from '../../performanceMonitor';
import { ColorPickerController } from '../interaction/ColorPickerController';
import { groupHeaderActionAtPoint, groupHeaderAtPoint, topmostImageAtPoint } from '../selection/HitTestService';
import { WindowMoveController } from '../interaction/WindowMoveController';
import type { GroupFrameBounds } from '../selection/GroupResizeController';
import { groupHeaderScreenWidth, groupHeaderWorldY } from '../groups/GroupPresentation';
import { VisualNotesController, type VisualNotesToolState } from '../interaction/VisualNotesController';
import { isAltColorPickerPointer, type ColorPickerShortcut } from '../../interactions';

export interface CanvasRuntimeOptions {
  background: string;
  backgroundOpacity: number;
  viewport: Viewport;
  onViewportCommit?(viewport: Viewport): void;
  selectedIds?: string[];
  selectedGroupId?: string;
  onSelectionChange?(ids: string[]): void;
  onGroupSelectionChange?(id?: string): void;
  onItemsChanged?(changes: Array<Partial<ImageItem> & { id: string }>): void;
  onGroupMoved?(id: string, deltaX: number, deltaY: number): void;
  onGroupResized?(id: string, bounds: GroupFrameBounds): void;
  onRenameGroup?(id: string): void;
  onOpenGroupMenu?(id: string, position: { x: number; y: number }): void;
  onExpandGroup?(id: string): void;
  onGroupPreviewAnchor?(id: string, position: { x: number; y: number }): void;
  onFocusItem?(item: ImageItem): void;
  onContextMenu?(position: { x: number; y: number }): void;
  colorPickerHeld?: boolean;
  colorPickerShortcut?: ColorPickerShortcut;
  drawingCollaborationMode?: boolean;
  onColorPicked?(color: PickedColor): void;
  windowLocked?: boolean;
  onWindowMoveStart?(): void;
  onWindowMove?(): void;
  onWindowMoveEnd?(): void;
  visualNotesState?: VisualNotesToolState;
  onVisualNotesChanged?(notes: VisualNotesState): void;
  onVisualNoteSelectionChange?(id?: string): void;
}

export class CanvasRuntime {
  private readonly lifecycle = new RuntimeLifecycle();
  private readonly frames = new FrameScheduler();
  private readonly renderer = new PixiRenderer(() => this.scheduleRender());
  private readonly camera: Camera;
  private started = false;
  private sceneStore?: SceneStore;
  private selectionController?: SelectionController;
  private projectEpoch = 0;
  private cameraChangedAt = 0;
  private colorPickerHeld = false;
  private colorPickerShortcut: ColorPickerShortcut = 'alt';
  private altPointerArmed = false;
  private windowLocked = false;
  private drawingCollaborationMode = false;
  private visualNotesController?: VisualNotesController;
  private visualNotesState: VisualNotesToolState;
  private colorPickerHud?: HTMLDivElement;
  private colorPickerReticle?: HTMLDivElement;
  private colorPickerSwatch?: HTMLDivElement;
  private colorPickerHex?: HTMLElement;
  private colorPickerRgb?: HTMLElement;
  private colorPickerSampling = false;
  private colorPickerPoint?: { x: number; y: number };
  private colorPickerColor?: PickedColor;

  constructor(private readonly container: HTMLElement, private readonly options: CanvasRuntimeOptions) {
    this.camera = new Camera(options.viewport);
    this.colorPickerHeld = Boolean(options.colorPickerHeld);
    this.colorPickerShortcut = options.colorPickerShortcut ?? 'alt';
    this.windowLocked = Boolean(options.windowLocked);
    this.drawingCollaborationMode = Boolean(options.drawingCollaborationMode);
    this.visualNotesState = options.visualNotesState ?? { enabled: false, tool: 'brush', color: '#c6a15b', opacity: 0.82, width: 'medium', pressureEnabled: true, eraserSize: 'medium', selectedMarkId: undefined };
  }

  async start() {
    if (this.started) return;
    this.started = true;
    await this.renderer.start(this.container, this.options.background, this.options.backgroundOpacity);
    if (!this.started) {
      this.renderer.destroy();
      return;
    }
    this.createColorPickerHud();
    const armAltFromPointer = (event: PointerEvent) => {
      if (event.type === 'pointerenter') this.altPointerArmed = event.altKey;
      else if (event.altKey) this.altPointerArmed = true;
      if (event.pointerType === 'pen' && event.buttons === 0 && !this.colorPickerSampling) {
        if (this.colorPickerHeld || event.altKey || this.altPointerArmed) {
          const bounds = this.container.getBoundingClientRect();
          this.showColorPickerHover({ x: event.clientX - bounds.left, y: event.clientY - bounds.top });
        } else this.showColorPickerHover();
      }
    };
    const hideAltHover = () => { if (!this.colorPickerSampling) this.showColorPickerHover(); };
    const updateAltFromKeyboard = (event: KeyboardEvent) => {
      if (event.key !== 'Alt' && event.code !== 'AltLeft' && event.code !== 'AltRight') return;
      this.altPointerArmed = event.type === 'keydown';
      if (event.type === 'keyup') hideAltHover();
    };
    this.container.addEventListener('pointerenter', armAltFromPointer, true);
    this.container.addEventListener('pointermove', armAltFromPointer, true);
    this.container.addEventListener('pointerleave', hideAltHover, true);
    window.addEventListener('keydown', updateAltFromKeyboard, true);
    window.addEventListener('keyup', updateAltFromKeyboard, true);
    this.lifecycle.add(() => {
      this.container.removeEventListener('pointerenter', armAltFromPointer, true);
      this.container.removeEventListener('pointermove', armAltFromPointer, true);
      this.container.removeEventListener('pointerleave', hideAltHover, true);
      window.removeEventListener('keydown', updateAltFromKeyboard, true);
      window.removeEventListener('keyup', updateAltFromKeyboard, true);
    });
    const input = new InputRouter(this.container, this.lifecycle);
    const cameraController = new CameraController(this.container, input, this.camera, this.lifecycle, (committed) => {
      this.cameraChangedAt = performance.now();
      this.renderer.setGroupHeaderHover();
      this.container.style.cursor = '';
      this.scheduleRender();
      this.selectionController?.refresh();
      if (committed) this.options.onViewportCommit?.(this.camera.snapshot());
    }, (event) => this.isColorPickerPointer(event), (event) => {
      if (!this.drawingCollaborationMode || event.altKey
        || (event.pointerType !== 'mouse' && event.pointerType !== 'pen') || event.isPrimary === false) return undefined;
      return window.refCanvas?.isKeyDown('Space').catch(() => false) ?? false;
    });
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
        const current = this.sceneStore?.snapshot();
        if (current) {
          const scene = new ImageTransformCommand(current, changes).execute(current);
          this.sceneStore?.replace(scene);
          this.renderer.setScene(this.sceneStore?.renderScene() ?? scene);
        }
        this.options.onItemsChanged?.(changes);
      },
      selectionChanged: (ids) => { this.renderer.setSelectedImageCount(ids.length); this.options.onSelectionChange?.(ids); },
      groupSelectionChanged: (id) => { this.renderer.setSelectedGroup(id); this.options.onGroupSelectionChange?.(id); },
      previewGroup: (id, deltaX, deltaY) => {
        this.sceneStore?.previewGroupMove(id, deltaX, deltaY);
        if (this.sceneStore) this.renderer.setScene(this.sceneStore.renderScene());
        this.emitGroupPreviewAnchor(id);
        this.scheduleRender();
      },
      commitGroup: (id, deltaX, deltaY) => this.options.onGroupMoved?.(id, deltaX, deltaY),
      previewGroupResize: (id, bounds) => {
        this.sceneStore?.previewGroupResize(id, bounds);
        if (this.sceneStore) this.renderer.setScene(this.sceneStore.renderScene());
        this.emitGroupPreviewAnchor(id);
        this.scheduleRender();
      },
      commitGroupResize: (id, bounds) => this.options.onGroupResized?.(id, bounds),
      openGroupMenu: (id, position) => this.options.onOpenGroupMenu?.(id, position),
      expandGroup: (id) => this.options.onExpandGroup?.(id),
      groupHeaderHoverChanged: (id, action) => {
        if (this.renderer.setGroupHeaderHover(id, action)) this.scheduleRender();
      },
      drawOverlay: (items, scale, box) => this.renderer.drawSelection(items, scale, box),
      hitHandle: (point) => this.renderer.hitSelectionHandle(point),
      hitGroupHandle: (point) => this.renderer.hitGroupResizeHandle(point),
      interactionBlocked: (event) => this.colorPickerHeld || this.visualNotesState.enabled || this.windowLocked
        || (this.drawingCollaborationMode && Boolean(event?.ctrlKey && event.button === 0)),
      cameraChanged: (committed) => {
        this.cameraChangedAt = performance.now(); this.scheduleRender();
        if (committed) this.options.onViewportCommit?.(this.camera.snapshot());
      },
    });
    this.selectionController.start();
    this.selectionController.setSelection(this.options.selectedIds ?? []);
    this.renderer.setSelectedImageCount(this.options.selectedIds?.length ?? 0);
    this.selectionController.setGroupSelection(this.options.selectedGroupId);
    this.renderer.setSelectedGroup(this.options.selectedGroupId);
    this.visualNotesController = new VisualNotesController({
      element: this.container, input, camera: this.camera, lifecycle: this.lifecycle,
      scene: () => this.sceneStore, state: () => this.visualNotesState,
      preview: (mark) => { this.renderer.setVisualNotePreview(mark); this.scheduleRender(); },
      previewErase: (notes) => {
        if (!this.sceneStore) return;
        this.sceneStore.previewVisualNotes(notes);
        this.renderer.previewVisualNotes(notes, this.sceneStore.images());
        this.scheduleRender();
      },
      eraserCursor: (point, radiusScreen) => {
        this.renderer.setVisualNoteEraserCursor(point, radiusScreen);
        this.scheduleRender();
      },
      commit: (notes) => {
        const current = this.sceneStore?.snapshot();
        if (current) {
          const next = { ...current, visualNotes: notes };
          this.sceneStore?.replace(next); this.renderer.setScene(this.sceneStore?.renderScene() ?? next);
        }
        this.options.onVisualNotesChanged?.(notes);
      },
      selectionChanged: (id) => { this.renderer.setSelectedVisualNote(id); this.options.onVisualNoteSelectionChange?.(id); },
      interactionBlocked: (event) => this.drawingCollaborationMode && event.button === 0,
    });
    this.visualNotesController.start();
    const picker = new ColorPickerController({
      element: this.container, input, camera: this.camera, lifecycle: this.lifecycle,
      scene: () => this.sceneStore, enabled: (event) => this.isColorPickerPointer(event),
      sample: (point, final) => this.renderer.sampleColor(point, final),
      position: (point) => this.positionColorPickerPreview(point),
      preview: (color) => this.updateColorPickerPreview(color),
      picked: (color) => this.options.onColorPicked?.(color),
    });
    picker.start();
    new WindowMoveController({
      input, lifecycle: this.lifecycle, locked: () => this.windowLocked,
      begin: () => this.options.onWindowMoveStart?.(), move: () => this.options.onWindowMove?.(), end: () => this.options.onWindowMoveEnd?.(),
    }).startListening();
    const disposeContext = input.onContextMenu((event) => {
      if (this.windowLocked) {
        this.options.onContextMenu?.({ x: event.clientX, y: event.clientY });
        return;
      }
      const bounds = this.container.getBoundingClientRect();
      const point = this.camera.screenToWorld({ x: event.clientX - bounds.left, y: event.clientY - bounds.top });
      const group = groupHeaderAtPoint(this.sceneStore?.groups() ?? [], point, this.camera.snapshot().scale);
      if (group) {
        this.selectionController?.setSelection([]);
        this.selectionController?.setGroupSelection(group.id);
        this.renderer.setSelectedImageCount(0);
        this.renderer.setSelectedGroup(group.id);
        this.options.onSelectionChange?.([]);
        this.options.onGroupSelectionChange?.(group.id);
      } else {
        const image = topmostImageAtPoint(this.sceneStore?.images() ?? [], point);
        if (image) {
          this.selectionController?.setGroupSelection(undefined);
          this.selectionController?.setSelection([image.id]);
          this.renderer.setSelectedGroup(undefined);
          this.renderer.setSelectedImageCount(1);
          this.options.onGroupSelectionChange?.(undefined);
          this.options.onSelectionChange?.([image.id]);
        }
      }
      this.options.onContextMenu?.({ x: event.clientX, y: event.clientY });
    });
    const disposeDouble = input.onDoubleClick((event) => {
      if (this.windowLocked) return;
      const bounds = this.container.getBoundingClientRect();
      const point = this.camera.screenToWorld({ x: event.clientX - bounds.left, y: event.clientY - bounds.top });
      const group = groupHeaderAtPoint(this.sceneStore?.groups() ?? [], point, this.camera.snapshot().scale);
      if (group) {
        if (groupHeaderActionAtPoint(group, point, this.camera.snapshot().scale) === 'drag') {
          this.options.onRenameGroup?.(group.id);
        }
        return;
      }
      const item = topmostImageAtPoint(this.sceneStore?.images() ?? [], point);
      if (item) this.options.onFocusItem?.(item);
    });
    this.lifecycle.add(() => { disposeContext(); disposeDouble(); });
    const observer = new ResizeObserver(() => this.scheduleRender());
    observer.observe(this.container);
    this.lifecycle.add(() => observer.disconnect());
    const updateDropTarget = (event: DragEvent) => {
      const bounds = this.container.getBoundingClientRect();
      const world = this.camera.screenToWorld({ x: event.clientX - bounds.left, y: event.clientY - bounds.top });
      const group = [...(this.sceneStore?.groups() ?? [])].reverse().find((candidate) => !candidate.hidden
        && !candidate.collapsed && world.x >= candidate.x && world.x <= candidate.x + candidate.width
        && world.y >= candidate.y && world.y <= candidate.y + candidate.height);
      if (this.renderer.setGroupDropTarget(group?.id)) this.scheduleRender();
    };
    const clearDropTarget = () => {
      if (this.renderer.setGroupDropTarget()) this.scheduleRender();
    };
    this.container.addEventListener('dragover', updateDropTarget);
    this.container.addEventListener('drop', clearDropTarget);
    this.container.addEventListener('dragleave', clearDropTarget);
    this.lifecycle.add(() => {
      this.container.removeEventListener('dragover', updateDropTarget);
      this.container.removeEventListener('drop', clearDropTarget);
      this.container.removeEventListener('dragleave', clearDropTarget);
    });
    this.scheduleRender();
  }

  private emitGroupPreviewAnchor(id: string) {
    const group = this.sceneStore?.groups().find((candidate) => candidate.id === id);
    if (!group) return;
    const viewport = this.camera.snapshot();
    const scale = Math.max(viewport.scale, 0.0001);
    const bounds = this.container.getBoundingClientRect();
    this.options.onGroupPreviewAnchor?.(id, {
      x: bounds.left + viewport.x + group.x * scale
        + groupHeaderScreenWidth(group, scale) + 6,
      y: bounds.top + viewport.y + groupHeaderWorldY(group, scale) * scale,
    });
  }

  setViewport(viewport: Viewport) { this.camera.set(viewport); this.scheduleRender(); }
  setScene(scene: Scene) {
    if (this.sceneStore) this.sceneStore.replace(scene); else this.sceneStore = new SceneStore(scene);
    this.renderer.setScene(this.sceneStore.renderScene());
    this.selectionController?.refresh();
    this.scheduleRender();
  }
  setSelection(ids: string[]) { this.selectionController?.setSelection(ids); this.renderer.setSelectedImageCount(ids.length); }
  setGroupSelection(id?: string) { this.selectionController?.setGroupSelection(id); this.renderer.setSelectedGroup(id); }
  setGroupMenuOpen(open: boolean) { this.renderer.setGroupControlsMuted(open); }
  setColorPickerHeld(held: boolean) {
    this.colorPickerHeld = held;
    this.container.classList.toggle('color-picker-active', held);
    if (!held && !this.colorPickerSampling) this.showColorPickerHover();
  }
  setColorPickerShortcut(shortcut: ColorPickerShortcut) { this.colorPickerShortcut = shortcut; }
  setVisualNotesState(state: VisualNotesToolState) {
    this.visualNotesState = state; this.renderer.setSelectedVisualNote(state.enabled ? state.selectedMarkId : undefined);
    if (!state.enabled) this.visualNotesController?.cancel();
    if (!state.enabled || state.tool !== 'eraser') this.renderer.setVisualNoteEraserCursor();
  }
  setVisualNotesTemporaryHidden(hidden: boolean) { this.renderer.setVisualNotesTemporaryHidden(hidden); }
  cancelVisualNotesGesture() { this.visualNotesController?.cancel(); return this.visualNotesController?.active() ?? false; }
  setWindowLocked(locked: boolean) {
    this.windowLocked = locked;
    this.container.classList.toggle('canvas-content-locked', locked);
    if (!locked) return;
    this.selectionController?.setSelection([]);
    this.selectionController?.setGroupSelection(undefined);
    this.renderer.setSelectedImageCount(0);
    this.renderer.setSelectedGroup(undefined);
    this.options.onSelectionChange?.([]);
    this.options.onGroupSelectionChange?.(undefined);
  }

  setDrawingCollaborationMode(enabled: boolean) {
    this.drawingCollaborationMode = enabled;
  }
  setProjectEpoch(epoch: number) {
    if (epoch === this.projectEpoch) return;
    this.projectEpoch = epoch;
    this.renderer.advanceTextureGeneration();
    this.scheduleRender();
  }
  setBackground(background: string, opacity: number) { this.renderer.setBackground(background, opacity); }
  getViewport() { return this.camera.snapshot(); }

  private isColorPickerPointer(event: PointerEvent) {
    const primaryButton = event.button === 0
      || (event.pointerType === 'pen' && event.button === -1 && (event.buttons & 1) !== 0);
    if (this.drawingCollaborationMode && event.ctrlKey && primaryButton) return false;
    // Locked reference mode always mirrors Photoshop's Alt+pen gesture, even
    // when the editable-board shortcut preference is still set to S.
    const shortcut = this.windowLocked ? 'alt' : this.colorPickerShortcut;
    const altKey = event.altKey || (event.pointerType === 'pen' && this.altPointerArmed);
    const enabled = this.colorPickerHeld || isAltColorPickerPointer(shortcut, {
      button: event.button, buttons: event.buttons, pointerType: event.pointerType,
      ctrlKey: event.ctrlKey, altKey, shiftKey: event.shiftKey,
    });
    // The pointer-enter latch only bridges the focus transition. Consume it on
    // the first pen contact so a missed key-up cannot arm later normal taps.
    if (enabled && event.pointerType === 'pen' && (event.button === 0 || event.button === -1)) {
      this.altPointerArmed = false;
    }
    return enabled;
  }

  private createColorPickerHud() {
    const reticle = document.createElement('div');
    reticle.className = 'color-picker-reticle';
    reticle.hidden = true;
    const reticleDot = document.createElement('i');
    reticleDot.className = 'color-picker-reticle-dot';
    const reticleIcon = document.createElement('i');
    reticleIcon.className = 'color-picker-reticle-icon';
    reticle.append(reticleDot, reticleIcon);
    const hud = document.createElement('div');
    hud.className = 'color-picker-hud';
    hud.hidden = true;
    const swatch = document.createElement('div');
    swatch.className = 'color-picker-swatch';
    const values = document.createElement('div');
    values.className = 'color-picker-values';
    const hex = document.createElement('strong');
    const rgb = document.createElement('small');
    values.append(hex, rgb);
    hud.append(swatch, values);
    this.container.append(reticle, hud);
    this.colorPickerReticle = reticle;
    this.colorPickerHud = hud;
    this.colorPickerSwatch = swatch;
    this.colorPickerHex = hex;
    this.colorPickerRgb = rgb;
  }

  private positionColorPickerPreview(point?: { x: number; y: number }) {
    this.colorPickerSampling = Boolean(point);
    this.colorPickerPoint = point;
    if (!point) {
      this.hideColorPickerOverlay();
      this.container.classList.remove('color-picker-sampling');
      return;
    }
    this.container.classList.add('color-picker-sampling');
    this.positionColorPickerReticle(point, this.colorPickerColor);
    if (this.colorPickerColor && this.colorPickerHud && !this.colorPickerHud.hidden) {
      this.positionColorPickerHud(point);
    }
  }

  private updateColorPickerPreview(color?: PickedColor) {
    const hud = this.colorPickerHud;
    this.colorPickerColor = color;
    if (!hud || !color || !this.colorPickerPoint) {
      if (hud) hud.hidden = true;
      if (this.colorPickerPoint) this.positionColorPickerReticle(this.colorPickerPoint);
      return;
    }
    this.positionColorPickerReticle(this.colorPickerPoint, color);
    if (this.colorPickerSwatch) this.colorPickerSwatch.style.setProperty('--picked-color', color.hex);
    if (this.colorPickerHex) this.colorPickerHex.textContent = color.hex;
    if (this.colorPickerRgb) this.colorPickerRgb.textContent = `RGB ${color.r}  ${color.g}  ${color.b}`;
    hud.hidden = false;
    this.positionColorPickerHud(this.colorPickerPoint);
  }

  private positionColorPickerHud(point: { x: number; y: number }) {
    const hud = this.colorPickerHud;
    if (!hud) return;
    const width = 178; const height = 54; const gap = 32;
    const preferredX = point.x + gap + width <= this.container.clientWidth ? point.x + gap : point.x - gap - width;
    const preferredY = point.y + gap + height <= this.container.clientHeight ? point.y + gap : point.y - gap - height;
    hud.style.left = `${Math.max(8, Math.min(this.container.clientWidth - width - 8, preferredX))}px`;
    hud.style.top = `${Math.max(8, Math.min(this.container.clientHeight - height - 8, preferredY))}px`;
  }

  private showColorPickerHover(point?: { x: number; y: number }) {
    if (!point) {
      this.hideColorPickerOverlay();
      return;
    }
    this.positionColorPickerReticle(point);
  }

  private positionColorPickerReticle(point: { x: number; y: number }, color?: PickedColor) {
    const reticle = this.colorPickerReticle;
    if (!reticle) return;
    reticle.hidden = false;
    reticle.style.left = `${point.x}px`;
    reticle.style.top = `${point.y}px`;
    if (color) reticle.style.setProperty('--picked-color', color.hex);
    else reticle.style.removeProperty('--picked-color');
  }

  private hideColorPickerOverlay() {
    if (this.colorPickerHud) this.colorPickerHud.hidden = true;
    if (this.colorPickerReticle) this.colorPickerReticle.hidden = true;
    this.colorPickerPoint = undefined;
    this.colorPickerColor = undefined;
  }

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
    this.container.classList.remove('color-picker-active', 'color-picker-sampling', 'canvas-content-locked');
    this.colorPickerHud?.remove();
    this.colorPickerReticle?.remove();
    this.colorPickerHud = undefined;
    this.colorPickerReticle = undefined;
    this.colorPickerSwatch = undefined;
    this.colorPickerHex = undefined;
    this.colorPickerRgb = undefined;
    this.lifecycle.destroy();
    this.frames.destroy();
    this.renderer.destroy();
    this.started = false;
  }
}
