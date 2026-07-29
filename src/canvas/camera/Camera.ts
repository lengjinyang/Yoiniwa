import type { Viewport } from '../../types';
import { clampCameraScale } from './CameraConstraints';
import { screenToWorld, type Point, worldToScreen } from './CoordinateTransform';

export class Camera {
  private viewport: Viewport;

  constructor(initial: Viewport = { x: 0, y: 0, scale: 1 }) {
    this.viewport = { ...initial, scale: clampCameraScale(initial.scale) };
  }

  snapshot(): Viewport { return { ...this.viewport }; }
  set(next: Viewport) { this.viewport = { ...next, scale: clampCameraScale(next.scale) }; }
  panBy(deltaX: number, deltaY: number) {
    this.viewport.x += deltaX;
    this.viewport.y += deltaY;
  }
  zoomAt(screen: Point, factor: number) {
    const world = screenToWorld(screen, this.viewport);
    const scale = clampCameraScale(this.viewport.scale * factor);
    this.viewport = { x: screen.x - world.x * scale, y: screen.y - world.y * scale, scale };
  }
  worldToScreen(point: Point) { return worldToScreen(point, this.viewport); }
  screenToWorld(point: Point) { return screenToWorld(point, this.viewport); }
}
