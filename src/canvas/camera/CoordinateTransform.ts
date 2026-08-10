import type { Viewport } from '../../types';

export interface Point { x: number; y: number }

export function worldToScreen(point: Point, viewport: Viewport): Point {
  return { x: viewport.x + point.x * viewport.scale, y: viewport.y + point.y * viewport.scale };
}

export function screenToWorld(point: Point, viewport: Viewport): Point {
  return { x: (point.x - viewport.x) / viewport.scale, y: (point.y - viewport.y) / viewport.scale };
}
