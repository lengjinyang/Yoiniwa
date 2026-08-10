import type { Camera } from '../camera/Camera';
import type { InputRouter } from './InputRouter';
import type { RuntimeLifecycle } from '../runtime/RuntimeLifecycle';
import type { SceneStore } from '../scene/SceneStore';
import type { EraserSize, VisualMark, VisualNotesState, VisualNoteTool, VisualNoteWidth } from '../../types';
import { topmostImageAtPoint } from '../selection/HitTestService';
import { markWorldPoints, moveMarkInWorld, pointToAnchor } from '../../visualNotes/VisualNoteGeometry';
import { simplifyBrushPoints, widthFactorForSample, type RawBrushSample } from '../../visualNotes/BrushEngine';
import { eraseArrow, eraseStroke } from '../../visualNotes/EraserEngine';

export interface VisualNotesToolState {
  enabled: boolean;
  tool: VisualNoteTool;
  color: string;
  opacity: number;
  width: VisualNoteWidth;
  pressureEnabled: boolean;
  eraserSize: EraserSize;
  selectedMarkId?: string;
}

interface VisualNotesControllerOptions {
  element: HTMLElement;
  input: InputRouter;
  camera: Camera;
  lifecycle: RuntimeLifecycle;
  scene(): SceneStore | undefined;
  state(): VisualNotesToolState;
  preview(mark?: VisualMark): void;
  previewErase(notes: VisualNotesState): void;
  eraserCursor(point?: { x: number; y: number }, radiusScreen?: number): void;
  commit(next: VisualNotesState): void;
  selectionChanged(id?: string): void;
  interactionBlocked?(event: PointerEvent): boolean;
}

type Gesture =
  | { kind: 'brush'; pointerId: number; anchor: VisualMark['anchor']; worldPoints: Array<{ x: number; y: number; widthFactor: number }>; previous?: RawBrushSample }
  | { kind: 'arrow'; pointerId: number; anchor: VisualMark['anchor']; start: { x: number; y: number }; current: { x: number; y: number } }
  | { kind: 'eraser'; pointerId: number; path: Array<{ x: number; y: number }>; originalNotes: VisualNotesState; previewNotes: VisualNotesState }
  | { kind: 'move'; pointerId: number; mark: VisualMark; start: { x: number; y: number }; current: { x: number; y: number } };

const widths: Record<VisualNoteWidth, number> = { thin: 1.6, medium: 3.2, thick: 6 };
const erasers: Record<EraserSize, number> = { small: 10, medium: 24, large: 48 };

export class VisualNotesController {
  private gesture?: Gesture;

  constructor(private readonly options: VisualNotesControllerOptions) {}

  start() {
    const disposers: Array<() => void> = [
      this.options.input.onPointerDown((event) => this.down(event)),
      this.options.input.onPointerMove((event) => this.move(event)),
      this.options.input.onPointerUp((event) => this.up(event)),
    ];
    const pointerLeave = () => {
      if (!this.gesture) this.options.eraserCursor();
    };
    this.options.element.addEventListener('pointerleave', pointerLeave);
    disposers.push(() => this.options.element.removeEventListener('pointerleave', pointerLeave));
    this.options.lifecycle.add(() => disposers.forEach((dispose) => dispose()));
  }

  cancel() {
    if (this.gesture?.kind === 'eraser') this.options.previewErase(this.gesture.originalNotes);
    this.gesture = undefined; this.options.preview(); this.options.eraserCursor();
  }
  active() { return Boolean(this.gesture); }

  private local(event: PointerEvent) {
    const bounds = this.options.element.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }

  private anchorAt(world: { x: number; y: number }) {
    const image = topmostImageAtPoint(this.options.scene()?.images() ?? [], world);
    return { image, anchor: image ? { type: 'image' as const, imageId: image.id } : { type: 'scene' as const } };
  }

  private style() {
    const state = this.options.state();
    return { color: state.color, opacity: state.opacity, width: state.width, baseWidth: widths[state.width] / this.options.camera.snapshot().scale };
  }

