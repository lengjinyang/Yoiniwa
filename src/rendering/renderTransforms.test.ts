import { describe, expect, it } from 'vitest';
import { canvasImageTransform, webglTransform } from './renderTransforms';
import type { ImageRenderCommand } from './renderPlan';

const command: ImageRenderCommand = {
  id: 'item', source: {}, sourceRect: { x: 0, y: 0, width: 100, height: 50 },
  naturalWidth: 100, naturalHeight: 50, x: 10, y: 20, width: 100, height: 50,
  rotation: 90, flipX: true, flipY: false, opacity: 1, grayscale: false, zIndex: 0,
};

describe('shared render transforms', () => {
  it('uses the same world center for Canvas2D and WebGL2', () => {
    const viewport = { x: 5, y: 6, scale: 2 };
    expect(canvasImageTransform(command, viewport)).toMatchObject({ x: 125, y: 96, scaleX: -2, scaleY: 2 });
    const matrix = webglTransform(command, viewport, 2);
    expect(matrix[6]).toBe(250);
    expect(matrix[7]).toBe(192);
  });
});
