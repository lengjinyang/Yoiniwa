export class FrameScheduler {
  private frame?: number;
  private destroyed = false;

  request(callback: (time: number) => void) {
    if (this.destroyed || this.frame !== undefined) return;
    this.frame = requestAnimationFrame((time) => {
      this.frame = undefined;
      if (!this.destroyed) callback(time);
    });
  }

  destroy() {
    this.destroyed = true;
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = undefined;
  }
}
