import type { BjdIkChainId, BjdJointId, Quaternion } from '../../domain/sceneTypes';
import type { BjdRigV1 } from './rigContract';
import { distributeCompoundAngle } from './compoundJoint';

type SemanticFingerStem = 'thumbMetacarpal' | 'thumbProximal' | 'thumbDistal'
  | 'indexProximal' | 'indexMiddle' | 'indexDistal'
  | 'middleProximal' | 'middleMiddle' | 'middleDistal'
  | 'ringProximal' | 'ringMiddle' | 'ringDistal'
  | 'littleProximal' | 'littleMiddle' | 'littleDistal';
export type SemanticFingerJointId = `${SemanticFingerStem}${'L' | 'R'}`;

export type SemanticJointId =
  | 'pelvis' | 'spine' | 'chest' | 'neck' | 'head'
  | 'shoulderL' | 'elbowL' | 'wristL' | 'shoulderR' | 'elbowR' | 'wristR'
  | 'hipL' | 'kneeL' | 'ankleL' | 'hipR' | 'kneeR' | 'ankleR'
  | 'toeL' | 'bigToeL' | 'toeR' | 'bigToeR'
  | SemanticFingerJointId;

export interface SemanticIkChain {
  root: SemanticJointId;
  middle: SemanticJointId;
  end: SemanticJointId;
  upperLength: number;
  lowerLength: number;
  minBend?: number;
  maxBend?: number;
  flexionAxis: BjdRigV1['ikChains'][BjdIkChainId]['flexionAxis'];
  defaultPoleDirection: BjdRigV1['ikChains'][BjdIkChainId]['defaultPoleDirection'];
}

/** Runtime command state; authored elbow/knee node names never cross this boundary. */
export interface SemanticJointState {
  joint: SemanticJointId;
  rotationDelta?: Quaternion;
  bendAngle?: number;
}

/**
 * The solver only asks for semantic human parts. Model node names stay behind
 * this adapter so a different authored rig can reuse the pose interaction code.
 */
export interface PoseRigAdapter {
  readonly contract: BjdRigV1;
  jointNode(jointId: BjdJointId): string;
  jointPivot(jointId: BjdJointId): BjdRigV1['jointPivots'][BjdJointId];
  ikChain(chainId: BjdIkChainId): BjdRigV1['ikChains'][BjdIkChainId];
  semanticIkChain(chainId: BjdIkChainId): SemanticIkChain;
  authoredJoint(jointId: SemanticJointId): BjdJointId;
  semanticChainForCompoundJoint(jointId: BjdJointId): BjdIkChainId | undefined;
  rotationDeltasFor(
    state: SemanticJointState,
    rotationFor: (jointId: BjdJointId, angle: number) => Quaternion,
  ): Partial<Record<BjdJointId, Quaternion>>;
  segmentNode(segmentId: string): string | undefined;
}

export function createPoseRigAdapter(contract: BjdRigV1): PoseRigAdapter {
  const semanticChains: Record<BjdIkChainId, SemanticIkChain> = {
    armL: { ...contract.ikChains.armL, root: 'shoulderL', middle: 'elbowL', end: 'wristL' },
    armR: { ...contract.ikChains.armR, root: 'shoulderR', middle: 'elbowR', end: 'wristR' },
    legL: { ...contract.ikChains.legL, root: 'hipL', middle: 'kneeL', end: 'ankleL' },
    legR: { ...contract.ikChains.legR, root: 'hipR', middle: 'kneeR', end: 'ankleR' },
  };
  const semanticToAuthored = {
    pelvis: 'pelvis', spine: 'spineLower', chest: 'spineUpper', neck: 'neck', head: 'head',
    shoulderL: 'shoulderL', elbowL: contract.ikChains.armL.middle[1], wristL: 'wristL',
    shoulderR: 'shoulderR', elbowR: contract.ikChains.armR.middle[1], wristR: 'wristR',
    hipL: 'hipL', kneeL: contract.ikChains.legL.middle[1], ankleL: 'ankleL',
    hipR: 'hipR', kneeR: contract.ikChains.legR.middle[1], ankleR: 'ankleR',
    toeL: 'toeBaseL', bigToeL: 'bigToeL', toeR: 'toeBaseR', bigToeR: 'bigToeR',
  } as Record<SemanticJointId, BjdJointId>;
  const fingerStems: SemanticFingerStem[] = ['thumbMetacarpal', 'thumbProximal', 'thumbDistal', 'indexProximal', 'indexMiddle', 'indexDistal', 'middleProximal', 'middleMiddle', 'middleDistal', 'ringProximal', 'ringMiddle', 'ringDistal', 'littleProximal', 'littleMiddle', 'littleDistal'];
  for (const side of ['L', 'R'] as const) for (const stem of fingerStems) {
    const joint = `${stem}${side}` as SemanticFingerJointId; semanticToAuthored[joint] = joint;
  }
  return {
    contract,
    jointNode: (jointId) => contract.jointNodes[jointId],
    jointPivot: (jointId) => contract.jointPivots[jointId],
    ikChain: (chainId) => contract.ikChains[chainId],
    semanticIkChain: (chainId) => semanticChains[chainId],
    authoredJoint: (jointId) => semanticToAuthored[jointId],
    semanticChainForCompoundJoint: (jointId) => (Object.keys(contract.ikChains) as BjdIkChainId[])
      .find((chainId) => contract.ikChains[chainId].middle.includes(jointId)),
    rotationDeltasFor: (state, rotationFor) => {
      if (state.rotationDelta) return { [semanticToAuthored[state.joint]]: state.rotationDelta };
      const chainId = (Object.keys(semanticChains) as BjdIkChainId[]).find((id) => semanticChains[id].middle === state.joint);
      if (!chainId || state.bendAngle === undefined) return {};
      const chain = contract.ikChains[chainId];
      const compound = contract.compoundJoints.find((value) => value.id === chain.compoundJointId);
      const deltaAngle = state.bendAngle - chain.restBend;
      const angles = compound ? distributeCompoundAngle(deltaAngle, compound)
        : { primary: deltaAngle / 2, secondary: deltaAngle / 2 };
      return {
        [chain.middle[0]]: rotationFor(chain.middle[0], angles.primary),
        [chain.middle[1]]: rotationFor(chain.middle[1], angles.secondary),
      };
    },
    segmentNode: (segmentId) => contract.segmentBindings[segmentId]?.node,
  };
}
