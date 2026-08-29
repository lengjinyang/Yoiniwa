import type { BjdJointId, Vec3 } from '../../domain/sceneTypes';

type Side = 'L' | 'R';
export interface ThumbBendBasis {
  joint: BjdJointId;
  childDirection: Vec3;
  palmTargetDirection: Vec3;
  palmNormal: Vec3;
  oppositionAxis: Vec3;
  adductionAxis: Vec3;
  flexAxis: Vec3;
}

const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const scale = (a: Vec3, value: number): Vec3 => ({ x: a.x * value, y: a.y * value, z: a.z * value });
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const normalized = (value: Vec3, fallback?: Vec3): Vec3 => {
  const length = Math.hypot(value.x, value.y, value.z);
  if (length > 1e-8) return scale(value, 1 / length);
  if (fallback) return normalized(fallback);
  throw new Error('Thumb authored basis contains a zero-length direction');
};

/** Builds anatomical thumb axes in authored joint-local rest coordinates. */
export function createThumbBendBases(pivots: Partial<Record<BjdJointId, Vec3>>, side: Side, distalChildDirection?: Vec3): [ThumbBendBasis, ThumbBendBasis, ThumbBendBasis] {
  const point = (stem: string) => {
    const value = pivots[`${stem}${side}` as BjdJointId];
    if (!value) throw new Error(`Thumb authored basis is missing ${stem}${side}`);
    return value;
  };
  const wrist = point('wrist'); const index = point('indexProximal'); const middle = point('middleProximal'); const little = point('littleProximal');
  const joints = [point('thumbMetacarpal'), point('thumbProximal'), point('thumbDistal')];
  const palmTarget = scale(add(index, middle), .5); const palmLong = normalized(sub(palmTarget, wrist));
  const palmAcross = normalized(side === 'L' ? sub(little, index) : sub(index, little));
  let palmNormal = normalized(cross(palmLong, palmAcross));
  if (dot(palmNormal, sub(palmTarget, joints[0])) < 0) palmNormal = scale(palmNormal, -1);
  const childDirections = [normalized(sub(joints[1], joints[0])), normalized(sub(joints[2], joints[1]))];
  childDirections.push(normalized(distalChildDirection ?? childDirections[1]));

  return joints.map((joint, index) => {
    const childDirection = childDirections[index]; const palmTargetDirection = normalized(sub(palmTarget, joint));
    const flexAxis = normalized(cross(childDirection, palmTargetDirection), cross(childDirection, palmNormal));
    let adductionAxis = palmNormal;
    if (dot(cross(adductionAxis, childDirection), palmTargetDirection) < 0) adductionAxis = scale(adductionAxis, -1);
    const oppositionAxis = scale(childDirection, side === 'L' ? 1 : -1);
    return {
      joint: `${['thumbMetacarpal', 'thumbProximal', 'thumbDistal'][index]}${side}` as BjdJointId,
      childDirection, palmTargetDirection, palmNormal, oppositionAxis, adductionAxis, flexAxis,
    };
  }) as [ThumbBendBasis, ThumbBendBasis, ThumbBendBasis];
}
