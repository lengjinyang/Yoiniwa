import { Texture } from 'pixi.js';
import type { Scene, VideoItem } from '../../types';
import { resolveCanvasMipUrl } from '../assets/AssetPathResolver';
import type { TextureManager } from '../textures/TextureManager';
import { bindVideoSprite, videoPosterUrl } from './VideoPresentation';
import type { VideoRenderObject } from './VideoTypes';
import { VIDEO_POSTER_RELEASE_DELAY_MS, videoShouldShowPoster } from './VideoPerformancePolicy';

export interface VideoPosterHost {
  requestRender(): void;
  scene(): Scene | undefined;
  items: Map<string, VideoItem>;
  textures: TextureManager;
  bindObjectSprite(object: VideoRenderObject, texture?: Texture): void;
}

export class VideoPosterController {
  constructor(private readonly host: VideoPosterHost) {}

  ensure(
    object: VideoRenderObject,
    item: VideoItem,
    edge: number,
    priority: number,
    cameraMoving = false,
  ) {
    const scene = this.host.scene();
    if (!scene || object.posterLoading || !item.assetId) return;
    if (object.posterTexture && !object.posterTexture.destroyed && (object.posterEdge ?? 0) >= edge) {
      if (videoShouldShowPoster(object.phase, object.sprite.texture === object.videoTexture && object.lastUploadAt > 0, object.displayedFrame)) {
        bindVideoSprite(object.sprite, item, object.posterTexture);
      }
      return;
    }
    if (cameraMoving && object.posterTexture && !object.posterTexture.destroyed) return;
    if (object.posterTargetEdge === edge) return;
    const legacyPosterId = item.posterAssetId;
    const posterAssetId = legacyPosterId ?? item.assetId;
    const url = legacyPosterId
      ? resolveCanvasMipUrl(scene, { ...item, assetId: legacyPosterId }, edge, priority)
      : videoPosterUrl(item.assetId, edge, priority);
    if (!url) return;
    object.posterLoading = true;
    object.posterTargetEdge = edge;
    const token = ++object.posterToken;
    void this.host.textures.request({ assetId: posterAssetId, mip: edge, url, priority }).then((entry) => {
      object.posterLoading = false;
      object.posterTargetEdge = undefined;
      if (object.posterToken !== token || !this.host.items.has(item.id)) {
        this.host.textures.release(entry.key);
        return;
      }
      if (object.posterKey && object.posterKey !== entry.key) this.host.textures.release(object.posterKey);
      object.posterKey = entry.key;
      object.posterAssetId = posterAssetId;
      object.posterTexture = entry.texture;
      object.posterEdge = edge;
      if (videoShouldShowPoster(object.phase, object.sprite.texture === object.videoTexture && object.lastUploadAt > 0, object.displayedFrame)) {
        bindVideoSprite(object.sprite, item, entry.texture);
      }
      this.host.requestRender();
    }).catch(() => {
      if (object.posterToken === token) {
        object.posterLoading = false;
        object.posterTargetEdge = undefined;
      }
    });
  }

  scheduleRelease(object: VideoRenderObject) {
    if (object.posterReleaseTimer !== undefined || !object.posterTexture) return;
    object.posterReleaseTimer = window.setTimeout(() => {
      object.posterReleaseTimer = undefined;
      if (!object.visible && !object.prefetched) {
        this.release(object);
        if (!object.videoTexture) this.host.bindObjectSprite(object, Texture.EMPTY);
        this.host.requestRender();
      }
    }, VIDEO_POSTER_RELEASE_DELAY_MS);
  }

  release(object: VideoRenderObject) {
    if (object.posterReleaseTimer !== undefined) window.clearTimeout(object.posterReleaseTimer);
    object.posterReleaseTimer = undefined;
    object.posterToken += 1;
    object.posterLoading = false;
    object.posterTargetEdge = undefined;
    if (object.posterKey) this.host.textures.release(object.posterKey);
    object.posterKey = undefined;
    object.posterAssetId = undefined;
    object.posterTexture = undefined;
    object.posterEdge = undefined;
  }
}
