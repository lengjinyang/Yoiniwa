import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createScene } from '../../domain/scene';
import type { ImportedImage } from '../../types';
import { useAppPreferences } from './useAppPreferences';
import { useImageImport } from './useImageImport';

afterEach(() => { vi.unstubAllGlobals(); });

describe('video sound preference', () => {
  it('defaults to sound, persists both choices, and applies them only to newly imported videos', async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    vi.stubGlobal('window', { location: { search: '' }, innerWidth: 800, innerHeight: 600 });
    const scene = createScene();
    const setStatus = vi.fn();
    const source: ImportedImage = {
      assetId: 'clip', name: 'clip.mp4', sourceType: 'file',
      asset: { id: 'clip', hash: 'clip', kind: 'video', mimeType: 'video/mp4',
        byteLength: 100, naturalWidth: 640, naturalHeight: 360, originalName: 'clip.mp4' },
    };
    let preferences!: ReturnType<typeof useAppPreferences>;
    let importer!: ReturnType<typeof useImageImport>;
    function Probe() {
      preferences = useAppPreferences({ api: undefined, drawingCollaborationModeRef: { current: false }, setStatus });
      importer = useImageImport({
        api: undefined, scene, defaultVideoSoundEnabled: preferences.defaultVideoSoundEnabled,
        commit: (update) => update(scene), setSelectedIds: vi.fn(), setSelectedGroupId: vi.fn(), setStatus,
        internalDropMime: 'test/drop', internalDropHandlerRef: { current: async () => false },
        lastPointerRef: { current: { x: 0, y: 0 } },
      });
      return null;
    }

    renderToString(createElement(Probe));
    expect(preferences.defaultVideoSoundEnabled).toBe(true);
    await importer.prepareAndAddImages([source]);
    expect(scene.items[0]).toMatchObject({ mediaKind: 'video', muted: false });

    preferences.setDefaultVideoSoundEnabled(false);
    renderToString(createElement(Probe)); // Remount to read the saved preference.
    expect(preferences.defaultVideoSoundEnabled).toBe(false);
    await importer.prepareAndAddImages([source]);
    expect(scene.items[1]).toMatchObject({ mediaKind: 'video', muted: true });
    expect(scene.items[0]).toMatchObject({ muted: false });

    preferences.setDefaultVideoSoundEnabled(true);
    renderToString(createElement(Probe));
    expect(preferences.defaultVideoSoundEnabled).toBe(true);
    await importer.prepareAndAddImages([source]);
    expect(scene.items[2]).toMatchObject({ muted: false });
    expect(scene.items[1]).toMatchObject({ muted: true });
  });
});
