import type { ImageGroup } from '../../types';

// The header has a strict screen-space ceiling, but contracts slightly while
// zoomed out so a readable label never turns into a visually heavy strip.
export const GROUP_HEADER_SCREEN_HEIGHT = 30;
export const GROUP_TITLE_SCREEN_FONT_SIZE = 12;
export const GROUP_TITLE_SCREEN_LINE_HEIGHT = 14;
export const GROUP_HEADER_VERTICAL_PADDING = 2;
// Keep the zoomed-out bar coupled to the title metrics. Changing the large
// zoom ceiling must never make the compact state thick again.
export const GROUP_HEADER_MIN_SCREEN_HEIGHT = GROUP_TITLE_SCREEN_LINE_HEIGHT
  + GROUP_HEADER_VERTICAL_PADDING * 2;
export const GROUP_HEADER_GROWTH_START_SCALE = 1;
export const GROUP_HEADER_FULL_HEIGHT_SCALE = 1.5;
export const GROUP_RESIZE_HANDLE_SCREEN_SIZE = 6;
export const GROUP_HEADER_ACTION_SCREEN_WIDTH = 20;
export const GROUP_MORE_ICON_RIGHT_INSET = 14;

export function groupTitleScreenWidth(name: string) {
  return Array.from(name).reduce((width, character) => width + (/^[\x00-\xff]$/.test(character) ? 6.5 : 11), 0);
}

export function fitGroupTitle(name: string, availableWidth: number) {
  if (groupTitleScreenWidth(name) <= availableWidth) return name;
  const characters = Array.from(name);
  while (characters.length && groupTitleScreenWidth(`${characters.join('')}…`) > availableWidth) characters.pop();
  return characters.length ? `${characters.join('')}…` : '…';
}

/** Group titles remain readable while the world layer is zoomed out. */
type GroupHeaderShape = Pick<ImageGroup, 'name' | 'width' | 'collapsed'>
  & Partial<Pick<ImageGroup, 'contentsHidden' | 'sizeLocked'>>;

export function groupHeaderScreenWidth(group: GroupHeaderShape, scale: number) {
  const safeScale = Math.max(scale, 0.0001);
  return Math.max(1, group.width * safeScale);
}

export function groupHeaderScreenHeight(scale: number) {
  const safeScale = Math.max(scale, 0.0001);
  if (safeScale <= GROUP_HEADER_GROWTH_START_SCALE) return GROUP_HEADER_MIN_SCREEN_HEIGHT;
  if (safeScale >= GROUP_HEADER_FULL_HEIGHT_SCALE) return GROUP_HEADER_SCREEN_HEIGHT;
  const progress = (safeScale - GROUP_HEADER_GROWTH_START_SCALE)
    / (GROUP_HEADER_FULL_HEIGHT_SCALE - GROUP_HEADER_GROWTH_START_SCALE);
  // Smoothstep avoids a visible size kink when crossing 100% zoom.
  const eased = progress * progress * (3 - 2 * progress);
  return GROUP_HEADER_MIN_SCREEN_HEIGHT
    + (GROUP_HEADER_SCREEN_HEIGHT - GROUP_HEADER_MIN_SCREEN_HEIGHT) * eased;
}

export function groupHeaderWorldY(
  group: Pick<ImageGroup, 'y'>,
  scale: number,
) {
  return group.y - groupHeaderScreenHeight(scale) / Math.max(scale, 0.0001);
}

export function groupHeaderWorldBounds(
  group: GroupHeaderShape & Pick<ImageGroup, 'x' | 'y'>,
  scale: number,
) {
  const safeScale = Math.max(scale, 0.0001);
  return {
    x: group.x,
    y: groupHeaderWorldY(group, safeScale),
    width: groupHeaderScreenWidth(group, safeScale) / safeScale,
    height: groupHeaderScreenHeight(safeScale) / safeScale,
  };
}
