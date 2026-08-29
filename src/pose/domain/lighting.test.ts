import { describe, expect, it } from 'vitest';
import { lightingIntensities } from './lighting';

describe('pose lighting mapping', () => {
  it('maps contrast endpoints exactly', () => {
    expect(lightingIntensities(0)).toEqual({ ambient: 1, directional: .8 });
    expect(lightingIntensities(1).ambient).toBeCloseTo(.2);
    expect(lightingIntensities(1).directional).toBeCloseTo(3.2);
  });
});
