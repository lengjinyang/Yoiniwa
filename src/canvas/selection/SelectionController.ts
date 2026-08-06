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

type ImageChange = Partial<ImageItem> & { id: string };
type Drag =
  | { kind: 'move'; start: { x: number; y: number }; originals: ImageItem[] }
  | { kind: 'box'; start: { x: number; y: number }; additive: string[] }
  | { kind: 'transform'; start: { x: number; y: number }; originals: ImageItem[]; bounds: NonNullable<ReturnType<typeof unionImageBounds>>; handle: TransformHandle }
  | { kind: 'group'; start: { x: number; y: number }; last: { x: number; y: number }; id: string }
  | { kind: 'group-resize'; start: { x: number; y: number }; id: string; original: ImageGroup; handle: GroupResizeHandle; bounds: GroupFrameBounds };

interface SelectionControllerOptions {
  element: HTMLElement;
  input: InputRouter;
  camera: Camera;
  lifecycle: RuntimeLifecycle;
  scene: () => SceneStore | undefined;
  preview(changes: ImageChange[]): void;
  commit(changes: ImageChange[]): void;
  selectionChanged(ids: string[]): void;
  groupSelectionChanged(id?: string): void;
  previewGroup(id: string, deltaX: number, deltaY: number): void;
  commitGroup(id: string, deltaX: number, deltaY: number): void;
  previewGroupResize(id: string, bounds: GroupFrameBounds): void;
  commitGroupResize(id: string, bounds: GroupFrameBounds): void;
  openGroupMenu(id: string, position: { x: number; y: number }): void;
  expandGroup(id: string): void;
  groupHeaderHoverChanged(id?: string, action?: ReturnType<typeof groupHeaderActionAtPoint>): void;
  drawOverlay(items: ImageItem[], scale: number, box?: { x: number; y: number; width: number; height: number }): void;
  hitHandle(point: { x: number; y: number }): TransformHandle | undefined;
  hitGroupHandle(point: { x: number; y: number }): GroupResizeHandle | undefined;
  interactionBlocked(): boolean;
  cameraChanged(committed: boolean): void;
}

export class SelectionController {
  private readonly selection = new SceneSelection();
  private readonly pointer = new PointerState();
  private drag?: Drag;
  private pendingChanges: ImageChange[] = [];
  private selectedGroupId?: string;

  constructor(private readonly options: SelectionControllerOptions) {}

  start() {
    const down = (event: PointerEvent) => this.pointerDown(event);
    const move = (event: PointerEvent) => this.pointerMove(event);
    const up = (event: PointerEvent) => this.pointerUp(event);
    const disposers = [
      this.options.input.onPointerDown(down), this.options.input.onPointerMove(move), this.options.input.onPointerUp(up),
    ];
    const leave = () => {
      this.options.groupHeaderHoverChanged();
      this.options.element.style.cursor = '';
    };
    this.options.element.addEventListener('pointerleave', leave);
    this.options.lifecycle.add(() => {
      disposers.forEach((dispose) => dispose());
      this.options.element.removeEventListener('pointerleave', leave);
      this.options.element.style.cursor = '';
    });
    this.refresh();
  }

  setSelection(ids: string[]) { this.selection.replace(ids); this.refresh(); }
  setGroupSelection(id?: string) { this.selectedGroupId = id; }
  refresh() {
    const scene = this.options.scene();
    if (!scene) return;
    this.options.drawOverlay(scene.images().filter((item) => this.selection.has(item.id)), this.options.camera.snapshot().scale);
  }

  private local(event: PointerEvent) {
    const bounds = this.options.element.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }

  private pointerDown(event: PointerEvent) {
    if (event.button !== 0 || event.altKey || this.options.interactionBlocked()) return;
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
    if (groupHandle && selectedGroup && !selectedGroup.collapsed && !selectedGroup.sizeLocked) {
      this.beginPointer(event);
      this.drag = { kind: 'group-resize', start: world, id: selectedGroup.id, original: { ...selectedGroup }, handle: groupHandle,
        bounds: { x: selectedGroup.x, y: selectedGroup.y, width: selectedGroup.width, height: selectedGroup.height } };
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
      return;
    }
    // The title bar is the group's interaction surface. It must win over
    // images beneath it so selecting and dragging the group is predictable.
    if (headerGroup) {
      this.selection.clear();
      this.selectedGroupId = headerGroup.id;
      this.options.selectionChanged([]); this.options.groupSelectionChanged(headerGroup.id);
      this.drag = { kind: 'group', start: world, last: world, id: headerGroup.id };
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
      const scene = this.options.scene();
      const scale = this.options.camera.snapshot().scale;
      const world = this.options.camera.screenToWorld(this.local(event));
      const groupHandle = this.options.hitGroupHandle(world);
      if (groupHandle) {
        this.options.groupHeaderHoverChanged();
        this.options.element.style.cursor = groupHandle === 'north' || groupHandle === 'south' ? 'ns-resize'
          : groupHandle === 'west' || groupHandle === 'east' ? 'ew-resize'
            : groupHandle === 'north-west' || groupHandle === 'south-east' ? 'nwse-resize' : 'nesw-resize';
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
    if (this.drag.kind === 'box') {
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
      this.options.preview(this.pendingChanges);
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
    } else if (this.drag.kind === 'transform') {
      this.pendingChanges = transformImageSelection({ ...this.drag, current: world });
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
    if (this.options.element.hasPointerCapture(event.pointerId)) this.options.element.releasePointerCapture(event.pointerId);
    if (this.drag.kind === 'box') this.options.cameraChanged(true);
    if (this.drag.kind === 'box') {
      this.options.selectionChanged(this.selection.values());
      this.options.groupSelectionChanged(this.selectedGroupId);
    }
    if (this.pendingChanges.length) this.options.commit(this.pendingChanges);
    if (this.drag.kind === 'group') this.options.commitGroup(this.drag.id, this.drag.last.x - this.drag.start.x, this.drag.last.y - this.drag.start.y);
    if (this.drag.kind === 'group-resize') this.options.commitGroupResize(this.drag.id, this.drag.bounds);
    this.pendingChanges = [];
    this.drag = undefined;
    this.options.element.style.cursor = '';
    this.refresh();
  }

  private emitSelection() { this.options.selectionChanged(this.selection.values()); this.refresh(); }

  private beginPointer(event: PointerEvent) {
    this.pointer.begin(event);
    try { this.options.element.setPointerCapture(event.pointerId); } catch { /* Synthetic benchmark events have no native capture target. */ }
  }
}
