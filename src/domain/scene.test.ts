import { describe, expect, it } from 'vitest';
import { addMemberToGroup, applyNonDestructiveCrop, createGroupFrame, createScene, groupVisibleBounds, GROUP_TITLE_HEIGHT, moveGroupWithContents, normalizeScene, reconcileMemberBounds, reorderImages, resetImageTransform, resetNonDestructiveCrop, rotateItemsAsGroup, scaleItemsAsGroup, topmostVisibleGroupAtPoint, translateItems } from './scene';
import type { ImageGroup, ImageItem } from '../types';

const image = (id: string, x: number, width = 100): ImageItem => ({
  id, name: id, sourceType: 'file', dataUrl: '', naturalWidth: 1000, naturalHeight: 500,
  x, y: 20, width, height: 50, rotation: 0, flipX: false, flipY: false,
  opacity: 1, zIndex: 0, locked: false, crop: { x: 0, y: 0, width: 1000, height: 500 },
});

describe('group transforms', () => {
  it('assigns selected images to a persistent named group immediately', () => {
    const scene = createScene();
    scene.items = [image('a', 0), image('b', 200), image('c', 400)];
    const group = createGroupFrame(scene, [{ type: 'image', id: 'a' }, { type: 'image', id: 'b' }], '人物参考', 'group-1');
    expect(group).toMatchObject({ id: 'group-1', name: '人物参考', x: -8, y: 12, width: 316, height: 66 });
    expect(group.members).toEqual([{ type: 'image', id: 'a' }, { type: 'image', id: 'b' }]);
  });

  it('moves the frame and every member as one undoable mutation', () => {
    const scene = createScene();
    scene.items = [image('a', 0), image('b', 200)];
    const group = createGroupFrame(scene, [{ type: 'image', id: 'a' }, { type: 'image', id: 'b' }], '组', 'group-1');
    moveGroupWithContents(scene, group.id, 30, -10);
    expect(group).toMatchObject({ x: 22, y: 2 });
    expect(scene.items.map((item) => ({ x: item.x, y: item.y }))).toEqual([{ x: 30, y: 10 }, { x: 230, y: 10 }]);
  });

  it('joins only when fully contained and keeps auto-fit members until explicitly detached', () => {
    const scene = createScene();
    scene.items = [image('a', 0), image('b', 200), image('c', 30)];
    const group = createGroupFrame(scene, [{ type: 'image', id: 'a' }, { type: 'image', id: 'b' }], '组', 'group-1');
    expect(reconcileMemberBounds(scene, { type: 'image', id: 'c' }, { x: 30, y: 20, width: 100, height: 50 })).toBe(group.id);
    expect(group.members.some((member) => member.id === 'c')).toBe(true);
    expect(reconcileMemberBounds(scene, { type: 'image', id: 'c' }, { x: 300, y: 20, width: 100, height: 50 })).toBe(group.id);
    expect(group.members.some((member) => member.id === 'c')).toBe(true);
    expect(reconcileMemberBounds(scene, { type: 'image', id: 'c' }, { x: 1000, y: 1000, width: 100, height: 50 })).toBe(group.id);
    expect(group.members.some((member) => member.id === 'c')).toBe(true);
  });

  it('does not accept new members while collapsed', () => {
    const scene = createScene();
    scene.items = [image('a', 0), image('b', 200), image('c', 30)];
    const group = createGroupFrame(scene, [{ type: 'image', id: 'a' }, { type: 'image', id: 'b' }], '组', 'group-1');
    group.collapsed = true;
    expect(reconcileMemberBounds(scene, { type: 'image', id: 'c' }, { x: 30, y: 20, width: 100, height: 50 })).toBeUndefined();
  });

  it('presents a collapsed group as a compact title capsule without changing its stored frame', () => {
    const scene = createScene();
    scene.items = [image('a', 0), image('b', 200)];
    const group = createGroupFrame(scene, [{ type: 'image', id: 'a' }, { type: 'image', id: 'b' }], '组 1', 'group-1');
    const storedSize = { width: group.width, height: group.height };
    group.collapsed = true;
    expect(groupVisibleBounds(group)).toMatchObject({ x: group.x, y: group.y - GROUP_TITLE_HEIGHT, width: group.width, height: GROUP_TITLE_HEIGHT });
    expect({ width: group.width, height: group.height }).toEqual(storedSize);
    group.collapsed = false;
    expect(groupVisibleBounds(group)).toMatchObject({ x: group.x, y: group.y - GROUP_TITLE_HEIGHT,
      width: storedSize.width, height: storedSize.height + GROUP_TITLE_HEIGHT });
  });

  it('finds the topmost group at a pointer using visible bounds', () => {
    const back = { id: 'back', name: 'Back', x: 0, y: 0, width: 120, height: 100, color: '#000', opacity: 1, titleColor: '#fff', collapsed: false, sizeLocked: false, contentsHidden: false, members: [] } satisfies ImageGroup;
    const front = { ...back, id: 'front', name: 'Front', x: 20, y: 20 };
    expect(topmostVisibleGroupAtPoint([back, front], ['back', 'front'], new Set(), { x: 30, y: 30 })).toBe('front');
    expect(topmostVisibleGroupAtPoint([back, front], ['back', 'front'], new Set(['front']), { x: 30, y: 30 })).toBe('back');
    expect(topmostVisibleGroupAtPoint([back], ['back'], new Set(), { x: 200, y: 200 })).toBeUndefined();
  });

  it('uses the compact bounds of a collapsed group for hit testing', () => {
    const group = { id: 'collapsed', name: '组', x: 10, y: 20, width: 300, height: 180, color: '#000', opacity: 1, titleColor: '#fff', collapsed: true, sizeLocked: false, contentsHidden: false, members: [] } satisfies ImageGroup;
    expect(topmostVisibleGroupAtPoint([group], [group.id], new Set(), { x: 20, y: 20 - GROUP_TITLE_HEIGHT / 2 })).toBe(group.id);
    expect(topmostVisibleGroupAtPoint([group], [group.id], new Set(), { x: 20, y: 20 + GROUP_TITLE_HEIGHT + 1 })).toBeUndefined();
  });

  it('normalizes object tags when loading an existing v2 scene', () => {
    const scene = createScene();
    scene.items = [{ ...image('tagged', 0), tags: ['  环境 ', '环境', '', '角色'] }];
    scene.groups = [{ id: 'group', name: '组', x: 0, y: 0, width: 100, height: 100, color: '#000', opacity: 1, titleColor: '#fff', collapsed: false, sizeLocked: false, contentsHidden: false, tags: ['参考'], members: [] }];
    normalizeScene(scene);
    expect(scene.items[0].tags).toEqual(['环境', '角色']);
    expect(scene.groups[0].tags).toEqual(['参考']);
  });

  it('supports nesting while rejecting parent-child cycles', () => {
    const scene = createScene();
    scene.items = [image('a', 0), image('b', 200), image('c', 400)];
    const child = createGroupFrame(scene, [{ type: 'image', id: 'a' }, { type: 'image', id: 'b' }], '子组', 'child');
    const parent = createGroupFrame(scene, [{ type: 'group', id: child.id }, { type: 'image', id: 'c' }], '父组', 'parent');
    expect(child.parentId).toBe(parent.id);
    expect(addMemberToGroup(scene, child, { type: 'group', id: parent.id })).toBe(false);
  });

  it('moves every member by the same delta', () => {
    expect(translateItems([image('a', 10), image('b', 210)], 30, -5)).toEqual([
      { id: 'a', x: 40, y: 15 }, { id: 'b', x: 240, y: 15 },
    ]);
  });

  it('scales members and their spacing around the group center', () => {
    const result = scaleItemsAsGroup([image('a', 0), image('b', 200)], 2);
    expect(result).toEqual([
      { id: 'a', x: -150, y: -5, width: 200, height: 100 },
      { id: 'b', x: 250, y: -5, width: 200, height: 100 },
    ]);
  });
});

