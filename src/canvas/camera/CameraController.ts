import { Camera } from './Camera';
import { CAMERA_ZOOM_STEP } from '../runtime/CanvasConfig';
import type { RuntimeLifecycle } from '../runtime/RuntimeLifecycle';

export class CameraController {
  private pointerId?: number;
  private last = { x: 0, y: 0 };

  constructor(
    private readonly element: HTMLElement,
    private readonly camera: Camera,
    private readonly lifecycle: RuntimeLifecycle,
    private readonly changed: (committed: boolean) => void,
  ) {}

  start() {
    const down = (event: PointerEvent) => {
      if (event.button !== 0 && event.button !== 1) return;
      this.pointerId = event.pointerId;
      this.last = { x: event.clientX, y: event.clientY };
      this.element.setPointerCapture(event.pointerId);
    };
    const move = (event: PointerEvent) => {
      if (event.pointerId !== this.pointerId) return;
      this.camera.panBy(event.clientX - this.last.x, event.clientY - this.last.y);
      this.last = { x: event.clientX, y: event.clientY };
      this.changed(false);
    };
    const up = (event: PointerEvent) => {
      if (event.pointerId !== this.pointerId) return;
      this.pointerId = undefined;
      this.element.releasePointerCapture(event.pointerId);
      this.changed(true);
    };
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const bounds = this.element.getBoundingClientRect();
      this.camera.zoomAt({ x: event.clientX - bounds.left, y: event.clientY - bounds.top }, event.deltaY < 0 ? CAMERA_ZOOM_STEP : 1 / CAMERA_ZOOM_STEP);
      this.changed(true);
    };
    this.element.addEventListener('pointerdown', down);
    this.element.addEventListener('pointermove', move);
    this.element.addEventListener('pointerup', up);
    this.element.addEventListener('pointercancel', up);
    this.element.addEventListener('wheel', wheel, { passive: false });
    this.lifecycle.add(() => {
      this.element.removeEventListener('pointerdown', down);
      this.element.removeEventListener('pointermove', move);
      this.element.removeEventListener('pointerup', up);
      this.element.removeEventListener('pointercancel', up);
      this.element.removeEventListener('wheel', wheel);
    });
  }
}
