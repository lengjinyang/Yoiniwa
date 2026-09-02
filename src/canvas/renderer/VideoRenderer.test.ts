import { describe, expect, it, vi } from 'vitest';

vi.mock('pixi.js', () => {
  const chain = () => ({
    clear() { return this; },
    roundRect() { return this; },
    fill() { return this; },
    stroke() { return this; },
    moveTo() { return this; },
    lineTo() { return this; },
    closePath() { return this; },
  });
  class Graphics {
    visible = true;
    rotation = 0;
    alpha = 1;
    zIndex = 0;
    position = { set() { return undefined; } };
    clear() { return Object.assign(this, chain()); }
    roundRect() { return this; }
    fill() { return this; }
    stroke() { return this; }
    moveTo() { return this; }
    lineTo() { return this; }
    closePath() { return this; }
    destroy() { return undefined; }
  }
  class Sprite {
    texture: unknown;
    visible = true;
    rotation = 0;
    alpha = 1;
    zIndex = 0;
    position = { set() { return undefined; } };
    anchor = { set() { return undefined; } };
    scale = { set() { return undefined; } };
    constructor(texture: unknown) { this.texture = texture; }
    destroy() { return undefined; }
  }
  class Container {
    sortableChildren = false;
    addChild() { return this; }
  }
  return {
    Graphics, Sprite, Container,
    Texture: { EMPTY: { width: 1, height: 1, destroyed: false } },
    CanvasSource: class {},
  };
});

import { Container } from 'pixi.js';
import { createScene } from '../../domain/scene';
import type { VideoItem } from '../../types';
import { TextureManager } from '../textures/TextureManager';
import { VideoRenderer } from './VideoRenderer';

function videoItem(): VideoItem {
  return {
    id: 'clip', name: 'clip', sourceType: 'file', mediaKind: 'video',
    naturalWidth: 1920, naturalHeight: 1080, x: 0, y: 0, width: 320, height: 180,
    rotation: 0, flipX: false, flipY: false, opacity: 1, zIndex: 1, locked: false,
    crop: { x: 0, y: 0, width: 1920, height: 1080 }, durationSec: 4,
  };
}

describe('VideoRenderer', () => {
  it('returns empty transport and stats until a video exists, then syncs a paused clip', () => {
    const textures = new TextureManager({ texture: { initSource: vi.fn() } }, () => undefined);
    const renderer = new VideoRenderer(new Container(), textures, () => undefined);
    expect(renderer.beginCanvasJog('missing')).toBe(false);
    expect(renderer.transportState('missing')).toBeUndefined();
    expect(renderer.stats()).toMatchObject({
      playbackIntents: 0, activeDecoders: 0, suspendedVideos: 0, posterTextures: 0,
    });

    const scene = createScene();
    scene.items = [videoItem()];
    renderer.sync(scene);
    expect(renderer.transportState('clip')).toMatchObject({
      id: 'clip', phase: 'paused', playing: false, duration: 4,
    });
    expect(renderer.setHoveredVideo('clip')).toBe(true);
    expect(renderer.setHoveredVideo('clip')).toBe(false);
    renderer.destroy();
    textures.destroy();
  });
});
