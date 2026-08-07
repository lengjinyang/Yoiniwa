import { describe, expect, it, vi } from 'vitest';
import { Camera } from './Camera';
import { CameraController } from './CameraController';
import type { InputRouter } from '../interaction/InputRouter';
import { RuntimeLifecycle } from '../runtime/RuntimeLifecycle';

describe('CameraController', () => {
  it('keeps wheel motion in Runtime and commits one summary after the gesture settles', () => {
    vi.useFakeTimers();
    let wheel: ((event: WheelEvent) => void) | undefined;
    const input = {
      onPointerDown: () => () => undefined, onPointerMove: () => () => undefined, onPointerUp: () => () => undefined,
      onPointerCancel: () => () => undefined,
      onWheel: (handler: (event: WheelEvent) => void) => { wheel = handler; return () => { wheel = undefined; }; },
    } as unknown as InputRouter;
    const element = {
      getBoundingClientRect: () => ({ left: 0, top: 0 }),
      setPointerCapture: () => undefined, releasePointerCapture: () => undefined,
    } as unknown as HTMLElement;
    const changes: boolean[] = [];
    const lifecycle = new RuntimeLifecycle();
    new CameraController(element, input, new Camera(), lifecycle, (committed) => changes.push(committed)).start();
    const event = { preventDefault: vi.fn(), clientX: 100, clientY: 100, deltaY: -1 } as unknown as WheelEvent;
    wheel?.(event); wheel?.(event); wheel?.(event);
    expect(changes).toEqual([false, false, false]);
    vi.advanceTimersByTime(119);
    expect(changes).toEqual([false, false, false]);
    vi.advanceTimersByTime(1);
    expect(changes).toEqual([false, false, false, true]);
    lifecycle.destroy();
    vi.useRealTimers();
  });
});
