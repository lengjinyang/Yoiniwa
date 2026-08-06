import { describe, expect, it } from 'vitest';
import { compositeDisplayedColor } from './colorSampling';

describe('displayed color sampling', () => {
  it('keeps opaque framebuffer colors unchanged', () => {
    expect(compositeDisplayedColor({ r: 12, g: 34, b: 56, a: 255 }, { r: 23, g: 25, b: 29 }, false))
      .toEqual({ r: 12, g: 34, b: 56, a: 1, hex: '#0C2238' });
  });

  it('composites straight-alpha pixels over the application surface', () => {
    expect(compositeDisplayedColor({ r: 200, g: 100, b: 0, a: 128 }, { r: 20, g: 40, b: 60 }, false))
      .toEqual({ r: 110, g: 70, b: 30, a: 1, hex: '#6E461E' });
  });

  it('supports premultiplied framebuffer values', () => {
    expect(compositeDisplayedColor({ r: 100, g: 50, b: 0, a: 128 }, { r: 20, g: 40, b: 60 }, true))
      .toEqual({ r: 110, g: 70, b: 30, a: 1, hex: '#6E461E' });
  });
});
