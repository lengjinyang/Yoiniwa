import { Container, Texture, TextureSource } from 'pixi.js';
import { expect, it, vi } from 'vitest';
import { createScene } from '../../domain/scene';
import type { SceneItem } from '../../types';
import type { TextureManager } from '../textures/TextureManager';
import { TileRenderer } from './TileRenderer';

vi.mock('pixi.js', async (original) => ({
  ...await original<typeof import('pixi.js')>(),
  ColorMatrixFilter: class { destroy() {} },
}));

it('keeps loaded and pending tile geometry in sync with resize, crop, and flip edits', async () => {
  const texture = new Texture({ source: new TextureSource({ width: 512, height: 512 }) });
  const request = vi.fn(async () => ({ key: 'tile', texture, width: 512, height: 512 }));
  const textures = { release: vi.fn(), request } as unknown as TextureManager;
  const layer = new Container();
  const renderer = new TileRenderer(layer, textures, vi.fn());
  const item: SceneItem = { id: 'image', assetId: 'asset', name: 'image', sourceType: 'file',
    naturalWidth: 4096, naturalHeight: 4096, x: 0, y: 0, width: 1200, height: 1200,
    rotation: 0, flipX: false, flipY: false, opacity: 1, zIndex: 0, locked: false,
    crop: { x: 0, y: 0, width: 4096, height: 4096 } };
  const scene = createScene(); scene.items = [item];
  const bounds = { x: 0, y: 0, width: 5000, height: 5000 };
  try {
    renderer.sync(scene);
    renderer.update(item, 1500, bounds, 100);
    await Promise.resolve(); await Promise.resolve();
    const resized = { ...item, width: 1300, height: 1300 };
    renderer.sync({ ...scene, items: [resized] });
    renderer.commitPendingSwaps(); // Size changed while the first tiles were pending.
    const tileSet = layer.children[0];
    const sprite = tileSet.children[0].children[0];
    const mask = tileSet.children[1];
    const maskWidth = () => mask.toGlobal({ x: 0.5, y: 0 }).x - mask.toGlobal({ x: -0.5, y: 0 }).x;
    expect(sprite.getBounds().width).toBeCloseTo(325);
    expect(maskWidth()).toBeCloseTo(1300);
    const cropped = { ...resized, width: 1400, height: 1400, crop: { x: 100, y: 100, width: 3896, height: 3896 } };
    renderer.sync({ ...scene, items: [cropped] });
    renderer.update(cropped, 1750, bounds, 100);
    expect(layer.children[0]).toBe(tileSet);
    expect(request).toHaveBeenCalledTimes(16);
    expect(sprite.getBounds().width).toBeCloseTo(1024 / 3896 * 1400);
    expect(sprite.getBounds().x).toBeCloseTo(-100 / 3896 * 1400);
    expect(maskWidth()).toBeCloseTo(1400);
    renderer.sync({ ...scene, items: [{ ...cropped, flipX: true }] });
    expect(sprite.getBounds().x).toBeCloseTo(1400 - (1024 - 100) / 3896 * 1400);
  } finally {
    renderer.destroy(); layer.destroy(); texture.destroy(true);
  }
});
