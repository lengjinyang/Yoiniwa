import type { RuntimeLifecycle } from '../runtime/RuntimeLifecycle';

type PointerHandler = (event: PointerEvent) => void;
type WheelHandler = (event: WheelEvent) => void;

export class InputRouter {
  private readonly down = new Set<PointerHandler>();
  private readonly move = new Set<PointerHandler>();
  private readonly up = new Set<PointerHandler>();
  private readonly wheel = new Set<WheelHandler>();

  constructor(element: HTMLElement, lifecycle: RuntimeLifecycle) {
    const pointerDown = (event: PointerEvent) => this.down.forEach((handler) => handler(event));
    const pointerMove = (event: PointerEvent) => this.move.forEach((handler) => handler(event));
    const pointerUp = (event: PointerEvent) => this.up.forEach((handler) => handler(event));
    const mouseWheel = (event: WheelEvent) => {
      event.preventDefault();
      this.wheel.forEach((handler) => handler(event));
    };
    element.addEventListener('pointerdown', pointerDown);
    element.addEventListener('pointermove', pointerMove);
    element.addEventListener('pointerup', pointerUp);
    element.addEventListener('pointercancel', pointerUp);
    element.addEventListener('wheel', mouseWheel, { passive: false });
    lifecycle.add(() => {
      element.removeEventListener('pointerdown', pointerDown);
      element.removeEventListener('pointermove', pointerMove);
      element.removeEventListener('pointerup', pointerUp);
      element.removeEventListener('pointercancel', pointerUp);
      element.removeEventListener('wheel', mouseWheel);
    });
  }

  onPointerDown(handler: PointerHandler) { this.down.add(handler); return () => this.down.delete(handler); }
  onPointerMove(handler: PointerHandler) { this.move.add(handler); return () => this.move.delete(handler); }
  onPointerUp(handler: PointerHandler) { this.up.add(handler); return () => this.up.delete(handler); }
  onWheel(handler: WheelHandler) { this.wheel.add(handler); return () => this.wheel.delete(handler); }
}
