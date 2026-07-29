import { describe, expect, it, vi } from 'vitest';
import type { Scene } from '../../types';
import { AutosaveCoordinator } from './AutosaveCoordinator';
import { loadProjectScene } from './ProjectLoader';
import { serializeProjectScene } from './ProjectSerializer';

const scene = {
  format: 'refcanvas', version: 2, name: 'roundtrip', savedAt: '', viewport: { x: 12, y: -8, scale: 2 },
  canvas: { background: '#000', padding: 20, snap: true, includeBackgroundOnExport: true },
  assets: { missing: { id: 'missing', hash: 'hash', mimeType: 'image/png', byteLength: 1, naturalWidth: 10, naturalHeight: 10, originalName: 'gone.png' } },
  items: [{ id: 'image', name: 'gone', sourceType: 'file', assetId: 'missing', naturalWidth: 10, naturalHeight: 10,
    x: 1, y: 2, width: 10, height: 10, rotation: 5, flipX: false, flipY: false, opacity: 1, zIndex: 7, locked: false,
    crop: { x: 1, y: 1, width: 8, height: 8 } }], groups: [], annotations: [],
} satisfies Scene;

describe('project persistence boundary', () => {
  it('round trips viewport, z-order, crop and cache-backed missing sources', () => {
    const loaded = loadProjectScene(JSON.parse(JSON.stringify(serializeProjectScene(scene))));
    expect(loaded?.viewport).toEqual(scene.viewport);
    expect(loaded?.items[0]).toMatchObject({ zIndex: 7, crop: scene.items[0].crop, assetId: 'missing' });
    expect(loaded?.assets.missing.originalName).toBe('gone.png');
  });

  it('migrates a version-one scene and rejects malformed viewport state', () => {
    expect(loadProjectScene({ ...scene, version: 1 })?.version).toBe(2);
    expect(loadProjectScene({ ...scene, viewport: { x: 0, y: 0, scale: 0 } })).toBeUndefined();
  });

  it('autosaves only the latest settled revision', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => undefined);
    const autosave = new AutosaveCoordinator(save, 100);
    autosave.schedule(scene, 1); autosave.schedule({ ...scene, name: 'latest' }, 2);
    await vi.advanceTimersByTimeAsync(101);
    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ name: 'latest' }), 2);
    autosave.destroy(); vi.useRealTimers();
  });
});
