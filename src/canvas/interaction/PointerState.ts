export class PointerState {
  pointerId?: number;
  start = { x: 0, y: 0 };
  current = { x: 0, y: 0 };

  begin(event: PointerEvent) {
    this.pointerId = event.pointerId;
    this.start = { x: event.clientX, y: event.clientY };
    this.current = this.start;
  }
  update(event: PointerEvent) {
    if (event.pointerId !== this.pointerId) return false;
    this.current = { x: event.clientX, y: event.clientY };
    return true;
  }
  end(event: PointerEvent) {
    if (!this.update(event)) return false;
    this.pointerId = undefined;
    return true;
  }
  cancel() { this.pointerId = undefined; }
}
