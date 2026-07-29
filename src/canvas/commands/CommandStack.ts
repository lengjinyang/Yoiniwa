import type { Scene } from '../../types';
import type { CanvasCommand } from './Command';

export class CommandStack {
  private undoCommands: CanvasCommand[] = [];
  private redoCommands: CanvasCommand[] = [];

  execute(command: CanvasCommand, scene: Scene) {
    const next = command.execute(scene);
    this.undoCommands.push(command);
    this.redoCommands = [];
    return next;
  }

  undo(scene: Scene) {
    const command = this.undoCommands.pop();
    if (!command) return scene;
    this.redoCommands.push(command);
    return command.undo(scene);
  }

  redo(scene: Scene) {
    const command = this.redoCommands.pop();
    if (!command) return scene;
    this.undoCommands.push(command);
    return command.execute(scene);
  }

  clear() { this.undoCommands = []; this.redoCommands = []; }
  get undoCount() { return this.undoCommands.length; }
  get redoCount() { return this.redoCommands.length; }
}
