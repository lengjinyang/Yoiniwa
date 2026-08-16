import { ImageTransformCommand } from '../commands/ImageTransformCommand';
import { isVideoItem } from '../../domain/media';
import { resolveImageChanges } from '../../domain/sceneCommands';
import type { SceneItem, SceneItemPatch } from '../../types';
import type { Camera } from '../camera/Camera';
import type { InputRouter } from '../interaction/InputRouter';
import type { PixiRenderer } from '../renderer/PixiRenderer';
import type { RuntimeLifecycle } from '../runtime/RuntimeLifecycle';
import type { SceneStore } from '../scene/SceneStore';
import type { GroupFrameBounds, LassoPoint } from '../publicTypes';
import { SelectionController } from './SelectionController';

export interface CanvasSelectionHost {
  container: HTMLElement;
  input: InputRouter;
  camera: Camera;
  lifecycle: RuntimeLifecycle;
  renderer: PixiRenderer;
  sceneStore: () => SceneStore | undefined;
  selectionController: () => SelectionController | undefined;
  options: {
    onItemsChanged?(changes: Array<SceneItemPatch>, snap?: boolean): void;
    onSelectionChange?(ids: string[], source?: 'lasso'): void;
    onLassoSelectionChange?(points?: LassoPoint[]): void;
    onGroupSelectionChange?(id?: string): void;
    onGroupMoved?(id: string, deltaX: number, deltaY: number): void;
    onGroupResized?(id: string, bounds: GroupFrameBounds): void;
    onOpenGroupMenu?(id: string, position: { x: number; y: number }): void;
    onExpandGroup?(id: string): void;
    onExternalImageDrag?(items: SceneItem[]): (() => void) | undefined;
    onViewportCommit?(viewport: { x: number; y: number; scale: number }): void;
    selectedIds?: string[];
    selectedGroupId?: string;
  };
  colorPickerHeld: () => boolean;
  visualNotesEnabled: () => boolean;
  windowLocked: () => boolean;
  drawingCollaborationMode: () => boolean;
  emitGroupPreviewAnchor(id: string): void;
  scheduleRender(): void;
  markCameraChanged(): void;
}

export function bindCanvasSelection(host: CanvasSelectionHost) {
  const controller = new SelectionController({
    element: host.container, input: host.input, camera: host.camera, lifecycle: host.lifecycle,
    scene: () => host.sceneStore(),
    preview: (changes, snap = true) => {
      const current = host.sceneStore()?.snapshot();
      const resolved = current ? resolveImageChanges(current, changes, snap) : changes;
      host.sceneStore()?.previewImageChanges(resolved);
      const store = host.sceneStore();
      if (store) host.renderer.setScene(store.renderScene());
      host.selectionController()?.refresh();
      host.scheduleRender();
    },
    commit: (changes, snap = true) => {
      const current = host.sceneStore()?.snapshot();
      const resolved = current ? resolveImageChanges(current, changes, snap) : changes;
      if (current) {
        const scene = new ImageTransformCommand(current, resolved).execute(current);
        host.sceneStore()?.replace(scene);
        host.renderer.setScene(host.sceneStore()?.renderScene() ?? scene);
      }
      host.options.onItemsChanged?.(resolved, snap);
    },
    selectionChanged: (ids, source) => { host.renderer.setSelectedImageCount(ids.length); host.options.onSelectionChange?.(ids, source); },
    lassoSelectionChanged: (points) => host.options.onLassoSelectionChange?.(points),
    groupSelectionChanged: (id) => { host.renderer.setSelectedGroup(id); host.options.onGroupSelectionChange?.(id); },
    previewGroup: (id, deltaX, deltaY) => {
      host.sceneStore()?.previewGroupMove(id, deltaX, deltaY);
      const store = host.sceneStore();
      if (store) host.renderer.setScene(store.renderScene());
      host.emitGroupPreviewAnchor(id);
      host.scheduleRender();
    },
    commitGroup: (id, deltaX, deltaY) => host.options.onGroupMoved?.(id, deltaX, deltaY),
    previewGroupResize: (id, bounds) => {
      host.sceneStore()?.previewGroupResize(id, bounds);
      const store = host.sceneStore();
      if (store) host.renderer.setScene(store.renderScene());
      host.emitGroupPreviewAnchor(id);
      host.scheduleRender();
    },
    commitGroupResize: (id, bounds) => host.options.onGroupResized?.(id, bounds),
    openGroupMenu: (id, position) => host.options.onOpenGroupMenu?.(id, position),
    expandGroup: (id) => host.options.onExpandGroup?.(id),
    groupHeaderHoverChanged: (id, action) => {
      if (host.renderer.setGroupHeaderHover(id, action)) host.scheduleRender();
    },
    transformOverlaysHidden: (hidden) => host.renderer.setTransformOverlaysHidden(hidden),
    drawOverlay: (items, scale, box, lasso, controlsVisible) => host.renderer.drawSelection(items, scale, box, lasso, controlsVisible),
    hitHandle: (point) => host.renderer.hitSelectionHandle(point),
    hitGroupHandle: (point) => host.renderer.hitGroupResizeHandle(point),
    interactionBlocked: (event) => host.colorPickerHeld() || host.visualNotesEnabled() || host.windowLocked()
      || (host.drawingCollaborationMode() && Boolean(event?.ctrlKey && event.button === 0))
      || (host.drawingCollaborationMode() && Boolean((event as (PointerEvent & { spaceKey?: boolean }) | undefined)?.spaceKey && event?.button === 0)),
    documentInteractionBlocked: () => host.drawingCollaborationMode() || host.windowLocked(),
    canVideoJog: (id) => {
      if (host.drawingCollaborationMode() || host.windowLocked()) return false;
      const scene = host.sceneStore()?.snapshot();
      const item = scene?.items.find((candidate) => candidate.id === id);
      return Boolean(scene && item && isVideoItem(item, scene.assets));
    },
    beginVideoJog: (id) => {
      if (host.drawingCollaborationMode() || host.windowLocked()) return undefined;
      const scene = host.sceneStore()?.snapshot();
      const item = scene?.items.find((candidate) => candidate.id === id);
      if (!scene || !item || !isVideoItem(item, scene.assets) || !host.renderer.beginCanvasVideoJog(id)) return undefined;
      return {
        update: (frameOffset: number) => { host.renderer.jogCanvasVideoFrames(id, frameOffset); },
        end: () => { host.renderer.endCanvasVideoJog(id); },
      };
    },
    externalDrag: (items) => host.options.onExternalImageDrag?.(items),
    cameraChanged: (committed) => {
      host.markCameraChanged();
      host.scheduleRender();
      if (committed) host.options.onViewportCommit?.(host.camera.snapshot());
    },
  });
  controller.start();
  controller.setSelection(host.options.selectedIds ?? []);
  host.renderer.setSelectedImageCount(host.options.selectedIds?.length ?? 0);
  controller.setGroupSelection(host.options.selectedGroupId);
  host.renderer.setSelectedGroup(host.options.selectedGroupId);
  return controller;
}
