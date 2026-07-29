import { describe, expect, it } from 'vitest';
import { percentile, percentileSorted } from './statistics';

describe('statistics', () => {
  it('computes stable bounded percentiles', () => {
    expect(percentile([3, 1, 2, 4], 0.5)).toBe(3);
    expect(percentileSorted([1, 2, 3], 2)).toBe(3);
    expect(percentile([], 0.95)).toBe(0);
  });

  it('can inject both helpers into an isolated renderer context', () => {
    const execute = new Function(`
      const percentileSorted = ${percentileSorted.toString()};
      const percentile = ${percentile.toString()};
      return percentile([3, 1, 2], 0.5);
    `);
    expect(execute()).toBe(2);
  });
});
