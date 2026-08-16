import type { ImageGroup } from '../../types';
import type { GroupFrameBounds, GroupResizeHandle } from '../publicTypes';

const MIN_GROUP_WIDTH = 64;
const MIN_GROUP_HEIGHT = 48;

/** Resize changes the group range only; member transforms remain untouched. */
function resizeGroupFrame(
  original: Pick<ImageGroup, 'x' | 'y' | 'width' | 'height'>,
  handle: GroupResizeHandle,
  point: { x: number; y: number },
): GroupFrameBounds {
  if (handle === 'rotate') return { x: original.x, y: original.y, width: original.width, height: original.height };
  const right = original.x + original.width;
  const bottom = original.y + original.height;
  const west = handle === 'north-west' || handle === 'south-west';
  const north = handle === 'north-west' || handle === 'north-east';
  const east = handle === 'north-east' || handle === 'south-east' || handle === 'east';
  const south = handle === 'south-west' || handle === 'south-east' || handle === 'south';
  const movesWest = west || handle === 'west';
  const movesNorth = north || handle === 'north';
  const x = movesWest ? Math.min(point.x, right - MIN_GROUP_WIDTH) : original.x;
  const y = movesNorth ? Math.min(point.y, bottom - MIN_GROUP_HEIGHT) : original.y;
  const width = movesWest ? right - x
    : east ? Math.max(MIN_GROUP_WIDTH, point.x - original.x) : original.width;
  const height = movesNorth ? bottom - y
    : south ? Math.max(MIN_GROUP_HEIGHT, point.y - original.y) : original.height;
  return { x, y, width, height };
}

/** Pointer deltas keep visual handles stable even when the title is wider than the body. */
export function resizeGroupFrameByDelta(
  original: Pick<ImageGroup, 'x' | 'y' | 'width' | 'height'>,
  handle: GroupResizeHandle,
  delta: { x: number; y: number },
): GroupFrameBounds {
  if (handle === 'rotate') return { x: original.x, y: original.y, width: original.width, height: original.height };
  const west = handle === 'north-west' || handle === 'west' || handle === 'south-west';
  const north = handle === 'north-west' || handle === 'north' || handle === 'north-east';
  return resizeGroupFrame(original, handle, {
    x: (west ? original.x : original.x + original.width) + delta.x,
    y: (north ? original.y : original.y + original.height) + delta.y,
  });
}
