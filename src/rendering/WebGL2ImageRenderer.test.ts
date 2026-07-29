import { describe, expect, it } from 'vitest';
import { WebGL2ImageRenderer } from './WebGL2ImageRenderer';

function createRenderer(atlasSize = 4096) {
  const uploads: unknown[][] = [];
  const sourceUploads: unknown[][] = [];
  const deletedTextures: unknown[] = [];
  const gl = {
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4, STATIC_DRAW: 5, DYNAMIC_DRAW: 6, ARRAY_BUFFER: 7,
    TEXTURE_2D: 5, UNPACK_PREMULTIPLY_ALPHA_WEBGL: 6, UNPACK_FLIP_Y_WEBGL: 7,
    TEXTURE_MIN_FILTER: 8, TEXTURE_MAG_FILTER: 9, TEXTURE_WRAP_S: 10, TEXTURE_WRAP_T: 11,
    LINEAR: 12, CLAMP_TO_EDGE: 13, RGBA: 14, UNSIGNED_BYTE: 15, MAX_TEXTURE_SIZE: 16,
    getParameter: () => atlasSize,
    createShader: () => ({}), shaderSource: () => undefined, compileShader: () => undefined,
    getShaderParameter: () => true, getShaderInfoLog: () => null, deleteShader: () => undefined,
    createProgram: () => ({}), attachShader: () => undefined, linkProgram: () => undefined,
    getProgramParameter: () => true, getProgramInfoLog: () => null, deleteProgram: () => undefined,
    getAttribLocation: () => 0, getUniformLocation: () => ({}),
    createBuffer: () => ({}), deleteBuffer: () => undefined, bindBuffer: () => undefined,
    bufferData: () => undefined, bufferSubData: () => undefined,
    createVertexArray: () => ({}), deleteVertexArray: () => undefined, bindVertexArray: () => undefined,
    enableVertexAttribArray: () => undefined, vertexAttribPointer: () => undefined, vertexAttribDivisor: () => undefined,
    createTexture: () => ({}), deleteTexture: (texture: unknown) => deletedTextures.push(texture),
    bindTexture: () => undefined, pixelStorei: () => undefined, texParameteri: () => undefined,
    texImage2D: (...args: unknown[]) => uploads.push(args),
    texSubImage2D: (...args: unknown[]) => sourceUploads.push(args),
  } as unknown as WebGL2RenderingContext;
  const canvas = {
    style: {}, width: 0, height: 0,
    getContext: () => gl,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as unknown as HTMLCanvasElement;
  return { renderer: new WebGL2ImageRenderer(canvas), uploads, sourceUploads, deletedTextures };
}

describe('WebGL2 image renderer texture sharing', () => {
  it('uploads one texture for multiple command IDs that use the same image', () => {
    const { renderer, sourceUploads } = createRenderer();
    const image = { naturalWidth: 200, naturalHeight: 100 } as HTMLImageElement;
    renderer.syncImages(new Map([['first', image], ['second', image]]), new Set(['first', 'second']));

    expect(sourceUploads).toHaveLength(1);
    const resources = renderer as unknown as { textures: Map<string, unknown>; sharedTextures: Map<string, { refs: number }> };
    expect(resources.textures).toHaveLength(2);
    expect([...resources.sharedTextures.values()][0]?.refs).toBe(2);
  });

  it('keeps an inactive LOD resident so a zoom reversal does not reupload it', () => {
    const { renderer, sourceUploads } = createRenderer();
    const image = { naturalWidth: 200, naturalHeight: 100 } as HTMLImageElement;
    renderer.syncImages(new Map([['first', image], ['second', image]]), new Set(['first', 'second']));
    renderer.syncImages(new Map([['first', image]]), new Set(['first']));

    const resources = renderer as unknown as { textures: Map<string, unknown>; sharedTextures: Map<string, { refs: number }> };
    expect(resources.textures.has('second')).toBe(true);
    expect([...resources.sharedTextures.values()][0]?.refs).toBe(2);

    renderer.syncImages(new Map([['second', image]]), new Set(['second']));
    expect(sourceUploads).toHaveLength(1);
    expect(resources.textures.has('first')).toBe(true);
    expect(resources.textures.has('second')).toBe(true);
  });

  it('deletes shared textures during renderer destruction', () => {
    const { renderer, deletedTextures } = createRenderer();
    const image = { naturalWidth: 200, naturalHeight: 100 } as HTMLImageElement;
    renderer.syncImages(new Map([['image', image]]), new Set(['image']));
    renderer.destroy();

    expect(deletedTextures).toHaveLength(1);
  });

  it('keeps the current atlas intact when a new image cannot fit', () => {
    const { renderer, deletedTextures } = createRenderer(32);
    const images = new Map<string, HTMLImageElement>();
    for (let index = 0; index < 16; index += 1) {
      images.set(`image-${index}`, { naturalWidth: 14, naturalHeight: 14 } as HTMLImageElement);
    }
    for (let index = 0; index < images.size; index += 1) renderer.syncImages(images, new Set(images.keys()));
    const extra = { naturalWidth: 14, naturalHeight: 14 } as HTMLImageElement;
    renderer.syncImages(new Map([...images, ['extra', extra]]), new Set([...images.keys(), 'extra']));

    expect(renderer.isImageResident('extra')).toBe(false);
    expect(deletedTextures).toHaveLength(0);
    expect([...images.keys()].every((id) => renderer.isImageResident(id))).toBe(true);
  });

  it('uploads a small bounded batch per sync', () => {
    const { renderer, sourceUploads } = createRenderer();
    const images = new Map([
      ['first', { naturalWidth: 200, naturalHeight: 100 } as HTMLImageElement],
      ['second', { naturalWidth: 201, naturalHeight: 100 } as HTMLImageElement],
    ]);
    const pending = renderer.syncImages(images, new Set(images.keys()));

    expect(sourceUploads).toHaveLength(2);
    expect(pending.needsRetry).toBe(false);
    expect(pending.uploadedIds).toEqual(['first', 'second']);
  });

  it('keeps a queued replacement pending even while the old stable texture is resident', () => {
    const { renderer } = createRenderer();
    const oldImages = new Map<string, HTMLImageElement>();
    const newImages = new Map<string, HTMLImageElement>();
    for (let index = 0; index < 5; index += 1) {
      oldImages.set(`image-${index}`, { naturalWidth: 100, naturalHeight: 100 } as HTMLImageElement);
      newImages.set(`image-${index}`, { naturalWidth: 120, naturalHeight: 120 } as HTMLImageElement);
    }
    let result = renderer.syncImages(oldImages, new Set(oldImages.keys()));
    while (result.needsRetry) result = renderer.syncImages(oldImages, new Set(oldImages.keys()));
    result = renderer.syncImages(newImages, new Set(newImages.keys()));
    expect(result.pendingIds).toHaveLength(1);
    expect(result.needsRetry).toBe(true);
    expect(renderer.syncImages(newImages, new Set(newImages.keys())).needsRetry).toBe(false);
  });

  it('converges a multi-frame active set without evicting resources admitted earlier in the same set', () => {
    const { renderer, sourceUploads } = createRenderer(1024);
    const images = new Map<string, HTMLImageElement>();
    for (let index = 0; index < 12; index += 1) {
      images.set(`image-${index}`, { naturalWidth: 180, naturalHeight: 180 } as HTMLImageElement);
    }
    let result = renderer.syncImages(images, new Set(images.keys()));
    for (let pass = 0; pass < 10 && result.needsRetry; pass += 1) result = renderer.syncImages(images, new Set(images.keys()));
    expect(result.needsRetry).toBe(false);
    expect([...images.keys()].every((id) => renderer.isImageResident(id))).toBe(true);
    expect(sourceUploads).toHaveLength(images.size);
  });

  it('allows visible textures to evict unprotected prewarm textures', () => {
    const { renderer } = createRenderer(32);
    const prewarm = { naturalWidth: 14, naturalHeight: 14 } as HTMLImageElement;
    const visible = { naturalWidth: 14, naturalHeight: 14 } as HTMLImageElement;
    const images = new Map([['prewarm', prewarm], ['visible', visible]]);
    renderer.syncImages(images, new Set(['prewarm']), new Set());
    renderer.syncImages(images, new Set(['visible', 'prewarm']), new Set(['visible']));
    expect(renderer.isImageResident('visible')).toBe(true);
  });

  it('defers decoded uploads while the backend is interaction-paused', () => {
    const { renderer, sourceUploads } = createRenderer(1024);
    const image = { naturalWidth: 128, naturalHeight: 128 } as HTMLImageElement;
    renderer.setUploadsPaused(true);

    expect(renderer.syncImages(new Map([['focus', image]]), new Set(['focus']))).toMatchObject({
      pendingIds: ['focus'], needsRetry: true,
    });
    expect(renderer.isImageResident('focus')).toBe(false);
    expect(sourceUploads).toHaveLength(0);

    renderer.setUploadsPaused(false);
    renderer.syncImages(new Map([['focus', image]]), new Set(['focus']));
    expect(renderer.isImageResident('focus')).toBe(true);
    expect(sourceUploads).toHaveLength(1);
  });

  it('reports capacity-blocked resources for bounded retry', () => {
    const { renderer } = createRenderer(32);
    const images = new Map<string, HTMLImageElement>();
    for (let index = 0; index < 17; index += 1) {
      images.set(`image-${index}`, { naturalWidth: 14, naturalHeight: 14 } as HTMLImageElement);
    }
    let result = renderer.syncImages(images, new Set(images.keys()));
    for (let index = 0; index < 5 && result.pendingIds.length; index += 1) {
      result = renderer.syncImages(images, new Set(images.keys()));
    }
    expect(result.blockedIds).toContain('image-16');
    expect(result.needsRetry).toBe(true);
  });
});
