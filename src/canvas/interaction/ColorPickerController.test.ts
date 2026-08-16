import { describe, expect, it, vi } from 'vitest';
import { Camera } from '../camera/Camera';
import { RuntimeLifecycle } from '../runtime/RuntimeLifecycle';
import { SceneStore } from '../scene/SceneStore';
import { createScene } from '../../domain/scene';
import type { ImageItem, PickedColor } from '../../types';
import { ColorPickerController } from './ColorPickerController';

type Handler = (event: PointerEvent) => void;

class FakeInput {
  down?: Handler; move?: Handler; up?: Handler; cancel?: Handler;
  onPointerDown(handler: Handler) { this.down = handler; return () => { this.down = undefined; }; }
  onPointerMove(handler: Handler) { this.move = handler; return () => { this.move = undefined; }; }
  onPointerUp(handler: Handler) { this.up = handler; return () => { this.up = undefined; }; }
  onPointerCancel(handler: Handler) { this.cancel = handler; return () => { this.cancel = undefined; }; }
}

function pointer(overrides: Partial<PointerEvent> & { nativeInput?: boolean } = {}) {
  return {
    pointerId: 1, pointerType: 'pen', isPrimary: true, button: 0, buttons: 1,
    clientX: 10, clientY: 10, altKey: true, ctrlKey: false, shiftKey: false,
    preventDefault: vi.fn(), stopPropagation: vi.fn(), getCoalescedEvents: () => [],
    ...overrides,
  } as unknown as PointerEvent;
}

function image(): ImageItem {
  return {
    id: 'image', name: 'image.png', sourceType: 'file', assetId: 'asset',
    naturalWidth: 100, naturalHeight: 100, x: 0, y: 0, width: 100, height: 100,
    rotation: 0, flipX: false, flipY: false, opacity: 1, zIndex: 0, locked: false,
    crop: { x: 0, y: 0, width: 100, height: 100 },
  };
}

class FakeCaptureHost {
  private readonly handlers = new Map<string, Set<EventListener>>();
  addEventListener(type: string, handler: EventListener) {
    const set = this.handlers.get(type) ?? new Set();
    set.add(handler);
    this.handlers.set(type, set);
  }
  removeEventListener(type: string, handler: EventListener) {
    this.handlers.get(type)?.delete(handler);
  }
  emit(type: string, event: PointerEvent) {
    this.handlers.get(type)?.forEach((handler) => handler(event));
  }
}

function setup(
  sampleFn?: (point: { x: number; y: number }, final: boolean) => PickedColor | undefined,
  captureTarget?: FakeCaptureHost,
) {
  const input = new FakeInput();
  const lifecycle = new RuntimeLifecycle();
  const scene = createScene(); scene.items = [image()];
  const captured = new Set<number>();
  let rectCalls = 0;
  const element = {
    getBoundingClientRect: () => {
      rectCalls += 1;
      return { left: 0, top: 0, width: 200, height: 200 };
    },
    setPointerCapture: (id: number) => captured.add(id),
    hasPointerCapture: (id: number) => captured.has(id),
    releasePointerCapture: (id: number) => captured.delete(id),
  } as unknown as HTMLElement;
  const frames = new Map<number, FrameRequestCallback>(); let frameId = 0;
  const positions: Array<{ x: number; y: number } | undefined> = [];
  const previews: Array<PickedColor | undefined> = [];
  const picked: PickedColor[] = [];
  let pending = 0;
  const captureReleasedBeforePick: boolean[] = [];
  const samples: Array<{ point: { x: number; y: number }; final: boolean }> = [];
  let now = 0;
  const controller = new ColorPickerController({
    element, input, lifecycle, camera: new Camera(), scene: () => new SceneStore(scene),
    enabled: (event) => event.altKey,
    sample: (point, final) => {
      samples.push({ point, final });
      if (sampleFn) return sampleFn(point, final);
      return { r: point.x, g: point.y, b: 30, a: 1, hex: `#${point.x}-${point.y}` };
    },
    position: (point) => positions.push(point),
    pending: () => { pending += 1; },
    preview: (color) => previews.push(color),
    picked: (color) => { captureReleasedBeforePick.push(!captured.has(1)); picked.push(color); },
    schedulePreview: (callback) => {
      const id = ++frameId;
      frames.set(id, (time) => { frames.delete(id); callback(time); });
      return id;
    },
    cancelPreview: (id) => { frames.delete(id); },
    now: () => now,
    captureTarget,
  });
  controller.start();
  return {
    input, lifecycle, captured, frames, positions, previews, picked, samples, captureReleasedBeforePick,
    pending: () => pending,
    rectCalls: () => rectCalls,
    advance(ms: number) { now += ms; },
  };
}

