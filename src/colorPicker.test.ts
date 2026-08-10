import { describe, expect, it } from 'vitest';
import { imagePixelFromWorld, pickedColorFromRgba, rgbToHex, topmostImagePixel } from './colorPicker';
import type { ImageItem } from './types';

function image(patch: Partial<ImageItem> = {}): ImageItem {
  return {
    id: 'image', name: 'test.png', sourceType: 'file', dataUrl: 'data:image/png;base64,',
    naturalWidth: 200, naturalHeight: 100,
    x: 10, y: 20, width: 100, height: 50,
    rotation: 0, flipX: false, flipY: false, opacity: 1, zIndex: 0, locked: false,
    crop: { x: 0, y: 0, width: 200, height: 100 },
    ...patch,
  };
}

describe('source image color picking', () => {
  it('maps the displayed image center into its original pixels', () => {
    expect(imagePixelFromWorld(image(), 60, 45)).toMatchObject({ x: 100, y: 50, u: 0.5, v: 0.5 });
  });

  it('maps through a non-destructive crop', () => {
    const item = image({ crop: { x: 20, y: 10, width: 100, height: 50 } });
    expect(imagePixelFromWorld(item, 60, 45)).toMatchObject({ x: 70, y: 35 });
  });

  it('inverts rotation and horizontal/vertical flips', () => {
    expect(imagePixelFromWorld(image({ rotation: 90 }), 60, 70)).toMatchObject({ x: 150, y: 50 });
    expect(imagePixelFromWorld(image({ flipX: true }), 85, 45)).toMatchObject({ x: 50, y: 50 });
    expect(imagePixelFromWorld(image({ flipY: true }), 60, 57.5)).toMatchObject({ x: 100, y: 25 });
  });

  it('rejects points outside the rotated image', () => {
    expect(imagePixelFromWorld(image({ rotation: 30 }), -100, -100)).toBeUndefined();
  });

  it('chooses the top visible image regardless of display opacity', () => {
    const bottom = image({ id: 'bottom', zIndex: 1 });
    const top = image({ id: 'top', zIndex: 8, opacity: 0.05 });
    expect(topmostImagePixel([top, bottom], new Set(), 60, 45)?.item.id).toBe('top');
    expect(topmostImagePixel([top, bottom], new Set(['top']), 60, 45)?.item.id).toBe('bottom');
  });

  it('keeps RGB from translucent pixels and ignores fully transparent pixels', () => {
    expect(pickedColorFromRgba(12, 128, 254, 1)).toEqual({ r: 12, g: 128, b: 254, a: 1, hex: '#0C80FE' });
    expect(pickedColorFromRgba(12, 128, 254, 0)).toBeUndefined();
    expect(rgbToHex(300, -2, 15.6)).toBe('#FF0010');
  });
});
