import type { ImageItem, PickedColor } from './types';

export interface ImagePixelPoint { x: number; y: number; u: number; v: number }

export function imagePixelFromWorld(item: ImageItem, worldX: number, worldY: number): ImagePixelPoint | undefined {
  if (item.width <= 0 || item.height <= 0 || item.crop.width <= 0 || item.crop.height <= 0) return;
  const centerX = item.x + item.width / 2;
  const centerY = item.y + item.height / 2;
  const radians = item.rotation * Math.PI / 180;
  const deltaX = worldX - centerX;
  const deltaY = worldY - centerY;
  let localX = deltaX * Math.cos(radians) + deltaY * Math.sin(radians);
  let localY = -deltaX * Math.sin(radians) + deltaY * Math.cos(radians);
  if (item.flipX) localX = -localX;
  if (item.flipY) localY = -localY;
  const u = localX / item.width + 0.5;
  const v = localY / item.height + 0.5;
  if (u < 0 || u >= 1 || v < 0 || v >= 1) return;
  const x = Math.max(0, Math.min(item.naturalWidth - 1, Math.floor(item.crop.x + u * item.crop.width)));
  const y = Math.max(0, Math.min(item.naturalHeight - 1, Math.floor(item.crop.y + v * item.crop.height)));
  return { x, y, u, v };
}

export function topmostImagePixel(items: ImageItem[], hiddenIds: Set<string>, worldX: number, worldY: number) {
  for (const item of [...items].sort((a, b) => b.zIndex - a.zIndex)) {
    if (hiddenIds.has(item.id)) continue;
    const pixel = imagePixelFromWorld(item, worldX, worldY);
    if (pixel) return { item, pixel };
  }
  return undefined;
}

export function rgbToHex(red: number, green: number, blue: number) {
  return `#${[red, green, blue].map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

export function pickedColorFromRgba(red: number, green: number, blue: number, alpha: number): PickedColor | undefined {
  if (alpha <= 0) return;
  const r = Math.max(0, Math.min(255, Math.round(red)));
  const g = Math.max(0, Math.min(255, Math.round(green)));
  const b = Math.max(0, Math.min(255, Math.round(blue)));
  return { r, g, b, a: Math.max(0, Math.min(255, Math.round(alpha))), hex: rgbToHex(r, g, b) };
}
