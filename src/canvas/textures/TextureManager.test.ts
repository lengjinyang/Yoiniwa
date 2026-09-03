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

  it('boosts native generation only on a cold request or a priority increase, not a CPU cache hit', async () => {
    const boostImageResource = vi.fn();
    const fetchMock = vi.fn(async () => ({ ok: true, blob: async () => new Blob(['image']) }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 8, height: 8, close: vi.fn() })));
    const manager = new TextureManager({ texture: { initSource: vi.fn() } }, () => undefined, {
      gpuBudgetBytes: 1024 * 1024,
      boostImageResource,
    });
    const request = { assetId: 'asset', mip: 128, url: 'refcanvas-asset://asset', priority: 40 };
    const pending = [manager.request(request), manager.request(request)];
    expect(boostImageResource).toHaveBeenCalledOnce();
    expect(boostImageResource).toHaveBeenCalledWith('refcanvas-asset://asset', 40);
    pending.push(manager.request({ ...request, priority: 100 }));
    pending.push(manager.request({ ...request, priority: 80 }));
    pending.push(manager.request({ ...request, priority: 100 }));
    expect(boostImageResource).toHaveBeenCalledTimes(2);
    expect(boostImageResource).toHaveBeenLastCalledWith(request.url, 100);
    await vi.waitFor(() => expect(manager.uploads.length).toBe(1));
    // Starting the actual fetch must not send a second notification.
    expect(boostImageResource).toHaveBeenCalledTimes(2);
    manager.processFrame();
    const entries = await Promise.all(pending);
    expect(entries.every((entry) => entry === entries[0])).toBe(true);
    expect(entries[0].pinCount).toBe(pending.length);
    entries.forEach((entry) => manager.release(entry.key));
    expect(entries[0].pinCount).toBe(0);

    // Re-uploading an evicted GPU texture can reuse the decoded CPU bitmap.
    manager.gpu.delete(entries[0].key);
    const cached = manager.request({ ...request, priority: 200 });
    await vi.waitFor(() => expect(manager.uploads.length).toBe(1));
    manager.processFrame();
    const restored = await cached;
    expect(boostImageResource).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(createImageBitmap).toHaveBeenCalledOnce();
    manager.release(restored.key);
    manager.destroy();
  });
});
