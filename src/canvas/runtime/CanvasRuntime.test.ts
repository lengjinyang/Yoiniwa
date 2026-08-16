import { afterEach, describe, expect, it, vi } from 'vitest';
import { createScene } from '../../domain/scene';
import { CanvasRuntime } from './CanvasRuntime';

afterEach(() => {
  vi.unstubAllGlobals();
});

class FakeClassList {
  private readonly values = new Set<string>();
  add(...tokens: string[]) { tokens.forEach((token) => this.values.add(token)); }
  remove(...tokens: string[]) { tokens.forEach((token) => this.values.delete(token)); }
  contains(token: string) { return this.values.has(token); }
  toggle(token: string, force?: boolean) {
    if (force === true) this.values.add(token);
    else if (force === false) this.values.delete(token);
    else if (this.values.has(token)) this.values.delete(token);
    else this.values.add(token);
    return this.values.has(token);
  }
}

describe('CanvasRuntime', () => {
  it('keeps viewport and item screen rects before Pixi start, and locks selection', () => {
    const documentElement = { classList: new FakeClassList() };
    vi.stubGlobal('document', { documentElement, createElement: () => ({ classList: new FakeClassList() }) });
    vi.stubGlobal('window', { addEventListener: () => undefined, removeEventListener: () => undefined });
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => undefined);

    const classList = new FakeClassList();
    const container = {
      classList,
      clientWidth: 800,
      clientHeight: 600,
      style: {},
      appendChild: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      getBoundingClientRect: () => ({
        left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON() { return {}; },
      }),
    } as unknown as HTMLElement;
    const runtime = new CanvasRuntime(container, {
      background: '#111111',
      backgroundOpacity: 1,
      viewport: { x: 10, y: 20, scale: 2 },
    });
    expect(runtime.getViewport()).toEqual({ x: 10, y: 20, scale: 2 });

    const scene = createScene();
    scene.items = [{
      id: 'still', name: 'still', sourceType: 'file', naturalWidth: 100, naturalHeight: 50,
      x: 5, y: 8, width: 100, height: 50, rotation: 0, flipX: false, flipY: false,
      opacity: 1, zIndex: 0, locked: false, crop: { x: 0, y: 0, width: 100, height: 50 },
    }];
    runtime.setViewport({ x: 0, y: 0, scale: 1 });
    runtime.setScene(scene);
    expect(runtime.itemScreenRect('still')).toEqual({ left: 5, top: 8, width: 100, height: 50 });
    expect(runtime.itemScreenRect('missing')).toBeUndefined();

    runtime.setWindowLocked(true);
    expect(classList.contains('canvas-content-locked')).toBe(true);
    runtime.setColorPickerHeld(true);
    expect(classList.contains('color-picker-active')).toBe(true);
    runtime.setWindowLocked(false);
    runtime.setColorPickerHeld(false);
    expect(classList.contains('canvas-content-locked')).toBe(false);
    expect(classList.contains('color-picker-active')).toBe(false);
  });
});
