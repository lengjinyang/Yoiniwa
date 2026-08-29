import { describe, expect, it } from 'vitest';
import { createDefaultPoseDocument } from './defaultPoseDocument';
import { flipPoseLimbs, mirrorPoseLimb } from './poseOperations';
import { blendPosePreset, type PosePresetV1 } from './posePresets';

describe('Magic-Poser-style pose editing operations', () => {
  it('blends a preset without changing camera and rendering settings', () => {
    const base = createDefaultPoseDocument();
    const preset: PosePresetV1 = {
      id: 'reach', label: '伸展', rootTransform: { position: { x: 2, y: 0, z: 0 }, rotation: { x: 0, y: 1, z: 0, w: 0 } },
      jointRotations: { shoulderL: { x: 0, y: 0, z: 1, w: 0 } },
    };
    const blended = blendPosePreset(base, preset, .5);
    expect(blended.rootTransform.position.x).toBe(1);
    expect(blended.camera).toEqual(base.camera);
    expect(Math.hypot(...Object.values(blended.jointRotations.shoulderL!))).toBeCloseTo(1);
  });

  it('mirrors and flips complete limbs, including IK pole direction', () => {
    const pose = createDefaultPoseDocument();
    pose.jointRotations.shoulderL = { x: .1, y: .2, z: .3, w: .9 };
    pose.jointRotations.shoulderR = { x: -.4, y: .1, z: -.2, w: .86 };
    pose.ikState = { armL: { poleDirection: { x: .2, y: .5, z: .8 }, pinned: true,
      bendState: { planeNormal: { x: .1, y: .2, z: .9 }, bendSide: -1, bendAngle: .7 } } };
    const mirrored = mirrorPoseLimb(pose, 'arm', 'L');
    expect(mirrored.jointRotations.shoulderR).toEqual({ x: .1, y: -.2, z: -.3, w: .9 });
    expect(mirrored.ikState?.armR).toMatchObject({ poleDirection: { x: -.2, y: .5, z: .8 }, pinned: false });
    expect(mirrored.ikState?.armR?.bendState?.planeNormal).toEqual({ x: -.1, y: .2, z: .9 });
    const flipped = flipPoseLimbs(pose, 'arm');
    expect(flipped.jointRotations.shoulderL).toEqual({ x: -.4, y: -.1, z: .2, w: .86 });
    expect(flipped.jointRotations.shoulderR).toEqual({ x: .1, y: -.2, z: -.3, w: .9 });
  });

  it('mirrors aggregate toe and big-toe rotation without a five-toe rig', () => {
    const pose = createDefaultPoseDocument();
    pose.jointRotations.toeBaseL = { x: .3, y: .1, z: -.2, w: .92 };
    pose.jointRotations.bigToeL = { x: .2, y: -.1, z: .15, w: .96 };
    const mirrored = mirrorPoseLimb(pose, 'leg', 'L');
    expect(mirrored.jointRotations.toeBaseR).toEqual({ x: .3, y: -.1, z: .2, w: .92 });
    expect(mirrored.jointRotations.bigToeR).toEqual({ x: .2, y: .1, z: -.15, w: .96 });
  });
});
