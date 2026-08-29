import type { Vec3 } from '../../domain/sceneTypes';

export interface TwoBoneIkInput {
  root: Vec3;
  target: Vec3;
  /** Legacy fallback for callers that have no saved Bend State. */
  poleDirection?: Vec3;
  /** Stable bend-plane normal; preferred over a freshly guessed pole. */
  bendNormal?: Vec3;
  upperLength: number;
  lowerLength: number;
  minBend?: number;
  maxBend?: number;
}

export interface TwoBoneIkSolution {
  clampedTarget: Vec3;
  middle: Vec3;
  reach: number;
  rootBend: number;
  middleBend: number;
  bendNormal: Vec3;
  clamped: boolean;
}

const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const subtract = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const scale = (value: Vec3, factor: number): Vec3 => ({ x: value.x * factor, y: value.y * factor, z: value.z * factor });
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const length = (value: Vec3) => Math.hypot(value.x, value.y, value.z);
const normalize = (value: Vec3, fallback: Vec3): Vec3 => {
  const magnitude = length(value);
  return magnitude > 1e-8 ? scale(value, 1 / magnitude) : fallback;
};
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** Analytic, non-stretching solution used by all four arm/leg chains. */
export function solveTwoBoneIk(input: TwoBoneIkInput): TwoBoneIkSolution {
  if (!(input.upperLength > 0) || !(input.lowerLength > 0)
    || !Number.isFinite(input.upperLength) || !Number.isFinite(input.lowerLength)) {
    throw new Error('IK 肢段长度必须是有限正数');
  }
  const toTarget = subtract(input.target, input.root);
  const originalReach = length(toTarget);
  const direction = normalize(toTarget, { x: 0, y: -1, z: 0 });
  const minReach = Math.abs(input.upperLength - input.lowerLength) + 1e-6;
  const maxReach = input.upperLength + input.lowerLength - 1e-6;
  let reach = clamp(originalReach, minReach, maxReach);
  const minBend = clamp(input.minBend ?? 0, 0, Math.PI);
  const maxBend = clamp(input.maxBend ?? Math.PI, minBend, Math.PI);
  const bendForReach = (value: number) => Math.PI - Math.acos(clamp((input.upperLength * input.upperLength
    + input.lowerLength * input.lowerLength - value * value) / (2 * input.upperLength * input.lowerLength), -1, 1));
  const requestedBend = bendForReach(reach);
  if (requestedBend < minBend || requestedBend > maxBend) {
    const constrainedBend = clamp(requestedBend, minBend, maxBend);
    reach = clamp(Math.sqrt(Math.max(0, input.upperLength * input.upperLength + input.lowerLength * input.lowerLength
      + 2 * input.upperLength * input.lowerLength * Math.cos(constrainedBend))), minReach, maxReach);
  }
  const clampedTarget = add(input.root, scale(direction, reach));
  const fallbackPole = input.poleDirection ?? { x: 1, y: 0, z: 0 };
  // If a Bend State exists, reconstruct the bend direction from its plane
  // normal. This keeps the solver on the current branch instead of guessing a
  // new pole from the target on every pointer event.
  let pole = input.bendNormal
    ? cross(input.bendNormal, direction)
    : subtract(fallbackPole, scale(direction, dot(fallbackPole, direction)));
  if (length(pole) < 1e-8) {
    const fallback = Math.abs(direction.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
    pole = cross(cross(direction, fallback), direction);
  }
  const bendDirection = normalize(pole, { x: 1, y: 0, z: 0 });
  const along = (reach * reach + input.upperLength * input.upperLength
    - input.lowerLength * input.lowerLength) / (2 * reach);
  const height = Math.sqrt(Math.max(0, input.upperLength * input.upperLength - along * along));
  const middle = add(add(input.root, scale(direction, along)), scale(bendDirection, height));
  const rootBend = Math.atan2(height, along);
  const internalCos = clamp((input.upperLength * input.upperLength + input.lowerLength * input.lowerLength
    - reach * reach) / (2 * input.upperLength * input.lowerLength), -1, 1);
  return {
    clampedTarget, middle, reach, rootBend, middleBend: Math.PI - Math.acos(internalCos),
    bendNormal: normalize(cross(direction, bendDirection), { x: 0, y: 0, z: 1 }),
    clamped: Math.abs(reach - originalReach) > 1e-6,
  };
}