describe('ColorPickerController', () => {
  it('captures a Windows Ink pen, previews the latest move once per frame, and commits on release', () => {
    const state = setup();
    state.input.down?.(pointer());
    expect(state.captured.has(1)).toBe(false);
    expect(state.previews.at(-1)).toBeUndefined();
    state.input.move?.(pointer({ clientX: 20, clientY: 25 }));
    state.input.move?.(pointer({ clientX: 30, clientY: 35 }));
    expect(state.frames.size).toBe(1);
    state.advance(34);
    state.frames.values().next().value?.(16);
    expect(state.positions.at(-1)).toEqual({ x: 30, y: 35 });
    expect(state.previews.at(-1)).toMatchObject({ r: 30, g: 35 });
    state.input.up?.(pointer({ clientX: 40, clientY: 45, buttons: 0 }));
    expect(state.captured.has(1)).toBe(false);
    expect(state.picked).toHaveLength(1);
    expect(state.picked[0]).toMatchObject({ r: 30, g: 35 });
    expect(state.samples.every((sample) => sample.final === false)).toBe(true);
    expect(state.captureReleasedBeforePick).toEqual([true]);
    expect(state.positions.at(-1)).toBeUndefined();
    expect(state.previews.at(-1)).toBeUndefined();
    state.input.up?.(pointer({ clientX: 50, clientY: 55, buttons: 0 }));
    expect(state.picked).toHaveLength(1);
    state.lifecycle.destroy();
  });

  it('tracks mouse and pen on the pointer path without sampling until the next frame', () => {
    for (const pointerType of ['mouse', 'pen'] as const) {
      const state = setup();
      state.input.down?.(pointer({ pointerType }));
      expect(state.samples).toHaveLength(0);
      const started = performance.now();
      for (let index = 0; index < 120; index += 1) {
        state.input.move?.(pointer({
          pointerType, clientX: 20 + index, clientY: 30 + index,
        }));
      }
      expect(performance.now() - started).toBeLessThan(40);
      expect(state.samples).toHaveLength(0);
      const tracked = state.positions.filter((point) => point);
      expect(tracked).toHaveLength(121);
      expect(tracked.at(-1)).toEqual({ x: 139, y: 149 });
      state.advance(16);
      state.frames.values().next().value?.(16);
      expect(state.samples).toHaveLength(1);
      expect(state.samples[0]).toEqual({ point: { x: 139, y: 149 }, final: false });
      state.lifecycle.destroy();
    }
  });

  it('follows one-pixel native tablet moves as the same drag as a long stroke', () => {
    const state = setup();
    state.input.down?.(pointer({ nativeInput: true, clientX: 40, clientY: 50 }));
    expect(state.positions.at(-1)).toEqual({ x: 40, y: 50 });
    state.input.move?.(pointer({ nativeInput: true, clientX: 41, clientY: 51 }));
    expect(state.positions.at(-1)).toEqual({ x: 41, y: 51 });
    state.input.move?.(pointer({ nativeInput: true, clientX: 44, clientY: 53 }));
    expect(state.positions.at(-1)).toEqual({ x: 44, y: 53 });
    expect(state.samples).toHaveLength(0);
    state.lifecycle.destroy();
  });

  it('does not read coalesced packets for native collaboration input', () => {
    const coalesced = vi.fn(() => { throw new Error('native input must not walk coalesced packets'); });
    const state = setup();
    state.input.down?.(pointer({ nativeInput: true, getCoalescedEvents: coalesced }));
    expect(() => {
      state.input.move?.(pointer({
        nativeInput: true, clientX: 40, clientY: 41, getCoalescedEvents: coalesced,
      }));
    }).not.toThrow();
    expect(coalesced).not.toHaveBeenCalled();
    expect(state.positions.at(-1)).toEqual({ x: 40, y: 41 });
    state.lifecycle.destroy();
  });

  it('still captures a mouse gesture so tracking continues outside the canvas', () => {
    const state = setup();
    state.input.down?.(pointer({ pointerType: 'mouse' }));
    expect(state.captured.has(1)).toBe(true);
    state.input.up?.(pointer({ pointerType: 'mouse', buttons: 0 }));
    expect(state.captured.has(1)).toBe(false);
    state.lifecycle.destroy();
  });

  it('shows the HUD on tip-down before a GPU preview arrives', () => {
    const state = setup();
    state.input.down?.(pointer());
    expect(state.positions.at(-1)).toEqual({ x: 10, y: 10 });
    expect(state.pending()).toBe(0);
    expect(state.previews).toHaveLength(0);
    state.lifecycle.destroy();
  });

  it('previews a stationary click without waiting for a drag', () => {
    const state = setup();
    state.input.down?.(pointer());
    expect(state.frames.size).toBe(1);
    state.advance(10);
    state.frames.values().next().value?.(10);
    expect(state.previews.at(-1)).toMatchObject({ r: 10, g: 10 });
    state.lifecycle.destroy();
  });

  it('moves the reticle with the pen before the GPU preview frame arrives', () => {
    const state = setup();
    state.input.down?.(pointer());
    expect(state.positions.at(-1)).toEqual({ x: 10, y: 10 });
    state.input.move?.(pointer({ clientX: 28, clientY: 41 }));
    expect(state.positions.at(-1)).toEqual({ x: 28, y: 41 });
    expect(state.frames.size).toBe(1);
    state.lifecycle.destroy();
  });

  it('does not remeasure the canvas on every tablet move', () => {
    const state = setup();
    state.input.down?.(pointer());
    const afterDown = state.rectCalls();
    expect(afterDown).toBeGreaterThan(0);
    state.input.move?.(pointer({ clientX: 20, clientY: 25 }));
    state.input.move?.(pointer({ clientX: 40, clientY: 48 }));
    state.input.move?.(pointer({ clientX: 70, clientY: 62 }));
    expect(state.rectCalls()).toBe(afterDown);
    state.lifecycle.destroy();
  });

  it('commits a short click immediately and hides like Alt+mouse', () => {
    const state = setup();
    state.input.down?.(pointer());
    state.input.up?.(pointer({ buttons: 0 }));
    expect(state.picked).toHaveLength(1);
    expect(state.picked[0]).toMatchObject({ r: 10, g: 10 });
    expect(state.positions.at(-1)).toBeUndefined();
    expect(state.previews.at(-1)).toBeUndefined();
    state.lifecycle.destroy();
  });

  it('hides the preview as soon as the tip lifts after a color was shown', () => {
    const state = setup();
    state.input.down?.(pointer());
    state.advance(10);
    state.frames.values().next().value?.(10);
    expect(state.previews.at(-1)).toMatchObject({ r: 10, g: 10 });
    state.input.up?.(pointer({ buttons: 0 }));
    expect(state.picked).toHaveLength(1);
    expect(state.positions.at(-1)).toBeUndefined();
    expect(state.previews.at(-1)).toBeUndefined();
    state.lifecycle.destroy();
  });

  it('keeps the last preview while the pen keeps moving, including past the canvas edge', () => {
    const state = setup();
    state.input.down?.(pointer());
    state.advance(10);
    state.frames.values().next().value?.(10);
    expect(state.previews.at(-1)).toMatchObject({ r: 10, g: 10 });
    state.input.move?.(pointer({ clientX: 40, clientY: 48 }));
    expect(state.positions.at(-1)).toEqual({ x: 40, y: 48 });
    expect(state.previews.at(-1)).toMatchObject({ r: 10, g: 10 });
    state.input.move?.(pointer({ clientX: 260, clientY: 10 }));
    expect(state.positions.at(-1)?.x).toBeCloseTo(200, 0);
    expect(state.previews.at(-1)).toMatchObject({ r: 10, g: 10 });
    state.lifecycle.destroy();
  });

  it('treats a tablet tap with movement as the same stroke as a drag', () => {
    const state = setup();
    state.input.down?.(pointer());
    state.input.move?.(pointer({ clientX: 14, clientY: 16 }));
    state.advance(10);
    state.frames.values().next().value?.(10);
    expect(state.previews.at(-1)).toMatchObject({ r: 14, g: 16 });
    const samplesBeforeUp = state.samples.length;
    state.input.up?.(pointer({ clientX: 18, clientY: 19, buttons: 0 }));
    expect(state.picked).toHaveLength(1);
    expect(state.picked[0]).toMatchObject({ r: 14, g: 16 });
    expect(state.samples.length).toBe(samplesBeforeUp);
    expect(state.positions.at(-1)).toBeUndefined();
    expect(state.previews.at(-1)).toBeUndefined();
    state.lifecycle.destroy();
  });

  it('tracks the reticle on every move while GPU samples stay interval-throttled', () => {
    const state = setup();
    state.input.down?.(pointer());
    state.advance(10);
    state.frames.values().next().value?.(10);
    expect(state.samples).toHaveLength(1);
    state.input.move?.(pointer({ clientX: 24, clientY: 28 }));
    expect(state.positions.at(-1)).toEqual({ x: 24, y: 28 });
    state.advance(10);
    state.frames.values().next().value?.(20);
    expect(state.samples).toHaveLength(1);
    state.input.move?.(pointer({ clientX: 60, clientY: 70 }));
    expect(state.positions.at(-1)).toEqual({ x: 60, y: 70 });
    state.advance(50);
    state.frames.values().next().value?.(70);
    expect(state.samples).toHaveLength(2);
    expect(state.samples.at(-1)).toEqual({ point: { x: 60, y: 70 }, final: false });
    state.lifecycle.destroy();
  });

  it('keeps sampling a stationary click until the async GPU preview arrives', () => {
    let previewCalls = 0;
    const state = setup((point, final) => {
      if (final) return { r: point.x, g: point.y, b: 30, a: 1, hex: `#${point.x}-${point.y}` };
      previewCalls += 1;
      if (previewCalls < 5) return undefined;
      return { r: point.x, g: point.y, b: 30, a: 1, hex: `#${point.x}-${point.y}` };
    });
    state.input.down?.(pointer());
    for (let frame = 0; frame < 8; frame += 1) {
      const callback = state.frames.values().next().value;
      if (!callback) break;
      state.advance(10);
      callback(10);
    }
    expect(previewCalls).toBeGreaterThanOrEqual(5);
    expect(state.previews.at(-1)).toMatchObject({ r: 10, g: 10 });
    state.lifecycle.destroy();
  });

  it('primes the async GPU preview without waiting for physical movement', () => {
    const state = setup();
    state.input.down?.(pointer());
    expect(state.samples).toHaveLength(0);

    state.input.move?.(pointer({ clientX: 20, clientY: 21 }));
    state.advance(10);
    state.frames.values().next().value?.(10);
    expect(state.positions.at(-1)).toEqual({ x: 20, y: 21 });
    expect(state.samples).toHaveLength(1);
    expect(state.samples.at(-1)).toEqual({ point: { x: 20, y: 21 }, final: false });

    state.input.move?.(pointer({ clientX: 30, clientY: 31 }));
    state.advance(50);
    state.frames.values().next().value?.(60);
    expect(state.positions.at(-1)).toEqual({ x: 30, y: 31 });
    expect(state.samples).toHaveLength(2);
    expect(state.samples.at(-1)).toEqual({ point: { x: 30, y: 31 }, final: false });

    state.input.up?.(pointer({ clientX: 40, clientY: 41, buttons: 0 }));
    expect(state.picked).toHaveLength(1);
    expect(state.picked[0]).toMatchObject({ r: 30, g: 31 });
    expect(state.samples.every((sample) => sample.final === false)).toBe(true);
    state.lifecycle.destroy();
  });

  it('latches a valid Alt gesture through modifier/button fluctuations and recovers a pen cancel', () => {
    const state = setup();
    state.input.down?.(pointer());
    state.input.move?.(pointer({ altKey: false, buttons: 0, clientX: 22, clientY: 24 }));
    state.input.up?.(pointer({ altKey: false, buttons: 0 }));
    expect(state.picked).toHaveLength(1);
    state.input.down?.(pointer({ pointerId: 2 }));
    state.input.move?.(pointer({ pointerId: 2, clientX: 35, clientY: 38, buttons: 0 }));
    state.input.cancel?.(pointer({ pointerId: 2, clientX: 0, clientY: 0, buttons: 0 }));
    expect(state.picked).toHaveLength(2);
    expect(state.picked[1]).toMatchObject({ r: 35, g: 38 });
    expect(state.captured.size).toBe(0);
    state.lifecycle.destroy();
  });

  it('cleans up a native collaboration cancel without committing a color', () => {
    const state = setup();
    state.input.down?.(pointer());
    state.input.move?.(pointer({ clientX: 35, clientY: 38, buttons: 0 }));
    state.input.cancel?.(pointer({ clientX: 35, clientY: 38, buttons: 0, nativeInput: true }));
    expect(state.picked).toHaveLength(0);
    expect(state.captured.size).toBe(0);
    expect(state.positions.at(-1)).toBeUndefined();
    expect(state.previews.at(-1)).toBeUndefined();
    state.lifecycle.destroy();
  });

  it('commits the last preview immediately when tip-up stays near the sample point', () => {
    const state = setup();
    state.input.down?.(pointer());
    state.input.move?.(pointer({ clientX: 30, clientY: 35 }));
    state.advance(34);
    state.frames.values().next().value?.(16);
    expect(state.previews.at(-1)).toMatchObject({ r: 30, g: 35 });
    const samplesBeforeUp = state.samples.length;
    state.input.up?.(pointer({ clientX: 34, clientY: 38, buttons: 0 }));
    expect(state.picked).toHaveLength(1);
    expect(state.picked[0]).toMatchObject({ r: 30, g: 35 });
    expect(state.samples.length).toBe(samplesBeforeUp);
    state.lifecycle.destroy();
  });

  it('reuses the preview against the point that produced it, not the latest pointer', () => {
    let issued: { x: number; y: number } | undefined;
    const state = setup((point, final) => {
      if (final) return { r: point.x, g: point.y, b: 30, a: 1, hex: `#${point.x}-${point.y}` };
      const previous = issued;
      issued = { x: point.x, y: point.y };
      if (!previous) return undefined;
      return { r: previous.x, g: previous.y, b: 30, a: 1, hex: `#${previous.x}-${previous.y}` };
    });
    state.input.down?.(pointer());
    for (let frame = 0; frame < 3; frame += 1) {
      state.advance(10);
      state.frames.values().next().value?.(10);
    }
    state.input.move?.(pointer({ clientX: 30, clientY: 35 }));
    state.advance(50);
    state.frames.values().next().value?.(16);
    state.input.move?.(pointer({ clientX: 50, clientY: 55 }));
    state.advance(50);
    state.frames.values().next().value?.(16);
    expect(state.previews.at(-1)).toMatchObject({ r: 30, g: 35 });
    const samplesBeforeUp = state.samples.length;
    state.input.up?.(pointer({ clientX: 32, clientY: 36, buttons: 0 }));
    expect(state.picked).toHaveLength(1);
    expect(state.picked[0]).toMatchObject({ r: 30, g: 35 });
    expect(state.samples.length).toBe(samplesBeforeUp);
    state.lifecycle.destroy();
  });

  it('ignores touch, pen erasers, side buttons, and non-primary pen contacts', () => {
    const state = setup();
    state.input.down?.(pointer({ pointerType: 'touch' }));
    state.input.down?.(pointer({ button: 5 }));
    state.input.down?.(pointer({ button: 2 }));
    state.input.down?.(pointer({ isPrimary: false }));
    expect(state.captured.size).toBe(0);
    expect(state.previews).toHaveLength(0);
    expect(state.picked).toHaveLength(0);
    state.lifecycle.destroy();
  });

  it('accepts Windows Ink primary-tip pointerdown with button=-1', () => {
    const state = setup();
    state.input.down?.(pointer({ button: -1, buttons: 1 }));
    state.input.up?.(pointer({ button: -1, buttons: 0 }));
    expect(state.picked).toHaveLength(1);
    state.lifecycle.destroy();
  });

  it('accepts the primary mouse button and samples rendered canvas pixels outside images', () => {
    const state = setup();
    state.input.down?.(pointer({ pointerType: 'mouse' }));
    state.input.up?.(pointer({ pointerType: 'mouse', buttons: 0 }));
    expect(state.picked).toHaveLength(1);
    state.input.down?.(pointer({ pointerId: 2, clientX: 150, clientY: 150 }));
    state.input.up?.(pointer({ pointerId: 2, clientX: 150, clientY: 150, buttons: 0 }));
    expect(state.picked).toHaveLength(2);
    expect(state.picked[1]).toMatchObject({ r: 150, g: 150 });
    state.lifecycle.destroy();
  });

  it('still samples a few pixels past the canvas edge', () => {
    const state = setup();
    state.input.down?.(pointer({ pointerType: 'mouse', clientX: 204, clientY: 8 }));
    state.input.up?.(pointer({ pointerType: 'mouse', clientX: 204, clientY: 8, buttons: 0 }));
    expect(state.picked).toHaveLength(1);
    expect(state.picked[0].r).toBeCloseTo(200, 0);
    expect(state.picked[0].g).toBe(8);
    state.lifecycle.destroy();
  });

  it('cancels when the pointer is far outside the canvas', () => {
    const state = setup();
    state.input.down?.(pointer({ pointerType: 'mouse', clientX: 260, clientY: 10 }));
    state.input.up?.(pointer({ pointerType: 'mouse', clientX: 260, clientY: 10, buttons: 0 }));
    expect(state.picked).toHaveLength(0);
    state.lifecycle.destroy();
  });

  it('keeps native collaboration input on the canvas even when CSS coords sit past the edge', () => {
    const state = setup();
    state.input.down?.(pointer({
      pointerType: 'mouse', nativeInput: true, clientX: -30, clientY: 8,
    }));
    state.input.up?.(pointer({
      pointerType: 'mouse', nativeInput: true, clientX: 260, clientY: 8, buttons: 0,
    }));
    expect(state.picked).toHaveLength(1);
    expect(state.picked[0].r).toBeCloseTo(200, 0);
    expect(state.picked[0].g).toBe(8);
    state.lifecycle.destroy();
  });

  it('starts sampling from an overlay that sits above the canvas', () => {
    const host = new FakeCaptureHost();
    const state = setup(undefined, host);
    host.emit('pointerdown', pointer({ pointerType: 'mouse', clientX: 12, clientY: 14 }));
    expect(state.positions.at(-1)).toEqual({ x: 12, y: 14 });
    host.emit('pointerup', pointer({ pointerType: 'mouse', clientX: 12, clientY: 14, buttons: 0 }));
    expect(state.picked).toHaveLength(1);
    expect(state.picked[0]).toMatchObject({ r: 12, g: 14 });
    state.lifecycle.destroy();
  });

  it('does not restart when capture and the canvas router see the same pointerdown', () => {
    const host = new FakeCaptureHost();
    const state = setup(undefined, host);
    const event = pointer({ pointerType: 'mouse', clientX: 12, clientY: 14 });
    host.emit('pointerdown', event);
    state.input.down?.(event);
    expect(state.positions.filter((point) => point)).toHaveLength(1);
    state.input.up?.(pointer({ pointerType: 'mouse', clientX: 12, clientY: 14, buttons: 0 }));
    expect(state.picked).toHaveLength(1);
    state.lifecycle.destroy();
  });
});
