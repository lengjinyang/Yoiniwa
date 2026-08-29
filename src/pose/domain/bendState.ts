import type { Vec3 } from '../../domain/sceneTypes';

export interface BendPlaneFrame {
  axis: Vec3;
  reference: Vec3;
  tangent: Vec3;
}

const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const length = (value: Vec3) => Math.hypot(value.x, value.y, value.z);
const normalize = (value: Vec3, fallback: Vec3): Vec3 => {
  const magnitude = length(value);
  return magnitude > 1e-8 ? { x: value.x / magnitude, y: value.y / magnitude, z: value.z / magnitude } : fallback;
};
const subtractProjection = (value: Vec3, axis: Vec3): Vec3 => {
  const amount = dot(value, axis);
  return { x: value.x - axis.x * amount, y: value.y - axis.y * amount, z: value.z - axis.z * amount };
};

export function createBendPlaneFrame(axis: Vec3, reference: Vec3): BendPlaneFrame {
  const normalizedAxis = normalize(axis, { x: 0, y: 1, z: 0 });
  const fallback = Math.abs(normalizedAxis.y) < .9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  const projectedReference = normalize(subtractProjection(reference, normalizedAxis), fallback);
  const tangent = normalize(cross(normalizedAxis, projectedReference), { x: 0, y: 0, z: 1 });
  return { axis: normalizedAxis, reference: projectedReference, tangent };
}

export function bendPlaneAngle(frame: BendPlaneFrame, direction: Vec3): number {
  const projected = normalize(subtractProjection(direction, frame.axis), frame.reference);
  return Math.atan2(dot(projected, frame.tangent), dot(projected, frame.reference));
}

/** Keeps the bend-plane angle unwrapped across ±PI. */
export function unwrapBendPlaneAngle(previous: number, next: number): number {
  let value = next;
  while (value - previous > Math.PI) value -= Math.PI * 2;
  while (value - previous < -Math.PI) value += Math.PI * 2;
  return value;
}

export function bendDirectionAtAngle(frame: BendPlaneFrame, angle: number): Vec3 {
  return normalize({
    x: frame.reference.x * Math.cos(angle) + frame.tangent.x * Math.sin(angle),
    y: frame.reference.y * Math.cos(angle) + frame.tangent.y * Math.sin(angle),
    z: frame.reference.z * Math.cos(angle) + frame.tangent.z * Math.sin(angle),
  }, frame.reference);
}

export function bendNormal(axis: Vec3, direction: Vec3): Vec3 {
  return normalize(cross(normalize(axis, { x: 0, y: 1, z: 0 }), normalize(direction, { x: 1, y: 0, z: 0 })), { x: 0, y: 0, z: 1 });
}
