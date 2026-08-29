import type { BjdIkChainId, BjdJointId, PoseBendState, PoseDocumentV1, Quaternion, Vec3 } from '../../domain/sceneTypes';
import { ROOT_CONTROLS, type PoseBranchId } from './controlTree';

export const POSE_DOCUMENT_MAX_BYTES = 256 * 1024;

const JOINT_IDS = new Set<BjdJointId>([
  'pelvis', 'spineLower', 'spineUpper', 'neck', 'head',
  'shoulderL', 'shoulderR', 'elbowUpperL', 'elbowUpperR', 'elbowLowerL', 'elbowLowerR',
  'wristL', 'wristR', 'hipL', 'hipR', 'kneeUpperL', 'kneeUpperR',
  'kneeLowerL', 'kneeLowerR', 'ankleL', 'ankleR',
  'toeBaseL', 'toeBaseR', 'bigToeL', 'bigToeR',
  'thumbMetacarpalL', 'thumbProximalL', 'thumbDistalL',
  'indexProximalL', 'indexMiddleL', 'indexDistalL', 'middleProximalL', 'middleMiddleL', 'middleDistalL',
  'ringProximalL', 'ringMiddleL', 'ringDistalL', 'littleProximalL', 'littleMiddleL', 'littleDistalL',
  'thumbMetacarpalR', 'thumbProximalR', 'thumbDistalR',
  'indexProximalR', 'indexMiddleR', 'indexDistalR', 'middleProximalR', 'middleMiddleR', 'middleDistalR',
  'ringProximalR', 'ringMiddleR', 'ringDistalR', 'littleProximalR', 'littleMiddleR', 'littleDistalR',
]);
const IK_IDS = new Set<BjdIkChainId>(['armL', 'armR', 'legL', 'legR']);
const BRANCH_IDS = new Set<PoseBranchId>(['cog', ...ROOT_CONTROLS.map(({ branch }) => branch)]);
const ASPECTS = new Set(['1:1', '3:4', '4:3', '16:9']);

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function finite(value: unknown, min = -Number.MAX_VALUE, max = Number.MAX_VALUE): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function vec3(value: unknown): Vec3 | undefined {
  const v = object(value);
  return v && finite(v.x) && finite(v.y) && finite(v.z) ? { x: v.x, y: v.y, z: v.z } : undefined;
}

function quaternion(value: unknown): Quaternion | undefined {
  const q = object(value);
  if (!q || !finite(q.x) || !finite(q.y) || !finite(q.z) || !finite(q.w)) return undefined;
  const length = Math.hypot(q.x, q.y, q.z, q.w);
  if (length < 1e-8) return undefined;
  return { x: q.x / length, y: q.y / length, z: q.z / length, w: q.w / length };
}

function bendState(value: unknown): PoseBendState | undefined {
  const source = object(value);
  const planeNormal = vec3(source?.planeNormal);
  const bendSide = source?.bendSide === -1 || source?.bendSide === 1 ? source.bendSide : undefined;
  if (!planeNormal || bendSide === undefined || !finite(source?.bendAngle, 0, Math.PI)
    || (source?.bendPlaneAngle !== undefined && !finite(source.bendPlaneAngle, -1_000_000, 1_000_000))) return undefined;
  const previous = source?.previousStable === undefined ? undefined : object(source.previousStable);
  if (source?.previousStable !== undefined && (!previous || !vec3(previous.planeNormal)
    || (previous.bendSide !== -1 && previous.bendSide !== 1) || !finite(previous.bendAngle, 0, Math.PI)
    || (previous.bendPlaneAngle !== undefined && !finite(previous.bendPlaneAngle, -1_000_000, 1_000_000)))) return undefined;
  return {
    planeNormal,
    bendSide,
    bendAngle: source.bendAngle as number,
    ...(source.bendPlaneAngle !== undefined ? { bendPlaneAngle: source.bendPlaneAngle as number } : {}),
    ...(previous ? {
      previousStable: {
        planeNormal: vec3(previous.planeNormal)!,
        bendSide: previous.bendSide as -1 | 1,
        bendAngle: previous.bendAngle as number,
        ...(previous.bendPlaneAngle !== undefined ? { bendPlaneAngle: previous.bendPlaneAngle as number } : {}),
      },
    } : {}),
  };
}

