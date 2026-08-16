import type { SceneItem, PickedColor } from '../../types';
import type { Camera } from '../camera/Camera';
import type { SceneStore } from '../scene/SceneStore';
import type { InputRouter } from './InputRouter';
import type { RuntimeLifecycle } from '../runtime/RuntimeLifecycle';

interface Point { x: number; y: number }

interface PointerInput {
  onPointerDown(handler: (event: PointerEvent) => void): () => void;
  onPointerMove(handler: (event: PointerEvent) => void): () => void;
  onPointerUp(handler: (event: PointerEvent) => void): () => void;
  onPointerCancel(handler: (event: PointerEvent) => void): () => void;
}

interface SampleTarget {
  point: Point;
  world: Point;
  inside: boolean;
  item?: SceneItem;
  color?: PickedColor;
}

function sourcePixel(item: SceneItem, point: Point) {
  const centerX = item.x + item.width / 2; const centerY = item.y + item.height / 2;
  const radians = -item.rotation * Math.PI / 180;
  const dx = point.x - centerX; const dy = point.y - centerY;
  let localX = dx * Math.cos(radians) - dy * Math.sin(radians);
  let localY = dx * Math.sin(radians) + dy * Math.cos(radians);
  if (item.flipX) localX *= -1; if (item.flipY) localY *= -1;
  const u = Math.max(0, Math.min(1, localX / item.width + 0.5));
  const v = Math.max(0, Math.min(1, localY / item.height + 0.5));
  return { x: Math.floor(item.crop.x + u * Math.max(0, item.crop.width - 1)), y: Math.floor(item.crop.y + v * Math.max(0, item.crop.height - 1)) };
}

function latestPointerEvent(event: PointerEvent) {
  if ((event as PointerEvent & { nativeInput?: boolean }).nativeInput) return event;
  const coalesced = event.getCoalescedEvents?.();
  return coalesced?.length ? coalesced[coalesced.length - 1] : event;
}

function supportsPickerGesture(event: PointerEvent) {
  if (event.pointerType === 'mouse') return event.button === 0;
  if (event.pointerType !== 'pen' || !event.isPrimary) return false;
  const primaryTip = event.button === 0 || (event.button === -1 && (event.buttons & 1) !== 0);
  return primaryTip && (event.buttons & ~1) === 0;
}

