import { afterEach, expect, it, vi } from 'vitest';
import type { SceneItem } from '../types';

afterEach(() => { vi.unstubAllGlobals(); });

it('maps full and cropped video posters to bitmap pixels without changing the destination', async () => {
  const drawImage = vi.fn();
  const context = { scale: vi.fn(), translate: vi.fn(), save: vi.fn(), restore: vi.fn(), rotate: vi.fn(), drawImage };
  const bitmap = { width: 2048, height: 1152, close: vi.fn() };
  const postMessage = vi.fn();
  const worker = { onmessage: undefined as ((event: MessageEvent) => void) | undefined, postMessage };
  vi.stubGlobal('self', worker);
  vi.stubGlobal('OffscreenCanvas', class {
    getContext() { return context; }
    async convertToBlob() { return new Blob(); }
  });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob() })));
  vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
  await import('./exportScene.worker');
  const item: SceneItem = {
    id: 'clip', name: '4K clip', mediaKind: 'video', sourceType: 'file', naturalWidth: 3840, naturalHeight: 2160,
    x: 0, y: 0, width: 384, height: 216, rotation: 0, flipX: false, flipY: false, opacity: 1, zIndex: 0, locked: false,
    crop: { x: 0, y: 0, width: 3840, height: 2160 },
  };
  const items = [item, { ...item, crop: { x: 960, y: 540, width: 1920, height: 1080 } },
    { ...item, mediaKind: 'image', naturalWidth: 2048, naturalHeight: 1152, crop: { x: 0, y: 0, width: 2048, height: 1152 } }];
  const completed = new Promise<void>((resolve) => { postMessage.mockImplementation(() => resolve()); });
  worker.onmessage!({ data: { width: 384, height: 216, scale: 1, offsetX: 0, offsetY: 0, format: 'png',
    groups: [], items: items.map((value) => ({ ...value, resourceUrl: 'poster' })) } } as MessageEvent);
  await completed;
  expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ ok: true }), expect.anything());
  expect(drawImage).toHaveBeenNthCalledWith(1, bitmap, 0, 0, 2048, 1152, -192, -108, 384, 216);
  expect(drawImage).toHaveBeenNthCalledWith(2, bitmap, 512, 288, 1024, 576, -192, -108, 384, 216);
  expect(drawImage).toHaveBeenNthCalledWith(3, bitmap, 0, 0, 2048, 1152, -192, -108, 384, 216);
  expect(bitmap.close).toHaveBeenCalledTimes(3);
});
