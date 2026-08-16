import { describe, expect, it } from 'vitest';
import { IMAGE_CACHE_FORMAT_VERSION, imageRequestKey } from './imagePipelineConfig';
import imageCacheFormat from './imageCacheFormat.json';

describe('image cache format version', () => {
  it('uses the shared JSON as the only frontend source', () => {
    expect(IMAGE_CACHE_FORMAT_VERSION).toBe(imageCacheFormat.version);
    expect(imageRequestKey('asset', 128)).toBe(`asset:v${imageCacheFormat.version}:a2:m128:full`);
  });
});
