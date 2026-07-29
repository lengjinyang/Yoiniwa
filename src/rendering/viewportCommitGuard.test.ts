import { describe, expect, it } from 'vitest';
import { nextViewportCommitPending, sameViewport } from './viewportCommitGuard';

describe('viewport commit guard', () => {
  const before = { x: 0, y: 0, scale: 1 };
  const dragged = { x: 180, y: -75, scale: 1 };

  it('holds the live pan frame when pointerup precedes the Scene commit', () => {
    expect(nextViewportCommitPending(false, true, false, before, dragged)).toBe(true);
  });

  it('releases the guard when the Scene viewport catches up', () => {
    expect(nextViewportCommitPending(true, false, false, dragged, dragged)).toBe(false);
  });

  it('does not defer an image gesture that did not move the viewport', () => {
    expect(nextViewportCommitPending(false, true, false, before, before)).toBe(false);
    expect(sameViewport(before, { x: 0.00001, y: 0, scale: 1 })).toBe(true);
  });
});
