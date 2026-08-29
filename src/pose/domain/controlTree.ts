import type { BjdIkChainId, BjdJointId } from '../../domain/sceneTypes';

export type PoseBranchId = 'cog' | 'head' | 'chest' | 'waist' | 'pelvis' | 'handL' | 'handR' | 'footL' | 'footR';
export type PoseFingerId = 'thumb' | 'index' | 'middle' | 'ring' | 'little';
export type PoseCompoundId = 'elbowL' | 'elbowR' | 'kneeL' | 'kneeR';

export interface PoseControlTreeState {
  branch?: PoseBranchId;
  detail?: PoseFingerId | PoseCompoundId;
}

export const ROOT_CONTROLS: ReadonlyArray<{ branch: PoseBranchId; joint: BjdJointId; ikChain?: BjdIkChainId }> = [
  { branch: 'head', joint: 'head' },
  { branch: 'chest', joint: 'spineUpper' },
  { branch: 'waist', joint: 'spineLower' },
  { branch: 'pelvis', joint: 'pelvis' },
  { branch: 'handL', joint: 'wristL', ikChain: 'armL' },
  { branch: 'handR', joint: 'wristR', ikChain: 'armR' },
  { branch: 'footL', joint: 'ankleL', ikChain: 'legL' },
  { branch: 'footR', joint: 'ankleR', ikChain: 'legR' },
];

const FINGERS: PoseFingerId[] = ['thumb', 'index', 'middle', 'ring', 'little'];

function fingerJoints(side: 'L' | 'R', finger: PoseFingerId): [BjdJointId, BjdJointId, BjdJointId] {
  const stem = finger === 'thumb' ? ['thumbMetacarpal', 'thumbProximal', 'thumbDistal']
    : [`${finger}Proximal`, `${finger}Middle`, `${finger}Distal`];
  return stem.map((value) => `${value}${side}` as BjdJointId) as [BjdJointId, BjdJointId, BjdJointId];
}

export const FINGER_JOINTS = Object.fromEntries(
  (['L', 'R'] as const).flatMap((side) => FINGERS.map((finger) => [`${finger}${side}`, fingerJoints(side, finger)])),
) as Record<`${PoseFingerId}${'L' | 'R'}`, [BjdJointId, BjdJointId, BjdJointId]>;

export function branchForJoint(joint: BjdJointId): PoseBranchId {
  if (joint === 'head') return 'head';
  if (joint === 'spineLower') return 'waist';
  if (joint === 'neck' || joint === 'spineUpper') return 'chest';
  if (joint === 'pelvis' || joint === 'hipL' || joint === 'hipR') return 'pelvis';
  if (joint.endsWith('L')) return joint.startsWith('hip') || joint.startsWith('knee') || joint.startsWith('ankle') || joint.startsWith('toe') || joint.startsWith('bigToe')
    ? 'footL' : 'handL';
  return joint.startsWith('hip') || joint.startsWith('knee') || joint.startsWith('ankle') || joint.startsWith('toe') || joint.startsWith('bigToe') ? 'footR' : 'handR';
}

export function detailForJoint(joint: BjdJointId): PoseControlTreeState['detail'] {
  const finger = FINGERS.find((value) => joint.toLowerCase().startsWith(value));
  if (finger) return finger;
  if (joint.startsWith('elbow')) return joint.endsWith('L') ? 'elbowL' : 'elbowR';
  if (joint.startsWith('knee')) return joint.endsWith('L') ? 'kneeL' : 'kneeR';
  return undefined;
}

export function expandedJointControls(state: PoseControlTreeState): BjdJointId[] {
  if (!state.branch) return [];
  if (state.branch === 'head') return ['head', 'neck'];
  if (state.branch === 'chest') return ['spineLower', 'spineUpper', 'neck'];
  if (state.branch === 'waist') return ['pelvis', 'spineLower', 'spineUpper'];
  if (state.branch === 'pelvis') return ['pelvis', 'hipL', 'hipR'];
  const side = state.branch.endsWith('L') ? 'L' : 'R';
  if (state.branch.startsWith('hand')) {
    if (FINGERS.includes(state.detail as PoseFingerId)) return FINGER_JOINTS[`${state.detail as PoseFingerId}${side}`];
    return [`shoulder${side}`, `wrist${side}`,
      ...FINGERS.map((finger) => FINGER_JOINTS[`${finger}${side}`][0])] as BjdJointId[];
  }
  return [`hip${side}`, `ankle${side}`, `toeBase${side}`, `bigToe${side}`] as BjdJointId[];
}

export function visibleCompoundControls(state: PoseControlTreeState): PoseCompoundId[] {
  if (state.branch === 'handL') return ['elbowL'];
  if (state.branch === 'handR') return ['elbowR'];
  if (state.branch === 'footL') return ['kneeL'];
  if (state.branch === 'footR') return ['kneeR'];
  return [];
}

export function compoundJoints(id: PoseCompoundId): [BjdJointId, BjdJointId] {
  const side = id.endsWith('L') ? 'L' : 'R';
  const stem = id.startsWith('elbow') ? 'elbow' : 'knee';
  return [`${stem}Upper${side}`, `${stem}Lower${side}`] as [BjdJointId, BjdJointId];
}

export function allControlTreeJoints(): Set<BjdJointId> {
  const result = new Set<BjdJointId>();
  ROOT_CONTROLS.forEach(({ joint }) => result.add(joint));
  (ROOT_CONTROLS.map(({ branch }) => branch)).forEach((branch) => {
    expandedJointControls({ branch }).forEach((joint) => result.add(joint));
    visibleCompoundControls({ branch }).forEach((compound) => compoundJoints(compound).forEach((joint) => result.add(joint)));
  });
  Object.values(FINGER_JOINTS).flat().forEach((joint) => result.add(joint));
  return result;
}
