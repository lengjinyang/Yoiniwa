import { describe, expect, it } from 'vitest';
import { edgeAutoPanDelta, exceededWindowMoveThreshold, getImageDragMode, isAltColorPickerPointer, isPrimaryPointerButton, matchesColorPickerShortcut, MAX_ZOOM, MIN_ZOOM, offsetPointOutward, zoomViewportAtPoint } from './interactions';

describe('PureRef-style image gestures', () => {
  it('supports very small overview scales without allowing zero zoom', () => {
    expect(MIN_ZOOM).toBeLessThanOrEqual(1e-9);
    expect(MAX_ZOOM).toBeGreaterThanOrEqual(1e9);
  });
  it('maps modifier combinations to the expected continuous action', () => {
    expect(getImageDragMode({ ctrlKey: false, altKey: false, shiftKey: false })).toBe('move');
    expect(getImageDragMode({ ctrlKey: false, altKey: true, shiftKey: false })).toBe('pan');
    expect(getImageDragMode({ ctrlKey: true, altKey: false, shiftKey: false })).toBe('rotate');
    expect(getImageDragMode({ ctrlKey: true, altKey: true, shiftKey: false })).toBe('scale');
    expect(getImageDragMode({ ctrlKey: true, altKey: true, shiftKey: true })).toBe('opacity');
  });

  it('supports S by default and Alt as an explicit color-picker shortcut', () => {
    expect(matchesColorPickerShortcut('s', { key: 's', code: 'KeyS', ctrlKey: false, altKey: false, shiftKey: false })).toBe(true);
    expect(matchesColorPickerShortcut('s', { key: 'Alt', code: 'AltLeft', ctrlKey: false, altKey: true, shiftKey: false })).toBe(false);
    expect(matchesColorPickerShortcut('alt', { key: 'Alt', code: 'AltLeft', ctrlKey: false, altKey: true, shiftKey: false })).toBe(true);
    expect(isAltColorPickerPointer('alt', { button: 0, ctrlKey: false, altKey: true, shiftKey: false })).toBe(true);
    expect(isAltColorPickerPointer('s', { button: 0, ctrlKey: false, altKey: true, shiftKey: false })).toBe(false);
  });

  it('distinguishes a right click from a right-button window drag', () => {
    expect(exceededWindowMoveThreshold(100, 100, 103, 103)).toBe(false);
    expect(exceededWindowMoveThreshold(100, 100, 106, 100)).toBe(true);
  });

  it('never treats a right click as image selection or focus', () => {
    expect(isPrimaryPointerButton(0)).toBe(true);
    expect(isPrimaryPointerButton(1)).toBe(false);
    expect(isPrimaryPointerButton(2)).toBe(false);
  });

  it('auto-pans only near or beyond a selection edge', () => {
    expect(edgeAutoPanDelta(200, 500, 36)).toBe(0);
    expect(edgeAutoPanDelta(0, 500, 36)).toBeGreaterThan(0);
    expect(edgeAutoPanDelta(500, 500, 36)).toBeLessThan(0);
    expect(Math.abs(edgeAutoPanDelta(900, 500, 36))).toBeLessThanOrEqual(18);
  });

  it('keeps the world point under the cursor fixed during consecutive wheel events', () => {
    const pointer = { x: 420, y: 260 };
    const start = { x: 20, y: 10, scale: 0.5 };
    const first = zoomViewportAtPoint(start, pointer, -100);
    const second = zoomViewportAtPoint(first, pointer, -100);
    expect(second.scale).toBeGreaterThan(first.scale);
    expect((pointer.x - second.x) / second.scale).toBeCloseTo((pointer.x - start.x) / start.scale);
    expect((pointer.y - second.y) / second.scale).toBeCloseTo((pointer.y - start.y) / start.scale);
    expect(zoomViewportAtPoint({ x: 0, y: 0, scale: 16 }, pointer, -100).scale).toBeGreaterThan(16);
  });

  it('places rotation controls outside corners without moving the scale corners', () => {
    const corner = { x: 10, y: 10 };
    const result = offsetPointOutward(corner, { x: 50, y: 50 }, 12, 0.5);
    expect(result.x).toBeLessThan(corner.x);
    expect(result.y).toBeLessThan(corner.y);
    expect(Math.hypot(result.x - corner.x, result.y - corner.y) * 0.5).toBeCloseTo(12);
    expect(corner).toEqual({ x: 10, y: 10 });
  });
});
