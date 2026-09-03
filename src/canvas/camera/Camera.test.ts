import { describe, expect, it } from 'vitest';
import { Camera } from './Camera';
import { clampCameraScale } from './CameraConstraints';
import { screenToWorld, worldToScreen } from './CoordinateTransform';
import { boundedDevicePixelRatio } from '../runtime/CanvasConfig';
import { MAX_ZOOM, MIN_ZOOM } from '../../shared/pointerPolicy';

describe('Pixi canvas camera', () => {
  it('round trips world and screen coordinates', () => {
    const viewport = { x: 120, y: -40, scale: 2.5 };
    const world = { x: 32, y: 18 };
    expect(screenToWorld(worldToScreen(world, viewport), viewport)).toEqual(world);
  });

  it('keeps the pointer world coordinate fixed while zooming', () => {
    const camera = new Camera({ x: 20, y: 30, scale: 1 });
    const anchor = { x: 400, y: 250 };
    const before = camera.screenToWorld(anchor);
    camera.zoomAt(anchor, 2);
    expect(camera.screenToWorld(anchor)).toEqual(before);
  });

  it('pans and clamps scale and DPR', () => {
    const camera = new Camera({ x: 0, y: 0, scale: 1 });
    camera.panBy(14, -9);
    expect(camera.snapshot()).toEqual({ x: 14, y: -9, scale: 1 });
    expect(clampCameraScale(0)).toBe(MIN_ZOOM);
    expect(clampCameraScale(MAX_ZOOM * 2)).toBe(MAX_ZOOM);
    expect(clampCameraScale(100)).toBe(100);
    expect(boundedDevicePixelRatio(4)).toBe(2);
  });

  it('uses the command zoom range and preserves the anchor through both extremes', () => {
    const anchor = { x: 640, y: 410 };
    for (const target of [133.17552342239196, 0.00750888732630175, MIN_ZOOM, MAX_ZOOM]) {
      const camera = new Camera({ x: 0, y: 0, scale: 1 });
      camera.zoomAt(anchor, target);
      const viewport = camera.snapshot();
      expect(viewport.scale).toBeCloseTo(target);
      const restored = new Camera(viewport);
      expect(restored.snapshot()).toEqual(viewport);
      expect(restored.worldToScreen(anchor).x).toBeCloseTo(anchor.x, 3);
      expect(restored.worldToScreen(anchor).y).toBeCloseTo(anchor.y, 3);
    }
  });
});
