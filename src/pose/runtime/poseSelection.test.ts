import { describe, expect, it } from 'vitest';
import { createPoseSelection } from './PoseRuntime';

describe('pose selection mapping', () => {
  it('maps finger, hand, head and ordinary joints to their branches', () => {
    expect(createPoseSelection('indexDistalL')).toMatchObject({ part: 'finger', branch: 'handL', dof: 'both' });
    expect(createPoseSelection('wristR')).toMatchObject({ part: 'hand', branch: 'handR' });
    expect(createPoseSelection('wristR', 'handR', false, 'direction')).toMatchObject({ branch: 'handR', control: 'direction' });
    expect(createPoseSelection('head')).toMatchObject({ part: 'head', branch: 'head' });
    expect(createPoseSelection('spineUpper')).toMatchObject({ part: 'joint', branch: 'chest' });
  });

  it('removes editing freedom while a branch is locked', () => {
    expect(createPoseSelection('wristL', undefined, true)).toMatchObject({ branch: 'handL', dof: 'none', locked: true });
    expect(createPoseSelection()).toBeUndefined();
  });

  it('marks elbow and knee controllers as bend-direction translation controls', () => {
    expect(createPoseSelection('elbowUpperL')).toMatchObject({ branch: 'handL', dof: 'translate' });
    expect(createPoseSelection('kneeLowerR')).toMatchObject({ branch: 'footR', dof: 'translate' });
  });
});
