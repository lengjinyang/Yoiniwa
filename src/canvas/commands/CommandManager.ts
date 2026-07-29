import type { ImageItem, Scene } from '../../types';
import { CommandStack } from './CommandStack';
import { ImageTransformCommand } from './ImageTransformCommand';

export class CommandManager {
  private scene?: Scene;
  readonly stack = new CommandStack();

  sync(scene: Scene) { this.scene = scene; }
  reset(scene?: Scene) { this.scene = scene; this.stack.clear(); }

  commitImageChanges(changes: Array<Partial<ImageItem> & { id: string }>) {
    if (!this.scene) return undefined;
    this.scene = this.stack.execute(new ImageTransformCommand(this.scene, changes), this.scene);
    return this.scene;
  }
}
