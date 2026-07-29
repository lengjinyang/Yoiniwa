import { describe, expect, it } from 'vitest';
import { clampGroupToolbarX } from './uiGeometry';

describe('app ui geometry', () => {
  it('keeps the group toolbar within the visible width', () => {
    expect(clampGroupToolbarX(-20, 1000)).toBe(150);
    expect(clampGroupToolbarX(600, 1000)).toBe(600);
    expect(clampGroupToolbarX(1200, 1000)).toBe(850);
  });
});
