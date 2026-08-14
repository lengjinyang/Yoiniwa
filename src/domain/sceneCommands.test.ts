import { describe, expect, it } from 'vitest';
import { createScene } from './scene';
import { applyImageChanges, deleteSceneSelection, moveImageLayer } from './sceneCommands';

const image = (id: string, x: number, zIndex: number) => ({
  id, name: id, sourceType: 'file' as const, naturalWidth: 100, naturalHeight: 100,
  x, y: 0, width: 100, height: 100, rotation: 0, flipX: false, flipY: false,
  opacity: 1, zIndex, locked: false, crop: { x: 0, y: 0, width: 100, height: 100 },
});

describe('scene commands', () => {
  it('deletes selections and cleans group memberships', () => {
    const scene = createScene();
    scene.items = [image('a', 0, 0), image('b', 100, 1)];
    scene.groups = [{ id: 'g', name: 'g', x: 0, y: 0, width: 200, height: 100, color: '#fff', opacity: 1,
      titleColor: '#fff', collapsed: false, sizeLocked: false, contentsHidden: false,
      members: [{ type: 'image', id: 'a' }, { type: 'image', id: 'b' }] }];
    deleteSceneSelection(scene, ['a']);
    expect(scene.items.map((item) => item.id)).toEqual(['b']);
    expect(scene.groups[0].members).toEqual([{ type: 'image', id: 'b' }]);
  });

  it('preserves snapping behavior while applying image changes', () => {
    const scene = createScene();
    scene.items = [image('a', 0, 0), image('b', 104, 1)];
    applyImageChanges(scene, [{ id: 'a', x: 3, y: 0 }]);
    expect(scene.items[0].x).toBe(4);
  });

  it('moves one image by one z-order step', () => {
    const scene = createScene();
    scene.items = [image('a', 0, 0), image('b', 0, 1)];
    expect(moveImageLayer(scene, 'a', 1)).toBe(true);
    expect([...scene.items].sort((a, b) => a.zIndex - b.zIndex).map((item) => item.id)).toEqual(['b', 'a']);
  });
});
