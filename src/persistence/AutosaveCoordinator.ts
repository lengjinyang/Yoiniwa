import type { Scene } from '../types';
import { serializeProjectScene } from './ProjectSerializer';

const DEFAULT_AUTOSAVE_DELAY_MS = 10 * 1000;

export class AutosaveCoordinator {
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  constructor(private readonly save: (scene: Scene, revision: number) => Promise<void>, private readonly delayMs = DEFAULT_AUTOSAVE_DELAY_MS) {}
  schedule(scene: Scene, revision: number) {
    this.cancelTimer();
    const generation = ++this.generation;
    const snapshot = serializeProjectScene(scene);
    this.timer = globalThis.setTimeout(() => {
      this.timer = undefined;
      if (generation === this.generation) void this.save(snapshot, revision).catch(() => undefined);
    }, this.delayMs);
  }
  cancel() { this.generation += 1; this.cancelTimer(); }
  destroy() { this.cancel(); }
  private cancelTimer() { if (this.timer !== undefined) globalThis.clearTimeout(this.timer); this.timer = undefined; }
}
