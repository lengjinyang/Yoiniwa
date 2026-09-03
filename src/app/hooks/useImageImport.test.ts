import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { createScene } from '../../domain/scene';
import type { ImportedImage } from '../../types';
import { useImageImport } from './useImageImport';
import { SceneStore } from '../../canvas/scene/SceneStore';

vi.mock('../../runtime/imageResources', () => ({ preloadImagePreview: async () => true }));
afterEach(() => vi.unstubAllGlobals());

it('assigns distinct frontmost layers when imports overlap on a stale scene closure', async () => {
  vi.stubGlobal('window', { innerWidth: 1000, innerHeight: 800, location: { search: '' } });
  let current = createScene();
  const source = (id: string): ImportedImage => ({ assetId: id, name: id, asset: {
    id, hash: id, mimeType: 'image/png', byteLength: 10, naturalWidth: 100, naturalHeight: 100, originalName: id,
  } });
  let importer!: ReturnType<typeof useImageImport>;
  function Probe() {
    importer = useImageImport({ api: undefined, scene: current, captureProjectContext: () => ({ isCurrent: () => true }),
      defaultVideoSoundEnabled: false, commit: (fn) => { current = structuredClone(current); fn(current); },
      setSelectedIds: vi.fn(), setSelectedGroupId: vi.fn(), setStatus: vi.fn(), internalDropMime: 'test',
      internalDropHandlerRef: { current: async () => false }, lastPointerRef: { current: { x: 0, y: 0 } } });
    return null;
  }
  renderToString(createElement(Probe));
  await importer.prepareAndAddImages([source('existing')]);
  current.items[0].zIndex = 99;
  await Promise.all(['a', 'b'].map((id) => importer.prepareAndAddImages([source(id)])));
  expect(current.items.map((item) => item.zIndex)).toEqual([99, 100, 101]);
  const store = new SceneStore(current);
  expect(store.imageAtPoint({ x: 500, y: 400 })?.id).toBe(current.items.at(-1)?.id);
});

it('reports picker failures without discarding valid imports or treating cancel as failure', async () => {
  vi.stubGlobal('window', { innerWidth: 1000, innerHeight: 800, location: { search: '' } });
  const source: ImportedImage = { assetId: 'good', name: 'good', asset: {
    id: 'good', hash: 'good', mimeType: 'image/png', byteLength: 10, naturalWidth: 100, naturalHeight: 100, originalName: 'good.png',
  } };
  for (const images of [[], [source]]) {
    const scene = createScene(), setStatus = vi.fn();
    const api = { importImages: vi.fn(async () => ({ images, failures: ['损坏.png: 无法解码'] })),
      prewarmImages: vi.fn(async () => ({ canceled: false, completed: images.length, total: images.length, failed: 0 })) };
    let importer!: ReturnType<typeof useImageImport>;
    function Probe() {
      importer = useImageImport({ api: api as unknown as Window['refCanvas'], scene,
        captureProjectContext: () => ({ isCurrent: () => true }), defaultVideoSoundEnabled: false,
        commit: (fn) => fn(scene), setSelectedIds: vi.fn(), setSelectedGroupId: vi.fn(), setStatus,
        internalDropMime: 'test', internalDropHandlerRef: { current: async () => false }, lastPointerRef: { current: { x: 0, y: 0 } } });
      return null;
    }
    renderToString(createElement(Probe));
    await importer.importImages();
    expect(scene.items).toHaveLength(images.length);
    expect(setStatus).toHaveBeenLastCalledWith('1 个文件导入失败：损坏.png: 无法解码');
    setStatus.mockClear();
    api.importImages.mockResolvedValueOnce({ images: [], failures: [] });
    await importer.importImages();
    expect(setStatus).not.toHaveBeenCalled();
  }
});

it('isolates imports across project switches during registration, prewarming, and fallback', async () => {
  vi.stubGlobal('window', { innerWidth: 1000, innerHeight: 800, location: { search: '' } });
  const source: ImportedImage = { assetId: 'image', name: 'image', sourceType: 'file', asset: {
    id: 'image', hash: 'image', mimeType: 'image/png', byteLength: 10,
    naturalWidth: 100, naturalHeight: 100, originalName: 'image.png',
  } };
  for (const stage of ['registration', 'prewarm', 'fallback', 'decode']) {
    let complete!: () => void;
    const waiting = new Promise<void>((resolve) => { complete = resolve; });
    let generation = 0;
    let scene = createScene();
    const api = {
      importImages: vi.fn(async () => { if (stage === 'registration') await waiting; return { images: [source], failures: [] }; }),
      prewarmImages: vi.fn(async () => {
        if (stage === 'prewarm' || stage === 'fallback') await waiting;
        if (stage === 'fallback') throw new Error('cache unavailable');
        return { canceled: false, completed: 1, total: 1, failed: 0 };
      }),
    };
    const commit = vi.fn((fn: (s: typeof scene) => void) => fn(scene));
    let importer!: ReturnType<typeof useImageImport>;
    function Probe() {
      importer = useImageImport({ api: stage === 'decode' ? undefined : api as unknown as Window['refCanvas'], scene,
        captureProjectContext: () => { const captured = generation; return { isCurrent: () => captured === generation }; },
        defaultVideoSoundEnabled: false, commit, setSelectedIds: vi.fn(), setSelectedGroupId: vi.fn(), setStatus: vi.fn(),
        internalDropMime: 'test', internalDropHandlerRef: { current: async () => false },
        lastPointerRef: { current: { x: 0, y: 0 } } });
      return null;
    }
    renderToString(createElement(Probe));
    const importing = stage === 'registration' ? importer.importImages() : importer.prepareAndAddImages([source]);
    if (stage === 'prewarm' || stage === 'fallback') await vi.waitFor(() => expect(api.prewarmImages).toHaveBeenCalledOnce());
    generation += 1;
    scene = createScene();
    complete();
    await importing;
    expect(commit, stage).not.toHaveBeenCalled();
    expect(scene.items, stage).toHaveLength(0);
    // The new board still accepts fresh imports (including a cache-failure fallback).
    await importer.prepareAndAddImages([source]);
    expect(scene.items, stage).toHaveLength(1);
  }
});
