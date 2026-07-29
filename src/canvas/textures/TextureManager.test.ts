import { afterEach, describe, expect, it, vi } from 'vitest';

const textureDestroy = vi.fn();
vi.mock('pixi.js', () => ({
  Texture: {
    from: (bitmap: { width: number; height: number }) => ({
      source: { width: bitmap.width, height: bitmap.height, style: { scaleMode: 'nearest' } },
      destroy: textureDestroy,
    }),
  },
}));

import { TextureManager } from './TextureManager';

afterEach(() => {
  vi.unstubAllGlobals();
  textureDestroy.mockClear();
});

describe('TextureManager CPU lifecycle', () => {
  it('keeps a decoded bitmap in the byte LRU after upload and closes it on destroy', async () => {
    const close = vi.fn();
    const bitmap = { width: 64, height: 32, close };
    const fetchMock = vi.fn(async () => ({ ok: true, blob: async () => new Blob(['image']) }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
    const manager = new TextureManager({ texture: { initSource: vi.fn() } }, () => undefined, { gpuBudgetBytes: 1024 * 1024 });
    const pending = manager.request({ assetId: 'asset', mip: 128, url: 'refcanvas-asset://asset', priority: 100 });
    await vi.waitFor(() => expect(manager.uploads.length).toBe(1));
    manager.processFrame();
    const entry = await pending;
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(manager.cpu.size).toBe(1);
    expect(manager.cpu.bytes).toBe(64 * 32 * 4);
    expect(close).not.toHaveBeenCalled();
    manager.release(entry.key);
    manager.destroy();
    expect(close).toHaveBeenCalledOnce();
    expect(textureDestroy).toHaveBeenCalled();
  });
});
