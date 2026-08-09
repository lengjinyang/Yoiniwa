import type { ImageGroup, ImageItem } from '../../types';
import type { Camera } from '../camera/Camera';
import type { InputRouter } from '../interaction/InputRouter';
import { PointerState } from '../interaction/PointerState';
import type { SceneStore } from '../scene/SceneStore';
import type { RuntimeLifecycle } from '../runtime/RuntimeLifecycle';
import { groupHeaderActionAtPoint, groupHeaderAtPoint, topmostImageAtPoint, unionImageBounds } from './HitTestService';
import { SceneSelection } from './SceneSelection';
import type { TransformHandle } from './SelectionOverlay';
import { boxFromPoints, collapsedGroupInSelectionBox, imagesInSelectionBox } from './BoxSelectionController';
import { transformImageSelection } from './TransformController';
import { resizeGroupFrameByDelta, type GroupFrameBounds, type GroupResizeHandle } from './GroupResizeController';
import { groupHeaderWorldBounds } from '../groups/GroupPresentation';
import { shortcutMatchesKeyboardEvent, shortcutReleasedByKeyboardEvent } from '../../keyboardShortcuts';

const rotationCursor = (degrees: 0 | 90 | 180 | 270) => `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='0 0 18 18' fill='none'%3E%3Cg transform='rotate(${degrees}%209%209)' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M14.5 4.5h-7q-3 0-3 3v7M12.1 2.1l2.4 2.4-2.4 2.4M2.1 12.1l2.4 2.4 2.4-2.4' stroke='%23101317' stroke-width='2.8'/%3E%3Cpath d='M14.5 4.5h-7q-3 0-3 3v7M12.1 2.1l2.4 2.4-2.4 2.4M2.1 12.1l2.4 2.4 2.4-2.4' stroke='%23f1f3f8' stroke-width='1.15'/%3E%3C/g%3E%3C/svg%3E") 9 9, crosshair`;

const ROTATE_CURSORS = {
  'north-west': rotationCursor(0),
  'north-east': rotationCursor(90),
  'south-east': rotationCursor(180),
  'south-west': rotationCursor(270),
} as const;

type ImageChange = Partial<ImageItem> & { id: string };
export type LassoPoint = { x: number; y: number };
type Drag =
  | { kind: 'move'; start: { x: number; y: number }; originals: ImageItem[] }
  | { kind: 'box'; start: { x: number; y: number }; additive: string[] }
  | { kind: 'lasso'; additive: string[]; points: LassoPoint[] }
  | { kind: 'transform'; start: { x: number; y: number }; originals: ImageItem[]; bounds: NonNullable<ReturnType<typeof unionImageBounds>>; handle: TransformHandle }
  | { kind: 'group-rotate'; start: { x: number; y: number }; originals: ImageItem[]; bounds: GroupFrameBounds }
  | { kind: 'group'; start: { x: number; y: number }; last: { x: number; y: number }; id: string }
  | { kind: 'group-resize'; start: { x: number; y: number }; id: string; original: ImageGroup; handle: GroupResizeHandle; bounds: GroupFrameBounds };

interface SelectionControllerOptions {
  element: HTMLElement;
  input: InputRouter;
  camera: Camera;
  lifecycle: RuntimeLifecycle;
  scene: () => SceneStore | undefined;
  preview(changes: ImageChange[], snap?: boolean): void;
  commit(changes: ImageChange[], snap?: boolean): void;
  selectionChanged(ids: string[], source?: 'lasso'): void;
  lassoSelectionChanged(points?: LassoPoint[]): void;
  groupSelectionChanged(id?: string): void;
  previewGroup(id: string, deltaX: number, deltaY: number): void;
  commitGroup(id: string, deltaX: number, deltaY: number): void;
  previewGroupResize(id: string, bounds: GroupFrameBounds): void;
  commitGroupResize(id: string, bounds: GroupFrameBounds): void;
  openGroupMenu(id: string, position: { x: number; y: number }): void;
  expandGroup(id: string): void;
  groupHeaderHoverChanged(id?: string, action?: ReturnType<typeof groupHeaderActionAtPoint>): void;
  transformOverlaysHidden(hidden: boolean): void;
  drawOverlay(items: ImageItem[], scale: number, box?: { x: number; y: number; width: number; height: number }, lasso?: LassoPoint[], controlsVisible?: boolean): void;
  hitHandle(point: { x: number; y: number }): TransformHandle | undefined;
  hitGroupHandle(point: { x: number; y: number }): GroupResizeHandle | undefined;
  interactionBlocked(event?: PointerEvent): boolean;
  documentInteractionBlocked(): boolean;
  boxSelectShortcut(): string;
  externalDrag(items: ImageItem[]): (() => void) | undefined;
  cameraChanged(committed: boolean): void;
}

