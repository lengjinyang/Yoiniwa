import { describe, expect, it } from 'vitest';
import { createDefaultPoseDocument } from './defaultPoseDocument';
import { parsePoseDocument } from './poseDocument';

describe('pose document compatibility', () => {
  it('defaults legacy documents to unlocked branches', () => {
    const document = createDefaultPoseDocument();
    const parsed = parsePoseDocument(document);
    expect(parsed?.lockedBranches).toBeUndefined();
  });

  it('round-trips branch locks and legacy pinned IK state', () => {
    const document = createDefaultPoseDocument();
    document.lockedBranches = { handL: true, head: false };
    document.ikState = { armL: { poleDirection: { x: 0, y: 1, z: 0 }, pinned: true } };
    const parsed = parsePoseDocument(document);
    expect(parsed?.lockedBranches).toEqual({ handL: true, head: false });
    expect(parsed?.ikState?.armL?.pinned).toBe(true);
  });

  it('round-trips an independent end-effector orientation', () => {
    const document = createDefaultPoseDocument();
    document.ikState = { legR: {
      poleDirection: { x: 0, y: 0, z: 1 },
      targetOrientation: { x: .1, y: .2, z: .3, w: .9 },
    } };
    const orientation = parsePoseDocument(document)?.ikState?.legR?.targetOrientation;
    expect(orientation).toBeDefined();
    expect(Math.hypot(orientation!.x, orientation!.y, orientation!.z, orientation!.w)).toBeCloseTo(1);
  });

  it('round-trips optional stable bend continuation state', () => {
    const document = createDefaultPoseDocument();
    document.ikState = { armL: {
      poleDirection: { x: 0, y: 1, z: 0 },
      bendState: {
        planeNormal: { x: 0, y: 0, z: 1 }, bendSide: 1, bendAngle: .8,
        previousStable: { planeNormal: { x: 0, y: 0, z: 1 }, bendSide: 1, bendAngle: .7 },
      },
    } };
    expect(parsePoseDocument(document)?.ikState?.armL?.bendState).toEqual(document.ikState?.armL?.bendState);
  });

  it('rejects unknown or malformed lock branches', () => {
    const document = createDefaultPoseDocument() as unknown as Record<string, unknown>;
    document.lockedBranches = { torso: true };
    expect(parsePoseDocument(document)).toBeUndefined();
  });
});
