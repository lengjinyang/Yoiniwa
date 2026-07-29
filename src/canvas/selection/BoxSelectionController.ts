import type { ImageItem } from '../../types';
import type { SceneBounds } from '../scene/SceneNode';
import { boundsIntersect, imageBounds } from './HitTestService';

export function boxFromPoints(start: { x: number; y: number }, end: { x: number; y: number }): SceneBounds {
  return { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) };
}

export function imagesInSelectionBox(items: ImageItem[], box: SceneBounds) {
  return items.filter((item) => !item.hidden && boundsIntersect(imageBounds(item), box)).map((item) => item.id);
}
