import type { Scene, Viewport, VisualNotesState } from '../../types';
import { Camera } from '../camera/Camera';
import { CameraController } from '../camera/CameraController';
import { PixiRenderer } from '../renderer/PixiRenderer';
import { FrameScheduler } from './FrameScheduler';
import { RuntimeLifecycle } from './RuntimeLifecycle';
import { InputRouter } from '../interaction/InputRouter';
import { SceneStore } from '../scene/SceneStore';
import type { SelectionController } from '../selection/SelectionController';
import type { PickedColor, SceneItem, SceneItemPatch } from '../../types';
import { PREFETCH_VIEWPORT_MARGIN } from '../textures/TextureConfig';
import { performanceMonitor } from '../../runtime/performanceMonitor';
import { ColorPickerController } from '../interaction/ColorPickerController';
import { groupHeaderActionAtPoint, groupHeaderAtPoint, topmostImageAtPoint } from '../selection/HitTestService';
import { WindowMoveController } from '../interaction/WindowMoveController';
import type { GroupFrameBounds, LassoPoint, VisualNotesToolState } from '../publicTypes';
import { groupHeaderScreenWidth, groupHeaderWorldY } from '../groups/GroupPresentation';
import { VisualNotesController } from '../interaction/VisualNotesController';
import { isAltColorPickerPointer, type ColorPickerShortcut } from '../../shared/pointerPolicy';
import { isVideoItem } from '../../domain/media';
import type { VideoTransportState } from '../renderer/VideoTypes';
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
  onActivateItem?(item: SceneItem): void;
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
  private colorPickerOrigin = { left: 0, top: 0 };
  private colorPickerView = { width: 0, height: 0 };
  private colorPickerMetricsAt = 0;
  private pickerChromeFrame?: number;
  private pickerHideFrame?: number;
  private lastPickerDisplayHex?: string;
  private lastPickedDisplay?: PickedColor;
  private colorPickerHudOffset = { x: 32, y: 32 };
  private colorPickerHudClamp = { left: 8, top: 8, right: 8, bottom: 8 };
  private colorPickerHudShown = false;
  private colorPickerReticleShown = false;

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
      if (this.colorPickerSampling) return;
      this.updateColorPickerVisibleBounds(event);
      const nativeInput = Boolean((event as PointerEvent & { nativeInput?: boolean }).nativeInput);
      if (event.type === 'pointerenter') this.altPointerArmed = event.altKey;
      else if (event.altKey) this.altPointerArmed = true;
      else if (nativeInput) this.altPointerArmed = false;
      this.syncColorPickerArmedClass();
      if (this.colorPickerSampling) return;
      // HUD is contact-only. Alt hover may show the reticle for a pen, never the swatch.
      if (event.pointerType === 'pen' && event.buttons === 0 && !this.colorPickerHoverSuppressed) {
        if (this.colorPickerHeld || event.altKey || this.altPointerArmed) {
          if (!this.colorPickerPoint) this.refreshColorPickerOrigin();
          this.showColorPickerHover({
            x: event.clientX - this.colorPickerOrigin.left,
            y: event.clientY - this.colorPickerOrigin.top,
          });
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
      this.syncColorPickerArmedClass();
      if (event.type === 'keydown') this.refreshColorPickerOrigin();
      if (event.type === 'keyup') hideAltHover();
    };
    this.container.addEventListener('pointerenter', armAltFromPointer, true);
    this.container.addEventListener('pointerdown', armAltFromPointer, true);
    this.container.addEventListener('pointermove', armAltFromPointer, true);
    this.container.addEventListener('pointerleave', hideAltHover, true);
    window.addEventListener('pointerdown', armAltFromPointer, true);
    window.addEventListener('pointermove', armAltFromPointer, true);
    window.addEventListener('keydown', updateAltFromKeyboard, true);
    window.addEventListener('keyup', updateAltFromKeyboard, true);
    this.lifecycle.add(() => {
      this.container.removeEventListener('pointerenter', armAltFromPointer, true);
      this.container.removeEventListener('pointerdown', armAltFromPointer, true);
      this.container.removeEventListener('pointermove', armAltFromPointer, true);
      this.container.removeEventListener('pointerleave', hideAltHover, true);
      window.removeEventListener('pointerdown', armAltFromPointer, true);
      window.removeEventListener('pointermove', armAltFromPointer, true);
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
      pending: () => this.showColorPickerPending(),
      preview: (color) => this.updateColorPickerPreview(color),
      picked: (color) => {
        this.altPointerArmed = false;
        this.colorPickerHoverSuppressed = true;
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
      this.options.onActivateItem?.(item);
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
    this.syncColorPickerArmedClass();
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
    this.syncColorPickerArmedClass();
    if (!held && !this.colorPickerSampling) this.showColorPickerHover();
  }
  setColorPickerShortcut(shortcut: ColorPickerShortcut) {
    this.colorPickerShortcut = shortcut;
    this.syncColorPickerArmedClass();
  }
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
    this.syncColorPickerArmedClass();
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
  seekVideoTimelineFrame(id: string, frame: number) { return this.renderer.seekVideoTimelineFrame(id, frame); }
  endVideoTimelineSeek(id: string) { return this.renderer.endVideoTimelineSeek(id); }
  beginCanvasVideoJog(id: string) { return this.renderer.beginCanvasVideoJog(id); }
  jogCanvasVideoFrames(id: string, frameOffset: number) { return this.renderer.jogCanvasVideoFrames(id, frameOffset); }
  endCanvasVideoJog(id: string) { return this.renderer.endCanvasVideoJog(id); }
  setVideoRate(id: string, rate: number) { return this.renderer.setVideoRate(id, rate); }
  setVideoMuted(id: string, muted: boolean) { return this.renderer.setVideoMuted(id, muted); }
  resumeVideoWhenProxyReady(assetId: string) { this.renderer.resumeVideoWhenProxyReady(assetId); }
  refreshVideoTiming(assetId: string) { this.renderer.refreshVideoTiming(assetId); }
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
    if (event.altKey) this.altPointerArmed = true;
    const primaryButton = event.button === 0
      || (event.pointerType === 'pen' && event.button === -1 && (event.buttons & 1) !== 0);
    if (this.drawingCollaborationMode && (event as PointerEvent & { spaceKey?: boolean }).spaceKey && !event.altKey && primaryButton) return false;
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
    // Consume the hover latch on the first pen contact, but do not restyle
    // the document here — that double-toggle hitches the first tablet drag.
    if (enabled && event.pointerType === 'pen' && (event.button === 0 || event.button === -1)) {
      this.altPointerArmed = false;
    }
    return enabled;
  }

  private syncColorPickerArmedClass() {
    const shortcut = this.windowLocked ? 'alt' : this.colorPickerShortcut;
    const armed = this.colorPickerHeld || this.colorPickerSampling
      || (shortcut === 'alt' && this.altPointerArmed);
    document.documentElement.classList.toggle('color-picker-armed', armed);
  }

  private createColorPickerHud() {
    const reticle = document.createElement('div');
    reticle.className = 'color-picker-reticle';
    const reticleDot = document.createElement('i');
    reticleDot.className = 'color-picker-reticle-dot';
    const reticleIcon = document.createElement('i');
    reticleIcon.className = 'color-picker-reticle-icon';
    reticle.append(reticleDot, reticleIcon);
    const hud = document.createElement('div');
    hud.className = 'color-picker-hud';
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

  private refreshColorPickerOrigin() {
    const bounds = this.container.getBoundingClientRect();
    this.colorPickerOrigin = { left: bounds.left, top: bounds.top };
    this.colorPickerView = { width: this.container.clientWidth, height: this.container.clientHeight };
    this.colorPickerMetricsAt = performance.now();
  }

  private ensureColorPickerMetrics() {
    if (this.colorPickerView.width > 0 && performance.now() - this.colorPickerMetricsAt < 2000) return;
    this.refreshColorPickerOrigin();
  }

  private schedulePickerChrome() {
    if (this.pickerChromeFrame !== undefined) return;
    this.pickerChromeFrame = requestAnimationFrame(() => {
      this.pickerChromeFrame = undefined;
      if (!this.colorPickerSampling) return;
      this.container.classList.add('color-picker-sampling');
      this.syncColorPickerArmedClass();
    });
  }

  private positionColorPickerPreview(point?: { x: number; y: number }) {
    if (point && this.pickerHideFrame !== undefined) {
      cancelAnimationFrame(this.pickerHideFrame);
      this.pickerHideFrame = undefined;
    }
    const starting = Boolean(point) && !this.colorPickerSampling;
    this.colorPickerSampling = Boolean(point);
    this.colorPickerPoint = point;
    if (!point) {
      if (this.pickerChromeFrame !== undefined) {
        cancelAnimationFrame(this.pickerChromeFrame);
        this.pickerChromeFrame = undefined;
      }
      // Same-tick native DOWN/UP never paints if we hide synchronously. Keep
      // the HUD up for one frame so a short tablet contact is still a drag.
      if (this.colorPickerHudShown || this.colorPickerReticleShown) {
        if (this.pickerHideFrame === undefined) {
          this.pickerHideFrame = requestAnimationFrame(() => {
            this.pickerHideFrame = undefined;
            this.hideColorPickerOverlay();
            this.container.classList.remove('color-picker-sampling');
            this.syncColorPickerArmedClass();
          });
        }
        return;
      }
      this.hideColorPickerOverlay();
      this.container.classList.remove('color-picker-sampling');
      this.syncColorPickerArmedClass();
      return;
    }
    if (starting) {
      this.ensureColorPickerMetrics();
      if (!this.colorPickerColor && this.lastPickedDisplay) this.colorPickerColor = this.lastPickedDisplay;
      this.lockColorPickerHudOffset(point);
    }
    this.positionColorPickerReticle(point, this.colorPickerColor);
    this.followColorPickerHud(point);
    if (starting) this.schedulePickerChrome();
  }

  private updateColorPickerPreview(color?: PickedColor) {
    if (!color || !this.colorPickerHud || !this.colorPickerPoint) return;
    this.applyPickedColor(color);
  }

  private applyPickedColor(color: PickedColor) {
    this.colorPickerColor = color;
    this.lastPickedDisplay = color;
    if (this.lastPickerDisplayHex === color.hex) return;
    this.lastPickerDisplayHex = color.hex;
    this.colorPickerSwatch?.style.setProperty('--picked-color', color.hex);
    if (this.colorPickerHex) this.colorPickerHex.textContent = color.hex;
    if (this.colorPickerRgb) this.colorPickerRgb.textContent = `RGB ${color.r}  ${color.g}  ${color.b}`;
    this.colorPickerReticle?.style.setProperty('--picked-color', color.hex);
  }

  private colorPickerHudBounds() {
    const origin = this.colorPickerOrigin;
    const visible = this.colorPickerVisibleBounds;
    const view = this.colorPickerView;
    return {
      left: Math.max(8, (visible?.left ?? origin.left) - origin.left + 8),
      top: Math.max(8, (visible?.top ?? origin.top) - origin.top + 8),
      right: Math.min(view.width - 8, (visible?.right ?? origin.left + view.width) - origin.left - 8),
      bottom: Math.min(view.height - 8, (visible?.bottom ?? origin.top + view.height) - origin.top - 8),
    };
  }

  private lockColorPickerHudOffset(point: { x: number; y: number }) {
    const width = 178; const height = 54; const gap = 32;
    const bounds = this.colorPickerHudBounds();
    this.colorPickerHudClamp = bounds;
    this.colorPickerHudOffset = {
      x: point.x + gap + width <= bounds.right ? gap : -gap - width,
      y: point.y + gap + height <= bounds.bottom ? gap : -gap - height,
    };
  }

  private positionColorPickerHud(point: { x: number; y: number }) {
    const hud = this.colorPickerHud;
    if (!hud) return;
    const width = 178; const height = 54;
    const { left, top, right, bottom } = this.colorPickerHudClamp;
    const x = Math.max(left, Math.min(right - width, point.x + this.colorPickerHudOffset.x));
    const y = Math.max(top, Math.min(bottom - height, point.y + this.colorPickerHudOffset.y));
    hud.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  }

  private updateColorPickerVisibleBounds(event: PointerEvent) {
    const bounds = (event as PointerEvent & {
      visibleBounds?: { left: number; top: number; right: number; bottom: number };
    }).visibleBounds;
    this.colorPickerVisibleBounds = bounds && [bounds.left, bounds.top, bounds.right, bounds.bottom].every(Number.isFinite)
      ? bounds : undefined;
  }

  private followColorPickerHud(point: { x: number; y: number }) {
    const hud = this.colorPickerHud;
    if (!hud) return;
    if (!this.colorPickerHudShown) {
      hud.classList.add('is-shown');
      this.colorPickerHudShown = true;
    }
    this.positionColorPickerHud(point);
  }

  private showColorPickerHover(point?: { x: number; y: number }) {
    if (!point) {
      this.hideColorPickerOverlay();
      return;
    }
    this.positionColorPickerReticle(point);
  }

  private showColorPickerPending() {
    const point = this.colorPickerPoint;
    if (!this.colorPickerHud || !point) return;
    this.followColorPickerHud(point);
  }

  private positionColorPickerReticle(point: { x: number; y: number }, color?: PickedColor) {
    const reticle = this.colorPickerReticle;
    if (!reticle) return;
    if (!this.colorPickerReticleShown) {
      reticle.classList.add('is-shown');
      this.colorPickerReticleShown = true;
    }
    // Keep pen tracking on the compositor. Updating left/top forces layout and
    // makes the first collaboration drag visibly hitch over a WebGL canvas.
    reticle.style.transform = `translate3d(${point.x}px, ${point.y}px, 0) translate(-50%, -50%)`;
    if (color) reticle.style.setProperty('--picked-color', color.hex);
    else reticle.style.removeProperty('--picked-color');
  }

  private hideColorPickerOverlay() {
    this.colorPickerHud?.classList.remove('is-shown');
    this.colorPickerReticle?.classList.remove('is-shown');
    this.colorPickerHudShown = false;
    this.colorPickerReticleShown = false;
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
    if (this.pickerHideFrame !== undefined) cancelAnimationFrame(this.pickerHideFrame);
    if (this.pickerChromeFrame !== undefined) cancelAnimationFrame(this.pickerChromeFrame);
    document.documentElement.classList.remove('color-picker-armed');
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
