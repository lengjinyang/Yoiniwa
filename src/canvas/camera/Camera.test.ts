import { describe, expect, it } from 'vitest';
import { Camera } from './Camera';
import { clampCameraScale } from './CameraConstraints';
import { screenToWorld, worldToScreen } from './CoordinateTransform';
import { boundedDevicePixelRatio } from '../runtime/CanvasConfig';

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
    expect(clampCameraScale(0)).toBe(0.02);
    expect(clampCameraScale(100)).toBe(32);
    expect(boundedDevicePixelRatio(4)).toBe(2);
  });
});