export class SelectionController {
  private readonly selection = new SceneSelection();
  private readonly pointer = new PointerState();
  private drag?: Drag;
  private pendingChanges: ImageChange[] = [];
  private selectedGroupId?: string;
  private boxSelectHeld = false;
  private lassoPoints: LassoPoint[] = [];
  private overlaysHidden = false;

  constructor(private readonly options: SelectionControllerOptions) {}

  start() {
    const down = (event: PointerEvent) => this.pointerDown(event);
    const move = (event: PointerEvent) => this.pointerMove(event);
    const up = (event: PointerEvent) => this.pointerUp(event);
    const keyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !shortcutMatchesKeyboardEvent(this.options.boxSelectShortcut(), event)) return;
      this.boxSelectHeld = true;
      if (!this.drag && !this.options.documentInteractionBlocked()) this.options.element.style.cursor = 'crosshair';
    };
    const keyUp = (event: KeyboardEvent) => {
      if (!shortcutReleasedByKeyboardEvent(this.options.boxSelectShortcut(), event)) return;
      this.boxSelectHeld = false;
      if (!this.drag) this.options.element.style.cursor = '';
    };
    const blur = () => {
      this.boxSelectHeld = false;
      if (!this.drag) this.options.element.style.cursor = '';
    };
    const disposers = [
      this.options.input.onPointerDown(down), this.options.input.onPointerMove(move), this.options.input.onPointerUp(up),
      this.options.input.onPointerCancel(up),
    ];
    window.addEventListener('keydown', keyDown, true);
    window.addEventListener('keyup', keyUp, true);
    window.addEventListener('blur', blur);
    const leave = (event: PointerEvent) => {
      if (this.tryStartExternalDrag(event)) return;
      this.options.groupHeaderHoverChanged();
      this.options.element.style.cursor = '';
    };
    this.options.element.addEventListener('pointerleave', leave);
    this.options.lifecycle.add(() => {
      disposers.forEach((dispose) => dispose());
      window.removeEventListener('keydown', keyDown, true);
      window.removeEventListener('keyup', keyUp, true);
      window.removeEventListener('blur', blur);
      this.options.element.removeEventListener('pointerleave', leave);
      this.options.element.style.cursor = '';
    });
    this.refresh();
  }

  setSelection(ids: string[]) { this.selection.replace(ids); this.refresh(); }
  hasSelection(id: string) { return this.selection.has(id); }
  selectedIds() { return this.selection.values(); }
  setGroupSelection(id?: string) { this.selectedGroupId = id; }
  refresh() {
    const scene = this.options.scene();
    if (!scene) return;
    this.options.drawOverlay(scene.images().filter((item) => this.selection.has(item.id)), this.options.camera.snapshot().scale,
      undefined, this.lassoPoints, this.drag?.kind !== 'move');
  }

  private local(event: PointerEvent) {
    const bounds = this.options.element.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }

  private pointerDown(event: PointerEvent) {
    if (event.button !== 0 || event.altKey || this.options.interactionBlocked(event)) return;
    const scene = this.options.scene();
    if (!scene) return;
    const world = this.options.camera.screenToWorld(this.local(event));
    const scale = this.options.camera.snapshot().scale;
    const headerGroup = groupHeaderAtPoint(scene.groups(), world, scale);
    const headerAction = headerGroup ? groupHeaderActionAtPoint(headerGroup, world, scale, {
      selected: headerGroup.id === this.selectedGroupId,
    }) : undefined;
    const groupHandle = this.options.hitGroupHandle(world);
    const handle = this.options.hitHandle(world);
    const selected = scene.images().filter((item) => this.selection.has(item.id) && !item.locked);
    const selectionBounds = unionImageBounds(selected);
    const selectedGroup = scene.groups().find((group) => group.id === this.selectedGroupId);
    if (this.boxSelectHeld && !this.options.documentInteractionBlocked()) {
      this.beginPointer(event);
      const additive = event.shiftKey || event.ctrlKey || event.metaKey ? this.selection.values() : [];
      if (!additive.length) {
        this.selectedGroupId = undefined;
        this.selection.clear();
        this.options.groupSelectionChanged(undefined);
      }
      this.clearLasso();
      this.drag = { kind: 'lasso', additive, points: [world] };
      this.lassoPoints = [world];
      this.options.drawOverlay([], scale, undefined, this.lassoPoints);
      return;
    }
    this.clearLasso();
    if (groupHandle === 'rotate' && selectedGroup && !selectedGroup.collapsed) {
      const snapshot = scene.snapshot();
      const originals = imagesInGroup(snapshot.groups, snapshot.items, selectedGroup.id);
      if (!originals.length) return;
      this.beginPointer(event);
      this.drag = { kind: 'group-rotate', start: world, originals,
        bounds: { x: selectedGroup.x, y: selectedGroup.y, width: selectedGroup.width, height: selectedGroup.height } };
      this.setTransformOverlaysHidden(true);
      return;
    }
    if (groupHandle && selectedGroup && !selectedGroup.collapsed && !selectedGroup.sizeLocked) {
      this.beginPointer(event);
      this.drag = { kind: 'group-resize', start: world, id: selectedGroup.id, original: { ...selectedGroup }, handle: groupHandle,
        bounds: { x: selectedGroup.x, y: selectedGroup.y, width: selectedGroup.width, height: selectedGroup.height } };
      this.setTransformOverlaysHidden(true);
      return;
    }
    if (headerGroup && headerAction !== 'drag') {
      this.selection.clear(); this.selectedGroupId = headerGroup.id;
      this.options.selectionChanged([]);
      this.options.groupSelectionChanged(headerGroup.id);
      if (headerAction === 'more') {
        const elementBounds = this.options.element.getBoundingClientRect();
        const headerBounds = groupHeaderWorldBounds(headerGroup, scale);
        const headerTopRight = this.options.camera.worldToScreen({
          x: headerBounds.x + headerBounds.width,
          y: headerBounds.y,
        });
        this.options.openGroupMenu(headerGroup.id, {
          x: elementBounds.left + headerTopRight.x,
          y: elementBounds.top + headerTopRight.y,
        });
      }
      if (headerAction === 'expand') this.options.expandGroup(headerGroup.id);
      return;
    }
    this.beginPointer(event);
    if (handle && selected.length && selectionBounds) {
      this.drag = { kind: 'transform', start: world, originals: selected.map((item) => ({ ...item })), bounds: selectionBounds, handle };
      this.setTransformOverlaysHidden(true);
      return;
    }
    // The title bar is the group's interaction surface. It must win over
    // images beneath it so selecting and dragging the group is predictable.
    if (headerGroup) {
      this.selection.clear();
      this.selectedGroupId = headerGroup.id;
      this.options.selectionChanged([]); this.options.groupSelectionChanged(headerGroup.id);
      this.drag = { kind: 'group', start: world, last: world, id: headerGroup.id };
      this.setTransformOverlaysHidden(true);
      this.options.element.style.cursor = 'grabbing';
      return;
    }
    const hit = topmostImageAtPoint(scene.images(), world);
    if (hit) {
      this.selectedGroupId = undefined;
      this.options.groupSelectionChanged(undefined);
      if (event.shiftKey || event.ctrlKey || event.metaKey) this.selection.toggle(hit.id);
      else if (!this.selection.has(hit.id)) this.selection.replace([hit.id]);
      this.emitSelection();
      const movable = scene.images().filter((item) => this.selection.has(item.id) && !item.locked);
      this.drag = { kind: 'move', start: world, originals: movable.map((item) => ({ ...item })) };
      this.setTransformOverlaysHidden(true);
    } else {
      const additive = event.shiftKey || event.ctrlKey || event.metaKey ? this.selection.values() : [];
      if (!additive.length) {
        this.selectedGroupId = undefined;
        this.selection.clear();
        this.emitSelection(); this.options.groupSelectionChanged(undefined);
      }
      this.drag = { kind: 'box', start: world, additive };
    }
  }

  private pointerMove(event: PointerEvent) {
    if (!this.drag) {
      if (this.options.interactionBlocked()) {
        this.options.groupHeaderHoverChanged();
        this.options.element.style.cursor = '';
        return;
      }
      if (this.boxSelectHeld && !this.options.documentInteractionBlocked()) {
        this.options.groupHeaderHoverChanged();
        this.options.element.style.cursor = 'crosshair';
        return;
      }
      const scene = this.options.scene();
      const scale = this.options.camera.snapshot().scale;
      const world = this.options.camera.screenToWorld(this.local(event));
      const groupHandle = this.options.hitGroupHandle(world);
      if (groupHandle) {
        this.options.groupHeaderHoverChanged();
        const selectedGroup = scene?.groups().find((group) => group.id === this.selectedGroupId);
        const header = selectedGroup ? groupHeaderWorldBounds(selectedGroup, scale) : undefined;
        const groupBounds = selectedGroup && header
          ? { x: selectedGroup.x, y: header.y, width: selectedGroup.width,
            height: selectedGroup.y + selectedGroup.height - header.y }
          : undefined;
        this.options.element.style.cursor = groupHandle === 'rotate' && groupBounds
          ? rotationCursorAtPoint(world, groupBounds)
          : groupHandle === 'north' || groupHandle === 'south' ? 'ns-resize'
          : groupHandle === 'west' || groupHandle === 'east' ? 'ew-resize'
            : groupHandle === 'north-west' || groupHandle === 'south-east' ? 'nwse-resize' : 'nesw-resize';
        return;
      }
      const imageHandle = this.options.hitHandle(world);
      if (imageHandle) {
        this.options.groupHeaderHoverChanged();
        const selectionBounds = scene ? unionImageBounds(scene.images().filter((item) => this.selection.has(item.id))) : undefined;
        this.options.element.style.cursor = imageHandle === 'rotate' && selectionBounds
          ? rotationCursorAtPoint(world, selectionBounds)
          : imageHandle === 'north-west' || imageHandle === 'south-east' ? 'nwse-resize' : 'nesw-resize';
        return;
      }
      const group = scene ? groupHeaderAtPoint(scene.groups(), world, scale) : undefined;
      const action = group ? groupHeaderActionAtPoint(group, world, scale, {
        selected: group.id === this.selectedGroupId,
      }) : undefined;
      this.options.groupHeaderHoverChanged(group?.id, action);
      this.options.element.style.cursor = action === 'drag' ? 'grab' : action ? 'pointer' : '';
      return;
    }
    if (!this.pointer.update(event)) return;
    if (this.tryStartExternalDrag(event)) return;
    if (this.drag.kind === 'move' || this.drag.kind === 'transform' || this.drag.kind === 'group'
      || this.drag.kind === 'group-resize' || this.drag.kind === 'group-rotate') this.setTransformOverlaysHidden(true);
    if (this.drag.kind === 'box' || this.drag.kind === 'lasso') {
      const local = this.local(event);
      const width = this.options.element.clientWidth; const height = this.options.element.clientHeight;
      const deltaX = local.x < 24 ? 12 : local.x > width - 24 ? -12 : 0;
      const deltaY = local.y < 24 ? 12 : local.y > height - 24 ? -12 : 0;
      if (deltaX || deltaY) { this.options.camera.panBy(deltaX, deltaY); this.options.cameraChanged(false); }
    }
    const scene = this.options.scene();
    if (!scene) return;
    const world = this.options.camera.screenToWorld(this.local(event));
    if (this.drag.kind === 'move') {
      const dx = world.x - this.drag.start.x;
      const dy = world.y - this.drag.start.y;
      this.pendingChanges = this.drag.originals.map((item) => ({ id: item.id, x: item.x + dx, y: item.y + dy }));
      this.options.preview(this.pendingChanges, false);
    } else if (this.drag.kind === 'box') {
      const box = boxFromPoints(this.drag.start, world);
      const group = collapsedGroupInSelectionBox(scene.groups(), box, this.options.camera.snapshot().scale);
      this.selectedGroupId = group?.id;
      if (group) this.selection.clear();
      else {
        const ids = imagesInSelectionBox(scene.images(), box);
        this.selection.replace([...this.drag.additive, ...ids]);
      }
      this.options.drawOverlay(scene.images().filter((item) => this.selection.has(item.id)), this.options.camera.snapshot().scale, box);
    } else if (this.drag.kind === 'lasso') {
      this.appendLassoPoint(this.drag.points, world);
      this.lassoPoints = [...this.drag.points];
      const box = lassoBounds(this.lassoPoints);
      const ids = imagesInSelectionBox(scene.images(), box);
      this.selectedGroupId = undefined;
      this.selection.replace([...this.drag.additive, ...ids]);
      this.options.drawOverlay(scene.images().filter((item) => this.selection.has(item.id)), this.options.camera.snapshot().scale,
        undefined, this.lassoPoints);
    } else if (this.drag.kind === 'transform') {
      this.pendingChanges = transformImageSelection({ ...this.drag, current: world });
      this.options.preview(this.pendingChanges);
    } else if (this.drag.kind === 'group-rotate') {
      this.pendingChanges = transformImageSelection({ ...this.drag, current: world, handle: 'rotate' });
      this.options.preview(this.pendingChanges);
    } else if (this.drag.kind === 'group') {
      this.options.previewGroup(this.drag.id, world.x - this.drag.last.x, world.y - this.drag.last.y);
      this.drag.last = world;
    } else if (this.drag.kind === 'group-resize') {
      this.drag.bounds = resizeGroupFrameByDelta(this.drag.original, this.drag.handle, {
        x: world.x - this.drag.start.x,
        y: world.y - this.drag.start.y,
      });
      this.options.previewGroupResize(this.drag.id, this.drag.bounds);
    }
  }

  private pointerUp(event: PointerEvent) {
    if (!this.drag || !this.pointer.end(event)) return;
    this.setTransformOverlaysHidden(false);
    if (this.options.element.hasPointerCapture(event.pointerId)) this.options.element.releasePointerCapture(event.pointerId);
    if (this.drag.kind === 'box' || this.drag.kind === 'lasso') this.options.cameraChanged(true);
    if (this.drag.kind === 'box') {
      this.options.selectionChanged(this.selection.values());
      this.options.groupSelectionChanged(this.selectedGroupId);
    }
    if (this.drag.kind === 'lasso') {
      const lasso = isUsableLasso(this.drag.points) ? [...this.drag.points] : undefined;
      this.lassoPoints = lasso ?? [];
      this.options.selectionChanged(this.selection.values(), 'lasso');
      this.options.groupSelectionChanged(undefined);
      this.options.lassoSelectionChanged(lasso);
    }
    if (this.pendingChanges.length) this.options.commit(this.pendingChanges, this.drag.kind !== 'move');
    if (this.drag.kind === 'group') this.options.commitGroup(this.drag.id, this.drag.last.x - this.drag.start.x, this.drag.last.y - this.drag.start.y);
    if (this.drag.kind === 'group-resize') this.options.commitGroupResize(this.drag.id, this.drag.bounds);
    this.pendingChanges = [];
    this.drag = undefined;
    this.options.element.style.cursor = this.boxSelectHeld && !this.options.documentInteractionBlocked() ? 'crosshair' : '';
    this.refresh();
  }

  private emitSelection() { this.options.selectionChanged(this.selection.values()); this.refresh(); }

  clearLasso() {
    if (!this.lassoPoints.length) return;
    this.lassoPoints = [];
    this.options.lassoSelectionChanged();
  }

  private appendLassoPoint(points: LassoPoint[], point: LassoPoint) {
    const previous = points.at(-1);
    const minimumDistance = 2 / Math.max(this.options.camera.snapshot().scale, 0.0001);
    if (!previous || Math.hypot(point.x - previous.x, point.y - previous.y) >= minimumDistance) points.push(point);
  }

  private tryStartExternalDrag(event: PointerEvent) {
    if (this.drag?.kind !== 'move' || (event.buttons & 1) !== 1) return false;
    const bounds = this.options.element.getBoundingClientRect();
    const outside = event.clientX <= bounds.left + 1 || event.clientX >= bounds.right - 1
      || event.clientY <= bounds.top + 1 || event.clientY >= bounds.bottom - 1;
    if (!outside) return false;
    const start = this.options.externalDrag(this.drag.originals);
    if (!start) return false;
    if (this.pendingChanges.length) {
      this.options.preview(this.drag.originals.map((item) => ({ id: item.id, x: item.x, y: item.y })), false);
    }
    if (this.options.element.hasPointerCapture(event.pointerId)) this.options.element.releasePointerCapture(event.pointerId);
    this.pointer.cancel();
    this.setTransformOverlaysHidden(false);
    this.pendingChanges = [];
    this.drag = undefined;
    this.options.element.style.cursor = '';
    this.refresh();
    queueMicrotask(start);
    return true;
  }

  private beginPointer(event: PointerEvent) {
    this.pointer.begin(event);
    try { this.options.element.setPointerCapture(event.pointerId); } catch { /* Synthetic benchmark events have no native capture target. */ }
  }

  private setTransformOverlaysHidden(hidden: boolean) {
    if (this.overlaysHidden === hidden) return;
    this.overlaysHidden = hidden;
    this.options.transformOverlaysHidden(hidden);
  }
}

