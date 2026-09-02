import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createScene } from '../../domain/scene';
import type { PhotoshopVersionRecord } from '../../types';
import { usePhotoshopVersions } from './usePhotoshopVersions';
import { renderProjectPreview } from '../projectPreview';

vi.mock('../projectPreview', () => ({ renderProjectPreview: vi.fn(async () => undefined) }));
afterEach(() => { vi.unstubAllGlobals(); });

const version: PhotoshopVersionRecord = {
  id: 'version-1',
  name: '角色上色',
  createdAt: '2026-08-09T00:00:00.000Z',
  documentName: 'character.psd',
  width: 100,
  height: 80,
  colorMode: 'RGB',
  bitDepth: 8,
  layerCount: 4,
  format: 'psd',
  byteLength: 1024,
  sha256: 'hash',
  previewAssetId: 'preview-1',
  previewAsset: {
    id: 'preview-1',
    hash: 'preview-hash',
    mimeType: 'image/png',
    byteLength: 128,
    naturalWidth: 100,
    naturalHeight: 80,
    originalName: 'preview.png',
  },
};

function renderVersions(options: Parameters<typeof usePhotoshopVersions>[0]) {
  let controller!: ReturnType<typeof usePhotoshopVersions>;
  function Probe() {
    controller = usePhotoshopVersions(options);
    return null;
  }
  renderToString(createElement(Probe));
  return controller;
}

function options(api: Partial<NonNullable<Window['refCanvas']>> = {}, documentBlocked = false) {
  const scene = createScene();
  return {
    api: api as Window['refCanvas'],
    captureProjectSave: () => ({ sessionId: 'session-1', photoshopProject: { versions: [version] }, isCurrent: () => true, release: vi.fn() }),
    onMetadataChange: vi.fn(),
    projectSessionIdRef: { current: 'session-1' },
    liveViewportRef: { current: scene.viewport },
    documentBlocked,
    flushViewport: vi.fn(() => ({ scene, revision: 3 })),
    markSaved: vi.fn(() => true),
    prepareAndAddImages: vi.fn(async () => undefined),
    beginOperation: vi.fn(() => 1),
    settleOperation: vi.fn(),
    clearOperation: vi.fn(),
    setStatus: vi.fn(),
    onBeforeOpenPanel: vi.fn(),
  };
}

describe('usePhotoshopVersions', () => {
  it('discards version deletion previews and responses after a project switch', async () => {
    vi.stubGlobal('window', { confirm: () => true });
    for (const stage of ['preview', 'commit']) {
      let release!: () => void;
      const pending = new Promise<void>((resolve) => { release = resolve; });
      const deletePhotoshopVersion = vi.fn(async () => {
        if (stage === 'commit') await pending;
        return { sessionId: 'session-1', scene: createScene(), metadata: { versions: [] } };
      });
      const hookOptions = options({ deletePhotoshopVersion });
      let current = true;
      const context = { ...hookOptions.captureProjectSave(), isCurrent: () => current };
      hookOptions.captureProjectSave = () => context;
      if (stage === 'preview') vi.mocked(renderProjectPreview).mockReturnValueOnce(pending.then(() => undefined));
      const controller = renderVersions(hookOptions);
      const deleting = controller.deletePhotoshopVersion(version);
      await Promise.resolve();
      current = false;
      hookOptions.projectSessionIdRef.current = 'session-2';
      release();
      await deleting;
      expect(deletePhotoshopVersion).toHaveBeenCalledTimes(stage === 'preview' ? 0 : 1);
      expect(hookOptions.markSaved).not.toHaveBeenCalled();
      expect(hookOptions.onMetadataChange).not.toHaveBeenCalled();
      expect(hookOptions.projectSessionIdRef.current).toBe('session-2');
      expect(context.release).toHaveBeenCalledOnce();
    }
  });

  it('opens a stored version through the current project session', async () => {
    const openPhotoshopVersion = vi.fn(async () => ({ ok: true, status: 'completed' as const, message: 'opened' }));
    const hookOptions = options({ openPhotoshopVersion });
    const controller = renderVersions(hookOptions);
    await controller.openPhotoshopVersion(version);
    expect(openPhotoshopVersion).toHaveBeenCalledWith('session-1', 'version-1');
    expect(hookOptions.setStatus).toHaveBeenCalledWith('opened');
  });

  it('does not call Photoshop document APIs while the domain is blocked', async () => {
    const openPhotoshopVersion = vi.fn(async () => ({ ok: true, status: 'completed' as const }));
    const controller = renderVersions(options({ openPhotoshopVersion }, true));
    await controller.openPhotoshopVersion(version);
    expect(openPhotoshopVersion).not.toHaveBeenCalled();
  });

  it('places the cached preview through the image import boundary', async () => {
    const hookOptions = options();
    const controller = renderVersions(hookOptions);
    await controller.placePhotoshopVersionPreview(version, { screenX: 25, screenY: 40 });
    expect(hookOptions.prepareAndAddImages).toHaveBeenCalledWith([
      expect.objectContaining({ name: '角色上色.png', assetId: 'preview-1', sourceType: 'file' }),
    ], { screenX: 25, screenY: 40 });
    expect(hookOptions.setStatus).toHaveBeenCalledWith('已将版本 角色上色 的预览放入画板');
  });
});
