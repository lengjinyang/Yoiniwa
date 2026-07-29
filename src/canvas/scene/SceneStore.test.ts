import { describe, expect, it } from 'vitest';
import type { Scene } from '../../types';
import { SceneStore } from './SceneStore';

function scene(ids: string[]): Scene {
  return {
    format: 'refcanvas', version: 2, name: 'test', savedAt: '', viewport: { x: 0, y: 0, scale: 1 },
    canvas: { background: '#000', padding: 0, snap: false, includeBackgroundOnExport: false }, assets: {},
    groups: [], annotations: [], items: ids.map((id, index) => ({
      id, name: id, sourceType: 'file', naturalWidth: 10, naturalHeight: 10,
      x: 0, y: 0, width: 10, height: 10, rotation: 0, flipX: false, flipY: false,
      opacity: 1, zIndex: ids.length - index, locked: false, crop: { x: 0, y: 0, width: 10, height: 10 },
    })),
  };
}

describe('SceneStore', () => {
  it('provides one indexed scene representation and z-sorted images', () => {
    const store = new SceneStore(scene(['a', 'b']));
    expect(store.node('a')?.kind).toBe('image');
    expect(store.images().map((item) => item.id)).toEqual(['b', 'a']);

    store.replace(scene(['next']));
    expect(store.node('a')).toBeUndefined();
    expect(store.node('next')?.id).toBe('next');
  });
});