function lassoBounds(points: LassoPoint[]) {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(1, Math.max(...xs) - x), height: Math.max(1, Math.max(...ys) - y) };
}

function isUsableLasso(points: LassoPoint[]) {
  if (points.length < 3) return false;
  const bounds = lassoBounds(points);
  return bounds.width > 1 && bounds.height > 1;
}

function rotationCursorAtPoint(point: LassoPoint, bounds: GroupFrameBounds) {
  const vertical = point.y < bounds.y + bounds.height / 2 ? 'north' : 'south';
  const horizontal = point.x < bounds.x + bounds.width / 2 ? 'west' : 'east';
  return ROTATE_CURSORS[`${vertical}-${horizontal}` as keyof typeof ROTATE_CURSORS];
}

function imagesInGroup(groups: ImageGroup[], images: ImageItem[], rootId: string) {
  const imageById = new Map(images.map((item) => [item.id, item]));
  const groupById = new Map(groups.map((group) => [group.id, group]));
  const imageIds = new Set<string>();
  const visited = new Set<string>();
  const collect = (groupId: string) => {
    if (visited.has(groupId)) return;
    visited.add(groupId);
    groupById.get(groupId)?.members.forEach((member) => {
      if (member.type === 'image') imageIds.add(member.id);
      else if (member.type === 'group') collect(member.id);
    });
  };
  collect(rootId);
  return [...imageIds].flatMap((id) => {
    const item = imageById.get(id);
    return item ? [{ ...item }] : [];
  });
}
