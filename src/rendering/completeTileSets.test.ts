import { describe, expect, it } from 'vitest';
import { commandsWithCompleteTileSets } from './completeTileSets';
import type { ImageRenderCommand } from './renderPlan';

const command = (id: string, imageId = 'image'): ImageRenderCommand => ({
  id, imageId, source: {}, sourceRect: { x: 0, y: 0, width: 1, height: 1 }, naturalWidth: 1, naturalHeight: 1,
  x: 0, y: 0, width: 1, height: 1, rotation: 0, flipX: false, flipY: false, opacity: 1, grayscale: false, zIndex: 0,
});

describe('complete tile set rendering', () => {
  it('keeps the preview and hides a partially loaded tile level', () => {
    const commands = [command('image:preview'), command('image:tile:0:0:0'), command('image:tile:0:1:0')];
    expect(commandsWithCompleteTileSets(commands, new Set(['image:preview', 'image:tile:0:0:0'])).map((value) => value.id))
      .toEqual(['image:preview']);
  });

  it('reveals the whole level together when every visible tile is loaded', () => {
    const commands = [command('image:preview'), command('image:tile:0:0:0'), command('image:tile:0:1:0')];
    expect(commandsWithCompleteTileSets(commands, new Set(commands.map((value) => value.id)))).toBe(commands);
  });

  it('does not hide an unrelated complete image level', () => {
    const commands = [command('a:tile:0:0:0', 'a'), command('b:tile:1:0:0', 'b')];
    expect(commandsWithCompleteTileSets(commands, new Set(['b:tile:1:0:0'])).map((value) => value.id))
      .toEqual(['b:tile:1:0:0']);
  });
});
