import { describe, expect, it } from 'vitest';
import { shouldUseImagePyramid, tileResourceUrl } from './tileResources';

describe('tile resources', () => {
  it('routes only large images to a pyramid', () => {
    expect(shouldUseImagePyramid({ naturalWidth: 1024, naturalHeight: 1024 })).toBe(false);
    expect(shouldUseImagePyramid({ naturalWidth: 2400, naturalHeight: 1600 })).toBe(true);
    expect(shouldUseImagePyramid({ naturalWidth: 5000, naturalHeight: 1000 })).toBe(true);
    expect(shouldUseImagePyramid({ naturalWidth: 4000, naturalHeight: 4000 })).toBe(true);
  });

  it('builds an addressable tile resource url', () => {
    expect(tileResourceUrl('asset id', 2, 4, 3)).toBe('refcanvas-asset://asset/asset%20id?variant=tile&level=2&column=4&row=3');
  });
});
