import type { ImageItem } from '../../types';
import type { Camera } from '../camera/Camera';
import type { InputRouter } from '../interaction/InputRouter';
import { PointerState } from '../interaction/PointerState';
import type { SceneStore } from '../scene/SceneStore';
import type { RuntimeLifecycle } from '../runtime/RuntimeLifecycle';
import { topmostImageAtPoint, unionImageBounds } from './HitTestService';
import { SceneSelection } from './SceneSelection';
import type { TransformHandle } from './SelectionOverlay';
import { boxFromPoints, imagesInSelectionBox } from './BoxSelectionController';
import { transformImageSelection } from './TransformController';

type ImageChange = Partial<ImageItem> & { id: string };
type Drag =
  | { kind: 'move'; start: { x: number; y: number }; originals: ImageItem[] }
  | { kind: 'box'; start: { x: number; y: number }; additive: string[] }
  | { kind: 'transform'; start: { x: number; y: number }; originals: ImageItem[]; bounds: NonNullable<ReturnType<typeof unionImageBounds>>; handle: TransformHandle };

interface SelectionControllerOptions {
  element: HTMLElement;
  input: InputRouter;
  camera: Camera;
  lifecycle: RuntimeLifecycle;
  scene: () => SceneStore | undefined;
  preview(changes: ImageChange[]): void;
  commit(changes: ImageChange[]): void;
  selectionChanged(ids: string[]): void;
  drawOverlay(items: ImageItem[], scale: number, box?: { x: number; y: number; width: number; height: number }): void;
  hitHandle(point: { x: number; y: number }): TransformHandle | undefined;
}

export class SelectionController {
  private readonly selection = new SceneSelection();
  private readonly pointer = new PointerState();
  private drag?: Drag;
  private pendingChanges: ImageChange[] = [];

  constructor(private readonly options: SelectionControllerOptions) {}

  start() {
    const down = (event: PointerEvent) => this.pointerDown(event);
    const move = (event: PointerEvent) => this.pointerMove(event);
    const up = (event: PointerEvent) => this.pointerUp(event);
    const disposers = [
      this.options.input.onPointerDown(down), this.options.input.onPointerMove(move), this.options.input.onPointerUp(up),
    ];
    this.options.lifecycle.add(() => disposers.forEach((dispose) => dispose()));
    this.refresh();
  }

  setSelection(ids: string[]) { this.selection.replace(ids); this.refresh(); }
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
    if (event.button !== 0 || event.altKey) return;
    const scene = this.options.scene();
    if (!scene) return;
    const world = this.options.camera.screenToWorld(this.local(event));
    const handle = this.options.hitHandle(world);
    const selected = scene.images().filter((item) => this.selection.has(item.id) && !item.locked);
    const selectionBounds = unionImageBounds(selected);
    this.pointer.begin(event);
    this.options.element.setPointerCapture(event.pointerId);
    if (handle && selected.length && selectionBounds) {
      this.drag = { kind: 'transform', start: world, originals: selected.map((item) => ({ ...item })), bounds: selectionBounds, handle };
      return;
    }
    const hit = topmostImageAtPoint(scene.images(), world);
    if (hit) {
      if (event.shiftKey || event.ctrlKey || event.metaKey) this.selection.toggle(hit.id);
      else if (!this.selection.has(hit.id)) this.selection.replace([hit.id]);
      this.emitSelection();
      const movable = scene.images().filter((item) => this.selection.has(item.id) && !item.locked);
      this.drag = { kind: 'move', start: world, originals: movable.map((item) => ({ ...item })) };
    } else {
      const additive = event.shiftKey || event.ctrlKey || event.metaKey ? this.selection.values() : [];
      if (!additive.length) { this.selection.clear(); this.emitSelection(); }
      this.drag = { kind: 'box', start: world, additive };
    }
  }

  private pointerMove(event: PointerEvent) {
    if (!this.drag || !this.pointer.update(event)) return;
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
      const ids = imagesInSelectionBox(scene.images(), box);
      this.selection.replace([...this.drag.additive, ...ids]);
      this.options.selectionChanged(this.selection.values());
      this.options.drawOverlay(scene.images().filter((item) => this.selection.has(item.id)), this.options.camera.snapshot().scale, box);
    } else {
      this.pendingChanges = transformImageSelection({ ...this.drag, current: world });
      this.options.preview(this.pendingChanges);
    }
  }

  private pointerUp(event: PointerEvent) {
    if (!this.drag || !this.pointer.end(event)) return;
    if (this.options.element.hasPointerCapture(event.pointerId)) this.options.element.releasePointerCapture(event.pointerId);
    if (this.pendingChanges.length) this.options.commit(this.pendingChanges);
    this.pendingChanges = [];
    this.drag = undefined;
    this.refresh();
  }

  private emitSelection() { this.options.selectionChanged(this.selection.values()); this.refresh(); }
}
