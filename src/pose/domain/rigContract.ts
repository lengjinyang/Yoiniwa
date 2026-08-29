import type { BjdIkChainId, BjdJointId, Quaternion, Vec3 } from '../../domain/sceneTypes';

export interface BjdRigV1 {
  schemaVersion: 1;
  modelId: 'chambersu-bjd-female-v1';
  rigVersion: 1;
  rootNode: string;
  restPose: Partial<Record<BjdJointId, Quaternion>>;
  segmentBindings: Record<string, { node: string; joint: BjdJointId; materialRole: 'body' | 'joint' | 'joint-slot' }>;
  jointNodes: Record<BjdJointId, string>;
  jointPivots: Record<BjdJointId, Vec3>;
  axisBasis: Record<BjdJointId, Quaternion>;
  jointLimits: Partial<Record<BjdJointId, { min: Vec3; max: Vec3 }>>;
  compoundJoints: Array<{
    id: string;
    primary: BjdJointId;
    secondary: BjdJointId;
    distribution: Array<{ angle: number; primaryRatio: number }>;
  }>;
  ikChains: Record<BjdIkChainId, {
    root: BjdJointId;
    middle: [BjdJointId, BjdJointId];
    end: BjdJointId;
    upperLength: number;
    lowerLength: number;
    /** Signed authored bend around flexionAxis at rotationDelta identity. */
    restBend: number;
    compoundJointId: string;
    minBend?: number;
    maxBend?: number;
    flexionAxis: Vec3;
    defaultPoleDirection: Vec3;
  }>;
  thumbPoseCurve: Array<{
    id: string;
    left: Partial<Record<BjdJointId, Quaternion>>;
    right: Partial<Record<BjdJointId, Quaternion>>;
  }>;
  pickTargets: Record<string, BjdJointId>;
}

const REQUIRED_JOINTS: BjdJointId[] = [
  'pelvis', 'spineLower', 'spineUpper', 'neck', 'head',
  'shoulderL', 'shoulderR', 'elbowUpperL', 'elbowUpperR', 'elbowLowerL', 'elbowLowerR', 'wristL', 'wristR',
  'hipL', 'hipR', 'kneeUpperL', 'kneeUpperR', 'kneeLowerL', 'kneeLowerR', 'ankleL', 'ankleR',
  'toeBaseL', 'toeBaseR', 'bigToeL', 'bigToeR',
  'thumbMetacarpalL', 'thumbProximalL', 'thumbDistalL',
  'indexProximalL', 'indexMiddleL', 'indexDistalL', 'middleProximalL', 'middleMiddleL', 'middleDistalL',
  'ringProximalL', 'ringMiddleL', 'ringDistalL', 'littleProximalL', 'littleMiddleL', 'littleDistalL',
  'thumbMetacarpalR', 'thumbProximalR', 'thumbDistalR',
  'indexProximalR', 'indexMiddleR', 'indexDistalR', 'middleProximalR', 'middleMiddleR', 'middleDistalR',
  'ringProximalR', 'ringMiddleR', 'ringDistalR', 'littleProximalR', 'littleMiddleR', 'littleDistalR',
];
const IK_CHAINS: BjdIkChainId[] = ['armL', 'armR', 'legL', 'legR'];

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function isVec3(value: unknown): value is Vec3 {
  const item = record(value);
  return Boolean(item && [item.x, item.y, item.z].every((part) => typeof part === 'number' && Number.isFinite(part)));
}

function isQuaternion(value: unknown): value is Quaternion {
  const item = record(value);
  return Boolean(item && [item.x, item.y, item.z, item.w].every((part) => typeof part === 'number' && Number.isFinite(part)));
}