describe('reset image transform', () => {
  it('restores crop, size, rotation, flips and opacity while preserving center', () => {
    const item = image('a', 10, 200);
    Object.assign(item, { y: 30, height: 100, rotation: 33, flipX: true, flipY: true, opacity: 0.4, crop: { x: 100, y: 50, width: 300, height: 200 } });
    resetImageTransform(item);
    expect(item).toMatchObject({ x: -130, y: -40, width: 480, height: 240, rotation: 0, flipX: false, flipY: false, opacity: 1, crop: { x: 0, y: 0, width: 1000, height: 500 } });
  });
});

describe('restore full image crop', () => {
  it('reveals the removed source area while preserving the crop scale', () => {
    const item = image('crop', 0);
    applyNonDestructiveCrop(item, { x: 250, y: 0, width: 500, height: 500 });
    expect(item).toMatchObject({ width: 50, crop: { x: 250, y: 0, width: 500, height: 500 } });
    resetNonDestructiveCrop(item);
    expect(item).toMatchObject({ width: 100, height: 50, crop: { x: 0, y: 0, width: 1000, height: 500 } });
  });
});

describe('image layer ordering', () => {
  it('moves a multi-selection to the front or back while preserving its internal order', () => {
    const items = [image('a', 0), image('b', 100), image('c', 200), image('d', 300)]
      .map((item, zIndex) => ({ ...item, zIndex }));
    expect(reorderImages(items, ['b', 'c'], true).map((item) => item.id)).toEqual(['a', 'd', 'b', 'c']);
    expect(reorderImages(items, ['b', 'c'], false).map((item) => item.id)).toEqual(['b', 'c', 'a', 'd']);
  });
});

describe('corner rotation', () => {
  it('rotates every selected image around the shared selection center', () => {
    const items = [image('a', 0), image('b', 200)];
    const changes = rotateItemsAsGroup(items, 90);
    expect(changes[0]).toMatchObject({ id: 'a', x: 100, y: -80, rotation: 90 });
    expect(changes[1]).toMatchObject({ id: 'b', x: 100, y: 120, rotation: 90 });
  });
});

describe('group frame migration', () => {
  it('maps legacy lock and visibility fields to their new semantics', () => {
    const scene = createScene();
    scene.groups = [{
      id: 'legacy', name: '旧分组', x: 10, y: 20, width: 300, height: 180,
      color: '#123456', opacity: 0.3, titleColor: '#ffffff', collapsed: false,
      locked: true, hidden: true, members: [],
    } as unknown as ImageGroup];

    normalizeScene(scene);

    expect(scene.groups[0]).toMatchObject({ sizeLocked: true, contentsHidden: true });
    expect(scene.groups[0].locked).toBeUndefined();
    expect(scene.groups[0].hidden).toBeUndefined();
  });
});
