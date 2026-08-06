import { describe, expect, it } from 'vitest';
import type { Scene } from '../../types';
import { ImageTransformCommand } from './ImageTransformCommand';

const scene = {
  format: 'refcanvas', version: 3, name: 'command', savedAt: '', viewport: { x: 0, y: 0, scale: 1 },
  canvas: { background: '#000', padding: 0, snap: false, includeBackgroundOnExport: true }, assets: {},
  items: [{ id: 'a', name: 'a', sourceType: 'file', naturalWidth: 10, naturalHeight: 10,
    x: 1, y: 2, width: 10, height: 10, rotation: 0, flipX: false, flipY: false, opacity: 1,
    zIndex: 0, locked: false, crop: { x: 0, y: 0, width: 10, height: 10 } }], groups: [],
  visualNotes: { visible: true, nextNumber: 1, marks: [] },
} satisfies Scene;

describe('ImageTransformCommand', () => {
  it('derives execute and undo scenes without mutating the SceneStore snapshot', () => {
    const command = new ImageTransformCommand(scene, [{ id: 'a', x: 20, rotation: 45 }]);
    const moved = command.execute(scene);
    expect(moved.items[0]).toMatchObject({ x: 20, rotation: 45 });
    expect(scene.items[0]).toMatchObject({ x: 1, rotation: 0 });
    expect(command.undo(moved).items[0]).toMatchObject({ x: 1, rotation: 0 });
  });
});
