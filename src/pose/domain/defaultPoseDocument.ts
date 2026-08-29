import type { PoseDocumentV1 } from '../../domain/sceneTypes';

const qx = (radians: number) => ({ x: Math.sin(radians / 2), y: 0, z: 0, w: Math.cos(radians / 2) });
const qz = (radians: number, side: 'L' | 'R') => ({ x: 0, y: 0, z: Math.sin(radians / 2) * (side === 'L' ? -1 : 1), w: Math.cos(radians / 2) });
const identity = { x: 0, y: 0, z: 0, w: 1 };

export const NATURAL_STANDING_ROTATIONS: PoseDocumentV1['jointRotations'] = {
  // Keep the neutral standing torso centered. A pelvis roll here makes the
  // mirrored arm pose look asymmetric from the front; weight-shift owns that
  // intentional side tilt instead.
  pelvis: { x: 0.0099998333, y: 0, z: 0, w: 0.9999500004 },
  // The source mesh is authored in a shallow A-pose with the arm depth behind
  // the torso. Add a relaxed forward swing so the hands sit beside the body
  // from the side view while keeping the two shoulders mirrored.
  shoulderL: { x: 0.1394314950, y: 0.0055802362, z: -0.0395980784, w: 0.9894239290 },
  shoulderR: { x: 0.1394314950, y: -0.0055802362, z: 0.0395980784, w: 0.9894239290 },
  elbowUpperL: qx(0.09), elbowLowerL: qx(0.055), elbowUpperR: qx(0.09), elbowLowerR: qx(0.055),
  hipL: { x: 0.012, y: 0, z: 0.035, w: 0.999315 }, hipR: { x: 0.012, y: 0, z: -0.035, w: 0.999315 },
  kneeUpperL: qx(-0.035), kneeLowerL: qx(-0.022), kneeUpperR: qx(-0.035), kneeLowerR: qx(-0.022),
  thumbMetacarpalL: identity, thumbProximalL: identity, thumbDistalL: identity,
  indexProximalL: qz(0.09, 'L'), indexMiddleL: qz(0.12, 'L'), indexDistalL: qz(0.08, 'L'),
  middleProximalL: qz(0.11, 'L'), middleMiddleL: qz(0.14, 'L'), middleDistalL: qz(0.09, 'L'),
  ringProximalL: qz(0.13, 'L'), ringMiddleL: qz(0.16, 'L'), ringDistalL: qz(0.1, 'L'),
  littleProximalL: qz(0.16, 'L'), littleMiddleL: qz(0.19, 'L'), littleDistalL: qz(0.12, 'L'),
  thumbMetacarpalR: identity, thumbProximalR: identity, thumbDistalR: identity,
  indexProximalR: qz(0.09, 'R'), indexMiddleR: qz(0.12, 'R'), indexDistalR: qz(0.08, 'R'),
  middleProximalR: qz(0.11, 'R'), middleMiddleR: qz(0.14, 'R'), middleDistalR: qz(0.09, 'R'),
  ringProximalR: qz(0.13, 'R'), ringMiddleR: qz(0.16, 'R'), ringDistalR: qz(0.1, 'R'),
  littleProximalR: qz(0.16, 'R'), littleMiddleR: qz(0.19, 'R'), littleDistalR: qz(0.12, 'R'),
};

export function createDefaultPoseDocument(): PoseDocumentV1 {
  return {
    schemaVersion: 1,
    modelId: 'chambersu-bjd-female-v1',
    rigVersion: 1,
    renderProfileId: 'bjd-clay-v1',
    poseRevision: 0,
    renderedRevision: 0,
    rootTransform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
    jointRotations: structuredClone(NATURAL_STANDING_ROTATIONS),
    camera: {
      projection: 'perspective', position: { x: 0, y: 0.9, z: -4.2 }, target: { x: 0, y: 0.85, z: 0 },
      focalLengthMm: 50, orthographicHeight: 2.2, horizon: 0, lensShift: { x: 0, y: 0 }, preserveFraming: true,
    },
    lighting: {
      contrast: 0.65, directionalDirection: { x: -0.7, y: 0.9, z: -1 },
    },
    appearance: {
      mode: 'clay', outline: true, bodyColor: '#E3DED4', jointEmphasis: 1,
      background: { type: 'transparent' }, ground: false, shadows: true,
    },
    frame: { aspect: '3:4' },
  };
}
