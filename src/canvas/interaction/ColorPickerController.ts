import type { ImageItem, PickedColor } from '../../types';
import type { Camera } from '../camera/Camera';
import type { SceneStore } from '../scene/SceneStore';
import { topmostImageAtPoint } from '../selection/HitTestService';
import type { InputRouter } from './InputRouter';
import type { RuntimeLifecycle } from '../runtime/RuntimeLifecycle';

function sourcePixel(item: ImageItem, point: { x: number; y: number }) {
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

export class ColorPickerController {
  private request = 0;
  constructor(private readonly options: {
    element: HTMLElement; input: InputRouter; camera: Camera; lifecycle: RuntimeLifecycle;
    scene(): SceneStore | undefined; enabled(): boolean; picked(color: PickedColor): void;
  }) {}

  start() {
    const down = (event: PointerEvent) => {
      if (!this.options.enabled() || event.button !== 0) return;
      const bounds = this.options.element.getBoundingClientRect();
      const world = this.options.camera.screenToWorld({ x: event.clientX - bounds.left, y: event.clientY - bounds.top });
      const item = topmostImageAtPoint(this.options.scene()?.images() ?? [], world);
      if (!item?.assetId || !window.refCanvas) return;
      const token = ++this.request;
      const pixel = sourcePixel(item, world);
      void window.refCanvas.sampleImagePixel(item.assetId, pixel.x, pixel.y).then((rgba) => {
        if (token !== this.request) return;
        const hex = `#${[rgba.r, rgba.g, rgba.b].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
        this.options.picked({ ...rgba, hex });
      }).catch((error: unknown) => window.dispatchEvent(new CustomEvent('refcanvas-resource-error', { detail: error })));
    };
    const dispose = this.options.input.onPointerDown(down);
    this.options.lifecycle.add(() => { this.request += 1; dispose(); });
  }
}
