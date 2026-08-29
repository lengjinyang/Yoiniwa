import { describe, expect, it } from 'vitest';
import { allControlTreeJoints, expandedJointControls, ROOT_CONTROLS } from './controlTree';
import type { BjdJointId } from '../../domain/sceneTypes';

describe('pose control tree', () => {
  it('starts with the compact body control set', () => expect(ROOT_CONTROLS).toHaveLength(8));
  it('covers every physical joint', () => {
    const expected: BjdJointId[] = [
      'pelvis', 'spineLower', 'spineUpper', 'neck', 'head',
      ...(['L', 'R'] as const).flatMap((side) => [
        `shoulder${side}`, `elbowUpper${side}`, `elbowLower${side}`, `wrist${side}`,
        `hip${side}`, `kneeUpper${side}`, `kneeLower${side}`, `ankle${side}`, `toeBase${side}`, `bigToe${side}`,
        `thumbMetacarpal${side}`, `thumbProximal${side}`, `thumbDistal${side}`,
        ...(['index', 'middle', 'ring', 'little'] as const).flatMap((finger) =>
          [`${finger}Proximal${side}`, `${finger}Middle${side}`, `${finger}Distal${side}`]),
      ]),
    ] as BjdJointId[];
    expect([...allControlTreeJoints()].sort()).toEqual(expected.sort());
  });
  it('shows only the selected finger detail', () => {
    expect(expandedJointControls({ branch: 'handL', detail: 'index' }))
      .toEqual(['indexProximalL', 'indexMiddleL', 'indexDistalL']);
  });
});
