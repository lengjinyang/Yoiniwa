import { ColorMatrixFilter, Rectangle, Sprite, Texture, type Container } from 'pixi.js';
import type { SceneItem, Scene, Viewport } from '../../types';
import { isVideoItem } from '../../domain/media';
import { imageRequestKey, IMAGE_WHOLE_TEXTURE_EDGE } from '../../shared/imagePipelineConfig';
import { resolveCanvasMipUrl } from '../assets/AssetPathResolver';
import { desiredImageMip, mipWithHysteresis, requiredImageEdge, type MipSelectionState } from '../textures/MipSelector';
import type { GpuTextureEntry } from '../textures/GpuTextureCache';
import type { TextureManager } from '../textures/TextureManager';
import { RenderObjectRegistry } from './RenderObjectRegistry';
import { TileRenderer } from './TileRenderer';
import type { SceneBounds } from '../scene/SceneNode';
import { shouldUseTiledImage } from '../textures/TileSelector';

import { imageGrayscaleContrast } from '../../imageAdjustments';

interface PendingSwap { entry: GpuTextureEntry; mip: number; token: number }
interface ImageRenderObject {
  sprite: Sprite;
  grayscale: ColorMatrixFilter;
  loadToken: number;
  targetKey?: string;
  textureKey?: string;
  currentMip?: number;
  mipState: MipSelectionState;
  frameTexture?: Texture;
  pendingSwap?: PendingSwap;
  lastRelevantAt: number;
  destroy(): void;
}

function cropFrame(textureWidth: number, textureHeight: number, item: SceneItem) {
  const scaleX = textureWidth / Math.max(1, item.naturalWidth);
  const scaleY = textureHeight / Math.max(1, item.naturalHeight);
  return new Rectangle(item.crop.x * scaleX, item.crop.y * scaleY,
    Math.max(1, item.crop.width * scaleX), Math.max(1, item.crop.height * scaleY));
}

function updateSprite(object: ImageRenderObject, item: SceneItem) {
  const { sprite } = object;
  sprite.visible = !item.hidden;
  sprite.position.set(item.x + item.width / 2, item.y + item.height / 2);
  sprite.anchor.set(0.5);
  const scaleX = Math.max(0.01, item.width) / Math.max(1, sprite.texture.width);
  const scaleY = Math.max(0.01, item.height) / Math.max(1, sprite.texture.height);
  sprite.scale.set(scaleX * (item.flipX ? -1 : 1), scaleY * (item.flipY ? -1 : 1));
  sprite.rotation = item.rotation * Math.PI / 180;
  sprite.alpha = item.opacity;
  sprite.zIndex = item.zIndex;
  if (item.grayscale) {
    object.grayscale.desaturate();
    object.grayscale.contrast(imageGrayscaleContrast(item) - 1, true);
  }
  sprite.filters = item.grayscale ? [object.grayscale] : [];
}

export class ImageRenderer {
  private readonly objects = new RenderObjectRegistry<ImageRenderObject>();
  private scene?: Scene;
  private readonly items = new Map<string, SceneItem>();
  private readonly tiles: TileRenderer;

  constructor(private readonly layer: Container, private readonly textures: TextureManager, private readonly requestRender: () => void) {
    layer.sortableChildren = true;
    this.tiles = new TileRenderer(layer, textures, requestRender);
  }

  sync(scene: Scene) {
    this.scene = scene;
    this.items.clear();
    scene.items.filter((item) => !isVideoItem(item, scene.assets)).forEach((item) => this.items.set(item.id, item));
    this.tiles.sync({ ...scene, items: [...this.items.values()] });
    const retained = new Set(this.items.keys());
    this.objects.retain(retained);
    this.items.forEach((item) => this.syncItem(item));
  }

  updateQuality(options: {
    viewport: Viewport; visible: ReadonlySet<string>; prefetch: ReadonlySet<string>;
    visibleBounds: SceneBounds; prefetchBounds: SceneBounds;
    devicePixelRatio: number; cameraMoving: boolean; now: number;
  }) {
    if (!this.scene) return;
    this.objects.forEach((object, id) => {
      const item = this.items.get(id);
      if (!item || item.hidden) return;
      const isVisible = options.visible.has(id);
      const isPrefetch = options.prefetch.has(id);
      object.sprite.renderable = isVisible || isPrefetch;
      if (!isVisible && !isPrefetch) {
        object.sprite.renderable = false;
        // A short grace period prevents a fast pan out-and-back from discarding
        // the only stable texture and briefly showing an empty sprite.
        if (options.now - object.lastRelevantAt >= 1500) {
          this.releaseObjectTextures(object);
          this.tiles.release(id);
        }
        return;
      }
      object.lastRelevantAt = options.now;
      if (object.currentMip === undefined) {
        // Put a tiny, bounded safety plane on screen before asking for the
        // final display Mip. This keeps a newly imported image visible while
        // its sharper level is generated and uploaded in the background.
        if (!object.pendingSwap) {
          const previewMip = Math.min(128, Math.max(1, item.naturalWidth, item.naturalHeight));
          this.requestMip(object, item, previewMip, isVisible ? 120 : 30);
        }
        return;
      }
      const desired = desiredImageMip(item, options.viewport, options.devicePixelRatio);
      const required = requiredImageEdge(item, options.viewport, options.devicePixelRatio);
      const selected = mipWithHysteresis({
        desired, required, state: object.mipState, now: options.now,
        cameraMoving: options.cameraMoving,
      });
      object.mipState = { ...selected.state, displayedMip: object.currentMip };
      const tiled = shouldUseTiledImage(item, required);
      // Keep an already displayed whole texture as the stable safety plane.
      // A direct high-zoom entry starts with a bounded 1024px plane while its
      // complete visible tile set is decoded and uploaded in later frames.
      const wholeMip = tiled
        ? Math.max(object.currentMip ?? 0, Math.min(selected.mip, IMAGE_WHOLE_TEXTURE_EDGE))
        : selected.mip;
      this.requestMip(object, item, wholeMip, isVisible ? 100 : 20);
      this.tiles.update(item, required, isVisible ? options.visibleBounds : options.prefetchBounds, isVisible ? 120 : 15);
    });
  }

