import { describe, expect, it, vi } from 'vitest';
import { createScene } from '../../scene';
import type { ImageItem } from '../../types';
import { Camera } from '../camera/Camera';
import { RuntimeLifecycle } from '../runtime/RuntimeLifecycle';
import { SceneStore } from '../scene/SceneStore';
import { SelectionController } from './SelectionController';

function pointer(clientX: number, clientY: number, type: 'down' | 'move' | 'up', pointerType: PointerEvent['pointerType'] = 'mouse'): PointerEvent {
  return {
    pointerId: 1,
    pointerType,
    button: type === 'move' ? -1 : 0,
    buttons: type === 'up' ? 0 : 1,
    clientX,
    clientY,
    altKey: false,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
  } as PointerEvent;
}

describe('SelectionController video scrub', () => {
  it('routes horizontal dragging on an already selected video to the scrub session', () => {
    const scene = createScene();
    const video: ImageItem = {
      id: 'video', name: 'clip.mp4', sourceType: 'file', assetId: 'asset', mediaKind: 'video',
      naturalWidth: 1920, naturalHeight: 1080, x: 0, y: 0, width: 200, height: 100,
      rotation: 0, flipX: false, flipY: false, opacity: 1, zIndex: 0, locked: false,
      crop: { x: 0, y: 0, width: 1920, height: 1080 }, durationSec: 10,
    };
    scene.items = [video];
    const updates: number[] = [];
    const end = vi.fn();
    const captured = new Set<number>();
    const element = {
      style: { cursor: '' },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 300 }),
      setPointerCapture: (id: number) => captured.add(id),
      hasPointerCapture: (id: number) => captured.has(id),
      releasePointerCapture: (id: number) => captured.delete(id),
    } as unknown as HTMLElement;
    const controller = new SelectionController({
      element,
      input: {} as never,
      camera: new Camera(),
      lifecycle: new RuntimeLifecycle(),
      scene: () => new SceneStore(scene),
      preview: vi.fn(), commit: vi.fn(), selectionChanged: vi.fn(), lassoSelectionChanged: vi.fn(),
      groupSelectionChanged: vi.fn(), previewGroup: vi.fn(), commitGroup: vi.fn(), previewGroupResize: vi.fn(),
      commitGroupResize: vi.fn(), openGroupMenu: vi.fn(), expandGroup: vi.fn(), groupHeaderHoverChanged: vi.fn(),
      transformOverlaysHidden: vi.fn(), drawOverlay: vi.fn(), hitHandle: () => undefined,
      hitGroupHandle: () => undefined, interactionBlocked: () => false, documentInteractionBlocked: () => false,
      beginVideoScrub: () => ({ update: (deltaX) => updates.push(deltaX), end }),
      externalDrag: () => undefined, cameraChanged: vi.fn(),
    });
    controller.setSelection([video.id]);
    const interactive = controller as unknown as {
      pointerDown(event: PointerEvent): void;
      pointerMove(event: PointerEvent): void;
      pointerUp(event: PointerEvent): void;
    };

    interactive.pointerDown(pointer(50, 50, 'down'));
    interactive.pointerMove(pointer(62, 50, 'move'));
    interactive.pointerMove(pointer(46, 50, 'move'));
    interactive.pointerUp(pointer(46, 50, 'up'));

    expect(updates).toEqual([12, -4]);
    expect(end).toHaveBeenCalledOnce();
    expect(captured.size).toBe(0);
  });

  it('also routes pen dragging on a selected video to the scrub session', () => {
    const scene = createScene();
    const video: ImageItem = {
      id: 'video', name: 'clip.mp4', sourceType: 'file', assetId: 'asset', mediaKind: 'video',
      naturalWidth: 1920, naturalHeight: 1080, x: 0, y: 0, width: 200, height: 100,
      rotation: 0, flipX: false, flipY: false, opacity: 1, zIndex: 0, locked: false,
      crop: { x: 0, y: 0, width: 1920, height: 1080 }, durationSec: 10,
    };
    scene.items = [video];
    const updates: number[] = [];
    const element = {
      style: { cursor: '' },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 300 }),
      setPointerCapture: vi.fn(),
      hasPointerCapture: () => false,
      releasePointerCapture: vi.fn(),
    } as unknown as HTMLElement;
    const controller = new SelectionController({
      element,
      input: {} as never,
      camera: new Camera(),
      lifecycle: new RuntimeLifecycle(),
      scene: () => new SceneStore(scene),
      preview: vi.fn(), commit: vi.fn(), selectionChanged: vi.fn(), lassoSelectionChanged: vi.fn(),
      groupSelectionChanged: vi.fn(), previewGroup: vi.fn(), commitGroup: vi.fn(), previewGroupResize: vi.fn(),
      commitGroupResize: vi.fn(), openGroupMenu: vi.fn(), expandGroup: vi.fn(), groupHeaderHoverChanged: vi.fn(),
      transformOverlaysHidden: vi.fn(), drawOverlay: vi.fn(), hitHandle: () => undefined,
      hitGroupHandle: () => undefined, interactionBlocked: () => false, documentInteractionBlocked: () => false,
      beginVideoScrub: () => ({ update: (deltaX) => updates.push(deltaX), end: vi.fn() }),
      externalDrag: () => undefined, cameraChanged: vi.fn(),
    });
    controller.setSelection([video.id]);
    const interactive = controller as unknown as {
      pointerDown(event: PointerEvent): void;
      pointerMove(event: PointerEvent): void;
    };
    interactive.pointerDown(pointer(50, 50, 'down', 'pen'));
    interactive.pointerMove({
      ...pointer(80, 50, 'move', 'pen'),
      getCoalescedEvents: () => [],
    } as PointerEvent);
    expect(updates).toEqual([30]);
  });
});
