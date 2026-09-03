import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { createScene } from '../../domain/scene';
import type { SceneHistoryController } from './useSceneHistory';
import { useSceneClipboard } from './useSceneClipboard';

it('pastes media and its poster assets into a different board', () => {
  const scene = createScene();
  for (const id of ['video', 'poster']) scene.assets[id] = {
    id, hash: id, mimeType: id === 'video' ? 'video/mp4' : 'image/png',
    byteLength: 10, naturalWidth: 100, naturalHeight: 100, originalName: id,
  };
  scene.items = [{ id: 'clip', assetId: 'video', posterAssetId: 'poster', mediaKind: 'video',
    name: 'clip', sourceType: 'file', naturalWidth: 100, naturalHeight: 100,
    x: 0, y: 0, width: 100, height: 100, rotation: 0, flipX: false, flipY: false,
    opacity: 1, zIndex: 0, locked: false, crop: { x: 0, y: 0, width: 100, height: 100 } }];
  const history = { scene, commit: (fn: (s: typeof scene) => void) => fn(history.scene) } as SceneHistoryController;
  let clipboard!: ReturnType<typeof useSceneClipboard>;
  function Probe() {
    clipboard = useSceneClipboard({ history, selectedIds: ['clip'], lastPointerRef: { current: { x: 0, y: 0 } },
      setSelectedIds: vi.fn(), setSelectedGroupId: vi.fn(), deleteSelected: vi.fn(), deleteGroup: vi.fn(), setStatus: vi.fn() });
    return null;
  }
  renderToString(createElement(Probe));
  clipboard.copySelection();
  history.scene = createScene();
  clipboard.pasteClipboard();
  expect(history.scene.items).toHaveLength(1);
  expect(history.scene.assets).toEqual(scene.assets);
  expect(history.scene.assets.video).not.toBe(scene.assets.video);
});
