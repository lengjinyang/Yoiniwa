import { describe, expect, it } from 'vitest';
import type { ImageRenderCommand } from './renderPlan';
import { resourcePriorityIds, resourceSyncIds } from './usePixelRenderer';

const command = (id: string, imageId: string): ImageRenderCommand => ({
  id,
  imageId,
  source: {},
  sourceRect: { x: 0, y: 0, width: 1, height: 1 },
  naturalWidth: 1,
  naturalHeight: 1,
  x: 0,
  y: 0,
  width: 1,
  height: 1,
  rotation: 0,
  flipX: false,
  flipY: false,
  opacity: 1,
  grayscale: false,
  zIndex: 0,
});

describe('pixel renderer resource priorities', () => {
  it('keeps a preview fallback for every image that requests optional detail', () => {
    const priorities = resourcePriorityIds([
      command('first:preview', 'first'),
      command('first:detail', 'first'),
      command('second:preview', 'second'),
      command('second:tile:0:0:0', 'second'),
    ]);

    expect(priorities.fallback).toEqual(['first:preview', 'second:preview']);
    expect(priorities.preferred).toEqual(['first:detail', 'second:tile:0:0:0']);
  });

  it('treats a preview-only plan as the final resource', () => {
    expect(resourcePriorityIds([command('image:preview', 'image')])).toEqual({
      preferred: ['image:preview'],
      fallback: [],
    });
  });

  it('uploads and protects bounded previews before optional detail', () => {
    const resources = resourceSyncIds([
      command('image:preview', 'image'),
      command('image:detail', 'image'),
    ], [], ['neighbor:detail']);

    expect([...resources.activeIds]).toEqual(['image:preview', 'image:detail', 'neighbor:detail']);
    expect([...resources.protectedIds]).toEqual(['image:preview', 'image:detail']);
  });
});
