import type { ImageRenderCommand } from './renderPlan';

function tileSetKey(command: Pick<ImageRenderCommand, 'id' | 'imageId'>) {
  const marker = command.id.indexOf(':tile:');
  if (marker < 0) return undefined;
  const level = command.id.slice(marker + ':tile:'.length).split(':', 1)[0];
  return `${command.imageId ?? command.id.slice(0, marker)}:${level}`;
}

/**
 * A high-resolution tile set replaces a complete low-resolution preview.
 * Drawing tiles as they arrive produces visible checkerboard flashes, so keep
 * the preview until every visible tile for that image/level is resident.
 */
export function commandsWithCompleteTileSets(
  commands: readonly ImageRenderCommand[],
  loadedIds: ReadonlySet<string>,
) {
  const incomplete = new Set<string>();
  for (const command of commands) {
    const key = tileSetKey(command);
    if (key && !loadedIds.has(command.id)) incomplete.add(key);
  }
  if (!incomplete.size) return commands;
  return commands.filter((command) => {
    const key = tileSetKey(command);
    return !key || !incomplete.has(key);
  });
}
