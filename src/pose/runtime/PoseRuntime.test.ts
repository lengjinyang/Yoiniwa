import { describe, expect, it } from 'vitest';
import { fingerCurlFromReach, projectThumbPoseCurve } from './PoseRuntime';

describe('fingertip curl intent', () => {
  it('uses distance to the palm instead of screen-depth error', () => {
    expect(fingerCurlFromReach(1, 1)).toBe(0);
    expect(fingerCurlFromReach(.75, 1)).toBe(.5);
    expect(fingerCurlFromReach(.5, 1)).toBe(1);
  });
});

describe('thumb pose curve', () => {
  it('projects fingertip drags continuously onto adjacent calibrated poses', () => {
    const points = [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }];
    expect(projectThumbPoseCurve({ x: .4, y: .2, z: 0 }, points)).toMatchObject({ segment: 0, amount: .4 });
    expect(projectThumbPoseCurve({ x: 1.1, y: .6, z: 0 }, points)).toMatchObject({ segment: 1, amount: .6 });
  });
});