function colorFromRgba(rgba: { r: number; g: number; b: number; a: number }): PickedColor {
  const hex = `#${[rgba.r, rgba.g, rgba.b].map((value) => value.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
  return { ...rgba, hex };
}

function preventMouseDefault(event: PointerEvent) {
  if (event.pointerType !== 'pen') event.preventDefault();
}

/** Client pixels past the canvas rect that still count as inside. Covers DPI
 *  rounding and a few pixels that Windows maps through the resize frame. */
const EDGE_TOLERANCE_PX = 24;

function fromCanvasElement(element: HTMLElement, event: PointerEvent) {
  if ((event as PointerEvent & { nativeInput?: boolean }).nativeInput) return true;
  const target = event.target;
  if (!target || typeof Node === 'undefined' || !(target instanceof Node)) return false;
  return element.contains?.(target) === true;
}

export class ColorPickerController {
  private state: 'idle' | 'sampling' | 'committed' | 'canceled' = 'idle';
  private request = 0;
  private pointerId?: number;
  private pointerType?: string;
  private previewFrame?: number;
  private pendingPreview?: Point;
  private lastClientPoint?: Point;
  private lastPreviewColor?: PickedColor;
  private lastPreviewSampleAt = Number.NEGATIVE_INFINITY;
  /** Same native event can arrive from window capture and the canvas router. */
  private handledPointerEvent?: PointerEvent;
  /** Native collaboration input is already clipped to the Yoiniwa window. */
  private nativeGesture = false;
  /** Client rect captured on tip-down so drag does not force layout. */
  private gestureHost?: { left: number; top: number; width: number; height: number };
  private lastHost?: { left: number; top: number; width: number; height: number; at: number };
  constructor(private readonly options: {
    element: HTMLElement;
    input: InputRouter | PointerInput;
    camera: Camera;
    lifecycle: RuntimeLifecycle;
    scene(): SceneStore | undefined;
    enabled(event: PointerEvent): boolean;
    sample(point: Point, final: boolean): PickedColor | undefined;
    position(point?: Point): void;
    pending?(): void;
    preview(color: PickedColor | undefined): void;
    picked(color: PickedColor): void;
    sampleSource?(item: SceneItem, point: Point): Promise<{ r: number; g: number; b: number; a: number }>;
    schedulePreview?(callback: FrameRequestCallback): number;
    cancelPreview?(handle: number): void;
    previewSampleIntervalMs?: number;
    now?(): number;
    /** Capture-phase host for overlay punch-through. Defaults to `window`. */
    captureTarget?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  }) {}

  private now() { return this.options.now?.() ?? performance.now(); }

  start() {
    const queuePreview = (clientPoint: Point) => {
      this.pendingPreview = clientPoint;
      this.lastClientPoint = clientPoint;
      if (this.previewFrame !== undefined) return;
      const schedule = this.options.schedulePreview ?? requestAnimationFrame;
      this.previewFrame = schedule(() => {
        this.previewFrame = undefined;
        const pending = this.pendingPreview;
        this.pendingPreview = undefined;
        if (!pending || this.pointerId === undefined) return;
        const target = this.sampleTarget(pending.x, pending.y, false, false);
        // Color readback is throttled. Reticle/HUD position is applied on the
        // pointer event itself so a tablet tip is not one frame behind.
        if (!target.inside) return;
        const now = this.now();
        const awaitingFirstColor = this.lastPreviewColor === undefined;
        // Match Alt+mouse: live color at display refresh. In-flight GPU
        // readback is the only throttle; the pointer path only moves the HUD.
        const interval = this.options.previewSampleIntervalMs ?? 16;
        if (!awaitingFirstColor && now - this.lastPreviewSampleAt < interval) return;
        this.lastPreviewSampleAt = now;
        const color = this.options.sample(target.point, false);
        if (color) {
          this.lastPreviewColor = color;
          this.options.preview(color);
        }
        if (this.pointerId !== undefined && this.lastPreviewColor === undefined) {
          queuePreview(pending);
        }
      });
    };
    const down = (event: PointerEvent) => {
      if (this.handledPointerEvent === event) return;
      if (!supportsPickerGesture(event) || !this.options.enabled(event)) return;
      this.handledPointerEvent = event;
      // Keep a valid Alt contact alive even when its first packet lands just
      // outside an image. The same contact can then begin sampling as soon as
      // the user drags onto an image instead of remaining inert until tip-up.
      if (this.state === 'sampling' || this.state === 'committed'
        || this.pointerId !== undefined || this.previewFrame !== undefined) this.cancel();
      else this.request += 1;
      this.nativeGesture = Boolean((event as PointerEvent & { nativeInput?: boolean }).nativeInput);
      this.captureHostRect();
      const target = this.mapClient(event.clientX, event.clientY);
      preventMouseDefault(event);
      this.state = 'sampling';
      this.pointerId = event.pointerId;
      this.pointerType = event.pointerType;
      this.lastClientPoint = { x: event.clientX, y: event.clientY };
      this.lastPreviewColor = undefined;
      this.lastPreviewSampleAt = Number.NEGATIVE_INFINITY;
      this.request += 1;
      // Pointer capture forces a WebView hit-test and can hitch the first
      // Windows Ink drag. Mouse still needs it to track outside the canvas.
      if (event.pointerType === 'mouse' && !this.nativeGesture) {
        try { this.options.element.setPointerCapture(event.pointerId); } catch { /* Synthetic input may not support capture. */ }
      }
      this.options.position(target.point);
      queuePreview({ x: event.clientX, y: event.clientY });
    };
    const move = (event: PointerEvent) => {
      if (this.state !== 'sampling' || event.pointerId !== this.pointerId) return;
      // Some Windows Ink drivers briefly report buttons=0 while the primary
      // tip is still captured. Mouse input has stable button state, but a pen
      // gesture is completed by pointerup/pointercancel instead.
      if (this.pointerType === 'mouse' && (event.buttons & 1) === 0) {
        this.cancel(event.pointerId);
        return;
      }
      preventMouseDefault(event);
      const latest = latestPointerEvent(event);
      const clientPoint = { x: latest.clientX, y: latest.clientY };
      const target = this.mapClient(clientPoint.x, clientPoint.y);
      this.options.position(target.point);
      queuePreview(clientPoint);
    };
    const up = (event: PointerEvent) => {
      if (this.state !== 'sampling' || event.pointerId !== this.pointerId) return;
      preventMouseDefault(event);
      const latest = latestPointerEvent(event);
      this.finish(event.pointerId, { x: latest.clientX, y: latest.clientY });
    };
    const cancel = (event: PointerEvent) => {
      if (event.pointerId !== this.pointerId) return;
      // Wacom/Windows Ink can end a valid primary-tip contact with
      // pointercancel during a focus transition. Preserve the artist's last
      // sampled position instead of silently dropping the gesture. The native
      // collaboration layer has stricter semantics: its CANCEL means the
      // gesture was aborted and must never submit color during a later DOWN.
      const nativeInput = Boolean((event as PointerEvent & { nativeInput?: boolean }).nativeInput);
      if (!nativeInput && this.pointerType === 'pen' && this.lastClientPoint) {
        this.finish(event.pointerId, this.lastClientPoint);
      } else this.cancel(event.pointerId);
    };
    const overlayDown = (event: PointerEvent) => {
      down(event);
      if (this.pointerId === event.pointerId && this.state === 'sampling'
        && !fromCanvasElement(this.options.element, event)) {
        preventMouseDefault(event);
        event.stopPropagation();
      }
    };
    const overlayMove = (event: PointerEvent) => {
      if (this.state !== 'sampling' || event.pointerId !== this.pointerId) return;
      if (fromCanvasElement(this.options.element, event)) return;
      move(event);
    };
    const overlayUp = (event: PointerEvent) => {
      if (this.state !== 'sampling' || event.pointerId !== this.pointerId) return;
      if (fromCanvasElement(this.options.element, event)) return;
      up(event);
    };
    const overlayCancel = (event: PointerEvent) => {
      if (event.pointerId !== this.pointerId) return;
      if (fromCanvasElement(this.options.element, event)) return;
      cancel(event);
    };
    const capture = { capture: true } as const;
    const captureHost = this.options.captureTarget
      ?? (typeof globalThis.window === 'undefined' ? undefined : globalThis.window);
    if (captureHost) {
      captureHost.addEventListener('pointerdown', overlayDown as EventListener, capture);
      captureHost.addEventListener('pointermove', overlayMove as EventListener, capture);
      captureHost.addEventListener('pointerup', overlayUp as EventListener, capture);
      captureHost.addEventListener('pointercancel', overlayCancel as EventListener, capture);
    }
    const disposers = [
      this.options.input.onPointerDown(down), this.options.input.onPointerMove(move),
      this.options.input.onPointerUp(up), this.options.input.onPointerCancel(cancel),
    ];
    this.options.lifecycle.add(() => {
      this.cancel();
      if (captureHost) {
        captureHost.removeEventListener('pointerdown', overlayDown as EventListener, capture);
        captureHost.removeEventListener('pointermove', overlayMove as EventListener, capture);
        captureHost.removeEventListener('pointerup', overlayUp as EventListener, capture);
        captureHost.removeEventListener('pointercancel', overlayCancel as EventListener, capture);
      }
      disposers.forEach((dispose) => dispose());
    });
  }

  cancel(pointerId = this.pointerId) {
    if (pointerId !== undefined) this.release(pointerId);
    else this.clearPreviewFrame();
    this.request += 1;
    this.state = 'canceled';
    this.options.position();
    this.options.preview(undefined);
  }

  private captureHostRect() {
    const cached = this.lastHost;
    if (cached && (this.nativeGesture || this.now() - cached.at < 2000)) {
      this.gestureHost = cached;
      return cached;
    }
    const bounds = this.options.element.getBoundingClientRect();
    this.lastHost = {
      left: bounds.left, top: bounds.top,
      width: Math.max(0, bounds.width), height: Math.max(0, bounds.height),
      at: this.now(),
    };
    this.gestureHost = this.lastHost;
    return this.gestureHost;
  }

  private mapClient(clientX: number, clientY: number) {
    const bounds = this.gestureHost ?? this.captureHostRect();
    const raw = { x: clientX - bounds.left, y: clientY - bounds.top };
    const inside = this.nativeGesture || (raw.x >= -EDGE_TOLERANCE_PX && raw.y >= -EDGE_TOLERANCE_PX
      && raw.x < bounds.width + EDGE_TOLERANCE_PX && raw.y < bounds.height + EDGE_TOLERANCE_PX);
    return {
      inside,
      point: {
        x: Math.max(0, Math.min(Math.max(0, bounds.width - 1e-4), raw.x)),
        y: Math.max(0, Math.min(Math.max(0, bounds.height - 1e-4), raw.y)),
      },
    };
  }

  private sampleTarget(clientX: number, clientY: number, final: boolean, sample = true): SampleTarget {
    const { point, inside } = this.mapClient(clientX, clientY);
    const world = this.options.camera.screenToWorld(point);
    const color = sample && inside ? this.options.sample(point, final) : undefined;
    const item = inside && sample && !color ? this.options.scene()?.imageAtPoint(world) : undefined;
    return { point, world, inside, item, color };
  }

  private release(pointerId: number) {
    this.clearPreviewFrame();
    this.pointerId = undefined;
    this.pointerType = undefined;
    this.lastClientPoint = undefined;
    this.lastPreviewColor = undefined;
    this.nativeGesture = false;
    this.gestureHost = undefined;
    try {
      if (this.options.element.hasPointerCapture?.(pointerId)) this.options.element.releasePointerCapture(pointerId);
    } catch { /* The pointer may already have been canceled by Windows Ink. */ }
  }

  private clearPreviewFrame() {
    if (this.previewFrame !== undefined) {
      const cancel = this.options.cancelPreview ?? cancelAnimationFrame;
      cancel(this.previewFrame);
    }
    this.previewFrame = undefined;
    this.pendingPreview = undefined;
  }

  private commit(color: PickedColor) {
    this.state = 'committed';
    this.options.position();
    this.options.preview(undefined);
    this.options.picked(color);
  }

  private finish(pointerId: number, clientPoint: Point) {
    const previewColor = this.lastPreviewColor;
    const target = this.sampleTarget(clientPoint.x, clientPoint.y, !previewColor, !previewColor);
    const token = this.request;
    this.release(pointerId);
    if (!target.inside) {
      this.state = 'canceled';
      this.options.position();
      this.options.preview(undefined);
      return;
    }
    if (previewColor) {
      this.commit(previewColor);
      return;
    }
    if (target.color) {
      this.commit(target.color);
      return;
    }
    const item = target.item;
    if (!item?.assetId) {
      this.state = 'canceled';
      this.options.position();
      this.options.preview(undefined);
      return;
    }
    this.options.position(target.point);
    this.options.pending?.();
    const sampleSource = this.options.sampleSource ?? ((item: SceneItem, point: Point) => {
      if (!window.refCanvas) return Promise.reject(new Error('桌面取色服务不可用'));
      const pixel = sourcePixel(item, point);
      return window.refCanvas.sampleImagePixel(item.assetId as string, pixel.x, pixel.y);
    });
    void sampleSource(item, target.world).then((rgba) => {
      if (token !== this.request) return;
      this.commit(colorFromRgba(rgba));
    }).catch((error: unknown) => {
      if (token !== this.request) return;
      this.state = 'canceled';
      this.options.position();
      this.options.preview(undefined);
      window.dispatchEvent(new CustomEvent('refcanvas-resource-error', { detail: error }));
    });
  }
}
