import { Graphics, type Container } from 'pixi.js';
import type { AnnotationItem, AnnotationTool } from '../../types';
import type { Camera } from '../camera/Camera';
import type { InputRouter } from './InputRouter';
import type { RuntimeLifecycle } from '../runtime/RuntimeLifecycle';

export interface AnnotationToolState { enabled: boolean; tool: AnnotationTool; color: string; width: number }

export class AnnotationToolController {
  private readonly preview = new Graphics();
  private pointerId?: number;
  private points: number[] = [];

  constructor(private readonly options: {
    element: HTMLElement; input: InputRouter; camera: Camera; lifecycle: RuntimeLifecycle; layer: Container;
    state(): AnnotationToolState; add(annotation: AnnotationItem): void;
    eraseStart(): void; eraseAt(x: number, y: number, radius: number): void; eraseEnd(): void;
    requestRender(): void;
  }) { options.layer.addChild(this.preview); }

  start() {
    const down = (event: PointerEvent) => {
      const state = this.options.state();
      if (!state.enabled || event.button !== 0) return;
      this.pointerId = event.pointerId;
      const point = this.world(event);
      this.points = [point.x, point.y];
      this.options.element.setPointerCapture(event.pointerId);
      if (state.tool === 'eraser') { this.options.eraseStart(); this.options.eraseAt(point.x, point.y, state.width * 3); }
      this.drawPreview();
    };
    const move = (event: PointerEvent) => {
      if (event.pointerId !== this.pointerId) return;
      const point = this.world(event);
      const state = this.options.state();
      if (state.tool === 'pen') this.points.push(point.x, point.y);
      else this.points.splice(2, 2, point.x, point.y);
      if (state.tool === 'eraser') this.options.eraseAt(point.x, point.y, state.width * 3);
      this.drawPreview();
    };
    const up = (event: PointerEvent) => {
      if (event.pointerId !== this.pointerId) return;
      const state = this.options.state();
      if (state.tool === 'eraser') this.options.eraseEnd();
      else {
        const annotation = this.createAnnotation(state);
        if (annotation) this.options.add(annotation);
      }
      this.pointerId = undefined;
      this.points = [];
      this.preview.clear();
      this.options.requestRender();
      if (this.options.element.hasPointerCapture(event.pointerId)) this.options.element.releasePointerCapture(event.pointerId);
    };
    const disposers = [this.options.input.onPointerDown(down), this.options.input.onPointerMove(move), this.options.input.onPointerUp(up)];
    this.options.lifecycle.add(() => { disposers.forEach((dispose) => dispose()); this.preview.destroy(); });
  }

  private world(event: PointerEvent) {
    const bounds = this.options.element.getBoundingClientRect();
    return this.options.camera.screenToWorld({ x: event.clientX - bounds.left, y: event.clientY - bounds.top });
  }

  private createAnnotation(state: AnnotationToolState): AnnotationItem | undefined {
    if (this.points.length < 4) return undefined;
    if (state.tool === 'eraser') return undefined;
    if (state.tool === 'pen' || state.tool === 'arrow') return {
      id: crypto.randomUUID(), type: state.tool, color: state.color, strokeWidth: state.width, points: [...this.points],
    };
    const [x1, y1, x2, y2] = this.points;
    return { id: crypto.randomUUID(), type: state.tool, color: state.color, strokeWidth: state.width,
      x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
  }

  private drawPreview() {
    const state = this.options.state();
    this.preview.clear();
    if (state.tool === 'eraser' || this.points.length < 4) { this.options.requestRender(); return; }
    const style = { color: state.color, width: state.width };
    if (state.tool === 'pen' || state.tool === 'arrow') {
      this.preview.moveTo(this.points[0], this.points[1]);
      for (let index = 2; index < this.points.length; index += 2) this.preview.lineTo(this.points[index], this.points[index + 1]);
      this.preview.stroke(style);
    } else {
      const [x1, y1, x2, y2] = this.points; const x = Math.min(x1, x2); const y = Math.min(y1, y2);
      const width = Math.abs(x2 - x1); const height = Math.abs(y2 - y1);
      if (state.tool === 'rectangle') this.preview.rect(x, y, width, height).stroke(style);
      else this.preview.ellipse(x + width / 2, y + height / 2, width / 2, height / 2).stroke(style);
    }
    this.options.requestRender();
  }
}
