import { describe, expect, it, vi } from 'vitest';
import { Camera } from '../camera/Camera';
import { RuntimeLifecycle } from '../runtime/RuntimeLifecycle';
import { SceneStore } from '../scene/SceneStore';
import { createScene } from '../../scene';
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

function pointer(overrides: Partial<PointerEvent> = {}) {
  return {
    pointerId: 1, pointerType: 'pen', isPrimary: true, button: 0, buttons: 1,
    clientX: 10, clientY: 10, altKey: true, ctrlKey: false, shiftKey: false,
    preventDefault: vi.fn(), getCoalescedEvents: () => [],
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

function setup() {
  const input = new FakeInput();
  const lifecycle = new RuntimeLifecycle();
  const scene = createScene(); scene.items = [image()];
  const captured = new Set<number>();
  const element = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 200 }),
    setPointerCapture: (id: number) => captured.add(id),
    hasPointerCapture: (id: number) => captured.has(id),
    releasePointerCapture: (id: number) => captured.delete(id),
  } as unknown as HTMLElement;
  const frames = new Map<number, FrameRequestCallback>(); let frameId = 0;
  const positions: Array<{ x: number; y: number } | undefined> = [];
  const previews: Array<PickedColor | undefined> = [];
  const picked: PickedColor[] = [];
  const captureReleasedBeforePick: boolean[] = [];
  const samples: Array<{ point: { x: number; y: number }; final: boolean }> = [];
  let now = 0;
  const controller = new ColorPickerController({
    element, input, lifecycle, camera: new Camera(), scene: () => new SceneStore(scene),
    enabled: (event) => event.altKey,
    sample: (point, final) => {
      samples.push({ point, final });
      return { r: point.x, g: point.y, b: 30, a: 1, hex: `#${point.x}-${point.y}` };
    },
    position: (point) => positions.push(point),
    preview: (color) => previews.push(color),
    picked: (color) => { captureReleasedBeforePick.push(!captured.has(1)); picked.push(color); },
    schedulePreview: (callback) => {
      const id = ++frameId;
      frames.set(id, (time) => { frames.delete(id); callback(time); });
      return id;
    },
    cancelPreview: (id) => { frames.delete(id); },
    now: () => now,
  });
  controller.start();
  return {
    input, lifecycle, captured, frames, positions, previews, picked, samples, captureReleasedBeforePick,
    advance(ms: number) { now += ms; },
  };
}

describe('ColorPickerController', () => {
  it('captures a Windows Ink pen, previews the latest move once per frame, and commits on release', () => {
    const state = setup();
    state.input.down?.(pointer());
    expect(state.captured.has(1)).toBe(true);
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
    expect(state.picked[0]).toMatchObject({ r: 40, g: 45 });
    expect(state.captureReleasedBeforePick).toEqual([true]);
    expect(state.positions.at(-1)).toBeUndefined();
    expect(state.previews.at(-1)).toBeUndefined();
    state.input.up?.(pointer({ clientX: 50, clientY: 55, buttons: 0 }));
    expect(state.picked).toHaveLength(1);
    state.lifecycle.destroy();
  });

  it('moves the reticle every frame while limiting GPU preview samples to 30 Hz', () => {
    const state = setup();
    state.input.down?.(pointer());
    expect(state.samples).toHaveLength(0);

    state.input.move?.(pointer({ clientX: 20, clientY: 21 }));
    state.advance(10);
    state.frames.values().next().value?.(10);
    expect(state.positions.at(-1)).toEqual({ x: 20, y: 21 });
    expect(state.samples).toHaveLength(0);

    state.input.move?.(pointer({ clientX: 30, clientY: 31 }));
    state.advance(24);
    state.frames.values().next().value?.(34);
    expect(state.positions.at(-1)).toEqual({ x: 30, y: 31 });
    expect(state.samples).toHaveLength(1);
    expect(state.samples.at(-1)).toEqual({ point: { x: 30, y: 31 }, final: false });

    state.input.up?.(pointer({ clientX: 40, clientY: 41, buttons: 0 }));
    expect(state.samples.at(-1)).toEqual({ point: { x: 40, y: 41 }, final: true });
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

  it('accepts the primary mouse button and ignores a gesture that starts off-image', () => {
    const state = setup();
    state.input.down?.(pointer({ pointerType: 'mouse' }));
    state.input.up?.(pointer({ pointerType: 'mouse', buttons: 0 }));
    expect(state.picked).toHaveLength(1);
    state.input.down?.(pointer({ pointerId: 2, clientX: 150, clientY: 150 }));
    state.input.up?.(pointer({ pointerId: 2, clientX: 150, clientY: 150, buttons: 0 }));
    expect(state.picked).toHaveLength(1);
    state.lifecycle.destroy();
  });
});
