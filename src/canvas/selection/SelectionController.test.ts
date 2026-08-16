import { afterEach, describe, expect, it, vi } from 'vitest';
import { createScene } from '../../domain/scene';
import type { ImageItem, VideoItem } from '../../types';
import { Camera } from '../camera/Camera';
import type { InputRouter } from '../interaction/InputRouter';
import { RuntimeLifecycle } from '../runtime/RuntimeLifecycle';
import { SceneStore } from '../scene/SceneStore';
import { SelectionController } from './SelectionController';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubWindow() {
  vi.stubGlobal('window', {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
}

function image(id: string, x = 0): ImageItem {
  return {
    id, name: id, sourceType: 'file', naturalWidth: 100, naturalHeight: 100,
    x, y: 0, width: 100, height: 100, rotation: 0, flipX: false, flipY: false,
    opacity: 1, zIndex: 1, locked: false, crop: { x: 0, y: 0, width: 100, height: 100 },
  };
}

function video(id: string): VideoItem {
  return { ...image(id), mediaKind: 'video', durationSec: 10 };
}

describe('SelectionController', () => {
  it('selects the topmost image on click and jogs video after a horizontal drag', () => {
    stubWindow();
    const scene = createScene();
    scene.items = [image('still', 0), video('clip')];
    scene.items[1].x = 200;
    const store = new SceneStore(scene);
    const lifecycle = new RuntimeLifecycle();
    const handlers: {
      down?: (event: PointerEvent) => void;
      move?: (event: PointerEvent) => void;
      up?: (event: PointerEvent) => void;
    } = {};
    const input = {
      onPointerDown: (handler: (event: PointerEvent) => void) => { handlers.down = handler; return () => undefined; },
      onPointerMove: (handler: (event: PointerEvent) => void) => { handlers.move = handler; return () => undefined; },
      onPointerUp: (handler: (event: PointerEvent) => void) => { handlers.up = handler; return () => undefined; },
      onPointerCancel: (handler: (event: PointerEvent) => void) => { handlers.up = handler; return () => undefined; },
    } as unknown as InputRouter;
    const element = {
      style: { cursor: '' },
      clientWidth: 800,
      clientHeight: 600,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
      setPointerCapture: () => undefined,
      releasePointerCapture: () => undefined,
      hasPointerCapture: () => false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as unknown as HTMLElement;
    const selected: string[][] = [];
    const jog = { update: vi.fn(), end: vi.fn() };
    const preview = vi.fn();
    const controller = new SelectionController({
      element, input, camera: new Camera(), lifecycle, scene: () => store,
      preview, commit: vi.fn(),
      selectionChanged: (ids) => { selected.push(ids); },
      lassoSelectionChanged: vi.fn(), groupSelectionChanged: vi.fn(),
      previewGroup: vi.fn(), commitGroup: vi.fn(), previewGroupResize: vi.fn(), commitGroupResize: vi.fn(),
      openGroupMenu: vi.fn(), expandGroup: vi.fn(), groupHeaderHoverChanged: vi.fn(),
      transformOverlaysHidden: vi.fn(), drawOverlay: vi.fn(),
      hitHandle: () => undefined, hitGroupHandle: () => undefined,
      interactionBlocked: () => false, documentInteractionBlocked: () => false,
      canVideoJog: (id) => id === 'clip',
      beginVideoJog: () => jog,
      externalDrag: () => undefined, cameraChanged: vi.fn(),
    });
    controller.start();

    handlers.down?.({
      button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse',
      altKey: false, shiftKey: false, ctrlKey: false, metaKey: false,
      clientX: 40, clientY: 40,
    } as PointerEvent);
    expect(controller.selectedIds()).toEqual(['still']);

    handlers.down?.({
      button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse',
      altKey: false, shiftKey: false, ctrlKey: false, metaKey: false,
      clientX: 240, clientY: 40,
    } as PointerEvent);
    handlers.move?.({
      button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse',
      altKey: false, shiftKey: false, ctrlKey: false, metaKey: false,
      clientX: 248, clientY: 40,
    } as PointerEvent);
    expect(jog.update).toHaveBeenCalledWith(1);
    handlers.up?.({
      button: 0, buttons: 0, pointerId: 1, pointerType: 'mouse',
      altKey: false, shiftKey: false, ctrlKey: false, metaKey: false,
      clientX: 248, clientY: 40,
    } as PointerEvent);
    expect(jog.end).toHaveBeenCalledOnce();
    expect(preview).not.toHaveBeenCalled();

    lifecycle.destroy();
  });
});
