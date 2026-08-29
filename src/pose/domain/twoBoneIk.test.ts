import { describe, expect, it } from 'vitest';
import { solveTwoBoneIk } from './twoBoneIk';

describe('two-bone IK reach limits', () => {
  const base = { root: { x: 0, y: 0, z: 0 }, poleDirection: { x: 0, y: 0, z: 1 }, upperLength: 2, lowerLength: 1 };

  it('clamps targets beyond maximum reach without stretching', () => {
    const result = solveTwoBoneIk({ ...base, target: { x: 10, y: 0, z: 0 } });
    expect(result.clamped).toBe(true);
    expect(result.reach).toBeLessThan(3);
    expect(result.clampedTarget.x).toBeCloseTo(3, 4);
  });

  it('clamps targets inside the minimum reach', () => {
    const result = solveTwoBoneIk({ ...base, target: { x: .01, y: 0, z: 0 } });
    expect(result.clamped).toBe(true);
    expect(result.reach).toBeGreaterThan(1);
  });

  it('respects a compound joint bend limit', () => {
    const result = solveTwoBoneIk({ ...base, target: { x: 1.01, y: 0, z: 0 }, maxBend: Math.PI * 5 / 6 });
    expect(result.clamped).toBe(true);
    expect(result.middleBend).toBeLessThanOrEqual(Math.PI * 5 / 6 + 1e-6);
  });
});
