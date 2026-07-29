import { describe, expect, it } from 'vitest';
import { createImagePyramid } from '../imagePyramid';
import type { ImageItem } from '../types';
import { tileRenderResource } from './tileRenderPlan';

const item: ImageItem = {
  id: 'large', name: 'large', sourceType: 'file', assetId: 'asset',
  naturalWidth: 2048, naturalHeight: 1024,
  x: 100, y: 50, width: 800, height: 400, rotation: 0,
  flipX: false, flipY: false, opacity: 0.8, grayscale: true,
  zIndex: 4, locked: false, crop: { x: 0, y: 0, width: 2048, height: 1024 },
};

describe('tile render plan', () => {
  it('maps a tile interior and excludes the generated gutter', () => {
    const pyramid = createImagePyramid(item.naturalWidth, item.naturalHeight);
    const resource = tileRenderResource(item, pyramid, { level: 0, column: 1, row: 0 });
    expect(resource?.command.sourceRect).toEqual({ x: 1, y: 0, width: 512, height: 512 });
    expect(resource?.command.naturalWidth).toBe(514);
    expect(resource?.command.x).toBe(300);
    expect(resource?.command.width).toBe(200);
    expect(resource?.command.resourceUrl).toContain('variant=tile');
  });

  it('clips edge tiles to a non-destructive crop', () => {
    const cropped = { ...item, crop: { x: 600, y: 100, width: 1000, height: 500 } };
    const pyramid = createImagePyramid(cropped.naturalWidth, cropped.naturalHeight);
    const resource = tileRenderResource(cropped, pyramid, { level: 0, column: 1, row: 0 });
    expect(resource?.command.sourceRect).toEqual({ x: 89, y: 100, width: 424, height: 412 });
    expect(resource?.command.width).toBeCloseTo(339.2);
  });

  it('positions tile pieces around the image center before rotation and flipping', () => {
    const transformed = { ...item, rotation: 90, flipX: true };
    const pyramid = createImagePyramid(transformed.naturalWidth, transformed.naturalHeight);
    const resource = tileRenderResource(transformed, pyramid, { level: 0, column: 0, row: 0 });
    expect(resource?.command.x).toBeCloseTo(500);
    expect(resource?.command.y).toBeCloseTo(450);
    expect(resource?.command.flipX).toBe(true);
    expect(resource?.command.rotation).toBe(90);
  });
});
