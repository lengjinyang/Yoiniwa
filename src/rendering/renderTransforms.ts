import type { ImageRenderCommand } from './renderPlan';
import type { Viewport } from '../types';

export function canvasImageTransform(command: ImageRenderCommand, viewport: Viewport) {
  return {
    x: viewport.x + (command.x + command.width / 2) * viewport.scale,
    y: viewport.y + (command.y + command.height / 2) * viewport.scale,
    rotation: command.rotation * Math.PI / 180,
    scaleX: (command.flipX ? -1 : 1) * viewport.scale,
    scaleY: (command.flipY ? -1 : 1) * viewport.scale,
  };
}

export function webglTransform(command: ImageRenderCommand, viewport: Viewport, pixelRatio: number) {
  const transform = canvasImageTransform(command, viewport);
  const cosine = Math.cos(transform.rotation);
  const sine = Math.sin(transform.rotation);
  const scaleX = transform.scaleX * pixelRatio;
  const scaleY = transform.scaleY * pixelRatio;
  return new Float32Array([
    cosine * scaleX, sine * scaleX, 0,
    -sine * scaleY, cosine * scaleY, 0,
    transform.x * pixelRatio, transform.y * pixelRatio, 1,
  ]);
}
