import type { Viewport } from '../types';

export function sameViewport(left: Viewport, right: Viewport, epsilon = 0.0001) {
  return Math.abs(left.x - right.x) <= epsilon
    && Math.abs(left.y - right.y) <= epsilon
    && Math.abs(left.scale - right.scale) <= epsilon;
}

/**
 * A gesture renders its viewport directly before React commits Scene state.
 * Keep that live frame when interaction ends until the parent viewport catches
 * up, otherwise the old Scene viewport is rendered for one rollback frame.
 */
export function nextViewportCommitPending(
  pending: boolean,
  wasInteractionActive: boolean,
  interactionActive: boolean,
  sceneViewport: Viewport,
  liveViewport: Viewport,
) {
  if (interactionActive) return false;
  if (wasInteractionActive && !sameViewport(sceneViewport, liveViewport)) return true;
  if (pending && sameViewport(sceneViewport, liveViewport)) return false;
  return pending;
}
