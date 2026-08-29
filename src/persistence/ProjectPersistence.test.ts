import { describe, expect, it, vi } from 'vitest';
import type { Scene } from '../types';
import { AutosaveCoordinator } from './AutosaveCoordinator';
import { loadProjectScene } from './ProjectLoader';
import { serializeProjectScene } from './ProjectSerializer';

const scene = {
  format: 'refcanvas', version: 4, name: 'roundtrip', savedAt: '', viewport: { x: 12, y: -8, scale: 2 },
  canvas: { background: '#000', padding: 20, snap: true, includeBackgroundOnExport: true },
  assets: {
    missing: { id: 'missing', hash: 'hash', mimeType: 'image/png', byteLength: 1, naturalWidth: 10, naturalHeight: 10, originalName: 'gone.png' },
    clip: { id: 'clip', hash: 'clip', mimeType: 'video/mp4', byteLength: 8, naturalWidth: 1920, naturalHeight: 1080, originalName: 'clip.mp4', kind: 'video' as const },
    poster: { id: 'poster', hash: 'poster', mimeType: 'image/jpeg', byteLength: 2, naturalWidth: 1920, naturalHeight: 1080, originalName: 'clip.jpg' },
  },
  items: [
    {
      id: 'image', name: 'gone', sourceType: 'file' as const, assetId: 'missing', naturalWidth: 10, naturalHeight: 10,
      x: 1, y: 2, width: 10, height: 10, rotation: 5, flipX: false, flipY: false, opacity: 1, zIndex: 7, locked: false,
      grayscale: true, grayscaleContrast: 1.4, mediaKind: 'image' as const,
      crop: { x: 1, y: 1, width: 8, height: 8 },
    },
    {
      id: 'video', name: 'clip', sourceType: 'file' as const, assetId: 'clip', naturalWidth: 1920, naturalHeight: 1080,
      x: 20, y: 4, width: 192, height: 108, rotation: 0, flipX: false, flipY: false, opacity: 1, zIndex: 8, locked: false,
      mediaKind: 'video' as const, posterAssetId: 'poster', durationSec: 12.5, muted: true, loop: false,
      crop: { x: 0, y: 0, width: 1920, height: 1080 },
    },
  ],
  groups: [],
  visualNotes: { visible: true, nextNumber: 1, marks: [] },
} satisfies Scene;

describe('project persistence boundary', () => {
  it('round trips viewport, z-order, crop and cache-backed missing sources', () => {
    const loaded = loadProjectScene(JSON.parse(JSON.stringify(serializeProjectScene(scene))));
    expect(loaded?.viewport).toEqual(scene.viewport);
    expect(loaded?.items[0]).toMatchObject({
      zIndex: 7, crop: scene.items[0].crop, assetId: 'missing',
      grayscale: true, grayscaleContrast: 1.4, mediaKind: 'image',
    });
    expect(loaded?.items[0]).not.toHaveProperty('muted');
    expect(loaded?.items[0]).not.toHaveProperty('loop');
    expect(loaded?.assets.missing.originalName).toBe('gone.png');
  });

  it('round trips independent video nodes without promoting still images', () => {
    const loaded = loadProjectScene(JSON.parse(JSON.stringify(serializeProjectScene(scene))));
    expect(loaded?.items[1]).toMatchObject({
      mediaKind: 'video', posterAssetId: 'poster', durationSec: 12.5, muted: true, loop: false, assetId: 'clip',
    });
  });

  it('migrates a version-one scene and rejects malformed viewport state', () => {
    expect(loadProjectScene({ ...scene, version: 1 })?.version).toBe(3);
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
