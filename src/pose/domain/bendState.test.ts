import { describe, expect, it } from 'vitest';
import { bendDirectionAtAngle, bendPlaneAngle, createBendPlaneFrame, unwrapBendPlaneAngle } from './bendState';

describe('stable bend-plane angles', () => {
  it('unwraps a bend plane through the 180 degree boundary', () => {
    const frame = createBendPlaneFrame({ x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 });
    const previous = 3.1;
    const wrapped = bendPlaneAngle(frame, bendDirectionAtAngle(frame, 3.18));
    expect(unwrapBendPlaneAngle(previous, wrapped)).toBeCloseTo(3.18, 2);
  });

  it('keeps the bend direction on the same plane frame', () => {
    const frame = createBendPlaneFrame({ x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 });
    const direction = bendDirectionAtAngle(frame, Math.PI * 1.5);
    expect(bendPlaneAngle(frame, direction)).toBeCloseTo(-Math.PI / 2, 5);
    expect(unwrapBendPlaneAngle(Math.PI, bendPlaneAngle(frame, direction))).toBeCloseTo(Math.PI * 1.5, 5);
  });
});
