import type { Scene } from '../../types';

/** Runtime scene transforms. Production undo lives in React `useSceneHistory`, not a CommandStack. */
export interface CanvasCommand {
  readonly label: string;
  execute(scene: Scene): Scene;
}
