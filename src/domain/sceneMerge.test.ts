import { describe, expect, it } from 'vitest';
import { createGroupFrame, createScene } from './scene';
import { mergeSceneInto } from './sceneMerge';
import type { AssetRecord, ImageItem } from '../types';

const asset: AssetRecord = {
  id: 'a'.repeat(64), hash: 'a'.repeat(64), mimeType: 'image/png', byteLength: 10,
  naturalWidth: 100, naturalHeight: 50, originalName: 'reference.png',
};

const image = (id: string, x: number): ImageItem => ({
  id, name: id, sourceType: 'file', assetId: asset.id, naturalWidth: 100, naturalHeight: 50,
  x, y: 0, width: 100, height: 50, rotation: 0, flipX: false, flipY: false,
  opacity: 1, zIndex: 0, locked: false, crop: { x: 0, y: 0, width: 100, height: 50 }, tags: ['环境'],
});

describe('scene merge', () => {
  it('preserves source metadata, remaps ids, and appends z order', () => {
    const target = createScene();
    target.items = [{ ...image('existing', 0), zIndex: 7 }];
    target.assets[asset.id] = asset;
    const source = createScene();
    source.items = [image('source', 0)];
    source.assets[asset.id] = asset;
    const group = createGroupFrame(source, [{ type: 'image', id: 'source' }], '来源组', 'group');
    group.tags = ['素材'];

    const result = mergeSceneInto(target, source, { x: 500, y: 300 });
    const merged = target.items.find((item) => item.id === result.imageIds[0])!;
    const mergedGroup = target.groups.find((value) => value.id === result.groupIds[0])!;

    expect(merged.id).not.toBe('source');
    expect(merged.zIndex).toBe(8);
    expect(merged.tags).toEqual(['环境']);
    expect(mergedGroup.members[0]).toEqual({ type: 'image', id: merged.id });
    expect(mergedGroup.tags).toEqual(['素材']);
    expect(mergedGroup.x + mergedGroup.width / 2).toBe(500);
    expect(mergedGroup.y + mergedGroup.height / 2).toBe(300);
  });

  it('rejects an asset id collision with incompatible metadata', () => {
    const target = createScene();
    const source = createScene();
    target.assets[asset.id] = asset;
    source.assets[asset.id] = { ...asset, byteLength: 99 };
    expect(() => mergeSceneInto(target, source, { x: 0, y: 0 })).toThrow('资产冲突');
  });

  it('retains nested group relationships with fresh ids', () => {
    const target = createScene();
    const source = createScene();
    source.items = [image('source', 0)];
    source.assets[asset.id] = asset;
    const child = createGroupFrame(source, [{ type: 'image', id: 'source' }], '子组', 'child');
    createGroupFrame(source, [{ type: 'group', id: child.id }], '父组', 'parent');
    const result = mergeSceneInto(target, source, { x: 100, y: 100 });
    const mergedParent = target.groups.find((group) => group.id === result.rootGroupIds[0])!;
    const mergedChild = target.groups.find((group) => group.parentId === mergedParent.id)!;
    expect(mergedParent.members).toEqual([{ type: 'group', id: mergedChild.id }]);
  });
});
