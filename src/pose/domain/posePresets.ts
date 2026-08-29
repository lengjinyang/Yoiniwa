import type { PoseDocumentV1, Quaternion } from '../../domain/sceneTypes';
import { createDefaultPoseDocument } from './defaultPoseDocument';
import { parsePoseDocument } from './poseDocument';

export type PosePresetId = 'a-pose' | 'natural-standing' | 'weight-shift' | 'walk' | 'run'
  | 'squat' | 'sit' | 'kneel' | 'reach' | 'jump';

export interface PosePresetV1 {
  id: PosePresetId;
  label: string;
  rootTransform: PoseDocumentV1['rootTransform'];
  jointRotations: PoseDocumentV1['jointRotations'];
}

export interface PosePresetPackV1 {
  schemaVersion: 1;
  modelId: 'chambersu-bjd-female-v1';
  rigVersion: 1;
  presets: PosePresetV1[];
}

const REQUIRED_IDS: PosePresetId[] = [
  'natural-standing', 'weight-shift', 'walk', 'run', 'squat', 'sit', 'kneel', 'reach', 'jump', 'a-pose',
];

export function parsePosePresetPack(value: unknown): PosePresetPackV1 {
  if (!value || typeof value !== 'object') throw new Error('姿势预设包无效');
  const source = value as Partial<PosePresetPackV1>;
  if (source.schemaVersion !== 1 || source.modelId !== 'chambersu-bjd-female-v1' || source.rigVersion !== 1
    || !Array.isArray(source.presets)) throw new Error('姿势预设包版本无效');
  const ids = new Set(source.presets.map((preset) => preset?.id));
  if (REQUIRED_IDS.some((id) => !ids.has(id))) throw new Error('姿势预设包缺少 v1 必需预设');
  const presets = source.presets.map((preset) => {
    if (!preset || !REQUIRED_IDS.includes(preset.id) || typeof preset.label !== 'string') throw new Error('姿势预设记录无效');
    const candidate = createDefaultPoseDocument();
    candidate.rootTransform = preset.rootTransform;
    candidate.jointRotations = preset.jointRotations;
    const parsed = parsePoseDocument(candidate);
    if (!parsed) throw new Error(`姿势预设数据无效：${preset.id}`);
    return { id: preset.id, label: preset.id === 'a-pose' ? 'A-Pose（校准）' : preset.label, rootTransform: parsed.rootTransform,
      jointRotations: parsed.jointRotations };
  }).sort((a, b) => REQUIRED_IDS.indexOf(a.id) - REQUIRED_IDS.indexOf(b.id));
  return { schemaVersion: 1, modelId: 'chambersu-bjd-female-v1', rigVersion: 1, presets };
}

export function applyPosePreset(document: PoseDocumentV1, preset: PosePresetV1): PoseDocumentV1 {
  return { ...structuredClone(document), rootTransform: structuredClone(preset.rootTransform),
    jointRotations: structuredClone(preset.jointRotations) };
}

function normalizedQuaternion(value: Quaternion): Quaternion {
  const length = Math.hypot(value.x, value.y, value.z, value.w) || 1;
  return { x: value.x / length, y: value.y / length, z: value.z / length, w: value.w / length };
}

function slerpQuaternion(from: Quaternion, to: Quaternion, amount: number): Quaternion {
  const t = Math.max(0, Math.min(1, amount));
  let target = normalizedQuaternion(to);
  const source = normalizedQuaternion(from);
  let dot = source.x * target.x + source.y * target.y + source.z * target.z + source.w * target.w;
  if (dot < 0) {
    dot = -dot;
    target = { x: -target.x, y: -target.y, z: -target.z, w: -target.w };
  }
  if (dot > .9995) return normalizedQuaternion({
    x: source.x + (target.x - source.x) * t,
    y: source.y + (target.y - source.y) * t,
    z: source.z + (target.z - source.z) * t,
    w: source.w + (target.w - source.w) * t,
  });
  const theta = Math.acos(Math.max(-1, Math.min(1, dot)));
  const sinTheta = Math.sin(theta);
  const fromWeight = Math.sin((1 - t) * theta) / sinTheta;
  const toWeight = Math.sin(t * theta) / sinTheta;
  return normalizedQuaternion({
    x: source.x * fromWeight + target.x * toWeight,
    y: source.y * fromWeight + target.y * toWeight,
    z: source.z * fromWeight + target.z * toWeight,
    w: source.w * fromWeight + target.w * toWeight,
  });
}

/** Blends from the pose that was active when a preset was chosen. Camera and rendering settings stay untouched. */
export function blendPosePreset(base: PoseDocumentV1, preset: PosePresetV1, amount: number): PoseDocumentV1 {
  const t = Math.max(0, Math.min(1, amount));
  const identity: Quaternion = { x: 0, y: 0, z: 0, w: 1 };
  const jointIds = new Set([...Object.keys(base.jointRotations), ...Object.keys(preset.jointRotations)]);
  const jointRotations: PoseDocumentV1['jointRotations'] = {};
  jointIds.forEach((rawId) => {
    const jointId = rawId as keyof PoseDocumentV1['jointRotations'];
    jointRotations[jointId] = slerpQuaternion(base.jointRotations[jointId] ?? identity,
      preset.jointRotations[jointId] ?? identity, t);
  });
  return {
    ...structuredClone(base),
    rootTransform: {
      position: {
        x: base.rootTransform.position.x + (preset.rootTransform.position.x - base.rootTransform.position.x) * t,
        y: base.rootTransform.position.y + (preset.rootTransform.position.y - base.rootTransform.position.y) * t,
        z: base.rootTransform.position.z + (preset.rootTransform.position.z - base.rootTransform.position.z) * t,
      },
      rotation: slerpQuaternion(base.rootTransform.rotation, preset.rootTransform.rotation, t),
    },
    jointRotations,
    ikState: undefined,
  };
}
