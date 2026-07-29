import { Assets, ColorMatrixFilter, Rectangle, Sprite, Texture, type Container } from 'pixi.js';
import type { ImageItem, Scene } from '../../types';
import { resolveCanvasImageUrl } from '../assets/AssetPathResolver';
import { RenderObjectRegistry } from './RenderObjectRegistry';

interface ImageRenderObject {
  sprite: Sprite;
  url?: string;
  loadToken: number;
  frameTexture?: Texture;
  destroy(): void;
}

function cropFrame(textureWidth: number, textureHeight: number, item: ImageItem) {
  const sourceWidth = Math.max(1, item.naturalWidth);
  const sourceHeight = Math.max(1, item.naturalHeight);
  const scaleX = textureWidth / sourceWidth;
  const scaleY = textureHeight / sourceHeight;
  return new Rectangle(
    item.crop.x * scaleX,
    item.crop.y * scaleY,
    Math.max(1, item.crop.width * scaleX),
    Math.max(1, item.crop.height * scaleY),
  );
}

function updateSprite(sprite: Sprite, item: ImageItem) {
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
    const grayscale = new ColorMatrixFilter();
    grayscale.grayscale(1, false);
    sprite.filters = [grayscale];
  } else sprite.filters = [];
}

export class ImageRenderer {
  private readonly objects = new RenderObjectRegistry<ImageRenderObject>();
  private scene?: Scene;

  constructor(private readonly layer: Container, private readonly requestRender: () => void) {
    layer.sortableChildren = true;
  }

  sync(scene: Scene) {
    this.scene = scene;
    const retained = new Set(scene.items.map((item) => item.id));
    this.objects.retain(retained);
    scene.items.forEach((item) => this.syncItem(scene, item));
  }

  private syncItem(scene: Scene, item: ImageItem) {
    let object = this.objects.get(item.id);
    if (!object) {
      const sprite = new Sprite(Texture.EMPTY);
      object = {
        sprite, loadToken: 0,
        destroy() {
          this.loadToken += 1;
          this.frameTexture?.destroy(false);
          this.sprite.destroy({ children: true, texture: false, textureSource: false });
        },
      };
      this.objects.set(item.id, object);
      this.layer.addChild(sprite);
    }
    updateSprite(object.sprite, item);
    const url = resolveCanvasImageUrl(scene, item, 'thumb1024');
    if (!url || object.url === url) {
      if (object.frameTexture) this.applyFrame(object, item, object.frameTexture.source);
      return;
    }
    object.url = url;
    const token = ++object.loadToken;
    void Assets.load<Texture>(url).then((texture) => {
      if (object?.loadToken !== token || object.url !== url) return;
      const currentItem = this.scene?.items.find((candidate) => candidate.id === item.id);
      if (!currentItem) return;
      this.applyFrame(object, currentItem, texture.source);
      this.requestRender();
    }).catch((error: unknown) => {
      if (object?.loadToken === token) console.error(`Failed to load canvas image ${item.id}`, error);
    });
  }

  private applyFrame(object: ImageRenderObject, item: ImageItem, source: Texture['source']) {
    object.frameTexture?.destroy(false);
    const base = new Texture({ source, frame: cropFrame(source.width, source.height, item) });
    object.frameTexture = base;
    object.sprite.texture = base;
    updateSprite(object.sprite, item);
  }

  destroy() { this.objects.destroy(); }
}
