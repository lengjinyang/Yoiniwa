import { describe, expect, it } from 'vitest';
import { Canvas2DImageRenderer } from './Canvas2DImageRenderer';

function createContext() {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const context = {
    setTransform: (...args: unknown[]) => calls.push({ name: 'setTransform', args }),
    clearRect: (...args: unknown[]) => calls.push({ name: 'clearRect', args }),
    save: () => calls.push({ name: 'save', args: [] }),
    restore: () => calls.push({ name: 'restore', args: [] }),
    translate: (...args: unknown[]) => calls.push({ name: 'translate', args }),
    rotate: (...args: unknown[]) => calls.push({ name: 'rotate', args }),
    scale: (...args: unknown[]) => calls.push({ name: 'scale', args }),
    drawImage: (...args: unknown[]) => calls.push({ name: 'drawImage', args }),
    globalAlpha: 1,
    filter: 'none',
  } as unknown as CanvasRenderingContext2D;
  return { context, calls };
}

describe('Canvas2D image renderer', () => {
  it('does not reset the canvas when a viewport-only update keeps its size', () => {
    const { context } = createContext();
    let bitmapWrites = 0;
    const canvas = { style: {}, getContext: () => context } as unknown as HTMLCanvasElement;
    Object.defineProperties(canvas, {
      width: { configurable: true, get: () => 0, set: () => { bitmapWrites += 1; } },
      height: { configurable: true, get: () => 0, set: () => { bitmapWrites += 1; } },
    });
    const renderer = new Canvas2DImageRenderer(canvas);

    renderer.resize(400, 300, 2);
    const writesAfterInitialResize = bitmapWrites;
    renderer.resize(400, 300, 2);

    expect(bitmapWrites).toBe(writesAfterInitialResize);
    renderer.resize(401, 300, 2);
    expect(bitmapWrites).toBeGreaterThan(writesAfterInitialResize);
  });

  it('applies shared viewport transform and crop source coordinates', () => {
    const { context, calls } = createContext();
    const canvas = {
      width: 0, height: 0, style: {},
      getContext: () => context,
    } as unknown as HTMLCanvasElement;
    const renderer = new Canvas2DImageRenderer(canvas);
    renderer.resize(400, 300, 2);
    const originalImage = globalThis.HTMLImageElement;
    class ImageElement {}
    Object.defineProperty(globalThis, 'HTMLImageElement', { configurable: true, value: ImageElement });
    try {
      const image = Object.assign(new ImageElement(), { naturalWidth: 2000, naturalHeight: 1000 }) as unknown as HTMLImageElement;
      renderer.render([{
        id: 'image', source: {}, sourceRect: { x: 100, y: 50, width: 500, height: 250 },
        naturalWidth: 1000, naturalHeight: 500, x: 10, y: 20, width: 200, height: 100,
        rotation: 0, flipX: false, flipY: false, opacity: 0.6, grayscale: true, zIndex: 0, image,
      }], { x: 5, y: 6, scale: 2 });
    } finally {
      Object.defineProperty(globalThis, 'HTMLImageElement', { configurable: true, value: originalImage });
    }
    expect(calls.find((call) => call.name === 'translate')?.args).toEqual([225, 146]);
    expect(calls.find((call) => call.name === 'drawImage')?.args.slice(1)).toEqual([200, 100, 1000, 500, -100, -50, 200, 100]);
  });
});
