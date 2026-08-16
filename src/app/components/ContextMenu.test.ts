import { describe, expect, it } from 'vitest';
import { clampMenuPosition } from './ContextMenu';

describe('context menu positioning', () => {
  const menu = { width: 240, height: 320 };
  const viewport = { width: 1000, height: 700 };

  it('keeps a menu at the requested position when it fits', () => {
    expect(clampMenuPosition({ x: 100, y: 80 }, menu, viewport)).toEqual({ x: 100, y: 80 });
  });

  it('clamps the menu at the bottom-right corner', () => {
    expect(clampMenuPosition({ x: 990, y: 690 }, menu, viewport)).toEqual({ x: 752, y: 372 });
  });

  it('keeps the menu inside the top-left margin', () => {
    expect(clampMenuPosition({ x: -40, y: -20 }, menu, viewport)).toEqual({ x: 8, y: 8 });
  });
});