  private down(event: PointerEvent) {
    const state = this.options.state();
    if (!state.enabled || event.button !== 0 || event.altKey || event.ctrlKey || this.options.interactionBlocked?.(event)) return;
    const scene = this.options.scene(); if (!scene) return;
    const local = this.local(event); const world = this.options.camera.screenToWorld(local);
    if (event.shiftKey) {
      const hit = this.hitMark(world);
      this.options.selectionChanged(hit?.id);
      if (hit) {
        try { this.options.element.setPointerCapture(event.pointerId); } catch { /* Synthetic events may not support capture. */ }
        this.gesture = { kind: 'move', pointerId: event.pointerId, mark: structuredClone(hit), start: world, current: world };
      }
      return;
    }
    const { anchor } = this.anchorAt(world);
    try { this.options.element.setPointerCapture(event.pointerId); } catch { /* Synthetic events may not support capture. */ }
    if (state.tool === 'eraser') {
      const originalNotes = structuredClone(scene.snapshot().visualNotes);
      this.gesture = { kind: 'eraser', pointerId: event.pointerId, path: [world], originalNotes,
        previewNotes: structuredClone(originalNotes) };
      this.options.eraserCursor(world, erasers[state.eraserSize]);
      this.previewEraser(this.gesture, [world]);
    }
    else if (state.tool === 'arrow') this.gesture = { kind: 'arrow', pointerId: event.pointerId, anchor, start: world, current: world };
    else {
      const raw = { ...local, pressure: event.pressure, time: event.timeStamp, pointerType: event.pointerType };
      this.gesture = { kind: 'brush', pointerId: event.pointerId, anchor, worldPoints: [{ ...world, widthFactor: widthFactorForSample(raw, undefined, state.pressureEnabled) }], previous: raw };
    }
  }

  private move(event: PointerEvent) {
    const local = this.local(event); const world = this.options.camera.screenToWorld(local);
    const state = this.options.state();
    if (state.enabled && state.tool === 'eraser') this.options.eraserCursor(world, erasers[state.eraserSize]);
    else this.options.eraserCursor();
    if (!this.gesture || event.pointerId !== this.gesture.pointerId) return;
    if (this.gesture.kind === 'eraser') {
      const last = this.gesture.path.at(-1)!;
      if (Math.hypot(world.x - last.x, world.y - last.y) >= 2 / this.options.camera.snapshot().scale) {
        this.gesture.path.push(world);
        this.previewEraser(this.gesture, [last, world]);
      }
      return;
    }
    if (this.gesture.kind === 'move') {
      this.gesture.current = world;
      this.options.preview(moveMarkInWorld(this.gesture.mark, this.options.scene()?.images() ?? [],
        world.x - this.gesture.start.x, world.y - this.gesture.start.y));
      return;
    }
    if (this.gesture.kind === 'arrow') this.gesture.current = world;
    else {
      const last = this.gesture.worldPoints.at(-1)!;
      if (Math.hypot(world.x - last.x, world.y - last.y) < 1.5 / this.options.camera.snapshot().scale) return;
      const raw = { ...local, pressure: event.pressure, time: event.timeStamp, pointerType: event.pointerType };
      const factor = widthFactorForSample(raw, this.gesture.previous, this.options.state().pressureEnabled);
      this.gesture.worldPoints.push({ ...world, widthFactor: last.widthFactor * 0.55 + factor * 0.45 });
      this.gesture.previous = raw;
    }
    this.options.preview(this.gestureMark());
  }

