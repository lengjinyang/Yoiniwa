import { describe, expect, it } from 'vitest';
import type { ImageItem, Scene } from '../../types';
import { CommandStack } from './CommandStack';
import { ImageTransformCommand } from './ImageTransformCommand';

const initial = {
  items: [{ id: 'image', x: 10, y: 20, width: 100, height: 50, crop: {} } as ImageItem],
} as Scene;

describe('CommandStack', () => {
  it('records a completed gesture as one reversible command', () => {
    const stack = new CommandStack();
    const moved = stack.execute(new ImageTransformCommand(initial, [{ id: 'image', x: 80, y: 90 }]), initial);
    expect(moved.items[0]).toMatchObject({ x: 80, y: 90 });
    expect(stack.undoCount).toBe(1);

    const undone = stack.undo(moved);
    expect(undone.items[0]).toMatchObject({ x: 10, y: 20 });
    expect(stack.redo(undone).items[0]).toMatchObject({ x: 80, y: 90 });
  });

  it('clears redo history when a new command is executed', () => {
    const stack = new CommandStack();
    const moved = stack.execute(new ImageTransformCommand(initial, [{ id: 'image', x: 20 }]), initial);
    const undone = stack.undo(moved);
    stack.execute(new ImageTransformCommand(undone, [{ id: 'image', x: 30 }]), undone);
    expect(stack.redoCount).toBe(0);
  });
});
