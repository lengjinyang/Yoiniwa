import { Camera } from './Camera';
import { CAMERA_ZOOM_STEP } from '../runtime/CanvasConfig';
import type { RuntimeLifecycle } from '../runtime/RuntimeLifecycle';
import type { InputRouter } from '../interaction/InputRouter';

export class CameraController {
  private pointerId?: number;
  private panMode?: 'middle' | 'alt' | 'space' | 'pending-space';
  private last = { x: 0, y: 0 };
  private wheelCommitTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly element: HTMLElement,
    private readonly input: InputRouter,
    private readonly camera: Camera,
    private readonly lifecycle: RuntimeLifecycle,
    private readonly changed: (committed: boolean) => void,
    private readonly interactionBlocked: (event: PointerEvent) => boolean = () => false,
    private readonly spacePanEnabled: (event: PointerEvent) => Promise<boolean> | boolean | undefined = () => undefined,
  ) {}

  start() {
    const down = (event: PointerEvent) => {
      const primaryButton = event.button === 0
        || (event.pointerType === 'pen' && event.button === -1 && (event.buttons & 1) !== 0);
      const spaceQuery = primaryButton && !event.altKey ? this.spacePanEnabled(event) : undefined;
      if (spaceQuery !== undefined) {
        event.preventDefault();
        this.pointerId = event.pointerId;
        this.panMode = 'pending-space';
        this.last = { x: event.clientX, y: event.clientY };
        try { this.element.setPointerCapture(event.pointerId); } catch { /* Synthetic benchmark events have no native capture target. */ }
        void Promise.resolve(spaceQuery).then((enabled) => {
          if (this.pointerId !== event.pointerId || this.panMode !== 'pending-space') return;
          if (enabled) this.panMode = 'space';
          else this.release(event.pointerId, false);
        });
        return;
      }
      const altPan = event.button === 0 && event.altKey;
      if (event.button !== 1 && !altPan) return;
      if (event.button === 0 && this.interactionBlocked(event)) return;
      this.panMode = event.button === 1 ? 'middle' : 'alt';
      this.pointerId = event.pointerId;
      this.last = { x: event.clientX, y: event.clientY };
      try { this.element.setPointerCapture(event.pointerId); } catch { /* Synthetic benchmark events have no native capture target. */ }
    };
    const move = (event: PointerEvent) => {
      if (event.pointerId !== this.pointerId) return;
      if (this.panMode === 'pending-space') {
        this.last = { x: event.clientX, y: event.clientY };
        return;
      }
      this.camera.panBy(event.clientX - this.last.x, event.clientY - this.last.y);
      this.last = { x: event.clientX, y: event.clientY };
      this.changed(false);
    };
    const up = (event: PointerEvent) => {
      if (event.pointerId !== this.pointerId) return;
      this.release(event.pointerId, this.panMode !== 'pending-space');
    };
    const cancel = (event: PointerEvent) => {
      if (event.pointerId !== this.pointerId) return;
      this.release(event.pointerId, this.panMode !== 'pending-space');
    };
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const bounds = this.element.getBoundingClientRect();
      this.camera.zoomAt({ x: event.clientX - bounds.left, y: event.clientY - bounds.top }, event.deltaY < 0 ? CAMERA_ZOOM_STEP : 1 / CAMERA_ZOOM_STEP);
      this.changed(false);
      if (this.wheelCommitTimer !== undefined) clearTimeout(this.wheelCommitTimer);
      this.wheelCommitTimer = setTimeout(() => {
        this.wheelCommitTimer = undefined;
        this.changed(true);
      }, 120);
    };
    const disposers = [
      this.input.onPointerDown(down), this.input.onPointerMove(move),
      this.input.onPointerUp(up), this.input.onPointerCancel(cancel), this.input.onWheel(wheel),
    ];
    this.lifecycle.add(() => {
      if (this.wheelCommitTimer !== undefined) clearTimeout(this.wheelCommitTimer);
      this.wheelCommitTimer = undefined;
      if (this.pointerId !== undefined) this.release(this.pointerId, false);
      disposers.forEach((dispose) => dispose());
    });
  }

  private release(pointerId: number, commit: boolean) {
    this.pointerId = undefined;
    this.panMode = undefined;
    if (this.element.hasPointerCapture?.(pointerId)) this.element.releasePointerCapture(pointerId);
    if (commit) this.changed(true);
  }
}
