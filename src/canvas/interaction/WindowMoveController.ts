import type { InputRouter } from './InputRouter';
import type { RuntimeLifecycle } from '../runtime/RuntimeLifecycle';

export class WindowMoveController {
  private pointerId?: number;
  private start = { x: 0, y: 0 };
  private moved = false;
  constructor(private readonly options: {
    input: InputRouter; lifecycle: RuntimeLifecycle; locked(): boolean;
    begin(): void; move(): void; end(): void;
  }) {}
  startListening() {
    const down = (event: PointerEvent) => {
      if (event.button !== 2 || this.options.locked()) return;
      this.pointerId = event.pointerId; this.start = { x: event.screenX, y: event.screenY }; this.moved = false;
      this.options.begin();
    };
    const move = (event: PointerEvent) => {
      if (event.pointerId !== this.pointerId) return;
      if (!this.moved && Math.hypot(event.screenX - this.start.x, event.screenY - this.start.y) >= 4) this.moved = true;
      if (this.moved) this.options.move();
    };
    const up = (event: PointerEvent) => {
      if (event.pointerId !== this.pointerId) return;
      const moved = this.moved;
      this.pointerId = undefined;
      if (moved) {
        this.options.input.suppressNextContextMenu();
      }
      // Every matching release must close the native/fallback move path,
      // including a stationary right-click that should still open its menu.
      this.options.end();
    };
    const disposers = [this.options.input.onPointerDown(down), this.options.input.onPointerMove(move), this.options.input.onPointerUp(up)];
    this.options.lifecycle.add(() => disposers.forEach((dispose) => dispose()));
  }
}
