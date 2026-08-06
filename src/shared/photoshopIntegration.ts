import type { WindowState } from '../types.js';

export function shouldAutoPhotoshopRoundTrip(
  state: Pick<WindowState, 'locked' | 'alwaysOnTop'>,
  requested = true,
) {
  return requested && state.locked && state.alwaysOnTop;
}

/** Windows can deliver pointer input to a non-activating topmost window. In
 * reference mode this keeps Photoshop foreground for the complete gesture. */
export function shouldUseFocuslessPhotoshopPicker(
  state: Pick<WindowState, 'locked' | 'alwaysOnTop'>,
) {
  return state.locked && state.alwaysOnTop;
}
