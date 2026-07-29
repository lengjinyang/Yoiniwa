import { emptyImageSyncResult, type ImageRenderBackend, type ResolvedImageRenderCommand } from './ImageRenderBackend';
import { canvasImageTransform } from './renderTransforms';
import type { Viewport } from '../types';

export class Canvas2DImageRenderer implements ImageRenderBackend {
  readonly kind = 'canvas2d' as const;
  private readonly context: CanvasRenderingContext2D;
  private pixelRatio = 1;
  private width = 0;
  private height = 0;
  private drawCalls = 0;
  private lastViewport: Viewport = { x: 0, y: 0, scale: 0 };

  constructor(private readonly canvas: HTMLCanvasElement) {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas2D 不可用');
    this.context = context;
  }

  resize(width: number, height: number, pixelRatio: number) {
    const nextWidth = Math.max(1, width);
    const nextHeight = Math.max(1, height);
    const nextPixelRatio = Math.max(1, pixelRatio);
    if (this.width === nextWidth && this.height === nextHeight && this.pixelRatio === nextPixelRatio) return;
    this.width = nextWidth;
    this.height = nextHeight;
    this.pixelRatio = nextPixelRatio;
    this.canvas.width = Math.max(1, Math.round(nextWidth * nextPixelRatio));
    this.canvas.height = Math.max(1, Math.round(nextHeight * nextPixelRatio));
    this.canvas.style.width = `${nextWidth}px`;
    this.canvas.style.height = `${nextHeight}px`;
  }

  syncImages(_images: ReadonlyMap<string, HTMLImageElement>, _activeIds: ReadonlySet<string>, _protectedIds?: ReadonlySet<string>) {
    // Canvas2D receives image sources with each draw command and does not own GPU resources.
    return emptyImageSyncResult();
  }

  render(commands: readonly ResolvedImageRenderCommand[], viewport: Viewport) {
    this.lastViewport = { ...viewport };
    const context = this.context;
    context.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
    context.clearRect(0, 0, this.canvas.width / this.pixelRatio, this.canvas.height / this.pixelRatio);
    // Resource resolution stays outside the backend; it only owns shared transform math.
    this.drawCalls = 0;
    commands.forEach((command) => {
      const image = command.image;
      if (!image) return;
      this.drawCalls += 1;
      context.save();
      const transform = canvasImageTransform(command, viewport);
      context.translate(transform.x, transform.y);
      context.rotate(transform.rotation);
      context.scale(transform.scaleX, transform.scaleY);
      context.globalAlpha = command.opacity;
      if (command.grayscale) context.filter = 'grayscale(1)';
      const sourceScaleX = image instanceof HTMLImageElement ? image.naturalWidth / command.naturalWidth : 1;
      const sourceScaleY = image instanceof HTMLImageElement ? image.naturalHeight / command.naturalHeight : 1;
      context.drawImage(image,
        command.sourceRect.x * sourceScaleX, command.sourceRect.y * sourceScaleY,
        command.sourceRect.width * sourceScaleX, command.sourceRect.height * sourceScaleY,
        -command.width / 2, -command.height / 2, command.width, command.height);
      context.restore();
    });
  }

  getStats() {
    return {
      drawCalls: this.drawCalls, instances: this.drawCalls, gpuBytes: 0, textureUploads: 0, textureCount: 0,
      bindTextureCalls: 0, bufferDataCalls: 0, bufferSubDataCalls: 0,
      texImage2DCalls: 0, texSubImage2DCalls: 0, textureUploadMs: 0,
      renderedViewportX: this.lastViewport.x, renderedViewportY: this.lastViewport.y,
      renderedViewportScale: this.lastViewport.scale,
    };
  }

  destroy() { this.context.clearRect(0, 0, this.canvas.width, this.canvas.height); }
}
