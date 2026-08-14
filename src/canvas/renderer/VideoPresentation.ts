import { Graphics, Sprite, Texture } from 'pixi.js';
import { assetResourceUrl } from '../../assetResourceUrl';
import type { VideoItem } from '../../types';

export function updateTransform(sprite: Sprite, item: VideoItem, textureWidth: number, textureHeight: number) {
  sprite.visible = !item.hidden;
  sprite.position.set(item.x + item.width / 2, item.y + item.height / 2);
  sprite.anchor.set(0.5);
  const scaleX = Math.max(0.01, item.width) / Math.max(1, textureWidth);
  const scaleY = Math.max(0.01, item.height) / Math.max(1, textureHeight);
  sprite.scale.set(scaleX * (item.flipX ? -1 : 1), scaleY * (item.flipY ? -1 : 1));
  sprite.rotation = item.rotation * Math.PI / 180;
  sprite.alpha = item.opacity;
  sprite.zIndex = item.zIndex;
}

export function bindVideoSprite(sprite: Sprite, item: VideoItem, texture?: Texture) {
  const next = texture && !texture.destroyed ? texture : Texture.EMPTY;
  sprite.texture = next;
  // Always scale from the texture actually bound to the sprite. Mixing a
  // high-res poster with a low-res canvas scale (or the reverse) after zoom
  // makes the video cover the rest of the board.
  updateTransform(sprite, item, next.width, next.height);
}

const VIDEO_BADGE_SCREEN_HEIGHT = 18;
const VIDEO_BADGE_MAX_ITEM_FRACTION = 0.9;

export function videoBadgeWorldSize(item: Pick<VideoItem, 'width' | 'height'>, viewportScale: number) {
  const scale = Math.max(0.001, viewportScale);
  const worldHeight = VIDEO_BADGE_SCREEN_HEIGHT / scale;
  const maxHeight = Math.min(item.width, item.height) * VIDEO_BADGE_MAX_ITEM_FRACTION;
  const badgeHeight = Math.max(1 / scale, Math.min(worldHeight, maxHeight));
  return { width: badgeHeight * 1.35, height: badgeHeight, inset: badgeHeight * 0.48 };
}

export function drawVideoBadge(badge: Graphics, item: VideoItem, viewportScale: number, hide = false) {
  badge.clear();
  badge.visible = !item.hidden && !hide;
  if (!badge.visible) return;
  const { width: badgeWidth, height: badgeHeight, inset } = videoBadgeWorldSize(item, viewportScale);
  const localX = -item.width / 2 + badgeWidth / 2 + inset;
  const localY = -item.height / 2 + badgeHeight / 2 + inset;
  const rotation = item.rotation * Math.PI / 180;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  badge.position.set(
    item.x + item.width / 2 + localX * cos - localY * sin,
    item.y + item.height / 2 + localX * sin + localY * cos,
  );
  badge.rotation = rotation;
  badge.alpha = item.opacity;
  badge.zIndex = item.zIndex + 0.5;
  badge.roundRect(-badgeWidth / 2, -badgeHeight / 2, badgeWidth, badgeHeight, badgeHeight * 0.24)
    .fill({ color: 0x11141a, alpha: 0.72 });
  const frameWidth = badgeWidth * 0.46;
  const frameHeight = badgeHeight * 0.52;
  const scale = Math.max(0.001, viewportScale);
  badge.roundRect(-frameWidth * 0.58, -frameHeight / 2, frameWidth, frameHeight, badgeHeight * 0.08)
    .stroke({ color: 0xf4f6f8, alpha: 0.92, width: Math.max(1 / scale, badgeHeight * 0.07) });
  badge.moveTo(frameWidth * 0.18, -frameHeight * 0.28)
    .lineTo(frameWidth * 0.55, -frameHeight * 0.48)
    .lineTo(frameWidth * 0.55, frameHeight * 0.48)
    .lineTo(frameWidth * 0.18, frameHeight * 0.28)
    .closePath()
    .fill({ color: 0xf4f6f8, alpha: 0.92 });
}

export function ensureVideoHost(): HTMLElement {
  const existing = document.getElementById('yoiniwa-video-host');
  if (existing) return existing;
  const host = document.createElement('div');
  host.id = 'yoiniwa-video-host';
  host.setAttribute('aria-hidden', 'true');
  Object.assign(host.style, {
    position: 'fixed', width: '16px', height: '16px', opacity: '1', pointerEvents: 'none',
    overflow: 'hidden', left: '-32px', top: '0', zIndex: '-1',
  });
  document.body.appendChild(host);
  return host;
}

export function videoPosterUrl(assetId: string, edge: number, priority: number) {
  return assetResourceUrl(assetId, new URLSearchParams({
    variant: 'video-poster', edge: String(edge), priority: String(priority),
  }));
}
