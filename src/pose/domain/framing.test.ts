import { describe, expect, it } from 'vitest';
import { fitBounds, outputFrameRect } from './framing';

describe('pose framing', () => {
  it('uses the limiting axis for narrow and wide frames', () => {
    const bounds = { min: { x: -1, y: -1, z: -.2 }, max: { x: 1, y: 1, z: .2 } };
    expect(fitBounds(bounds, .75, Math.PI / 4).orthographicHeight).toBeGreaterThan(3);
    expect(fitBounds(bounds, 16 / 9, Math.PI / 4).orthographicHeight).toBeLessThan(3);
  });
  it('shares a centered 86% output rectangle', () => {
    expect(outputFrameRect(1000, 800, 1)).toEqual({ x: 156, y: 56, width: 688, height: 688 });
  });
});
