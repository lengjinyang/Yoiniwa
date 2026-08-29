import type { BjdRigV1 } from './rigContract';

export interface CompoundJointAngles { primary: number; secondary: number }

/** Interpolates the authored shallow-to-deep bend curve; never assumes a fixed split ratio. */
export function distributeCompoundAngle(
  totalAngle: number,
  compound: BjdRigV1['compoundJoints'][number],
): CompoundJointAngles {
  const sign = totalAngle < 0 ? -1 : 1;
  const magnitude = Math.abs(totalAngle);
  const points = [...compound.distribution]
    .filter((point) => Number.isFinite(point.angle) && Number.isFinite(point.primaryRatio))
    .sort((left, right) => left.angle - right.angle);
  if (!points.length) return { primary: totalAngle / 2, secondary: totalAngle / 2 };
  const first = points[0];
  const last = points[points.length - 1];
  let ratio = magnitude <= first.angle ? first.primaryRatio : last.primaryRatio;
  for (let index = 1; index < points.length && magnitude < last.angle; index += 1) {
    const upper = points[index];
    if (magnitude > upper.angle) continue;
    const lower = points[index - 1];
    const span = Math.max(1e-8, upper.angle - lower.angle);
    const t = Math.max(0, Math.min(1, (magnitude - lower.angle) / span));
    ratio = lower.primaryRatio + (upper.primaryRatio - lower.primaryRatio) * t;
    break;
  }
  ratio = Math.max(0, Math.min(1, ratio));
  const primary = magnitude * ratio * sign;
  return { primary, secondary: totalAngle - primary };
}
