import type { Scene, Viewport, VisualNotesState } from '../../types';
import { Camera } from '../camera/Camera';
import { CameraController } from '../camera/CameraController';
import { PixiRenderer } from '../renderer/PixiRenderer';
import { FrameScheduler } from './FrameScheduler';
import { RuntimeLifecycle } from './RuntimeLifecycle';
import { InputRouter } from '../interaction/InputRouter';
import { SceneStore } from '../scene/SceneStore';
import type { LassoPoint, SelectionController } from '../selection/SelectionController';
import type { PickedColor, SceneItem, SceneItemPatch } from '../../types';
import { PREFETCH_VIEWPORT_MARGIN } from '../textures/TextureConfig';
import { performanceMonitor } from '../../runtime/performanceMonitor';
import { ColorPickerController } from '../interaction/ColorPickerController';
import { groupHeaderActionAtPoint, groupHeaderAtPoint, topmostImageAtPoint } from '../selection/HitTestService';
import { WindowMoveController } from '../interaction/WindowMoveController';
import type { GroupFrameBounds } from '../selection/GroupResizeController';
import { groupHeaderScreenWidth, groupHeaderWorldY } from '../groups/GroupPresentation';
import { VisualNotesController, type VisualNotesToolState } from '../interaction/VisualNotesController';
import { isAltColorPickerPointer, type ColorPickerShortcut } from '../../interactions';
import { isVideoItem } from '../../domain/media';
import type { VideoTransportState } from '../renderer/VideoRenderer';
import type { VideoPlaybackHost } from '../video/videoPlaybackHost';
import type { ImageResourceBoost } from '../textures/imageResourceBoost';
import type { SpaceKeyQuery } from './spaceKeyQuery';
import { bindVideoHover } from '../video/bindVideoHover';
import { bindCanvasSelection } from '../selection/bindCanvasSelection';

export interface CanvasRuntimeOptions {
  background: string;
  backgroundOpacity: number;
  viewport: Viewport;
  onViewportCommit?(viewport: Viewport): void;
  selectedIds?: string[];
  selectedGroupId?: string;
  onSelectionChange?(ids: string[], source?: 'lasso'): void;
  onLassoSelectionChange?(points?: LassoPoint[]): void;
  onGroupSelectionChange?(id?: string): void;
  onItemsChanged?(changes: Array<SceneItemPatch>, snap?: boolean): void;
  onGroupMoved?(id: string, deltaX: number, deltaY: number): void;
  onGroupResized?(id: string, bounds: GroupFrameBounds): void;
  onRenameGroup?(id: string): void;
  onOpenGroupMenu?(id: string, position: { x: number; y: number }): void;
  onExpandGroup?(id: string): void;
  onGroupPreviewAnchor?(id: string, position: { x: number; y: number }): void;
  onFocusItem?(item: SceneItem): void;
  onContextMenu?(position: { x: number; y: number }): void;
  onExternalImageDrag?(items: SceneItem[]): (() => void) | undefined;
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
  videoPlayback?: VideoPlaybackHost;
  boostImageResource?: ImageResourceBoost;
  isSpaceDown?: SpaceKeyQuery;
}

export class CanvasRuntime {
  private readonly lifecycle = new RuntimeLifecycle();
  private readonly frames = new FrameScheduler();
  private readonly renderer: PixiRenderer;
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
  private colorPickerHoverSuppressed = false;
  private colorPickerPoint?: { x: number; y: number };
  private colorPickerColor?: PickedColor;
  private colorPickerVisibleBounds?: { left: number; top: number; right: number; bottom: number };

