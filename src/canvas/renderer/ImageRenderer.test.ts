import { afterEach, describe, expect, it, vi } from 'vitest';
import { Container, Texture, TextureSource } from 'pixi.js';
import { createScene } from '../../domain/scene';
import { imageRequestKey } from '../../shared/imagePipelineConfig';
import { CAMERA_SETTLE_MS } from '../runtime/CanvasConfig';
import { MIP_DOWNGRADE_DELAY_MS } from '../textures/MipSelector';
import type { TextureManager } from '../textures/TextureManager';
import { ImageRenderer } from './ImageRenderer';

// No WebGL context is needed to exercise texture selection and frame timing.
vi.mock('pixi.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('pixi.js')>(),
  ColorMatrixFilter: class { grayscale() {} destroy() {} },
}));

afterEach(() => { vi.useRealTimers(); });

describe('ImageRenderer quality refresh', () => {
  it('upgrades during zoom, wakes after motion and downgrade delays, and cancels on destroy', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const uploaded: Texture[] = [];
    const request = vi.fn(async ({ assetId, mip }: Parameters<TextureManager['request']>[0]) => {
      const texture = new Texture({ source: new TextureSource({ width: mip, height: mip / 2 }) });
      uploaded.push(texture);
      return { key: imageRequestKey(assetId, mip), texture, width: mip, height: mip / 2,
        estimatedBytes: mip * mip * 2, pinCount: 1, dispose: () => texture.destroy(true) };
    });
    const textures = { request, release: vi.fn() } as unknown as TextureManager;
    const requestRender = vi.fn();
    const layer = new Container();
    const renderer = new ImageRenderer(layer, textures, requestRender);
    const scene = createScene();
    scene.items = [{
      id: 'image', assetId: 'asset', name: 'image', sourceType: 'file',
      naturalWidth: 2048, naturalHeight: 1024, x: 0, y: 0, width: 400, height: 200,
      rotation: 0, flipX: false, flipY: false, opacity: 1, zIndex: 0, locked: false,
      crop: { x: 0, y: 0, width: 2048, height: 1024 },
    }];
    renderer.sync(scene);
    const render = async (scale: number, cameraMoving: boolean) => {
      renderer.updateQuality({
        viewport: { x: 0, y: 0, scale }, devicePixelRatio: 1, cameraMoving, now: performance.now(),
        visible: new Set(['image']), prefetch: new Set(['image']),
        visibleBounds: { x: 0, y: 0, width: 800, height: 600 },
        prefetchBounds: { x: 0, y: 0, width: 800, height: 600 },
      });
      await Promise.resolve();
      renderer.commitPendingSwaps();
    };

    try {
      await render(1, false); // Initial 128px safety preview.
      await render(1, false);
      expect(renderer.displayedMips()).toBe('512');
      await render(4, true);
      expect(renderer.displayedMips()).toBe('2048');

      await render(1, true);
      expect(renderer.displayedMips()).toBe('2048');
      requestRender.mockClear();
      await vi.advanceTimersByTimeAsync(CAMERA_SETTLE_MS - 1);
      expect(requestRender).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(requestRender).toHaveBeenCalledOnce();

      await render(1, false); // The settled frame starts the downgrade delay.
      requestRender.mockClear();
      await vi.advanceTimersByTimeAsync(MIP_DOWNGRADE_DELAY_MS / 2);
      await render(1, false); // An unrelated frame must not postpone the deadline.
      expect(renderer.displayedMips()).toBe('2048');
      await vi.advanceTimersByTimeAsync(MIP_DOWNGRADE_DELAY_MS / 2 - 1);
      expect(requestRender).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(requestRender).toHaveBeenCalledOnce();
      await render(1, false);
      expect(renderer.displayedMips()).toBe('512');
      expect(vi.getTimerCount()).toBe(0);

      await render(4, true);
      requestRender.mockClear();
      renderer.destroy();
      await vi.advanceTimersByTimeAsync(CAMERA_SETTLE_MS + MIP_DOWNGRADE_DELAY_MS);
      expect(requestRender).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      renderer.destroy();
      layer.destroy();
      uploaded.forEach((texture) => texture.destroy(true));
    }
  });
});
