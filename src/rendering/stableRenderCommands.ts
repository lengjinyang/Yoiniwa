import type { ImageRenderCommand } from './renderPlan';
function logicalImageId(command: ImageRenderCommand) {
  return command.imageId ?? command.id;
}

function isPreview(command: ImageRenderCommand) {
  return command.id.endsWith(':preview');
}

function isFinalDetail(command: ImageRenderCommand) {
  return command.id.endsWith(':detail') || command.id.includes(':tile:');
}

function completeResident(commands: readonly ImageRenderCommand[], residentIds: ReadonlySet<string>) {
  return commands.length > 0 && commands.every((command) => residentIds.has(command.id));
}

function groupByImage(commands: readonly ImageRenderCommand[]) {
  const groups = new Map<string, ImageRenderCommand[]>();
  for (const command of commands) {
    const id = logicalImageId(command);
    const group = groups.get(id);
    if (group) group.push(command);
    else groups.set(id, [command]);
  }
  return groups;
}

/**
 * Selects an atomic, resident command group for every logical image.
 *
 * A loading thumbnail is never emitted when the current plan asks for detail
 * or tiles. The previous final LOD remains visible during a transition; on a
 * cold load the image appears atomically only after its complete final LOD is
 * resident. A preview-only plan is already the screen-resolution final LOD.
 */
export function commandsWithResidentFallback(
  commands: readonly ImageRenderCommand[],
  residentIds: ReadonlySet<string>,
  previousCommands: readonly ImageRenderCommand[],
) {
  const currentGroups = groupByImage(commands);
  const previousGroups = groupByImage(previousCommands);
  const result: ImageRenderCommand[] = [];
  const emitted = new Set<string>();

  for (const command of commands) {
    const id = logicalImageId(command);
    if (emitted.has(id)) continue;
    emitted.add(id);
    const current = currentGroups.get(id) ?? [];
    const desiredFinal = current.filter(isFinalDetail);
    if (desiredFinal.length) {
      if (completeResident(desiredFinal, residentIds)) {
        result.push(...desiredFinal);
        continue;
      }
      const previous = previousGroups.get(id) ?? [];
      // A preview-only previous group was not a loading placeholder: it was the
      // complete, screen-resolution LOD at the preceding zoom. Keep it across
      // the boundary until the sharper target is complete to avoid flashing.
      const previousHasDetail = previous.some(isFinalDetail);
      const previousFinal = previousHasDetail ? previous.filter(isFinalDetail) : previous;
      if (completeResident(previousFinal, residentIds)) {
        result.push(...previousFinal);
        continue;
      }
      // A preview is a cold-start safety plane only. It must never replace a
      // complete LOD that was already being displayed while sharper tiles load.
      const preview = current.filter(isPreview);
      if (completeResident(preview, residentIds)) result.push(...preview);
      continue;
    }
    const finalAtCurrentScale = current.filter((value) => !isPreview(value) || current.length === 1);
    if (completeResident(finalAtCurrentScale, residentIds)) result.push(...finalAtCurrentScale);
  }
  return result;
}

export function areFinalRenderCommandsResident(
  commands: readonly ImageRenderCommand[],
  residentIds: ReadonlySet<string>,
) {
  const groups = groupByImage(commands);
  for (const group of groups.values()) {
    const final = group.filter(isFinalDetail);
    const required = final.length ? final : group;
    if (!completeResident(required, residentIds)) return false;
  }
  return groups.size > 0;
}