  /** Called immediately before Pixi renders, so a completed upload never swaps mid-frame. */
  commitPendingSwaps() {
    let swapped = false;
    this.objects.forEach((object, id) => {
      const pending = object.pendingSwap;
      const item = this.items.get(id);
      if (!pending || !item || pending.token !== object.loadToken) return;
      object.pendingSwap = undefined;
      object.frameTexture?.destroy(false);
      const source = pending.entry.texture.source;
      const frame = new Texture({ source, frame: cropFrame(source.width, source.height, item) });
      object.frameTexture = frame;
      object.sprite.texture = frame;
      const oldKey = object.textureKey;
      object.textureKey = pending.entry.key;
      object.currentMip = pending.mip;
      object.mipState = { displayedMip: pending.mip };
      object.targetKey = undefined;
      updateSprite(object, item);
      swapped = true;
      if (oldKey && oldKey !== object.textureKey) this.textures.release(oldKey);
    });
    this.tiles.commitPendingSwaps();
    this.objects.forEach((object, id) => {
      if (this.tiles.hasCurrent(id)) object.sprite.renderable = false;
    });
    if (swapped) this.requestRender();
  }

  private syncItem(item: SceneItem) {
    let object = this.objects.get(item.id);
    if (!object) {
      const sprite = new Sprite(Texture.EMPTY);
      const grayscale = new ColorMatrixFilter();
      grayscale.grayscale(1, false);
      const textures = this.textures;
      object = {
        sprite, grayscale, loadToken: 0, mipState: {}, lastRelevantAt: performance.now(),
        destroy() {
          this.loadToken += 1;
          if (this.pendingSwap) textures.release(this.pendingSwap.entry.key);
          if (this.textureKey) textures.release(this.textureKey);
          this.frameTexture?.destroy(false);
          this.sprite.destroy({ children: true, texture: false, textureSource: false });
          this.grayscale.destroy();
        },
      };
      this.objects.set(item.id, object);
      this.layer.addChild(sprite);
    }
    updateSprite(object, item);
    if (object.frameTexture) {
      const source = object.frameTexture.source;
      object.frameTexture.destroy(false);
      object.frameTexture = new Texture({ source, frame: cropFrame(source.width, source.height, item) });
      object.sprite.texture = object.frameTexture;
      updateSprite(object, item);
    }
  }

  private requestMip(object: ImageRenderObject, item: SceneItem, mip: number, priority: number) {
    if (!this.scene || !item.assetId) return;
    const key = imageRequestKey(item.assetId, mip);
    if (object.textureKey === key || object.targetKey === key) return;
    const url = resolveCanvasMipUrl(this.scene, item, mip, priority);
    if (!url) return;
    object.targetKey = key;
    const token = ++object.loadToken;
    void this.textures.request({ assetId: item.assetId, mip, url, priority }).then((entry) => {
      if (object.loadToken !== token || object.targetKey !== key || !this.items.has(item.id)) {
        this.textures.release(entry.key);
        return;
      }
      if (object.pendingSwap) this.textures.release(object.pendingSwap.entry.key);
      object.pendingSwap = { entry, mip, token };
      this.requestRender();
    }).catch((error: unknown) => {
      if (object.loadToken === token) {
        object.targetKey = undefined;
        window.dispatchEvent(new CustomEvent('refcanvas-resource-error', { detail: { itemId: item.id, error } }));
      }
    });
  }

  private releaseObjectTextures(object: ImageRenderObject) {
    object.loadToken += 1;
    object.targetKey = undefined;
    if (object.pendingSwap) { this.textures.release(object.pendingSwap.entry.key); object.pendingSwap = undefined; }
    if (object.textureKey) { this.textures.release(object.textureKey); object.textureKey = undefined; }
    object.frameTexture?.destroy(false);
    object.frameTexture = undefined;
    object.currentMip = undefined;
    object.mipState = {};
    object.sprite.texture = Texture.EMPTY;
  }

  displayedMips() {
    const mips = new Set<number>();
    this.objects.forEach((object) => { if (object.currentMip) mips.add(object.currentMip); });
    return [...mips].sort((a, b) => a - b).join(', ') || '-';
  }

  invalidateTextures() {
    this.tiles.invalidateAll();
    this.objects.forEach((object) => this.releaseObjectTextures(object));
  }

  destroy() { this.tiles.destroy(); this.objects.destroy(); }
}
