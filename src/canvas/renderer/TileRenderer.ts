import { ColorMatrixFilter, Container, Graphics, Sprite } from 'pixi.js';
import { IMAGE_TILE_GUTTER, IMAGE_TILE_SIZE } from '../../shared/imagePipelineConfig';
import type { SceneItem, Scene } from '../../types';
import { imageGrayscaleContrast } from '../../imageAdjustments';
import { resolveCanvasTileUrl } from '../assets/AssetPathResolver';
import type { SceneBounds } from '../scene/SceneNode';
import type { GpuTextureEntry } from '../textures/GpuTextureCache';
import { selectVisibleTiles, shouldUseTiledImage, type TileAddress } from '../textures/TileSelector';
import type { TextureManager } from '../textures/TextureManager';
import { RenderObjectRegistry } from './RenderObjectRegistry';

interface TileSet { signature: string; container: Container; grayscale: ColorMatrixFilter; textureKeys: string[] }
interface PendingTileSet {
  signature: string; token: number; item: SceneItem; levelWidth: number; levelHeight: number;
  tiles: TileAddress[]; entries: GpuTextureEntry[];
}
interface TileRenderObject {
  token: number;
  current?: TileSet;
  pending?: PendingTileSet;
  targetSignature?: string;
  destroy(): void;
}

export class TileRenderer {
  private readonly objects = new RenderObjectRegistry<TileRenderObject>();
  private scene?: Scene;

  constructor(private readonly layer: Container, private readonly textures: TextureManager, private readonly requestRender: () => void) {}

  sync(scene: Scene) {
    this.scene = scene;
    this.objects.retain(new Set(scene.items.map((item) => item.id)));
    scene.items.forEach((item) => {
      const object = this.objects.get(item.id);
      if (object?.current) this.updateTileSet(object.current, item);
    });
  }

