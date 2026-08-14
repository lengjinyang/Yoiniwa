import { describe, expect, it } from 'vitest';
import { captureSceneSelection, pasteScenePayload } from './sceneClipboard';
import { createGroupFrame, createScene } from './scene';
import type { ImageItem } from './types';

const image = (id: string, x: number): ImageItem => ({
  id, name: id, sourceType: 'file', dataUrl: '', naturalWidth: 100, naturalHeight: 100,
  x, y: 0, width: 100, height: 100, rotation: 0, flipX: false, flipY: false, opacity: 1,
  zIndex: x, locked: false, crop: { x: 0, y: 0, width: 100, height: 100 },
});

describe('group-aware clipboard', () => {
  it('copies a group frame with selectable cloned members and relationships', () => {
    const scene = createScene(); scene.items = [image('a', 0), image('b', 120)];
    const group = createGroupFrame(scene, [{ type: 'image', id: 'a' }, { type: 'image', id: 'b' }], '参考', 'group');
    const payload = captureSceneSelection(scene, [], group.id)!;
    const pasted = pasteScenePayload(scene, payload, 30);
    const cloned = scene.groups.find((value) => value.id === pasted.rootGroupId)!;
    expect(cloned).toBeTruthy(); expect(cloned.id).not.toBe(group.id);
    expect(cloned.members).toHaveLength(2);
    expect(cloned.members.every((member) => scene.items.some((item) => item.id === member.id))).toBe(true);
  });

  it('deep-copies tags with clipboard payloads', () => {
    const scene = createScene();
    scene.items = [{ ...image('a', 0), tags: ['角色'] }];
    const payload = captureSceneSelection(scene, ['a'])!;
    payload.items[0].tags!.push('草图');
    expect(scene.items[0].tags).toEqual(['角色']);
    pasteScenePayload(scene, payload, 30);
    const copy = scene.items.find((item) => item.id !== 'a')!;
    expect(copy.tags).toEqual(['角色', '草图']);
  });

  it('centers pasted content on an explicit mouse world position', () => {
    const scene = createScene(); scene.items = [image('a', 0), image('b', 120)];
    const payload = captureSceneSelection(scene, ['a', 'b'])!;
    const pasted = pasteScenePayload(scene, payload, { x: 500, y: 300 });
    const pastedIds = new Set<string>(pasted.imageIds);
    const copies = scene.items.filter((item) => pastedIds.has(item.id));
    const left = Math.min(...copies.map((item) => item.x));
    const right = Math.max(...copies.map((item) => item.x + item.width));
    const top = Math.min(...copies.map((item) => item.y));
    const bottom = Math.max(...copies.map((item) => item.y + item.height));
    expect((left + right) / 2).toBe(500);
    expect((top + bottom) / 2).toBe(300);
  });
});
