import type { RuntimeLifecycle } from '../runtime/RuntimeLifecycle';
import { performanceMonitor } from '../../performanceMonitor';

type PointerHandler = (event: PointerEvent) => void;
type WheelHandler = (event: WheelEvent) => void;
type MouseHandler = (event: MouseEvent) => void;

export class InputRouter {
  private readonly down = new Set<PointerHandler>();
  private readonly move = new Set<PointerHandler>();
  private readonly up = new Set<PointerHandler>();
  private readonly cancel = new Set<PointerHandler>();
  private readonly wheel = new Set<WheelHandler>();
  private readonly context = new Set<MouseHandler>();
  private readonly doubleClick = new Set<MouseHandler>();
  private suppressContextMenu = false;

  constructor(element: HTMLElement, lifecycle: RuntimeLifecycle) {
    const pointerDown = (event: PointerEvent) => this.down.forEach((handler) => handler(event));
    const pointerMove = (event: PointerEvent) => {
      performanceMonitor.markPointerMove();
      this.move.forEach((handler) => handler(event));
    };
    const pointerUp = (event: PointerEvent) => this.up.forEach((handler) => handler(event));
    const pointerCancel = (event: PointerEvent) => this.cancel.forEach((handler) => handler(event));
    const mouseWheel = (event: WheelEvent) => {
      event.preventDefault();
      this.wheel.forEach((handler) => handler(event));
    };
    const contextMenu = (event: MouseEvent) => {
      event.preventDefault();
      if (this.suppressContextMenu) {
        this.suppressContextMenu = false;
        return;
      }
      this.context.forEach((handler) => handler(event));
    };
    const doubleClick = (event: MouseEvent) => this.doubleClick.forEach((handler) => handler(event));
    element.addEventListener('pointerdown', pointerDown);
    element.addEventListener('pointermove', pointerMove);
    element.addEventListener('pointerup', pointerUp);
    element.addEventListener('pointercancel', pointerCancel);
    element.addEventListener('wheel', mouseWheel, { passive: false });
    element.addEventListener('contextmenu', contextMenu);
    element.addEventListener('dblclick', doubleClick);
    lifecycle.add(() => {
      element.removeEventListener('pointerdown', pointerDown);
      element.removeEventListener('pointermove', pointerMove);
      element.removeEventListener('pointerup', pointerUp);
      element.removeEventListener('pointercancel', pointerCancel);
      element.removeEventListener('wheel', mouseWheel);
      element.removeEventListener('contextmenu', contextMenu);
      element.removeEventListener('dblclick', doubleClick);
    });
  }

  onPointerDown(handler: PointerHandler) { this.down.add(handler); return () => this.down.delete(handler); }
  onPointerMove(handler: PointerHandler) { this.move.add(handler); return () => this.move.delete(handler); }
  onPointerUp(handler: PointerHandler) { this.up.add(handler); return () => this.up.delete(handler); }
  onPointerCancel(handler: PointerHandler) { this.cancel.add(handler); return () => this.cancel.delete(handler); }
  onWheel(handler: WheelHandler) { this.wheel.add(handler); return () => this.wheel.delete(handler); }
  onContextMenu(handler: MouseHandler) { this.context.add(handler); return () => this.context.delete(handler); }
  onDoubleClick(handler: MouseHandler) { this.doubleClick.add(handler); return () => this.doubleClick.delete(handler); }
  suppressNextContextMenu() { this.suppressContextMenu = true; }
  resetContextMenuSuppression() { this.suppressContextMenu = false; }
}