/** Validates the versioned offline asset contract before any values reach Three.js. */
export function parseBjdRigV1(value: unknown): BjdRigV1 {
  const source = record(value);
  const jointNodes = record(source?.jointNodes);
  const restPose = record(source?.restPose);
  const jointPivots = record(source?.jointPivots);
  const axisBasis = record(source?.axisBasis);
  const jointLimits = source?.jointLimits === undefined ? {} : record(source.jointLimits);
  const segmentBindings = record(source?.segmentBindings);
  const ikChains = record(source?.ikChains);
  const thumbPoseCurve = source?.thumbPoseCurve;
  const pickTargets = record(source?.pickTargets);
  if (!source || source.schemaVersion !== 1 || source.modelId !== 'chambersu-bjd-female-v1'
    || source.rigVersion !== 1 || typeof source.rootNode !== 'string' || !jointNodes || !restPose || !jointPivots
    || !axisBasis || !jointLimits || !segmentBindings || !ikChains || !Array.isArray(thumbPoseCurve) || !pickTargets) {
    throw new Error('rig JSON 版本或必需字段无效');
  }
  for (const id of REQUIRED_JOINTS) {
    if (typeof jointNodes[id] !== 'string' || !isVec3(jointPivots[id]) || !isQuaternion(restPose[id])
      || !isQuaternion(axisBasis[id])) {
      throw new Error(`rig JSON 缺少必需关节契约：${id}`);
    }
  }
  for (const id of IK_CHAINS) if (!record(ikChains[id])) throw new Error(`rig JSON 缺少 IK 链：${id}`);
  if (thumbPoseCurve.length < 2) throw new Error('rig JSON 缺少 Thumb Pose Curve');
  const thumbPoseIds = new Set<string>();
  thumbPoseCurve.forEach((raw) => {
    const key = record(raw); const left = record(key?.left); const right = record(key?.right);
    if (!key || typeof key.id !== 'string' || !key.id || thumbPoseIds.has(key.id) || !left || !right
      || !(['thumbMetacarpalL', 'thumbProximalL', 'thumbDistalL'] as const).every((joint) => isQuaternion(left[joint]))
      || !(['thumbMetacarpalR', 'thumbProximalR', 'thumbDistalR'] as const).every((joint) => isQuaternion(right[joint]))) {
      throw new Error('rig JSON Thumb Pose Curve 无效');
    }
    thumbPoseIds.add(key.id);
  });
  if (!Array.isArray(source.compoundJoints)) throw new Error('rig JSON 缺少复合关节定义');
  for (const id of IK_CHAINS) {
    const chain = record(ikChains[id])!;
    if (typeof chain.root !== 'string' || !Array.isArray(chain.middle) || chain.middle.length !== 2
      || typeof chain.end !== 'string' || !(Number(chain.upperLength) > 0) || !(Number(chain.lowerLength) > 0)
      || !Number.isFinite(Number(chain.restBend)) || Number(chain.restBend) < -Math.PI || Number(chain.restBend) > Math.PI
      || typeof chain.compoundJointId !== 'string' || !isVec3(chain.flexionAxis) || !isVec3(chain.defaultPoleDirection)
      || (chain.minBend !== undefined && (!(Number(chain.minBend) >= 0) || !(Number(chain.minBend) <= Math.PI)))
      || (chain.maxBend !== undefined && (!(Number(chain.maxBend) >= 0) || !(Number(chain.maxBend) <= Math.PI)))
      || (chain.minBend !== undefined && chain.maxBend !== undefined && Number(chain.minBend) > Number(chain.maxBend))) {
      throw new Error(`rig JSON IK 链字段无效：${id}`);
    }
  }
  Object.entries(jointLimits).forEach(([jointId, raw]) => {
    const limit = record(raw);
    const min = limit?.min;
    const max = limit?.max;
    if (!REQUIRED_JOINTS.includes(jointId as BjdJointId) || !isVec3(min) || !isVec3(max)
      || min.x > max.x || min.y > max.y || min.z > max.z) {
      throw new Error(`rig JSON 关节限位无效：${jointId}`);
    }
  });
  if (!Object.keys(segmentBindings).length) throw new Error('rig JSON 缺少刚性分件绑定');
  Object.entries(segmentBindings).forEach(([segmentId, raw]) => {
    const binding = record(raw);
    if (!binding || typeof binding.node !== 'string' || !REQUIRED_JOINTS.includes(binding.joint as BjdJointId)
      || !['body', 'joint', 'joint-slot'].includes(String(binding.materialRole))) {
      throw new Error(`rig JSON 分件绑定无效：${segmentId}`);
    }
  });
  return {
    schemaVersion: 1, modelId: 'chambersu-bjd-female-v1', rigVersion: 1, rootNode: source.rootNode,
    restPose, segmentBindings, jointNodes, jointPivots, axisBasis, jointLimits,
    compoundJoints: source.compoundJoints, ikChains, thumbPoseCurve, pickTargets,
  } as unknown as BjdRigV1;
}
