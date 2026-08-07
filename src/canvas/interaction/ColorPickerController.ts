import type { ImageItem, PickedColor } from '../../types';
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
  item?: ImageItem;
  color?: PickedColor;
}

function sourcePixel(item: ImageItem, point: Point) {
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

export class ColorPickerController {
  private state: 'idle' | 'sampling' | 'committed' | 'canceled' = 'idle';
  private request = 0;
  private pointerId?: number;
  private pointerType?: string;
  private previewFrame?: number;
  private pendingPreview?: Point;
  private lastClientPoint?: Point;
  private lastPreviewSampleAt = Number.NEGATIVE_INFINITY;
  constructor(private readonly options: {
    element: HTMLElement;
    input: InputRouter | PointerInput;
    camera: Camera;
    lifecycle: RuntimeLifecycle;
    scene(): SceneStore | undefined;
    enabled(event: PointerEvent): boolean;
    sample(point: Point, final: boolean): PickedColor | undefined;
    position(point?: Point): void;
    preview(color: PickedColor | undefined): void;
    picked(color: PickedColor): void;
    sampleSource?(item: ImageItem, point: Point): Promise<{ r: number; g: number; b: number; a: number }>;
    schedulePreview?(callback: FrameRequestCallback): number;
    cancelPreview?(handle: number): void;
    previewSampleIntervalMs?: number;
    now?(): number;
  }) {}

  private now() { return this.options.now?.() ?? performance.now(); }

  start() {
    const down = (event: PointerEvent) => {
      if (!supportsPickerGesture(event) || !this.options.enabled(event)) return;
      const target = this.sampleTarget(event.clientX, event.clientY, false, false);
      if (!target.item?.assetId) return;
      if (this.state === 'sampling' || this.pointerId !== undefined || this.previewFrame !== undefined) this.cancel();
      else this.request += 1;
      event.preventDefault();
      this.state = 'sampling';
      this.pointerId = event.pointerId;
      this.pointerType = event.pointerType;
      this.lastClientPoint = { x: event.clientX, y: event.clientY };
      this.request += 1;
      try { this.options.element.setPointerCapture(event.pointerId); } catch { /* Synthetic input may not support capture. */ }
      this.lastPreviewSampleAt = this.now();
      this.options.position(target.point);
      // Defer the first GPU color readback until a move frame so pen-down
      // remains responsive and does not stall the start of a drag gesture.
      this.options.preview(undefined);
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
      event.preventDefault();
      const latest = latestPointerEvent(event);
      this.pendingPreview = { x: latest.clientX, y: latest.clientY };
      this.lastClientPoint = this.pendingPreview;
      if (this.previewFrame !== undefined) return;
      const schedule = this.options.schedulePreview ?? requestAnimationFrame;
      this.previewFrame = schedule(() => {
        this.previewFrame = undefined;
        const pending = this.pendingPreview;
        this.pendingPreview = undefined;
        if (!pending || this.pointerId === undefined) return;
        const target = this.sampleTarget(pending.x, pending.y, false, false);
        // Position updates are intentionally independent from GPU sampling. The
        // reticle stays attached to the pen at display refresh rate even when a
        // color readback is skipped because the GPU is busy.
        this.options.position(target.point);
        if (!target.item?.assetId) {
          this.options.preview(undefined);
          return;
        }
        const now = this.now();
        const interval = this.options.previewSampleIntervalMs ?? 33;
        if (now - this.lastPreviewSampleAt < interval) return;
        this.lastPreviewSampleAt = now;
        const color = this.options.sample(target.point, false);
        if (color) this.options.preview(color);
      });
    };
    const up = (event: PointerEvent) => {
      if (this.state !== 'sampling' || event.pointerId !== this.pointerId) return;
      event.preventDefault();
      const latest = latestPointerEvent(event);
      this.finish(event.pointerId, { x: latest.clientX, y: latest.clientY });
    };
    const cancel = (event: PointerEvent) => {
      if (event.pointerId !== this.pointerId) return;
      // Wacom/Windows Ink can end a valid primary-tip contact with
      // pointercancel during a focus transition. Preserve the artist's last
      // sampled position instead of silently dropping the gesture.
      if (this.pointerType === 'pen' && this.lastClientPoint) {
        this.finish(event.pointerId, this.lastClientPoint);
      } else this.cancel(event.pointerId);
    };
    const disposers = [
      this.options.input.onPointerDown(down), this.options.input.onPointerMove(move),
      this.options.input.onPointerUp(up), this.options.input.onPointerCancel(cancel),
    ];
    this.options.lifecycle.add(() => {
      this.cancel();
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

  private sampleTarget(clientX: number, clientY: number, final: boolean, sample = true): SampleTarget {
    const bounds = this.options.element.getBoundingClientRect();
    const point = { x: clientX - bounds.left, y: clientY - bounds.top };
    const world = this.options.camera.screenToWorld(point);
    const scene = this.options.scene();
    const item = scene?.imageAtPoint(world);
    return { point, world, item, color: sample && item?.assetId ? this.options.sample(point, final) : undefined };
  }

  private release(pointerId: number) {
    this.clearPreviewFrame();
    this.pointerId = undefined;
    this.pointerType = undefined;
    this.lastClientPoint = undefined;
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
    const target = this.sampleTarget(clientPoint.x, clientPoint.y, true);
    const token = this.request;
    this.release(pointerId);
    // The gesture has ended even when the final source-pixel read is async.
    // Clear the reticle immediately instead of leaving a stale marker visible
    // while Photoshop synchronization or the fallback read completes.
    this.options.position();
    this.options.preview(undefined);
    if (!target.item?.assetId) {
      this.state = 'canceled';
      this.options.position();
      this.options.preview(undefined);
      return;
    }
    if (target.color) {
      this.commit(target.color);
      return;
    }
    const sampleSource = this.options.sampleSource ?? ((item: ImageItem, point: Point) => {
      if (!window.refCanvas) return Promise.reject(new Error('桌面取色服务不可用'));
      const pixel = sourcePixel(item, point);
      return window.refCanvas.sampleImagePixel(item.assetId as string, pixel.x, pixel.y);
    });
    void sampleSource(target.item, target.world).then((rgba) => {
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
