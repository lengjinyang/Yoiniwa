import type { BjdIkChainId, BjdJointId, PoseBendState, PoseDocumentV1, Quaternion } from '../../domain/sceneTypes';
import type { BjdRigV1 } from './rigContract';

export function resetJoint(document: PoseDocumentV1, jointId: BjdJointId): PoseDocumentV1 {
  const next = structuredClone(document);
  delete next.jointRotations[jointId];
  return next;
}

export function resetIkChain(document: PoseDocumentV1, rig: BjdRigV1, chainId: BjdIkChainId): PoseDocumentV1 {
  const next = structuredClone(document);
  const chain = rig.ikChains[chainId];
  [chain.root, ...chain.middle, chain.end].forEach((joint) => delete next.jointRotations[joint]);
  if (next.ikState) delete next.ikState[chainId];
  return next;
}

export type PoseLimbKind = 'arm' | 'leg';
export type PoseSide = 'L' | 'R';

const ARM_STEMS = [
  'shoulder', 'elbowUpper', 'elbowLower', 'wrist',
  'thumbMetacarpal', 'thumbProximal', 'thumbDistal',
  'indexProximal', 'indexMiddle', 'indexDistal',
  'middleProximal', 'middleMiddle', 'middleDistal',
  'ringProximal', 'ringMiddle', 'ringDistal',
  'littleProximal', 'littleMiddle', 'littleDistal',
] as const;
const LEG_STEMS = ['hip', 'kneeUpper', 'kneeLower', 'ankle', 'toeBase', 'bigToe'] as const;

/** Mirrors a local joint rotation across the character's left/right symmetry plane. */
export function mirrorPoseQuaternion(value: Quaternion): Quaternion {
  return { x: value.x, y: -value.y, z: -value.z, w: value.w };
}

function mirroredIkState(document: PoseDocumentV1, kind: PoseLimbKind, source: PoseSide) {
  const target: PoseSide = source === 'L' ? 'R' : 'L';
  const sourceId = `${kind}${source}` as BjdIkChainId;
  const targetId = `${kind}${target}` as BjdIkChainId;
  const value = document.ikState?.[sourceId];
  if (!value) return { targetId, value: undefined };
  const mirrorBend = (bend?: PoseBendState): PoseBendState | undefined => bend && {
    planeNormal: { x: -bend.planeNormal.x, y: bend.planeNormal.y, z: bend.planeNormal.z },
    bendSide: bend.bendSide,
    bendAngle: bend.bendAngle,
    ...(bend.bendPlaneAngle !== undefined ? { bendPlaneAngle: bend.bendPlaneAngle } : {}),
    ...(bend.previousStable ? { previousStable: {
      planeNormal: { x: -bend.previousStable.planeNormal.x, y: bend.previousStable.planeNormal.y, z: bend.previousStable.planeNormal.z },
      bendSide: bend.previousStable.bendSide,
      bendAngle: bend.previousStable.bendAngle,
      ...(bend.previousStable.bendPlaneAngle !== undefined ? { bendPlaneAngle: bend.previousStable.bendPlaneAngle } : {}),
    } } : {}),
  };
  return { targetId, value: {
    poleDirection: { x: -value.poleDirection.x, y: value.poleDirection.y, z: value.poleDirection.z },
    ...(value.targetOrientation ? { targetOrientation: mirrorPoseQuaternion(value.targetOrientation) } : {}),
    ...(value.bendState ? { bendState: mirrorBend(value.bendState) } : {}),
    pinned: false,
  } };
}

export function mirrorPoseLimb(document: PoseDocumentV1, kind: PoseLimbKind, source: PoseSide): PoseDocumentV1 {
  const next = structuredClone(document);
  const target: PoseSide = source === 'L' ? 'R' : 'L';
  const stems = kind === 'arm' ? ARM_STEMS : LEG_STEMS;
  stems.forEach((stem) => {
    const sourceId = `${stem}${source}` as BjdJointId;
    const targetId = `${stem}${target}` as BjdJointId;
    const value = document.jointRotations[sourceId];
    if (value) next.jointRotations[targetId] = mirrorPoseQuaternion(value);
    else delete next.jointRotations[targetId];
  });
  const ik = mirroredIkState(document, kind, source);
  next.ikState ??= {};
  if (ik.value) next.ikState[ik.targetId] = ik.value;
  else delete next.ikState[ik.targetId];
  return next;
}

export function flipPoseLimbs(document: PoseDocumentV1, kind: PoseLimbKind): PoseDocumentV1 {
  const leftToRight = mirrorPoseLimb(document, kind, 'L');
  const rightToLeft = mirrorPoseLimb(document, kind, 'R');
  const next = structuredClone(document);
  const stems = kind === 'arm' ? ARM_STEMS : LEG_STEMS;
  stems.forEach((stem) => {
    const left = `${stem}L` as BjdJointId;
    const right = `${stem}R` as BjdJointId;
    const nextLeft = rightToLeft.jointRotations[left];
    const nextRight = leftToRight.jointRotations[right];
    if (nextLeft) next.jointRotations[left] = nextLeft; else delete next.jointRotations[left];
    if (nextRight) next.jointRotations[right] = nextRight; else delete next.jointRotations[right];
  });
  next.ikState ??= {};
  const leftChain = `${kind}L` as BjdIkChainId;
  const rightChain = `${kind}R` as BjdIkChainId;
  if (rightToLeft.ikState?.[leftChain]) next.ikState[leftChain] = rightToLeft.ikState[leftChain];
  else delete next.ikState[leftChain];
  if (leftToRight.ikState?.[rightChain]) next.ikState[rightChain] = leftToRight.ikState[rightChain];
  else delete next.ikState[rightChain];
  return next;
}
