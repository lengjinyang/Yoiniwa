import type { ImageItem } from '../../types';
import type { SceneBounds } from '../scene/SceneNode';

export function imageBounds(item: ImageItem): SceneBounds {
  const radians = item.rotation * Math.PI / 180;
  const width = Math.abs(item.width * Math.cos(radians)) + Math.abs(item.height * Math.sin(radians));
  const height = Math.abs(item.width * Math.sin(radians)) + Math.abs(item.height * Math.cos(radians));
  const centerX = item.x + item.width / 2;
  const centerY = item.y + item.height / 2;
  return { x: centerX - width / 2, y: centerY - height / 2, width, height };
}

export function pointInImage(item: ImageItem, point: { x: number; y: number }) {
  const centerX = item.x + item.width / 2;
  const centerY = item.y + item.height / 2;
  const radians = -item.rotation * Math.PI / 180;
  const dx = point.x - centerX;
  const dy = point.y - centerY;
  const localX = dx * Math.cos(radians) - dy * Math.sin(radians);
  const localY = dx * Math.sin(radians) + dy * Math.cos(radians);
  return Math.abs(localX) <= item.width / 2 && Math.abs(localY) <= item.height / 2;
}

export function topmostImageAtPoint(items: ImageItem[], point: { x: number; y: number }) {
  return [...items].sort((a, b) => b.zIndex - a.zIndex)
    .find((item) => !item.hidden && pointInImage(item, point));
}

export function boundsIntersect(left: SceneBounds, right: SceneBounds) {
  return left.x <= right.x + right.width && left.x + left.width >= right.x
    && left.y <= right.y + right.height && left.y + left.height >= right.y;
}

export function unionImageBounds(items: ImageItem[]) {
  const bounds = items.map(imageBounds);
  if (!bounds.length) return undefined;
  const x = Math.min(...bounds.map((value) => value.x));
  const y = Math.min(...bounds.map((value) => value.y));
  const right = Math.max(...bounds.map((value) => value.x + value.width));
  const bottom = Math.max(...bounds.map((value) => value.y + value.height));
  return { x, y, width: right - x, height: bottom - y };
}