  constructor(private readonly container: HTMLElement, private readonly options: CanvasRuntimeOptions) {
    this.renderer = new PixiRenderer(() => this.scheduleRender(), options.videoPlayback, options.boostImageResource);
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
      this.updateColorPickerVisibleBounds(event);
      if (event.type === 'pointerenter') this.altPointerArmed = event.altKey;
      else if (event.altKey) this.altPointerArmed = true;
      if (event.pointerType === 'pen' && event.buttons === 0 && !this.colorPickerSampling && !this.colorPickerHoverSuppressed) {
        if (this.colorPickerHeld || event.altKey || this.altPointerArmed) {
          const bounds = this.container.getBoundingClientRect();
          this.showColorPickerHover({ x: event.clientX - bounds.left, y: event.clientY - bounds.top });
        } else this.showColorPickerHover();
      }
    };
    const hideAltHover = () => {
      this.colorPickerHoverSuppressed = false;
      if (!this.colorPickerSampling) this.showColorPickerHover();
    };
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
    bindVideoHover({
      container: this.container,
      input,
      camera: this.camera,
      lifecycle: this.lifecycle,
      images: () => this.sceneStore?.images() ?? [],
      assets: () => this.sceneStore?.snapshot().assets,
      setHoveredVideo: (id) => this.renderer.setHoveredVideo(id),
      scheduleRender: () => this.scheduleRender(),
    });
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
      if ((event as PointerEvent & { spaceKey?: boolean }).spaceKey) return true;
      return this.options.isSpaceDown?.() ?? false;
    });
    cameraController.start();
    this.selectionController = bindCanvasSelection({
      container: this.container,
      input,
      camera: this.camera,
      lifecycle: this.lifecycle,
      renderer: this.renderer,
      sceneStore: () => this.sceneStore,
      selectionController: () => this.selectionController,
      options: this.options,
      colorPickerHeld: () => this.colorPickerHeld,
      visualNotesEnabled: () => this.visualNotesState.enabled,
      windowLocked: () => this.windowLocked,
      drawingCollaborationMode: () => this.drawingCollaborationMode,
      emitGroupPreviewAnchor: (id) => this.emitGroupPreviewAnchor(id),
      scheduleRender: () => this.scheduleRender(),
      markCameraChanged: () => { this.cameraChangedAt = performance.now(); },
    });
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
      picked: (color) => {
        this.altPointerArmed = false;
        this.colorPickerHoverSuppressed = true;
        this.hideColorPickerOverlay();
        this.container.classList.remove('color-picker-sampling');
        this.options.onColorPicked?.(color);
      },
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
        this.selectionController?.clearLasso();
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
          this.renderer.setSelectedGroup(undefined);
          this.options.onGroupSelectionChange?.(undefined);
          if (!this.selectionController?.hasSelection(image.id)) {
            this.selectionController?.clearLasso();
            this.selectionController?.setSelection([image.id]);
            this.renderer.setSelectedImageCount(1);
            this.options.onSelectionChange?.([image.id]);
          } else {
            const selectedIds = this.selectionController.selectedIds();
            this.renderer.setSelectedImageCount(selectedIds.length);
            this.options.onSelectionChange?.(selectedIds);
          }
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
      if (!item) return;
      if (isVideoItem(item, this.sceneStore?.snapshot().assets) && this.renderer.toggleVideoPlayback(item.id)) {
        return;
      }
      this.options.onFocusItem?.(item);
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
  clearLasso() {
    this.selectionController?.clearLasso();
    this.selectionController?.refresh();
    this.scheduleRender();
  }
  setGroupSelection(id?: string) { this.selectionController?.setGroupSelection(id); this.renderer.setSelectedGroup(id); }
  setGroupMenuOpen(open: boolean) { this.renderer.setGroupControlsMuted(open); }
  setColorPickerHeld(held: boolean) {
    this.colorPickerHeld = held;
    if (!held) this.colorPickerHoverSuppressed = false;
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
    this.selectionController?.clearLasso();
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

  getVideoTransport(id: string) { return this.renderer.getVideoTransport(id); }
  onVideoTransportChange(listener?: (state: VideoTransportState) => void) {
    this.renderer.onVideoTransportChange(listener);
  }
  playVideo(id: string) { return this.renderer.playVideo(id); }
  pauseVideo(id: string) { return this.renderer.pauseVideo(id); }
  toggleVideoPlayback(id: string) { return this.renderer.toggleVideoPlayback(id); }
  beginVideoTimelineSeek(id: string) { return this.renderer.beginVideoTimelineSeek(id); }
  seekVideoTimeline(id: string, time: number) { return this.renderer.seekVideoTimeline(id, time); }
  endVideoTimelineSeek(id: string) { return this.renderer.endVideoTimelineSeek(id); }
  beginCanvasVideoJog(id: string) { return this.renderer.beginCanvasVideoJog(id); }
  jogCanvasVideoFrames(id: string, frameOffset: number) { return this.renderer.jogCanvasVideoFrames(id, frameOffset); }
  endCanvasVideoJog(id: string) { return this.renderer.endCanvasVideoJog(id); }
  setVideoRate(id: string, rate: number) { return this.renderer.setVideoRate(id, rate); }
  setVideoMuted(id: string, muted: boolean) { return this.renderer.setVideoMuted(id, muted); }
  resumeVideoWhenProxyReady(assetId: string) { this.renderer.resumeVideoWhenProxyReady(assetId); }
  failVideoProxy(assetId: string) { this.renderer.failVideoProxy(assetId); }
  setVideoPreparation(assetId: string, stage: string, fraction: number) {
    this.renderer.setVideoPreparation(assetId, stage, fraction);
  }
  setSelectedVideo(id?: string) { this.renderer.setSelectedVideo(id); }

  /** Screen-space rect of an item relative to the canvas container. */
  itemScreenRect(id: string): { left: number; top: number; width: number; height: number } | undefined {
    const item = this.sceneStore?.images().find((candidate) => candidate.id === id);
    if (!item) return undefined;
    const viewport = this.camera.snapshot();
    const scale = Math.max(viewport.scale, 0.0001);
    return {
      left: viewport.x + item.x * scale,
      top: viewport.y + item.y * scale,
      width: item.width * scale,
      height: item.height * scale,
    };
  }

  private isColorPickerPointer(event: PointerEvent) {
    this.updateColorPickerVisibleBounds(event);
    const primaryButton = event.button === 0
      || (event.pointerType === 'pen' && event.button === -1 && (event.buttons & 1) !== 0);
    if (this.drawingCollaborationMode && (event as PointerEvent & { spaceKey?: boolean }).spaceKey && primaryButton) return false;
    if (this.drawingCollaborationMode && event.ctrlKey && primaryButton) return false;
    // Locked reference mode always mirrors Photoshop's Alt+pen gesture, even
    // when the editable-board shortcut preference is still set to S.
    const shortcut = this.windowLocked ? 'alt' : this.colorPickerShortcut;
    const altKey = event.altKey || (event.pointerType === 'pen' && this.altPointerArmed);
    const enabled = this.colorPickerHeld || isAltColorPickerPointer(shortcut, {
      button: event.button, buttons: event.buttons, pointerType: event.pointerType,
      ctrlKey: event.ctrlKey, altKey, shiftKey: event.shiftKey,
    });
    if (enabled && event.button === 0) this.colorPickerHoverSuppressed = false;
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
    const width = hud.offsetWidth || 178; const height = hud.offsetHeight || 54; const gap = 32;
    const containerBounds = this.container.getBoundingClientRect();
    const visible = this.colorPickerVisibleBounds;
    const left = Math.max(8, (visible?.left ?? containerBounds.left) - containerBounds.left + 8);
    const top = Math.max(8, (visible?.top ?? containerBounds.top) - containerBounds.top + 8);
    const right = Math.min(this.container.clientWidth - 8,
      (visible?.right ?? containerBounds.right) - containerBounds.left - 8);
    const bottom = Math.min(this.container.clientHeight - 8,
      (visible?.bottom ?? containerBounds.bottom) - containerBounds.top - 8);
    const preferredX = point.x + gap + width <= right ? point.x + gap : point.x - gap - width;
    const preferredY = point.y + gap + height <= bottom ? point.y + gap : point.y - gap - height;
    hud.style.left = `${Math.max(left, Math.min(right - width, preferredX))}px`;
    hud.style.top = `${Math.max(top, Math.min(bottom - height, preferredY))}px`;
  }

  private updateColorPickerVisibleBounds(event: PointerEvent) {
    const bounds = (event as PointerEvent & {
      visibleBounds?: { left: number; top: number; right: number; bottom: number };
    }).visibleBounds;
    this.colorPickerVisibleBounds = bounds && [bounds.left, bounds.top, bounds.right, bounds.bottom].every(Number.isFinite)
      ? bounds : undefined;
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
