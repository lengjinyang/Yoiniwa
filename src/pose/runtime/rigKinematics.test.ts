import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { orientationTowardDirection, rollEndOrientation } from './rigKinematics';

describe('end-effector direction control', () => {
  it('points toward the dragged direction while roll leaves that direction fixed', () => {
    const forward = new Vector3(0, 0, -1); const target = new Vector3(.4, .7, -.5).normalize();
    const pointed = orientationTowardDirection(new Quaternion(), forward, target);
    expect(forward.clone().applyQuaternion(pointed).angleTo(target)).toBeLessThan(1e-6);
    const rolled = rollEndOrientation(pointed, forward, .6);
    expect(forward.clone().applyQuaternion(rolled).angleTo(target)).toBeLessThan(1e-6);
  });
});
