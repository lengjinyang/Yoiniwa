import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from './videoProbe';

describe('mapWithConcurrency', () => {
  it('keeps video probing at the requested concurrency and preserves order', async () => {
    let active = 0;
    let peak = 0;
    const values = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return value * 2;
    });
    expect(values).toEqual([2, 4, 6, 8, 10]);
    expect(peak).toBe(2);
  });
});