  update(item: SceneItem, requiredEdge: number, worldBounds: SceneBounds, priority: number) {
    if (!this.scene || !item.assetId || !shouldUseTiledImage(item, requiredEdge)) {
      this.release(item.id);
      return;
    }
    let object = this.objects.get(item.id);
    if (!object) {
      const textures = this.textures;
      object = {
        token: 0,
        destroy() {
          this.token += 1;
          this.current?.textureKeys.forEach((key) => textures.release(key));
          this.current?.container.destroy({ children: true });
          this.current?.grayscale.destroy();
          this.pending?.entries.forEach((entry) => textures.release(entry.key));
        },
      };
      this.objects.set(item.id, object);
    }
    const selection = selectVisibleTiles(item, worldBounds, requiredEdge);
    const signature = `${item.assetId}:${selection.level}:${selection.tiles.map((tile) => `${tile.column},${tile.row}`).join(';')}`;
    if (object.current?.signature === signature || object.targetSignature === signature) return;
    const token = ++object.token;
    object.targetSignature = signature;
    const requests = selection.tiles.map((tile) => {
      const url = resolveCanvasTileUrl(item, tile.level, tile.column, tile.row);
      if (!url) throw new Error('Tile asset URL is unavailable');
      return this.textures.request({
        assetId: item.assetId as string, mip: tile.level, tileX: tile.column, tileY: tile.row, url, priority,
      });
    });
    void Promise.allSettled(requests).then((results) => {
      const entries = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
      const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failure) {
        entries.forEach((entry) => this.textures.release(entry.key));
        throw failure.reason;
      }
      if (object?.token !== token || object.targetSignature !== signature) {
        entries.forEach((entry) => this.textures.release(entry.key));
        return;
      }
      if (object.pending) object.pending.entries.forEach((entry) => this.textures.release(entry.key));
      object.pending = { signature, token, item, levelWidth: selection.levelWidth, levelHeight: selection.levelHeight, tiles: selection.tiles, entries };
      this.requestRender();
    }).catch((error: unknown) => {
      if (object?.token === token) {
        object.targetSignature = undefined;
        window.dispatchEvent(new CustomEvent('refcanvas-resource-error', { detail: { itemId: item.id, error } }));
      }
    });
  }

  commitPendingSwaps() {
    this.objects.forEach((object) => {
      const pending = object.pending;
      if (!pending || pending.token !== object.token) return;
      const item = this.scene?.items.find((value) => value.id === pending.item.id) ?? pending.item;
      const tileSet = this.createTileSet(pending, item);
      object.current?.textureKeys.forEach((key) => this.textures.release(key));
      object.current?.container.destroy({ children: true });
      object.current?.grayscale.destroy();
      object.current = tileSet;
      object.pending = undefined;
      object.targetSignature = undefined;
      this.layer.addChild(tileSet.container);
    });
  }

  release(id: string) {
    const object = this.objects.get(id);
    if (!object) return;
    object.token += 1;
    object.targetSignature = undefined;
    object.pending?.entries.forEach((entry) => this.textures.release(entry.key));
    object.pending = undefined;
    object.current?.textureKeys.forEach((key) => this.textures.release(key));
    object.current?.container.destroy({ children: true });
    object.current?.grayscale.destroy();
    object.current = undefined;
  }

  destroy() { this.objects.destroy(); }
  invalidateAll() { this.objects.forEach((_object, id) => this.release(id)); }
  hasCurrent(id: string) { return Boolean(this.objects.get(id)?.current); }

  private createTileSet(pending: PendingTileSet, item: SceneItem): TileSet {
    const container = new Container();
    const grayscale = new ColorMatrixFilter();
    container.sortableChildren = true;
    pending.tiles.forEach((tile, index) => {
      const entry = pending.entries[index];
      const sprite = new Sprite(entry.texture);
      const left = Math.max(0, tile.column * IMAGE_TILE_SIZE - IMAGE_TILE_GUTTER);
      const top = Math.max(0, tile.row * IMAGE_TILE_SIZE - IMAGE_TILE_GUTTER);
      const sourceX = left / pending.levelWidth * pending.item.naturalWidth;
      const sourceY = top / pending.levelHeight * pending.item.naturalHeight;
      const sourceWidth = entry.width / pending.levelWidth * pending.item.naturalWidth;
      const sourceHeight = entry.height / pending.levelHeight * pending.item.naturalHeight;
      sprite.position.set(
        (sourceX - pending.item.crop.x) / pending.item.crop.width * pending.item.width - pending.item.width / 2,
        (sourceY - pending.item.crop.y) / pending.item.crop.height * pending.item.height - pending.item.height / 2,
      );
      sprite.width = sourceWidth / pending.item.crop.width * pending.item.width;
      sprite.height = sourceHeight / pending.item.crop.height * pending.item.height;
      container.addChild(sprite);
    });
    const mask = new Graphics().rect(-pending.item.width / 2, -pending.item.height / 2, pending.item.width, pending.item.height).fill(0xffffff);
    container.addChild(mask);
    container.mask = mask;
    const tileSet = { signature: pending.signature, container, grayscale,
      textureKeys: pending.entries.map((entry) => entry.key) };
    this.updateTileSet(tileSet, item);
    return tileSet;
  }

  private updateTileSet(tileSet: TileSet, item: SceneItem) {
    const { container, grayscale } = tileSet;
    container.position.set(item.x + item.width / 2, item.y + item.height / 2);
    container.rotation = item.rotation * Math.PI / 180;
    container.scale.set(item.flipX ? -1 : 1, item.flipY ? -1 : 1);
    container.alpha = item.opacity;
    container.visible = !item.hidden;
    container.zIndex = item.zIndex + 0.5;
    if (item.grayscale) {
      grayscale.desaturate();
      grayscale.contrast(imageGrayscaleContrast(item) - 1, true);
    }
    container.filters = item.grayscale ? [grayscale] : [];
  }
}
