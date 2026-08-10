import type { Scene } from '../../types';

export interface CanvasCommand {
  readonly label: string;
  execute(scene: Scene): Scene;
  undo(scene: Scene): Scene;
}
