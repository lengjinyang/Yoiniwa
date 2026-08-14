import { describe, expect, it } from 'vitest';
import { createScene } from './scene';
import { groupOrDescendantMatches, outlineObjectMatches, sceneTagCatalog } from './outline';
import type { ImageGroup, ImageItem } from '../types';

const image = (id: string, tags?: string[]): ImageItem => ({
  id, name: '城市草图', sourceType: 'file', naturalWidth: 100, naturalHeight: 100,
  x: 0, y: 0, width: 100, height: 100, rotation: 0, flipX: false, flipY: false,
  opacity: 1, zIndex: 0, locked: false, crop: { x: 0, y: 0, width: 100, height: 100 }, tags,
});

const group: ImageGroup = {
  id: 'group', name: '场景', x: 0, y: 0, width: 100, height: 100, color: '#000', opacity: 1,
  titleColor: '#fff', collapsed: false, sizeLocked: false, contentsHidden: false,
  members: [{ type: 'image', id: 'image' }],
};

describe('outline filters', () => {
  it('searches names and tags', () => {
    const value = image('image', ['Environment']);
    expect(outlineObjectMatches(value, 'image', { query: 'environment' })).toBe(true);
    expect(outlineObjectMatches(value, 'image', { query: '城市' })).toBe(true);
  });

  it('supports ANY and ALL tag filters', () => {
    const value = image('image', ['角色', '环境']);
    expect(outlineObjectMatches(value, 'image', { tags: ['角色', '不存在'], tagMode: 'any' })).toBe(true);
    expect(outlineObjectMatches(value, 'image', { tags: ['角色', '环境'], tagMode: 'all' })).toBe(true);
    expect(outlineObjectMatches(value, 'image', { tags: ['角色', '不存在'], tagMode: 'all' })).toBe(false);
  });

  it('keeps an ancestor group when a descendant matches', () => {
    const scene = createScene();
    scene.items = [image('image', ['天空'])];
    scene.groups = [group];
    expect(groupOrDescendantMatches(scene, group, { tags: ['天空'] })).toBe(true);
  });

  it('builds a case-insensitive scene tag catalog', () => {
    const scene = createScene();
    scene.items = [image('image', ['角色', '角色'])];
    scene.groups = [{ ...group, tags: ['环境'] }];
    expect(sceneTagCatalog(scene)).toEqual(['环境', '角色']);
  });
});