  private up(event: PointerEvent) {
    if (!this.gesture || event.pointerId !== this.gesture.pointerId) return;
    const scene = this.options.scene(); if (!scene) return;
    const gesture = this.gesture; this.gesture = undefined; this.options.preview();
    if (this.options.element.hasPointerCapture(event.pointerId)) this.options.element.releasePointerCapture(event.pointerId);
    const notes = structuredClone(gesture.kind === 'eraser' ? gesture.previewNotes : scene.snapshot().visualNotes);
    if (gesture.kind === 'eraser') {
      if (JSON.stringify(gesture.originalNotes.marks) !== JSON.stringify(notes.marks)) this.options.commit(notes);
      else this.options.previewErase(gesture.originalNotes);
      return;
    }
    if (gesture.kind === 'move') {
      const moved = moveMarkInWorld(gesture.mark, scene.images(),
        gesture.current.x - gesture.start.x, gesture.current.y - gesture.start.y);
      const index = notes.marks.findIndex((mark) => mark.id === moved.id);
      if (index >= 0 && (gesture.current.x !== gesture.start.x || gesture.current.y !== gesture.start.y)) {
        notes.marks[index] = moved; this.options.commit(notes);
      }
      return;
    }
    const mark = this.markFromGesture(gesture);
    if (mark) { notes.marks.push(mark); this.options.commit(notes); }
  }

  private gestureMark() { return this.gesture && this.gesture.kind !== 'eraser' && this.gesture.kind !== 'move'
    ? this.markFromGesture(this.gesture, 'preview') : undefined; }

  private erasedMarks(marks: VisualMark[], path: Array<{ x: number; y: number }>) {
    const scene = this.options.scene();
    if (!scene) return marks;
    const scale = this.options.camera.snapshot().scale;
    const radius = erasers[this.options.state().eraserSize] / scale;
    return marks.flatMap<VisualMark>((mark) => {
      if (mark.kind === 'stroke') return eraseStroke(mark, scene.images(), path, radius, undefined, 0.75 / scale);
      if (mark.kind === 'arrow') return eraseArrow(mark, scene.images(), path, radius, undefined, 0.75 / scale);
      return [mark];
    });
  }

  private previewEraser(gesture: Extract<Gesture, { kind: 'eraser' }>, pathSegment: Array<{ x: number; y: number }>) {
    gesture.previewNotes = { ...gesture.previewNotes,
      marks: this.erasedMarks(gesture.previewNotes.marks, pathSegment) };
    this.options.previewErase(gesture.previewNotes);
  }

  private hitMark(point: { x: number; y: number }) {
    const scene = this.options.scene(); if (!scene) return undefined;
    const tolerance = 8 / this.options.camera.snapshot().scale;
    const segmentDistance = (start: { x: number; y: number }, end: { x: number; y: number }) => {
      const dx = end.x - start.x; const dy = end.y - start.y; const length = dx * dx + dy * dy;
      const t = length ? Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / length)) : 0;
      return Math.hypot(point.x - start.x - dx * t, point.y - start.y - dy * t);
    };
    return [...scene.snapshot().visualNotes.marks].reverse().find((mark) => {
      const points = markWorldPoints(mark, scene.images());
      if (mark.kind === 'number') return Math.hypot(point.x - points[0].x, point.y - points[0].y) <= tolerance * 1.5;
      return points.slice(1).some((end, index) => segmentDistance(points[index], end)
        <= tolerance + mark.style.baseWidth * Math.max(points[index].widthFactor, end.widthFactor) / 2);
    });
  }

  private markFromGesture(gesture: Exclude<Gesture, { kind: 'eraser' | 'move' }>, id: string = crypto.randomUUID()): VisualMark | undefined {
    const images = this.options.scene()?.images() ?? [];
    const style = this.style(); const createdAt = Date.now();
    if (gesture.kind === 'arrow') {
      const start = pointToAnchor(gesture.start, gesture.anchor, images);
      const end = pointToAnchor(gesture.current, gesture.anchor, images);
      if (Math.hypot(gesture.current.x - gesture.start.x, gesture.current.y - gesture.start.y) < 3 / this.options.camera.snapshot().scale) return;
      return { id, kind: 'arrow', anchor: gesture.anchor, start: { ...start, widthFactor: 1 }, end: { ...end, widthFactor: 1 }, style, createdAt };
    }
    const simplified = simplifyBrushPoints(gesture.worldPoints, 0.6 / this.options.camera.snapshot().scale);
    if (simplified.length < 2) return;
    return { id, kind: 'stroke', anchor: gesture.anchor, points: simplified.map((point) => ({
      ...pointToAnchor(point, gesture.anchor, images), widthFactor: point.widthFactor,
    })), style, createdAt };
  }
}