/** Returns a normalized, allow-listed clone. Unknown and runtime-only fields never pass this boundary. */
export function parsePoseDocument(value: unknown): PoseDocumentV1 | undefined {
  let encoded: string;
  try { encoded = JSON.stringify(value); } catch { return undefined; }
  if (!encoded || new TextEncoder().encode(encoded).byteLength > POSE_DOCUMENT_MAX_BYTES) return undefined;
  const source = object(value);
  if (!source || source.schemaVersion !== 1 || source.modelId !== 'chambersu-bjd-female-v1'
    || source.rigVersion !== 1 || source.renderProfileId !== 'bjd-clay-v1') return undefined;
  if (!Number.isSafeInteger(source.poseRevision) || Number(source.poseRevision) < 0
    || !Number.isSafeInteger(source.renderedRevision) || Number(source.renderedRevision) < 0) return undefined;

  const root = object(source.rootTransform);
  const rootPosition = vec3(root?.position);
  const rootRotation = quaternion(root?.rotation);
  const rotations = object(source.jointRotations);
  if (!rootPosition || !rootRotation || !rotations || Object.keys(rotations).length > JOINT_IDS.size) return undefined;
  const jointRotations: PoseDocumentV1['jointRotations'] = {};
  for (const [id, rotation] of Object.entries(rotations)) {
    if (!JOINT_IDS.has(id as BjdJointId)) return undefined;
    const normalized = quaternion(rotation);
    if (!normalized) return undefined;
    jointRotations[id as BjdJointId] = normalized;
  }

  const lockedSource = source.lockedBranches === undefined ? undefined : object(source.lockedBranches);
  if (source.lockedBranches !== undefined && (!lockedSource || Object.keys(lockedSource).length > BRANCH_IDS.size)) return undefined;
  const lockedBranches: PoseDocumentV1['lockedBranches'] = {};
  for (const [branch, value] of Object.entries(lockedSource ?? {})) {
    if (!BRANCH_IDS.has(branch as PoseBranchId) || typeof value !== 'boolean') return undefined;
    lockedBranches[branch as PoseBranchId] = value;
  }

  const camera = object(source.camera);
  const cameraPosition = vec3(camera?.position);
  const cameraTarget = vec3(camera?.target);
  const lensShift = object(camera?.lensShift);
  const lighting = object(source.lighting);
  const lightDirection = vec3(lighting?.directionalDirection);
  const appearance = object(source.appearance);
  const background = object(appearance?.background);
  const frame = object(source.frame);
  if (!camera || !cameraPosition || !cameraTarget || !lensShift
    || !['perspective', 'orthographic'].includes(String(camera.projection))
    || !finite(camera.focalLengthMm, 18, 120) || !finite(camera.orthographicHeight, 0.001, 10_000)
    || !finite(camera.horizon, -10_000, 10_000) || !finite(lensShift.x, -2, 2) || !finite(lensShift.y, -2, 2)
    || typeof camera.preserveFraming !== 'boolean' || !lighting || !lightDirection
    || !appearance || !['clay', 'silhouette'].includes(String(appearance.mode))
    || typeof appearance.outline !== 'boolean' || typeof appearance.bodyColor !== 'string'
    || !finite(appearance.jointEmphasis, 0, 2) || !background
    || !['transparent', 'solid'].includes(String(background.type))
    || (background.type === 'solid' && typeof background.color !== 'string')
    || typeof appearance.ground !== 'boolean' || typeof appearance.shadows !== 'boolean'
    || !frame || !ASPECTS.has(String(frame.aspect))) return undefined;

  const ikSource = source.ikState === undefined ? undefined : object(source.ikState);
  if (source.ikState !== undefined && (!ikSource || Object.keys(ikSource).length > IK_IDS.size)) return undefined;
  const ikState: PoseDocumentV1['ikState'] = {};
  for (const [id, raw] of Object.entries(ikSource ?? {})) {
    const entry = object(raw);
    const poleDirection = vec3(entry?.poleDirection);
    const targetOrientation = entry?.targetOrientation === undefined ? undefined : quaternion(entry.targetOrientation);
    const bend = entry?.bendState === undefined ? undefined : bendState(entry.bendState);
    if (!IK_IDS.has(id as BjdIkChainId) || !entry || !poleDirection
      || (entry.targetOrientation !== undefined && !targetOrientation)
      || (entry.bendState !== undefined && !bend)) return undefined;
    ikState[id as BjdIkChainId] = {
      poleDirection, targetOrientation,
      ...(bend ? { bendState: bend } : {}),
      ...(typeof entry.pinned === 'boolean' ? { pinned: entry.pinned } : {}),
    };
  }

  // Old documents may contain handPresetHints and separate light intensities. Hints are intentionally ignored;
  // finger rotations remain in jointRotations, and legacy light intensity is normalized to contrast.
  const contrast = finite(lighting.contrast, 0, 1) ? lighting.contrast
    : finite(lighting.directionalIntensity, 0, 20)
      ? Math.min(1, Math.max(0, (lighting.directionalIntensity - 0.8) / 2.4)) : undefined;
  if (contrast === undefined) return undefined;

  return {
    schemaVersion: 1, modelId: 'chambersu-bjd-female-v1', rigVersion: 1, renderProfileId: 'bjd-clay-v1',
    poseRevision: Number(source.poseRevision), renderedRevision: Number(source.renderedRevision),
    rootTransform: { position: rootPosition, rotation: rootRotation }, jointRotations,
    lockedBranches: lockedSource ? lockedBranches : undefined,
    ikState: ikSource ? ikState : undefined,
    camera: {
      projection: camera.projection as 'perspective' | 'orthographic', position: cameraPosition, target: cameraTarget,
      focalLengthMm: camera.focalLengthMm as number, orthographicHeight: camera.orthographicHeight as number,
      horizon: camera.horizon as number, lensShift: { x: lensShift.x as number, y: lensShift.y as number },
      preserveFraming: camera.preserveFraming as boolean,
    },
    lighting: { contrast, directionalDirection: lightDirection },
    appearance: { mode: appearance.mode as 'clay' | 'silhouette', outline: appearance.outline as boolean,
      bodyColor: appearance.bodyColor as string, jointEmphasis: appearance.jointEmphasis as number,
      background: background.type === 'transparent' ? { type: 'transparent' }
        : { type: 'solid', color: background.color as string },
      ground: appearance.ground as boolean, shadows: appearance.shadows as boolean },
    frame: { aspect: frame.aspect as PoseDocumentV1['frame']['aspect'] },
  };
}
