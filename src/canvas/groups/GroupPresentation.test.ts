import { describe, expect, it } from 'vitest';
import {
  GROUP_HEADER_MIN_SCREEN_HEIGHT,
  GROUP_HEADER_SCREEN_HEIGHT,
  groupHeaderScreenHeight,
  groupHeaderWorldBounds,
} from './GroupPresentation';

describe('group header screen sizing', () => {
  it('stays coupled to title metrics at every zoom-out level', () => {
    [0.01, 0.1, 0.5, 0.75, 1].forEach((scale) => {
      expect(groupHeaderScreenHeight(scale)).toBe(GROUP_HEADER_MIN_SCREEN_HEIGHT);
    });
  });

  it('only gains vertical padding while zooming in and keeps a hard ceiling', () => {
    expect(groupHeaderScreenHeight(1.25)).toBeGreaterThan(GROUP_HEADER_MIN_SCREEN_HEIGHT);
    expect(groupHeaderScreenHeight(1.25)).toBeLessThan(GROUP_HEADER_SCREEN_HEIGHT);
    expect(groupHeaderScreenHeight(1.5)).toBe(GROUP_HEADER_SCREEN_HEIGHT);
    expect(groupHeaderScreenHeight(8)).toBe(GROUP_HEADER_SCREEN_HEIGHT);
  });

  it('produces the same screen height after world scaling', () => {
    const group = { name: '组', x: 10, y: 20, width: 200, collapsed: false };
    [0.05, 0.5, 1, 1.25, 2].forEach((scale) => {
      const bounds = groupHeaderWorldBounds(group, scale);
      expect(bounds.height * scale).toBeCloseTo(groupHeaderScreenHeight(scale), 6);
    });
  });
});
