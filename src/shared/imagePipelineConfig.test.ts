import { describe, expect, it } from 'vitest';
import {
  CLIPBOARD_IMAGE_MAX_EDGE,
  CLIPBOARD_IMAGE_MAX_PIXELS,
  clipboardImageDimensionsAllowed,
} from './imagePipelineConfig';

describe('clipboard image limits', () => {
  it('accepts ordinary images and the exact pixel boundary', () => {
    expect(clipboardImageDimensionsAllowed(4096, 4096)).toBe(true);
    expect(clipboardImageDimensionsAllowed(CLIPBOARD_IMAGE_MAX_PIXELS / 10_000, 10_000)).toBe(true);
  });

  it('rejects invalid, oversized, and excessive-edge dimensions', () => {
    expect(clipboardImageDimensionsAllowed(0, 100)).toBe(false);
    expect(clipboardImageDimensionsAllowed(Number.NaN, 100)).toBe(false);
    expect(clipboardImageDimensionsAllowed(CLIPBOARD_IMAGE_MAX_EDGE + 1, 1)).toBe(false);
    expect(clipboardImageDimensionsAllowed(10_000, 10_000)).toBe(false);
  });
});
