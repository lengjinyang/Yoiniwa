import { describe, expect, it } from 'vitest';
import type { ImageRenderCommand } from './renderPlan';
import { areFinalRenderCommandsResident, commandsWithResidentFallback } from './stableRenderCommands';

const command = (id: string, imageId = 'image'): ImageRenderCommand => ({
  id, imageId, source: {}, sourceRect: { x: 0, y: 0, width: 1, height: 1 }, naturalWidth: 1, naturalHeight: 1,
  x: 0, y: 0, width: 1, height: 1, rotation: 0, flipX: false, flipY: false, opacity: 1, grayscale: false, zIndex: 0,
});

describe('stable resident render commands', () => {
  it('keeps the previous LOD until the new preview is resident', () => {
    const previous = [command('image:tile:1:0:0')];
    const next = [command('image:preview'), command('image:tile:0:0:0')];
    expect(commandsWithResidentFallback(next, new Set(['image:tile:1:0:0']), previous).map((value) => value.id))
      .toEqual(['image:tile:1:0:0']);
  });

  it('keeps a previously-final preview across an LOD boundary', () => {
    const previous = [command('image:preview')];
    const next = [command('image:preview'), command('image:tile:0:0:0')];
    expect(commandsWithResidentFallback(next, new Set(['image:preview']), previous).map((value) => value.id))
      .toEqual(['image:preview']);
  });

  it('uses a resident preview while the new tile set is incomplete', () => {
    const next = [command('image:preview'), command('image:tile:0:0:0'), command('image:tile:0:1:0')];
    expect(commandsWithResidentFallback(next, new Set(['image:preview', 'image:tile:0:0:0']), []).map((value) => value.id))
      .toEqual(['image:preview']);
  });

  it('atomically displays only the final tile set when it is complete', () => {
    const next = [command('image:preview'), command('image:tile:0:0:0'), command('image:tile:0:1:0')];
    expect(commandsWithResidentFallback(next, new Set(next.map((value) => value.id)), []).map((value) => value.id))
      .toEqual(['image:tile:0:0:0', 'image:tile:0:1:0']);
  });

  it('treats a preview-only screen-resolution plan as final', () => {
    const next = [command('image:preview')];
    expect(commandsWithResidentFallback(next, new Set(['image:preview']), []).map((value) => value.id))
      .toEqual(['image:preview']);
  });

  it('does not resurrect an image removed from the new scene plan', () => {
    expect(commandsWithResidentFallback([], new Set(['image:preview']), [command('image:preview')])).toEqual([]);
  });

  it('does not call an incomplete tiled target ready just because its preview is resident', () => {
    const next = [command('image:preview'), command('image:tile:0:0:0'), command('image:tile:0:1:0')];
    expect(areFinalRenderCommandsResident(next, new Set(['image:preview', 'image:tile:0:0:0']))).toBe(false);
    expect(areFinalRenderCommandsResident(next, new Set(next.map((value) => value.id)))).toBe(true);
  });
});
