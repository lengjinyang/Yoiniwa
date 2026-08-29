import type { Camera, Material, Mesh, Object3D, Quaternion as ThreeQuaternion, WebGLRenderer } from 'three';
import type { BjdIkChainId, BjdJointId, PoseBendState, PoseDocumentV1, PoseEditMode, Vec3 } from '../../domain/sceneTypes';
import { logInfo } from '../../runtime/logger';
import { parseBjdRigV1, type BjdRigV1 } from '../domain/rigContract';
import { createPoseRigAdapter, type SemanticJointId } from '../domain/rigAdapter';
import { solveTwoBoneIk } from '../domain/twoBoneIk';
import { bendDirectionAtAngle, bendNormal, bendPlaneAngle, createBendPlaneFrame, unwrapBendPlaneAngle } from '../domain/bendState';
import { flipPoseLimbs, mirrorPoseLimb, mirrorPoseQuaternion, resetIkChain } from '../domain/poseOperations';
import { parsePoseAssetAudit } from '../domain/assetAudit';
import {
  branchForJoint, detailForJoint, FINGER_JOINTS,
  ROOT_CONTROLS, type PoseBranchId, type PoseControlTreeState, type PoseFingerId,
} from '../domain/controlTree';
import { fitBounds } from '../domain/framing';
import { lightingIntensities, normalizeDirection } from '../domain/lighting';
import { NATURAL_STANDING_ROTATIONS } from '../domain/defaultPoseDocument';
import { createThumbBendBases } from '../domain/thumbAxes';
import { applyBjdFk } from './rigFk';
import { orientationTowardDirection, rollEndOrientation, rotationBetweenBendFrames } from './rigKinematics';

const ASSET_ROOT = '/pose/chambersu-bjd-female-v1';
const ASSET_REVISION = 'bjd-rigid-v24';
const IK_ORDER: BjdIkChainId[] = ['legL', 'legR', 'armL', 'armR'];
const BRANCH_LABELS: Record<PoseBranchId, string> = {
  cog: '重心 / COG', head: '头部', chest: '胸部', waist: '腰部', pelvis: '骨盆', handL: '左手腕', handR: '右手腕', footL: '左脚踝', footR: '右脚踝',
};
const FINGER_IDS: PoseFingerId[] = ['thumb', 'index', 'middle', 'ring', 'little'];

export function projectThumbPoseCurve(target: Vec3, points: Vec3[]) {
  if (points.length < 2) throw new Error('Thumb Pose Curve 至少需要两个关键姿态');
  let best = { segment: 0, amount: 0, error: Number.POSITIVE_INFINITY };
  points.slice(0, -1).forEach((point, segment) => {
    const end = points[segment + 1]!; const dx = end.x - point.x; const dy = end.y - point.y; const dz = end.z - point.z; const length = dx * dx + dy * dy + dz * dz;
    const amount = length > 1e-10 ? Math.max(0, Math.min(1, ((target.x - point.x) * dx + (target.y - point.y) * dy + (target.z - point.z) * dz) / length)) : 0;
    const ex = point.x + dx * amount - target.x; const ey = point.y + dy * amount - target.y; const ez = point.z + dz * amount - target.z; const error = ex * ex + ey * ey + ez * ez;
    if (error < best.error) best = { segment, amount, error };
  });
  return best;
}

export function fingerCurlFromReach(reach: number, maxReach: number) {
  return Math.max(0, Math.min(1, (1 - reach / Math.max(.001, maxReach)) / .5));
}
const JOINT_LABELS: Partial<Record<BjdJointId, string>> = {
  pelvis: '骨盆', spineLower: '下胸椎', spineUpper: '上胸椎', neck: '颈部', head: '头部',
  shoulderL: '左肩', shoulderR: '右肩', elbowUpperL: '左肘上节', elbowUpperR: '右肘上节',
  elbowLowerL: '左肘下节', elbowLowerR: '右肘下节', wristL: '左腕', wristR: '右腕', hipL: '左髋', hipR: '右髋',
  kneeUpperL: '左膝上节', kneeUpperR: '右膝上节', kneeLowerL: '左膝下节', kneeLowerR: '右膝下节', ankleL: '左踝', ankleR: '右踝',
  toeBaseL: '左脚趾', toeBaseR: '右脚趾', bigToeL: '左大脚趾', bigToeR: '右大脚趾',
};
const isHingeJoint = (jointId: BjdJointId) => /^(elbow|knee)/.test(jointId) || /(Middle|Distal)/.test(jointId);
const isFingerJoint = (jointId?: BjdJointId) => Boolean(jointId && Object.values(FINGER_JOINTS).some((joints) => joints.includes(jointId)));

function outputSize(aspect: PoseDocumentV1['frame']['aspect']) {
  if (aspect === '1:1') return { width: 2048, height: 2048 };
  if (aspect === '4:3') return { width: 2048, height: 1536 };
  if (aspect === '16:9') return { width: 2048, height: 1152 };
  return { width: 1536, height: 2048 };
}
function aspectValue(aspect: PoseDocumentV1['frame']['aspect']) {
  if (aspect === '1:1') return 1;
  if (aspect === '4:3') return 4 / 3;
  if (aspect === '16:9') return 16 / 9;
  return 3 / 4;
}
function jointLabel(jointId?: BjdJointId) {
  if (!jointId) return '关节';
  const finger = FINGER_IDS.find((id) => jointId.toLowerCase().startsWith(id));
  if (finger) { const names: Record<PoseFingerId, string> = { thumb: '拇指', index: '食指', middle: '中指', ring: '无名指', little: '小指' }; return `${jointId.endsWith('L') ? '左' : '右'}${names[finger]}指尖`; }
  return JOINT_LABELS[jointId] ?? jointId;
}

export type PoseSelectedPart = 'none' | 'model' | 'joint' | 'hand' | 'finger' | 'head';

export interface PoseSelection {
  part: PoseSelectedPart;
  jointId?: BjdJointId;
  branch?: PoseBranchId;
  control?: 'position' | 'direction';
  dof: 'none' | 'translate' | 'rotate' | 'both';
  locked: boolean;
}

export type PosePivotDebugAxis = 'x' | 'y' | 'z' | 'curl';
export interface PosePivotDebugState {
  enabled: boolean;
  jointId: BjdJointId;
  axis: PosePivotDebugAxis;
  angle: number;
  originPivotDistance: number;
  geometryPivotDistance?: number;
  geometryDrift?: number;
  geometryAvailable: boolean;
  geometryJointCenter?: Vec3;
  boneOrigin: Vec3;
  runtimePivot: Vec3;
  curlAxis?: Vec3;
}

export function createPoseSelection(jointId?: BjdJointId, branch?: PoseBranchId, locked = false, control?: PoseSelection['control']): PoseSelection | undefined {
  const resolvedBranch = branch ?? (jointId ? branchForJoint(jointId) : undefined);
  if (!jointId && !resolvedBranch) return undefined;
  const isFinger = jointId && Object.values(FINGER_JOINTS).some((joints) => joints.includes(jointId));
  const part: PoseSelectedPart = isFinger ? 'finger' : resolvedBranch?.startsWith('hand') ? 'hand'
    : resolvedBranch === 'head' ? 'head' : jointId ? 'joint' : 'model';
  const bendOnly = Boolean(jointId && /^(elbow|knee)/.test(jointId));
  return { part, jointId, branch: resolvedBranch, control, dof: locked ? 'none' : bendOnly ? 'translate' : 'both', locked };
}

export interface PoseRuntime {
  setDocument(document: PoseDocumentV1): void;
  setManipulatorMode(mode: PoseEditMode): void;
  /** Compatibility alias for older pose studio callers. */
  setEditMode(mode: PoseEditMode): void;
  setHandMode(enabled: boolean): void;
  setPivotDebugMode(enabled: boolean): void;
  setPivotDebugJoint(jointId: BjdJointId): void;
  setPivotDebugRotation(axis: PosePivotDebugAxis, angle: number): void;
  toggleSelectedLock(): void;
  getSelection(): PoseSelection | undefined;
  selectHand(side: 'L' | 'R'): void;
  setPreviewMode(enabled: boolean): void;
  setProjection(projection: PoseDocumentV1['camera']['projection']): void;
  setFocalLength(focalLengthMm: number): void;
  cancelInteraction(): void;
  setCameraView(view: 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'threeQuarter' | 'low' | 'high'): void;
  focusSelection(): void;
  mirrorSelectedLimb(): void;
  flipSelectedLimbs(): void;
  setToePose(curl: number, spread: number, bigToe: number): void;
  resetSelectedJoint(): void;
  resetSelectedLimb(): void;
  resetWholePose(): void;
  centerPerson(): void;
  setLightDirectionFromView(x: number, y: number): void;
  setFootLock(side: 'L' | 'R', locked: boolean): void;
  setBothFootLocks(locked: boolean): void;
  mirrorPose(): void;
  togglePinned(chainId?: BjdIkChainId): void;
  setHandZoomOpen(open: boolean): void;
  beginInteraction(): void;
  endInteraction(): void;
  renderPng(document: PoseDocumentV1): Promise<Blob>;
  dispose(): void;
}

export interface PoseRuntimeEvents {
  editable?: boolean;
  centerOnLoad?: boolean;
  onDocumentChange?(document: PoseDocumentV1): void;
  onInitialDocument?(document: PoseDocumentV1): void;
  onSelectionChange?(selection?: PoseSelection): void;
  onBranchChange?(branch?: PoseBranchId): void;
  onInteractionStart?(): void;
  onInteractionEnd?(): void;
  onHoverChange?(message?: string): void;
  onHandZoomChange?(open: boolean): void;
  onSideMiniViewChange?(visible: boolean): void;
  onDetailChange?(detail?: PoseFingerId): void;
  onPivotDebugChange?(state: PosePivotDebugState): void;
  onConstraintChange?(message?: string): void;
}

type BoundMesh = { mesh: Mesh; role: 'body' | 'joint' | 'joint-slot'; jointId?: BjdJointId };
type LimbMoveHandle = 'root' | 'middle' | 'end';
type MoveTarget = { kind: 'move'; branch: PoseBranchId; chainId?: BjdIkChainId; jointId?: BjdJointId; handle?: LimbMoveHandle };
type DirectionTarget = { kind: 'direction'; branch: PoseBranchId; chainId: BjdIkChainId; jointId: BjdJointId };
type PoleTarget = { kind: 'pole'; branch: PoseBranchId; chainId: BjdIkChainId; jointId: BjdJointId };
type RotateTarget = { kind: 'rotate'; jointId: BjdJointId; zone: 'inner' | 'outer' };
type HandTipTarget = { kind: 'hand-tip'; jointId: BjdJointId };
type PinTarget = { kind: 'pin'; chainId: BjdIkChainId };
type InteractionTarget = MoveTarget | DirectionTarget | PoleTarget | RotateTarget | HandTipTarget | PinTarget;
type ControlMesh = Mesh & { userData: Mesh['userData'] & {
  controlType?: string; branch?: PoseBranchId; chainId?: BjdIkChainId; jointId?: BjdJointId; handle?: LimbMoveHandle; zone?: 'inner' | 'outer';
} };

export async function createPoseRuntime(
  canvas: HTMLCanvasElement,
  initialDocument: PoseDocumentV1,
  events: PoseRuntimeEvents = {},
): Promise<PoseRuntime> {
  const THREE = await import('three');
  const editable = events.editable !== false;
  const [{ GLTFLoader }, { OrbitControls }] = await Promise.all([
    import('three/examples/jsm/loaders/GLTFLoader.js'),
    import('three/examples/jsm/controls/OrbitControls.js'),
  ]);
  const [auditResponse, rigResponse] = await Promise.all([
    fetch(`${ASSET_ROOT}/asset-audit-v1.json?rev=${ASSET_REVISION}`, { cache: 'force-cache' }),
    fetch(`${ASSET_ROOT}/bjd-rig-v1.json?rev=${ASSET_REVISION}`, { cache: 'force-cache' }),
  ]);
  if (!auditResponse.ok) throw new Error('缺少已批准的 asset-audit-v1.json；模型资产尚未通过 Phase 0 审计');
  parsePoseAssetAudit(await auditResponse.json());
  if (!rigResponse.ok) throw new Error('缺少 bjd-rig-v1.json；模型资产尚未通过 Phase 0 审计');
  const rig = parseBjdRigV1(await rigResponse.json());
  const rigAdapter = createPoseRigAdapter(rig);
  const gltf = await new GLTFLoader().loadAsync(`${ASSET_ROOT}/chambersu-bjd-female-v1.glb?rev=${ASSET_REVISION}`)
    .catch((error: unknown) => { throw new Error(`无法加载 BJD GLB：${error instanceof Error ? error.message : String(error)}`); });
  if (!gltf.scene.getObjectByName(rig.rootNode)) throw new Error(`GLB 缺少 rig 根节点：${rig.rootNode}`);
  for (const [jointId, nodeName] of Object.entries(rig.jointNodes)) if (!gltf.scene.getObjectByName(nodeName)) throw new Error(`GLB 缺少关节节点：${jointId}`);
  for (const [segmentId, binding] of Object.entries(rig.segmentBindings)) if (!gltf.scene.getObjectByName(binding.node)) throw new Error(`GLB 缺少刚性分件：${segmentId}`);
  const rootNode = gltf.scene.getObjectByName(rig.rootNode)!;
  const rootRestPosition = rootNode.position.clone(); const rootRestQuaternion = rootNode.quaternion.clone();
  gltf.scene.updateMatrixWorld(true);
  const authoredJointObjects = new Map((Object.keys(rig.jointNodes) as BjdJointId[]).map((jointId) => [jointId, gltf.scene.getObjectByName(rigAdapter.jointNode(jointId))!] as const));
  const jointObjects = new Map<BjdJointId, Object3D>(authoredJointObjects);
  const authoredFingerTipDirection = (jointId: BjdJointId) => {
    const joint = authoredJointObjects.get(jointId)!; const segmentName = rigAdapter.segmentNode(jointId);
    if (!segmentName) throw new Error(`Finger authored segment is missing：${jointId}`);
    const segment = gltf.scene.getObjectByName(segmentName)!;
    const toJointLocal = joint.matrixWorld.clone().invert(); const point = new THREE.Vector3(); let farthest = new THREE.Vector3(); let distance = 0;
    segment.traverse((object) => {
      const mesh = object as Mesh; const positions = mesh.geometry?.getAttribute('position'); if (!positions) return;
      for (let index = 0; index < positions.count; index += 1) {
        point.fromBufferAttribute(positions, index).applyMatrix4(mesh.matrixWorld).applyMatrix4(toJointLocal);
        if (point.lengthSq() > distance) { distance = point.lengthSq(); farthest = point.clone(); }
      }
    });
    if (distance < 1e-10) throw new Error(`Finger authored segment has no joint→tip direction：${jointId}`);
    return { x: farthest.x, y: farthest.y, z: farthest.z };
  };
  const fingertipDirections = new Map([...new Set(Object.values(FINGER_JOINTS).map((joints) => joints[2]))].map((jointId) => [jointId, authoredFingerTipDirection(jointId)]));
  const thumbBendBases = new Map((['L', 'R'] as const).flatMap((side) => createThumbBendBases(rig.jointPivots, side, fingertipDirections.get(`thumbDistal${side}` as BjdJointId))).map((basis) => [basis.joint, basis]));
  jointObjects.forEach((joint, jointId) => {
    const target = rigAdapter.jointPivot(jointId); const expected = new THREE.Vector3(target.x, target.y, target.z);
    const rest = rig.restPose[jointId];
    if (joint.getWorldPosition(new THREE.Vector3()).distanceTo(expected) > 1e-5) throw new Error(`Bone Origin 与 Rig Pivot 不一致：${jointId}`);
    if (rest && joint.quaternion.angleTo(new THREE.Quaternion(rest.x, rest.y, rest.z, rest.w)) > 1e-5) throw new Error(`GLB Rest Transform 与 Rig Rest Pose 不一致：${jointId}`);
  });
  Object.entries(rig.segmentBindings).forEach(([segmentId, binding]) => {
    const segment = gltf.scene.getObjectByName(binding.node)!; const joint = authoredJointObjects.get(binding.joint)!;
    if (segment.parent !== joint) throw new Error(`BJD 分件不是直接刚性绑定：${segmentId}`);
    segment.traverse((object) => {
      const mesh = object as Mesh; if (!mesh.isMesh) return;
      if ('isSkinnedMesh' in mesh && mesh.isSkinnedMesh) throw new Error(`BJD 分件错误使用 SkinnedMesh：${segmentId}`);
      if (mesh.geometry.getAttribute('skinIndex') || mesh.geometry.getAttribute('skinWeight')) throw new Error(`BJD 分件存在跨关节 Skin Weight：${segmentId}`);
    });
  });
  const scene = new THREE.Scene(); scene.add(gltf.scene);
  const originalMaterials = new Set<Material>();
  gltf.scene.traverse((object) => {
    const mesh = object as Mesh; if (!mesh.isMesh) return;
    (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach((material) => originalMaterials.add(material));
  });
  const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0xe3ded4, roughness: 0.82, metalness: 0 });
  const jointMaterial = new THREE.MeshStandardMaterial({ color: 0xe3ded4, roughness: 0.82, metalness: 0 });
  const slotMaterial = new THREE.MeshStandardMaterial({ color: 0xe3ded4, roughness: 0.82, metalness: 0 });
  const hoverMaterial = new THREE.MeshStandardMaterial({ color: 0xf0f7ff, emissive: 0x17314d, emissiveIntensity: .2, roughness: .72, metalness: 0 });
  const activeChainMaterial = new THREE.MeshStandardMaterial({ color: 0xe6d2b1, emissive: 0x4a3218, emissiveIntensity: .16, roughness: .78, metalness: 0 });
  const outlineUniforms = [bodyMaterial, jointMaterial, slotMaterial].map((material) => {
    const strength = { value: 0 };
    material.onBeforeCompile = (shader) => {
      shader.uniforms.bjdOutlineStrength = strength;
      shader.fragmentShader = `uniform float bjdOutlineStrength;\n${shader.fragmentShader}`;
      shader.fragmentShader = shader.fragmentShader.replace('#include <dithering_fragment>', `#include <dithering_fragment>
        float bjdFacing = abs(dot(normalize(normal), normalize(vViewPosition)));
        float bjdRim = smoothstep(0.2, 0.72, 1.0 - bjdFacing) * bjdOutlineStrength;
        gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.035), bjdRim);`);
    };
    material.customProgramCacheKey = () => 'bjd-rim-outline-v1'; return strength;
  });
  const silhouetteMaterial = new THREE.MeshBasicMaterial({ color: 0x111111 });
  const boundMeshes: BoundMesh[] = [];
  const pickJointForObject = (source: Object3D) => { let target: Object3D | null = source; while (target) { const jointId = rig.pickTargets[target.name]; if (jointId) return jointId; target = target.parent; } return undefined; };
  Object.values(rig.segmentBindings).forEach((binding) => gltf.scene.getObjectByName(binding.node)?.traverse((object) => {
    const mesh = object as Mesh; if (mesh.isMesh) boundMeshes.push({ mesh, role: binding.materialRole, jointId: pickJointForObject(mesh) ?? binding.joint });
  }));
  const jointGeometryObjects = new Map<BjdJointId, Mesh>();
  Object.values(rig.segmentBindings).forEach((binding) => {
    if (binding.materialRole !== 'joint' || jointGeometryObjects.has(binding.joint)) return;
    let source: Mesh | undefined;
    gltf.scene.getObjectByName(binding.node)?.traverse((object) => {
      const mesh = object as Mesh; if (!source && mesh.isMesh) source = mesh;
    });
    if (source) { source.geometry.computeBoundingSphere(); jointGeometryObjects.set(binding.joint, source); }
  });
  (Object.values(rig.ikChains) as BjdRigV1['ikChains'][BjdIkChainId][]).forEach((chain) => {
    const source = jointGeometryObjects.get(chain.middle[0]); if (source && !jointGeometryObjects.has(chain.middle[1])) jointGeometryObjects.set(chain.middle[1], source);
  });
  const ambient = new THREE.AmbientLight(0xffffff, 0.48); const directional = new THREE.DirectionalLight(0xffffff, 2.2); directional.castShadow = true;
  scene.add(ambient, directional, directional.target);
  const groundMaterial = new THREE.MeshStandardMaterial({ color: 0x777777, roughness: 1, metalness: 0 });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), groundMaterial); ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);

  const perspective = new THREE.PerspectiveCamera(35, 0.75, 0.01, 100); const orthographic = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);
  const handCamera = new THREE.OrthographicCamera(-.13, .13, .13, -.13, 0.01, 100);
  const sideCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);
  let camera: Camera = perspective;
  const renderer: WebGLRenderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: true });
  renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.NeutralToneMapping; renderer.toneMappingExposure = 1;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap; renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const controls = new OrbitControls(perspective as Camera, canvas); controls.enableDamping = false;
  // The blank canvas is the camera. Pose controls disable OrbitControls only
  // after they have been hit, so the same left drag can stay intuitive.
  controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE; controls.mouseButtons.MIDDLE = THREE.MOUSE.PAN; controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE;

  const moveGeometry = new THREE.OctahedronGeometry(.5, 0); const jointMoveGeometry = new THREE.SphereGeometry(.5, 12, 8); const moveMaterial = new THREE.MeshBasicMaterial({ color: 0x9fc9e8, depthTest: false, transparent: true, opacity: .72 });
  const cogMaterial = new THREE.MeshBasicMaterial({ color: 0xf0aa61, depthTest: false, transparent: true, opacity: .94 });
  const selectedMoveMaterial = new THREE.MeshBasicMaterial({ color: 0xf0aa61, depthTest: false, transparent: true, opacity: .88 });
  const pinnedMoveMaterial = new THREE.MeshBasicMaterial({ color: 0x5e98c8, depthTest: false, transparent: true, opacity: .8 });
  const limitedMoveMaterial = new THREE.MeshBasicMaterial({ color: 0xd85f5f, depthTest: false, transparent: true, opacity: .82 });
  const rotateInnerGeometry = new THREE.TorusGeometry(.06, .014, 8, 24); const rotateOuterGeometry = new THREE.TorusGeometry(.09, .014, 8, 24);
  const rotateMaterial = new THREE.MeshBasicMaterial({ color: 0xb9d7ef, depthTest: false, transparent: true, opacity: .72 });
  const rotateOuterMaterial = new THREE.MeshBasicMaterial({ color: 0x6f9ed0, depthTest: false, transparent: true, opacity: .62 });
  const rotateHoverMaterial = new THREE.MeshBasicMaterial({ color: 0xd7ecff, depthTest: false, transparent: true, opacity: 1 });
  const rotateOuterHoverMaterial = new THREE.MeshBasicMaterial({ color: 0xa9d3ff, depthTest: false, transparent: true, opacity: 1 });
  const directionMaterial = new THREE.MeshBasicMaterial({ color: 0xc4c9d1, depthTest: false, transparent: true, opacity: .94 });
  const directionHoverMaterial = new THREE.MeshBasicMaterial({ color: 0xf0aa61, depthTest: false, transparent: true, opacity: 1 });
  const pickMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0 });
  const pinCanvas = window.document.createElement('canvas'); pinCanvas.width = 64; pinCanvas.height = 64; const pinContext = pinCanvas.getContext('2d');
  if (pinContext) { pinContext.fillStyle = 'rgba(24, 45, 70, .96)'; pinContext.beginPath(); pinContext.arc(32, 32, 27, 0, Math.PI * 2); pinContext.fill(); pinContext.strokeStyle = '#d7ecff'; pinContext.lineWidth = 6; pinContext.beginPath(); pinContext.arc(32, 29, 11, Math.PI, 0); pinContext.stroke(); pinContext.fillStyle = '#d7ecff'; pinContext.fillRect(18, 28, 28, 23); }
  const pinTexture = new THREE.CanvasTexture(pinCanvas); pinTexture.colorSpace = THREE.SRGBColorSpace;
  const pinMaterial = new THREE.SpriteMaterial({ map: pinTexture, depthTest: false, transparent: true });
  const moveGroup = new THREE.Group(); const rotateGroup = new THREE.Group(); const pinGroup = new THREE.Group();
  const handZoomGroup = new THREE.Group();
  const pivotDebugGroup = new THREE.Group();
  const pivotDebugGeometry = new THREE.SphereGeometry(.012, 8, 6);
  const pivotDebugOriginMaterial = new THREE.MeshBasicMaterial({ color: 0xef5350, depthTest: false, transparent: true, opacity: .96 });
  const pivotDebugPivotMaterial = new THREE.MeshBasicMaterial({ color: 0x42a5f5, depthTest: false, transparent: true, opacity: .96 });
  const pivotDebugGeometryMaterial = new THREE.MeshBasicMaterial({ color: 0x66bb6a, depthTest: false, transparent: true, opacity: .96 });
  const pivotDebugMarkers = new Map<BjdJointId, { origin: Mesh; pivot: Mesh; geometry: Mesh }>();
  pivotDebugGroup.name = 'pose-pivot-debug'; pivotDebugGroup.visible = false;
  (Object.keys(rig.jointNodes) as BjdJointId[]).forEach((jointId) => {
    const origin = new THREE.Mesh(pivotDebugGeometry, pivotDebugOriginMaterial); const pivot = new THREE.Mesh(pivotDebugGeometry, pivotDebugPivotMaterial); const geometry = new THREE.Mesh(pivotDebugGeometry, pivotDebugGeometryMaterial);
    origin.name = `pivot-debug-origin-${jointId}`; pivot.name = `pivot-debug-runtime-${jointId}`; geometry.name = `pivot-debug-geometry-${jointId}`;
    origin.scale.setScalar(1.25); geometry.scale.setScalar(.75);
    origin.renderOrder = 3000; pivot.renderOrder = 3001; geometry.renderOrder = 3002;
    [origin, pivot, geometry].forEach((marker) => pivotDebugGroup.add(marker));
    pivotDebugMarkers.set(jointId, { origin, pivot, geometry });
  });
  moveGroup.name = 'pose-move-controls'; rotateGroup.name = 'pose-rotate-controls'; pinGroup.name = 'pose-pin-controls'; handZoomGroup.name = 'pose-hand-zoom-controls'; scene.add(moveGroup, rotateGroup, pinGroup, handZoomGroup, pivotDebugGroup);
  const guideGeometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
  const guideMaterial = new THREE.LineBasicMaterial({ color: 0xf0aa61, depthTest: false, transparent: true, opacity: .72 });
  const dragGuide = new THREE.Line(guideGeometry, guideMaterial); dragGuide.name = 'pose-drag-guide'; dragGuide.visible = false; dragGuide.renderOrder = 1999; scene.add(dragGuide);
  const moveControls = new Map<PoseBranchId, ControlMesh>();
  ROOT_CONTROLS.forEach(({ branch, ikChain }) => {
    const marker = new THREE.Mesh(ikChain ? jointMoveGeometry : moveGeometry, moveMaterial) as ControlMesh; marker.name = `move-control-${branch}`; marker.userData = { controlType: 'move-target', branch, chainId: ikChain }; marker.renderOrder = 2000;
    moveGroup.add(marker); moveControls.set(branch, marker);
  });
  const cogControl = new THREE.Mesh(jointMoveGeometry, cogMaterial) as ControlMesh;
  cogControl.name = 'move-control-cog'; cogControl.userData = { controlType: 'move-target', branch: 'cog', jointId: 'pelvis' }; cogControl.renderOrder = 2006;
  moveGroup.add(cogControl);
  const limbJointControls = new Map<BjdIkChainId, { root: ControlMesh; middle: ControlMesh }>();
  (Object.keys(rig.ikChains) as BjdIkChainId[]).forEach((chainId) => {
    const branch = ROOT_CONTROLS.find((control) => control.ikChain === chainId)?.branch;
    if (!branch) return;
    const chain = rig.ikChains[chainId];
    const root = new THREE.Mesh(jointMoveGeometry, moveMaterial) as ControlMesh;
    const middle = new THREE.Mesh(jointMoveGeometry, moveMaterial) as ControlMesh;
    root.name = `limb-root-control-${chainId}`; root.userData = { controlType: 'limb-joint', branch, chainId, jointId: chain.root, handle: 'root' }; root.renderOrder = 2001;
    middle.name = `limb-middle-control-${chainId}`; middle.userData = { controlType: 'pole-control', branch, chainId, jointId: chain.middle[1], handle: 'middle' }; middle.renderOrder = 2001;
    moveGroup.add(root, middle); limbJointControls.set(chainId, { root, middle });
  });
  const directionHandleGeometry = new THREE.OctahedronGeometry(.5, 0); const directionPickGeometry = new THREE.SphereGeometry(.5, 8, 6);
  const directionControls = new Map<BjdIkChainId, { handle: ControlMesh; pick: ControlMesh; line: InstanceType<typeof THREE.Line> }>();
  (Object.keys(rig.ikChains) as BjdIkChainId[]).forEach((chainId) => {
    const branch = ROOT_CONTROLS.find((control) => control.ikChain === chainId)?.branch;
    if (!branch) return;
    const handle = new THREE.Mesh(directionHandleGeometry, directionMaterial) as ControlMesh;
    const pick = new THREE.Mesh(directionPickGeometry, pickMaterial) as ControlMesh;
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), guideMaterial);
    handle.name = `limb-direction-control-${chainId}`; handle.userData = { controlType: 'direction', branch, chainId, jointId: rig.ikChains[chainId].end }; handle.renderOrder = 2003;
    pick.name = `limb-direction-pick-${chainId}`; pick.userData = { controlType: 'direction-pick', branch, chainId, jointId: rig.ikChains[chainId].end }; pick.renderOrder = 2003;
    line.name = `limb-direction-line-${chainId}`; line.renderOrder = 2002;
    moveGroup.add(handle, pick, line); directionControls.set(chainId, { handle, pick, line });
  });
  const pinControls = new Map<BjdIkChainId, InstanceType<typeof THREE.Sprite>>();
  (Object.keys(rig.ikChains) as BjdIkChainId[]).forEach((chainId) => { const marker = new THREE.Sprite(pinMaterial); marker.name = `pin-control-${chainId}`; marker.userData = { controlType: 'pin', chainId }; marker.renderOrder = 2005; pinGroup.add(marker); pinControls.set(chainId, marker); });
  const handZoomControls = new Map<BjdJointId, ControlMesh>();
  new Set(Object.values(FINGER_JOINTS).map((joints) => joints[2])).forEach((jointId) => {
    const marker = new THREE.Mesh(jointMoveGeometry, moveMaterial) as ControlMesh;
    marker.name = `hand-tip-control-${jointId}`; marker.userData = { controlType: 'hand-tip', jointId }; marker.renderOrder = 2004;
    handZoomGroup.add(marker); handZoomControls.set(jointId, marker);
  });
  const rotateControls = new Map<BjdJointId, { inner: ControlMesh; outer: ControlMesh; innerPick: ControlMesh; outerPick: ControlMesh }>();
  (Object.keys(rig.jointNodes) as BjdJointId[]).forEach((jointId) => {
    const inner = new THREE.Mesh(rotateInnerGeometry, rotateMaterial) as ControlMesh; const outer = new THREE.Mesh(rotateOuterGeometry, rotateOuterMaterial) as ControlMesh;
    const innerPick = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), pickMaterial) as ControlMesh; const outerPick = new THREE.Mesh(new THREE.TorusGeometry(.82, .28, 6, 16), pickMaterial) as ControlMesh;
    inner.name = `rotate-inner-${jointId}`; outer.name = `rotate-outer-${jointId}`; innerPick.name = `rotate-inner-pick-${jointId}`; outerPick.name = `rotate-outer-pick-${jointId}`;
    inner.userData = { controlType: 'rotate', jointId, zone: 'inner' }; outer.userData = { controlType: 'rotate', jointId, zone: 'outer' };
    innerPick.userData = { controlType: 'rotate-pick', jointId, zone: 'inner' }; outerPick.userData = { controlType: 'rotate-pick', jointId, zone: 'outer' };
    [inner, outer, innerPick, outerPick].forEach((mesh) => { mesh.renderOrder = 2002; rotateGroup.add(mesh); });
    rotateControls.set(jointId, { inner, outer, innerPick, outerPick });
  });

  const raycaster = new THREE.Raycaster(); const pointer = new THREE.Vector2(); let document = structuredClone(initialDocument); let documentApplied = false; let editMode: PoseEditMode = 'move';
  let selectedJointId: BjdJointId | undefined; let selectedControl: PoseSelection['control']; let controlTree: PoseControlTreeState = {}; let selection: PoseSelection | undefined;
  let applyingDocument = false; let renderFrame: number | undefined; let renderingOutput = false; let previewMode = false; let disposed = false; let sideMiniVisible = false;
  let handZoomOpen = false; let constraintMessage: string | undefined; let hoveredTarget: InteractionTarget | undefined;
  const pivotDebug: { enabled: boolean; jointId: BjdJointId; axis: PosePivotDebugAxis; angle: number; baselineGeometry?: InstanceType<typeof THREE.Vector3> } = {
    enabled: false, jointId: 'spineUpper', axis: 'x', angle: 0,
  };
  const pinnedTargets = new Map<BjdIkChainId, InstanceType<typeof THREE.Vector3>>(); const unreachableChains = new Set<BjdIkChainId>();
  let interaction: {
    pointerId: number; target: InteractionTarget; start: InstanceType<typeof THREE.Vector3>; startScreen: InstanceType<typeof THREE.Vector2>; lastScreen: InstanceType<typeof THREE.Vector2>;
    plane: InstanceType<typeof THREE.Plane>; startRoot: InstanceType<typeof THREE.Vector3>; center: InstanceType<typeof THREE.Vector3>; dragStarted: boolean; zoom: boolean; depthOffset: number;
    startDocument: PoseDocumentV1; startPinnedTargets: Map<BjdIkChainId, InstanceType<typeof THREE.Vector3>>; poleDirection?: InstanceType<typeof THREE.Vector3>; endTarget?: InstanceType<typeof THREE.Vector3>;
    bendStates?: Map<BjdIkChainId, PoseBendState>; bendPlaneAngles?: Map<BjdIkChainId, number>;
    cogLegTargets?: Map<BjdIkChainId, InstanceType<typeof THREE.Vector3>>; cogPoles?: Map<BjdIkChainId, InstanceType<typeof THREE.Vector3>>;
    endOrientation?: InstanceType<typeof THREE.Quaternion>;
  } | undefined;
  const jointGeometryCenter = (jointId: BjdJointId) => {
    const mesh = jointGeometryObjects.get(jointId); const center = mesh?.geometry.boundingSphere?.center;
    return center ? center.clone().applyMatrix4(mesh!.matrixWorld) : undefined;
  };
  const pivotDebugRotation = () => {
    const curl = thumbBendBases.get(pivotDebug.jointId)?.flexAxis;
    const axis = pivotDebug.axis === 'curl' && curl ? new THREE.Vector3(curl.x, curl.y, curl.z)
      : pivotDebug.axis === 'x' ? new THREE.Vector3(1, 0, 0) : pivotDebug.axis === 'y' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
    return new THREE.Quaternion().setFromAxisAngle(axis, THREE.MathUtils.degToRad(pivotDebug.angle));
  };
  const readPivotDebugState = (): PosePivotDebugState => {
    const origin = authoredJointObjects.get(pivotDebug.jointId)?.getWorldPosition(new THREE.Vector3()) ?? new THREE.Vector3();
    const pivot = jointObjects.get(pivotDebug.jointId)?.getWorldPosition(new THREE.Vector3()) ?? new THREE.Vector3();
    const geometry = jointGeometryCenter(pivotDebug.jointId);
    return {
      enabled: pivotDebug.enabled, jointId: pivotDebug.jointId, axis: pivotDebug.axis, angle: pivotDebug.angle,
      originPivotDistance: origin.distanceTo(pivot), geometryPivotDistance: geometry?.distanceTo(pivot),
      geometryDrift: pivotDebug.baselineGeometry && geometry ? pivotDebug.baselineGeometry.distanceTo(geometry) : undefined,
      geometryAvailable: Boolean(geometry),
      geometryJointCenter: geometry ? { x: geometry.x, y: geometry.y, z: geometry.z } : undefined,
      boneOrigin: { x: origin.x, y: origin.y, z: origin.z },
      runtimePivot: { x: pivot.x, y: pivot.y, z: pivot.z },
      curlAxis: thumbBendBases.get(pivotDebug.jointId)?.flexAxis,
    };
  };
  const updatePivotDebugMarkers = () => {
    if (!pivotDebug.enabled) { pivotDebugGroup.visible = false; return; }
    gltf.scene.updateMatrixWorld(true); pivotDebugGroup.visible = true;
    pivotDebugMarkers.forEach((markers, jointId) => {
      const origin = authoredJointObjects.get(jointId)?.getWorldPosition(new THREE.Vector3()); const pivot = jointObjects.get(jointId)?.getWorldPosition(new THREE.Vector3());
      if (origin) markers.origin.position.copy(origin); if (pivot) markers.pivot.position.copy(pivot);
      const geometry = jointGeometryCenter(jointId); markers.geometry.visible = Boolean(geometry); if (geometry) markers.geometry.position.copy(geometry);
    });
  };
  const resetPivotDebugBaseline = () => {
    gltf.scene.updateMatrixWorld(true); pivotDebug.baselineGeometry = jointGeometryCenter(pivotDebug.jointId)?.clone();
  };
  const hingeChainForJoint = (jointId: BjdJointId) => (Object.values(rig.ikChains) as BjdRigV1['ikChains'][BjdIkChainId][])
    .find((chain) => chain.middle.includes(jointId));
  const semanticHingeAxis = (chain: BjdRigV1['ikChains'][BjdIkChainId]) => new THREE.Vector3(chain.flexionAxis.x, chain.flexionAxis.y, chain.flexionAxis.z).normalize();
  const semanticHingeDelta = (jointId: BjdJointId, angle: number) => {
    const chain = hingeChainForJoint(jointId); if (!chain) return new THREE.Quaternion();
    const basisValue = rig.axisBasis[jointId]; const basis = basisValue ? new THREE.Quaternion(basisValue.x, basisValue.y, basisValue.z, basisValue.w).normalize() : new THREE.Quaternion();
    return basis.clone().multiply(new THREE.Quaternion().setFromAxisAngle(semanticHingeAxis(chain), angle)).multiply(basis.clone().invert()).normalize();
  };
  const semanticHingeAngle = (jointId: BjdJointId, delta: ThreeQuaternion) => {
    const chain = hingeChainForJoint(jointId); if (!chain) return 0;
    const basisValue = rig.axisBasis[jointId]; const basis = basisValue ? new THREE.Quaternion(basisValue.x, basisValue.y, basisValue.z, basisValue.w).normalize() : new THREE.Quaternion();
    const inBasis = basis.clone().invert().multiply(delta.clone().normalize()).multiply(basis).normalize(); const axis = semanticHingeAxis(chain);
    let angle = 2 * Math.atan2(inBasis.x * axis.x + inBasis.y * axis.y + inBasis.z * axis.z, inBasis.w);
    while (angle > Math.PI) angle -= Math.PI * 2; while (angle < -Math.PI) angle += Math.PI * 2;
    return angle;
  };
  const compoundBendAngle = (source: PoseDocumentV1, chainId: BjdIkChainId) => rig.ikChains[chainId].middle
    .reduce((sum, jointId) => { const value = source.jointRotations[jointId] ?? { x: 0, y: 0, z: 0, w: 1 }; return sum + semanticHingeAngle(jointId, new THREE.Quaternion(value.x, value.y, value.z, value.w)); }, rig.ikChains[chainId].restBend);
  // The only BJD transform write boundary: rootTransform + restQuaternion * rotationDelta, then Three.js FK.
  const applyPoseState = (source: PoseDocumentV1) => {
    const jointRotations: PoseDocumentV1['jointRotations'] = {};
    jointObjects.forEach((_object, jointId) => {
      const typedJointId = jointId as BjdJointId;
      const rest = rig.restPose[typedJointId];
      const delta = source.jointRotations[typedJointId];
      if (!rest) return;
      if (pivotDebug.enabled) {
        if (typedJointId === pivotDebug.jointId) { const value = pivotDebugRotation(); jointRotations[typedJointId] = { x: value.x, y: value.y, z: value.z, w: value.w }; }
        return;
      }
      const limited = delta ? hingeChainForJoint(typedJointId)
        ? new THREE.Quaternion(delta.x, delta.y, delta.z, delta.w).normalize()
        : limitedJointDelta(typedJointId, new THREE.Quaternion(delta.x, delta.y, delta.z, delta.w)) : undefined;
      if (limited) source.jointRotations[typedJointId] = { x: limited.x, y: limited.y, z: limited.z, w: limited.w };
      if (limited) jointRotations[typedJointId] = { x: limited.x, y: limited.y, z: limited.z, w: limited.w };
    });
    applyBjdFk(rootNode, jointObjects, rig.restPose, {
      rootTransform: pivotDebug.enabled
        ? { position: { x: rootRestPosition.x, y: rootRestPosition.y, z: rootRestPosition.z }, rotation: { x: rootRestQuaternion.x, y: rootRestQuaternion.y, z: rootRestQuaternion.z, w: rootRestQuaternion.w } }
        : source.rootTransform,
      jointRotations,
    });
    updatePivotDebugMarkers();
  };
  const worldPosition = (jointId: BjdJointId) => { const result = new THREE.Vector3(); jointObjects.get(jointId)?.getWorldPosition(result); return result; };
  const fingertipPosition = (jointId: BjdJointId) => {
    const joint = jointObjects.get(jointId); const direction = fingertipDirections.get(jointId);
    return joint && direction ? new THREE.Vector3(direction.x, direction.y, direction.z).applyMatrix4(joint.matrixWorld) : worldPosition(jointId);
  };
  // These point from the authored wrist/ankle pivot toward the visible fingertips/toe,
  // so the direction handle stays discoverable even in the default front view.
  const endForwardAxis = (chainId: BjdIkChainId) => chainId.startsWith('arm')
    ? new THREE.Vector3(0, -1, 0) : new THREE.Vector3(0, -.75, -.66).normalize();
  const cogPosition = () => worldPosition('pelvis').add(new THREE.Vector3(0, .24, 0));
  const contactLegIds = () => (['legL', 'legR'] as BjdIkChainId[]).filter((chainId) => worldPosition(rig.ikChains[chainId].end).y <= ground.position.y + .17);
  const clampCogDelta = (delta: InstanceType<typeof THREE.Vector3>, targets: Map<BjdIkChainId, InstanceType<typeof THREE.Vector3>>) => {
    const magnitude = delta.lengthSq(); if (magnitude < 1e-12) return delta;
    const boundaries = [0, 1];
    targets.forEach((target, chainId) => {
      const chain = rig.ikChains[chainId]; const offset = worldPosition(chain.root).sub(target); const maxBend = chain.maxBend ?? Math.PI; const minBend = chain.minBend ?? 0;
      const radii = [
        Math.sqrt(chain.upperLength ** 2 + chain.lowerLength ** 2 + 2 * chain.upperLength * chain.lowerLength * Math.cos(maxBend)) - .001,
        Math.sqrt(chain.upperLength ** 2 + chain.lowerLength ** 2 + 2 * chain.upperLength * chain.lowerLength * Math.cos(minBend)) + .001,
      ];
      radii.forEach((radius) => {
        const b = 2 * offset.dot(delta); const c = offset.lengthSq() - radius ** 2; const discriminant = b ** 2 - 4 * magnitude * c;
        if (discriminant < 0) return;
        const root = Math.sqrt(discriminant); const first = (-b - root) / (2 * magnitude); const second = (-b + root) / (2 * magnitude);
        if (first > 0 && first < 1) boundaries.push(first);
        if (second > 0 && second < 1) boundaries.push(second);
      });
    });
    boundaries.sort((a, b) => a - b);
    const reachable = (fraction: number) => [...targets].every(([chainId, target]) => {
      const chain = rig.ikChains[chainId]; const distance = worldPosition(chain.root).addScaledVector(delta, fraction).distanceTo(target); const maxBend = chain.maxBend ?? Math.PI; const minBend = chain.minBend ?? 0;
      const min = Math.sqrt(chain.upperLength ** 2 + chain.lowerLength ** 2 + 2 * chain.upperLength * chain.lowerLength * Math.cos(maxBend)) - .001;
      const max = Math.sqrt(chain.upperLength ** 2 + chain.lowerLength ** 2 + 2 * chain.upperLength * chain.lowerLength * Math.cos(minBend)) + .001;
      return distance >= min && distance <= max;
    });
    let fraction = 0;
    for (let index = 1; index < boundaries.length; index += 1) {
      const boundary = boundaries[index]!; if (!reachable((fraction + boundary) / 2)) break; fraction = boundary;
    }
    return delta.multiplyScalar(fraction);
  };
  // The authored ankle pivot sits above the sole. Keep a temporary COG
  // contact target only when that pivot is close to the ground; raised feet
  // remain free unless the user explicitly pins them.
  const defaultPoleWorldDirection = (chainId: BjdIkChainId) => {
    const chain = rig.ikChains[chainId]; const direction = new THREE.Vector3(chain.defaultPoleDirection.x, chain.defaultPoleDirection.y, chain.defaultPoleDirection.z); const parentWorld = new THREE.Quaternion(); jointObjects.get(chain.root)?.parent?.getWorldQuaternion(parentWorld); return direction.applyQuaternion(parentWorld).normalize();
  };
  const currentPoleWorldDirection = (chainId: BjdIkChainId) => {
    const chain = rig.ikChains[chainId]; gltf.scene.updateMatrixWorld(true); const root = worldPosition(chain.root); const middle = worldPosition(chain.middle[1]); const end = worldPosition(chain.end); const axis = end.clone().sub(root); if (axis.lengthSq() < 1e-8) return defaultPoleWorldDirection(chainId); axis.normalize(); const pole = middle.clone().sub(root); pole.addScaledVector(axis, -pole.dot(axis));
    // A nearly straight leg has no reliable measured bend plane: a tiny
    // authored x/z offset can point the pole sideways and make a small ankle
    // drag fold the leg across the body. Use the rig's anatomical pole until
    // the current pose has a meaningful bend. Once the limb is clearly bent,
    // preserving its measured plane avoids an unwanted reorientation.
    const limbLength = Math.min(root.distanceTo(middle), middle.distanceTo(end));
    const bendRatio = pole.length() / Math.max(1e-8, limbLength);
    const configured = document.ikState?.[chainId]?.poleDirection;
    const bendState = document.ikState?.[chainId]?.bendState;
    const statePole = (state: NonNullable<typeof bendState>) => {
      const planeNormal = new THREE.Vector3(state.planeNormal.x, state.planeNormal.y, state.planeNormal.z);
      const fromPlane = planeNormal.clone().cross(axis);
      return fromPlane.lengthSq() > 1e-10 ? fromPlane.normalize() : undefined;
    };
    const stored = bendState ? statePole(bendState) : undefined;
    if (stored && bendRatio > .12) return stored;
    if (pole.lengthSq() <= 1e-10 || bendRatio <= .12) {
      const stable = bendState?.previousStable && bendState.previousStable.bendAngle > .12 ? statePole(bendState.previousStable) : undefined;
      if (stable) return stable;
      return defaultPoleWorldDirection(chainId);
    }
    if (configured) {
      const direction = new THREE.Vector3(configured.x, configured.y, configured.z);
      if (direction.lengthSq() > 1e-10) return direction.normalize();
    }
    if (bendState) {
      const stable = statePole(bendState); if (stable) return stable;
    }
    return pole.normalize();
  };
  const cloneBendState = (state?: PoseBendState): PoseBendState | undefined => state && {
    planeNormal: { ...state.planeNormal }, bendSide: state.bendSide, bendAngle: state.bendAngle,
    ...(state.bendPlaneAngle !== undefined ? { bendPlaneAngle: state.bendPlaneAngle } : {}),
    ...(state.previousStable ? { previousStable: cloneBendState(state.previousStable) } : {}),
  };
  const stableBendSnapshot = (state?: PoseBendState) => state && ({
    planeNormal: { ...state.planeNormal }, bendSide: state.bendSide, bendAngle: state.bendAngle,
    ...(state.bendPlaneAngle !== undefined ? { bendPlaneAngle: state.bendPlaneAngle } : {}),
  });
  const currentBendState = (chainId: BjdIkChainId, source: PoseDocumentV1 = document): PoseBendState => {
    const stored = cloneBendState(source.ikState?.[chainId]?.bendState); if (stored && stored.bendAngle > .12) return stored;
    const chain = rig.ikChains[chainId]; const root = worldPosition(chain.root); const middle = worldPosition(chain.middle[1]); const end = worldPosition(chain.end); const axis = end.clone().sub(root).normalize(); const measured = middle.clone().sub(root); measured.addScaledVector(axis, -measured.dot(axis)); const limbLength = Math.min(root.distanceTo(middle), middle.distanceTo(end)); const reference = defaultPoleWorldDirection(chainId); const direction = measured.length() / Math.max(1e-8, limbLength) > .12 ? measured.normalize() : reference.clone().addScaledVector(axis, -reference.dot(axis)).normalize(); const frame = createBendPlaneFrame({ x: axis.x, y: axis.y, z: axis.z }, { x: reference.x, y: reference.y, z: reference.z }); const angle = bendPlaneAngle(frame, { x: direction.x, y: direction.y, z: direction.z }); const upper = middle.clone().sub(root).normalize(); const lower = end.clone().sub(middle).normalize(); const bendAngle = Math.PI - Math.acos(THREE.MathUtils.clamp(-upper.dot(lower), -1, 1)); const normal = bendNormal({ x: axis.x, y: axis.y, z: axis.z }, { x: direction.x, y: direction.y, z: direction.z }); return { planeNormal: normal, bendSide: direction.dot(reference) >= 0 ? 1 : -1, bendAngle, bendPlaneAngle: angle };
  };
  const bendStateAtPlaneAngle = (chainId: BjdIkChainId, angle: number, previous?: PoseBendState): PoseBendState => {
    const chain = rig.ikChains[chainId]; const root = worldPosition(chain.root); const end = worldPosition(chain.end); const axis = end.clone().sub(root).normalize(); const reference = defaultPoleWorldDirection(chainId); const frame = createBendPlaneFrame({ x: axis.x, y: axis.y, z: axis.z }, { x: reference.x, y: reference.y, z: reference.z }); const direction = bendDirectionAtAngle(frame, angle); const normal = bendNormal({ x: axis.x, y: axis.y, z: axis.z }, direction); return { planeNormal: normal, bendSide: previous?.bendSide ?? (direction.x * frame.reference.x + direction.y * frame.reference.y + direction.z * frame.reference.z >= 0 ? 1 : -1), bendAngle: previous?.bendAngle ?? 0, bendPlaneAngle: angle, ...(previous?.previousStable ? { previousStable: cloneBendState(previous.previousStable) } : {}) };
  };
  const writeBendState = (next: PoseDocumentV1, chainId: BjdIkChainId, state: PoseBendState, fallbackPole?: InstanceType<typeof THREE.Vector3>) => {
    const pole = next.ikState?.[chainId]?.poleDirection ?? fallbackPole ?? defaultPoleWorldDirection(chainId);
    next.ikState ??= {};
    next.ikState[chainId] = { ...next.ikState[chainId], poleDirection: { x: pole.x, y: pole.y, z: pole.z }, bendState: cloneBendState(state) };
  };
  const chainForBranch = (branch = controlTree.branch) => ROOT_CONTROLS.find((control) => control.branch === branch)?.ikChain;
  const branchLocked = (branch?: PoseBranchId) => Boolean(branch && document.lockedBranches?.[branch]);
  const jointLocked = (jointId?: BjdJointId) => branchLocked(jointId ? branchForJoint(jointId) : undefined);
  const makeSelection = (jointId?: BjdJointId, branch?: PoseBranchId): PoseSelection | undefined => {
    const resolvedBranch = branch ?? (jointId ? branchForJoint(jointId) : undefined);
    if (!jointId && !resolvedBranch) return undefined;
    const locked = branchLocked(resolvedBranch);
    return createPoseSelection(jointId, resolvedBranch, locked, selectedControl);
  };
  const emitSelection = () => {
    selection = makeSelection(selectedJointId, controlTree.branch);
    events.onSelectionChange?.(selection);
    events.onBranchChange?.(controlTree.branch);
  };
  const worldPerPixel = (position: InstanceType<typeof THREE.Vector3>, frameHeight: number) => camera === orthographic ? document.camera.orthographicHeight / Math.max(1, frameHeight) : 2 * camera.position.distanceTo(position) * Math.tan(THREE.MathUtils.degToRad(perspective.fov) / 2) / Math.max(1, frameHeight);
  const setConstraint = (message?: string) => { if (constraintMessage === message) return; constraintMessage = message; events.onConstraintChange?.(message); };
  const targetChainId = (target?: InteractionTarget) => target && 'chainId' in target ? target.chainId : undefined;
  const targetBranch = (target?: InteractionTarget) => !target ? undefined : target.kind === 'move' || target.kind === 'direction' || target.kind === 'pole' ? target.branch : target.kind === 'pin' ? ROOT_CONTROLS.find((control) => control.ikChain === target.chainId)?.branch : branchForJoint(target.jointId);
  const targetJointId = (target?: InteractionTarget) => !target ? undefined : target.kind === 'rotate' || target.kind === 'hand-tip' || target.kind === 'direction' || target.kind === 'pole' ? target.jointId : target.kind === 'move' ? target.jointId ?? (target.branch === 'cog' ? 'pelvis' : ROOT_CONTROLS.find((control) => control.branch === target.branch)?.joint) : target.kind === 'pin' ? rig.ikChains[target.chainId].end : undefined;
  const targetLocked = (target?: InteractionTarget) => branchLocked(targetBranch(target));
  const targetDescriptionKey = (target?: InteractionTarget) => !target ? '' : target.kind === 'move' ? `move:${target.branch}:${target.handle ?? 'end'}:${target.jointId ?? ''}` : target.kind === 'direction' || target.kind === 'pole' ? `${target.kind}:${target.chainId}` : target.kind === 'rotate' ? `rotate:${target.jointId}:${target.zone}` : target.kind === 'hand-tip' ? `tip:${target.jointId}` : `${target.kind}:${target.chainId}`;
  const chainForJoint = (jointId?: BjdJointId) => jointId && (Object.entries(rig.ikChains) as Array<[BjdIkChainId, BjdRigV1['ikChains'][BjdIkChainId]]>)
    .find(([, chain]) => chain.root === jointId || chain.middle.includes(jointId) || chain.end === jointId)?.[0];
  const selectedChainId = () => selection?.branch ? chainForBranch(selection.branch) : chainForJoint(selectedJointId);
  const chainContainsJoint = (chainId: BjdIkChainId | undefined, jointId?: BjdJointId) => Boolean(chainId && jointId && [rig.ikChains[chainId].root, ...rig.ikChains[chainId].middle, rig.ikChains[chainId].end].includes(jointId));
  const isCoreBranch = (branch: PoseBranchId) => branch === 'head' || branch === 'cog' || branch.startsWith('hand') || branch.startsWith('foot');
  const branchInContext = (branch: PoseBranchId) => isCoreBranch(branch) || branch === controlTree.branch || branch === selection?.branch || branch === targetBranch(hoveredTarget) || branch === targetBranch(interaction?.target);
  const refreshHoverAppearance = () => {
    const hoveredJointId = targetJointId(hoveredTarget); const activeChainId = selectedChainId(); boundMeshes.forEach(({ mesh, role, jointId }) => { const regular = document.appearance.mode === 'silhouette' ? silhouetteMaterial : role === 'body' ? bodyMaterial : role === 'joint' ? jointMaterial : slotMaterial; mesh.material = hoveredJointId && jointId === hoveredJointId ? hoverMaterial : chainContainsJoint(activeChainId, jointId) ? activeChainMaterial : regular; });
    rotateControls.forEach(({ inner, outer }, jointId) => { const hoveredZone = hoveredTarget?.kind === 'rotate' && hoveredTarget.jointId === jointId ? hoveredTarget.zone : undefined; inner.material = hoveredZone === 'inner' ? rotateHoverMaterial : rotateMaterial; outer.material = hoveredZone === 'outer' ? rotateOuterHoverMaterial : rotateOuterMaterial; });
    limbJointControls.forEach(({ root, middle }, chainId) => {
      const rootHovered = hoveredTarget?.kind === 'move' && hoveredTarget.chainId === chainId && hoveredTarget.handle === 'root';
      const middleHovered = hoveredTarget?.kind === 'pole' && hoveredTarget.chainId === chainId;
      root.material = rootHovered ? selectedMoveMaterial : moveMaterial; middle.material = middleHovered ? selectedMoveMaterial : moveMaterial;
    });
    directionControls.forEach(({ handle }, chainId) => { handle.material = hoveredTarget?.kind === 'direction' && hoveredTarget.chainId === chainId ? directionHoverMaterial : directionMaterial; });
  };
  const setHoveredTarget = (target?: InteractionTarget) => { const previous = targetDescriptionKey(hoveredTarget); const next = targetDescriptionKey(target); hoveredTarget = target; if (previous !== next) { updateControlVisibility(); refreshHoverAppearance(); requestRender(); } events.onHoverChange?.(targetDescription(target)); };
  const updateHandZoomState = (open: boolean) => { if (handZoomOpen === open) return; handZoomOpen = open; events.onHandZoomChange?.(open); requestRender(); };
  const mainRotateJointIds = () => {
    const ids = new Set<BjdJointId>();
    const branch = controlTree.branch;
    if (!branch || branch === 'cog') return ids;
    if (selectedJointId && (isFingerJoint(selectedJointId) || isHingeJoint(selectedJointId))) return ids;
    const selected = selectedJointId ?? (branch === 'head' ? 'head' : branch === 'chest' ? 'spineUpper' : branch === 'waist' ? 'spineLower' : branch === 'pelvis' ? 'pelvis'
      : branch.startsWith('hand') ? `wrist${branch.endsWith('L') ? 'L' : 'R'}` as BjdJointId
        : `ankle${branch.endsWith('L') ? 'L' : 'R'}` as BjdJointId);
    if (selected && !/^(wrist|ankle)/.test(selected)) ids.add(selected);
    return ids;
  };
  const setRotateVisibility = (ids: Set<BjdJointId>) => rotateControls.forEach((value, jointId) => {
    const enabled = editMode === 'rotate' || Boolean(selectedJointId) || interaction?.target.kind === 'rotate';
    const visible = editable && !previewMode && !pivotDebug.enabled && enabled && ids.has(jointId) && !jointLocked(jointId);
    const outerVisible = visible && (editMode === 'rotate' || hoveredTarget?.kind === 'rotate' || interaction?.target.kind === 'rotate');
    value.inner.visible = visible; value.innerPick.visible = visible; value.outer.visible = outerVisible; value.outerPick.visible = outerVisible;
  });
  const updateControlVisibility = () => {
    moveControls.forEach((marker, branch) => { marker.visible = editable && !previewMode && !pivotDebug.enabled && editMode === 'move' && !branchLocked(branch) && branchInContext(branch); const chainId = chainForBranch(branch); marker.material = chainId && unreachableChains.has(chainId) ? limitedMoveMaterial : branch === controlTree.branch ? selectedMoveMaterial : chainId && document.ikState?.[chainId]?.pinned ? pinnedMoveMaterial : moveMaterial; });
    cogControl.visible = editable && !previewMode && !pivotDebug.enabled && editMode === 'move' && !branchLocked('cog');
    cogControl.material = controlTree.branch === 'cog' ? selectedMoveMaterial : cogMaterial;
    limbJointControls.forEach(({ root, middle }, chainId) => {
      const branch = ROOT_CONTROLS.find((control) => control.ikChain === chainId)?.branch;
      const hoverChain = targetChainId(hoveredTarget) === chainId && (hoveredTarget?.kind === 'pole' || hoveredTarget?.kind === 'direction');
      const activeChain = targetChainId(interaction?.target) === chainId && (interaction?.target.kind === 'pole' || interaction?.target.kind === 'direction');
      const chainInContext = Boolean(branch && (branch === controlTree.branch || branch === selection?.branch || hoverChain || activeChain));
      const visible = Boolean(branch && editable && !previewMode && !pivotDebug.enabled && editMode === 'move' && !branchLocked(branch) && chainInContext);
      root.visible = false; middle.visible = visible;
      root.material = hoveredTarget?.kind === 'move' && hoveredTarget.chainId === chainId && hoveredTarget.handle === 'root' ? selectedMoveMaterial : moveMaterial;
      const middleSelected = branch === controlTree.branch && selectedJointId === rig.ikChains[chainId].middle[1];
      middle.material = hoveredTarget?.kind === 'pole' && hoveredTarget.chainId === chainId || middleSelected ? selectedMoveMaterial : moveMaterial;
    });
    directionControls.forEach(({ handle, pick, line }, chainId) => {
      const branch = ROOT_CONTROLS.find((control) => control.ikChain === chainId)?.branch; const selected = Boolean(branch && branch === controlTree.branch && selectedJointId === rig.ikChains[chainId].end);
      const visible = editable && !previewMode && !pivotDebug.enabled && editMode === 'move' && selected && !branchLocked(branch);
      handle.visible = visible; pick.visible = visible; line.visible = visible; handle.material = hoveredTarget?.kind === 'direction' && hoveredTarget.chainId === chainId ? directionHoverMaterial : directionMaterial;
    });
    // A selected point owns one lightweight ring. There is no global rig gizmo.
    setRotateVisibility(mainRotateJointIds());
    // Legacy pinned targets remain loadable, but are no longer an editing entry point.
    pinControls.forEach((marker) => { marker.visible = false; });
    handZoomControls.forEach((marker) => { marker.visible = false; });
  };
  const updateControlPositions = (frameHeight: number) => {
    gltf.scene.updateMatrixWorld(true);
    updatePivotDebugMarkers();
    ROOT_CONTROLS.forEach(({ branch, joint, ikChain }) => {
      const marker = moveControls.get(branch); if (!marker) return; const position = ikChain ? pinnedTargets.get(ikChain) ?? worldPosition(rig.ikChains[ikChain].end) : worldPosition(joint); marker.position.copy(position); const hovered = targetBranch(hoveredTarget) === branch; const pixels = ikChain ? branch === controlTree.branch ? 13 : 10 : branch === controlTree.branch ? 13 : 10; marker.scale.setScalar(worldPerPixel(position, frameHeight) * (pixels + (hovered ? 3 : 0)));
    });
    const cog = cogPosition(); cogControl.position.copy(cog); cogControl.scale.setScalar(worldPerPixel(cog, frameHeight) * (controlTree.branch === 'cog' ? 18 : targetBranch(hoveredTarget) === 'cog' ? 19 : 16));
    limbJointControls.forEach(({ root, middle }, chainId) => {
      const chain = rig.ikChains[chainId]; const rootPosition = worldPosition(chain.root); const middlePosition = worldPosition(chain.middle[1]);
      root.position.copy(rootPosition); middle.position.copy(middlePosition);
      const branch = ROOT_CONTROLS.find((control) => control.ikChain === chainId)?.branch; const boost = targetBranch(hoveredTarget) === branch ? 3 : 0;
      root.scale.setScalar(worldPerPixel(rootPosition, frameHeight) * (10 + boost)); middle.scale.setScalar(worldPerPixel(middlePosition, frameHeight) * (10 + boost));
    });
    const facing = new THREE.Vector3(0, 0, 1).applyQuaternion(camera.quaternion).normalize();
    const facingQuaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), facing);
    directionControls.forEach(({ handle, pick, line }, chainId) => {
      const end = worldPosition(rig.ikChains[chainId].end); const pixel = worldPerPixel(end, frameHeight); const orientation = jointObjects.get(rig.ikChains[chainId].end)?.getWorldQuaternion(new THREE.Quaternion()) ?? new THREE.Quaternion();
      const target = end.clone().add(basisAxis(rig.ikChains[chainId].end, endForwardAxis(chainId)).applyQuaternion(orientation).normalize().multiplyScalar(pixel * 68));
      handle.position.copy(target); pick.position.copy(target); handle.quaternion.copy(facingQuaternion); pick.quaternion.copy(facingQuaternion);
      handle.scale.setScalar(Math.max(.001, pixel * 15)); pick.scale.setScalar(Math.max(.001, pixel * 30));
      const positions = line.geometry.getAttribute('position'); positions.setXYZ(0, end.x, end.y, end.z); positions.setXYZ(1, target.x, target.y, target.z); positions.needsUpdate = true; line.geometry.computeBoundingSphere();
    });
    pinControls.forEach((marker, chainId) => { const target = pinnedTargets.get(chainId) ?? worldPosition(rig.ikChains[chainId].end); const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion); const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion); const pixel = worldPerPixel(target, frameHeight); marker.position.copy(target).addScaledVector(right, pixel * 22).addScaledVector(up, pixel * 22); marker.scale.setScalar(pixel * 25); });
    rotateControls.forEach((value, jointId) => {
      const position = worldPosition(jointId); [value.inner, value.outer, value.innerPick, value.outerPick].forEach((mesh) => mesh.position.copy(position));
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), facing); [value.inner, value.outer, value.innerPick, value.outerPick].forEach((mesh) => mesh.quaternion.copy(q));
      value.inner.scale.setScalar(Math.max(.001, worldPerPixel(position, frameHeight) * 9 / .074)); value.outer.scale.setScalar(Math.max(.001, worldPerPixel(position, frameHeight) * 13 / .104));
      value.innerPick.scale.setScalar(Math.max(.001, worldPerPixel(position, frameHeight) * 18)); value.outerPick.scale.setScalar(Math.max(.001, worldPerPixel(position, frameHeight) * 30));
    });
    handZoomControls.forEach((marker, jointId) => { marker.position.copy(worldPosition(jointId)); marker.scale.setScalar(.018); });
  };
  const updateHandTipControlPositions = () => { handZoomControls.forEach((marker, jointId) => marker.position.copy(fingertipPosition(jointId))); };
  const updateProjection = (aspect: number) => {
    perspective.aspect = aspect; perspective.filmOffset = document.camera.lensShift.x * 12; perspective.clearViewOffset();
    const verticalShift = document.camera.lensShift.y + document.camera.horizon;
    if (Math.abs(verticalShift) > 1e-6) { const fullHeight = 1000; const fullWidth = Math.max(1, Math.round(fullHeight * aspect)); perspective.setViewOffset(fullWidth, fullHeight, 0, Math.round(-verticalShift * fullHeight * .25), fullWidth, fullHeight); }
    perspective.updateProjectionMatrix(); const heightView = Math.max(.001, document.camera.orthographicHeight); const shiftX = document.camera.lensShift.x * heightView * .25; const shiftY = (document.camera.lensShift.y + document.camera.horizon) * heightView * .25;
    orthographic.left = -heightView * aspect / 2 + shiftX; orthographic.right = heightView * aspect / 2 + shiftX; orthographic.top = heightView / 2 + shiftY; orthographic.bottom = -heightView / 2 + shiftY; orthographic.updateProjectionMatrix();
  };
  const updateHandCamera = () => {
    const branch = controlTree.branch; if (!branch?.startsWith('hand')) return; const side = branch.endsWith('L') ? 'L' : 'R'; const wrist = worldPosition(`wrist${side}` as BjdJointId); const index = worldPosition(`indexProximal${side}` as BjdJointId); const middle = worldPosition(`middleProximal${side}` as BjdJointId); const little = worldPosition(`littleProximal${side}` as BjdJointId); const palmBase = index.clone().add(middle).add(little).multiplyScalar(1 / 3); const up = palmBase.clone().sub(wrist).normalize(); const center = wrist.clone().addScaledVector(up, wrist.distanceTo(palmBase) * 1.5); const across = (side === 'L' ? little.clone().sub(index) : index.clone().sub(little)).normalize(); const normal = new THREE.Vector3().crossVectors(up, across).normalize(); if (normal.dot(camera.position.clone().sub(center)) < 0) normal.negate();
    handCamera.left = -.13; handCamera.right = .13; handCamera.top = .13; handCamera.bottom = -.13;
    handCamera.position.copy(center).addScaledVector(normal, .8); handCamera.up.copy(up); handCamera.lookAt(center); handCamera.updateProjectionMatrix();
  };
  const getHandZoomRect = () => {
    const width = Math.max(1, canvas.clientWidth); const height = Math.max(1, canvas.clientHeight); const size = Math.max(240, Math.min(320, Math.round(Math.min(width * .39, height * .48))));
    return { x: width - size - 18, y: 18, size };
  };
  const getSideMiniRect = () => {
    const width = Math.max(1, canvas.clientWidth); const height = Math.max(1, canvas.clientHeight); const size = Math.max(150, Math.min(220, Math.round(Math.min(width * .28, height * .3))));
    return { x: 18, y: 18, size };
  };
  const updateSideCamera = () => {
    const bounds = visibleBodyBounds(); if (bounds.isEmpty()) return;
    const center = bounds.getCenter(new THREE.Vector3()); const size = bounds.getSize(new THREE.Vector3()); const height = Math.max(.4, size.y * 1.28);
    sideCamera.left = -height * .5; sideCamera.right = height * .5; sideCamera.top = height * .5; sideCamera.bottom = -height * .5;
    sideCamera.position.set(center.x - Math.max(1.6, size.length() * .9), center.y, center.z); sideCamera.up.set(0, 1, 0); sideCamera.lookAt(center); sideCamera.updateProjectionMatrix();
  };
  const renderPreview = () => {
    const fullWidth = Math.max(1, canvas.clientWidth); const fullHeight = Math.max(1, canvas.clientHeight); const width = fullWidth; const height = fullHeight;
    updateProjection(width / height); updateControlPositions(height); setRotateVisibility(mainRotateJointIds()); const clearColor = renderer.getClearColor(new THREE.Color()).clone(); const clearAlpha = renderer.getClearAlpha(); renderer.setScissorTest(false); renderer.setViewport(0, 0, fullWidth, fullHeight); renderer.setClearColor(0x000000, 0); renderer.clear(true, true, true); renderer.setClearColor(clearColor, clearAlpha);
    handZoomGroup.visible = false; renderer.render(scene, camera);
    const limbDrag = interaction && (interaction.target.kind === 'move' || interaction.target.kind === 'direction' || interaction.target.kind === 'pole') && interaction.target.chainId;
    const nextSideMiniVisible = Boolean(!previewMode && limbDrag);
    if (nextSideMiniVisible !== sideMiniVisible) { sideMiniVisible = nextSideMiniVisible; events.onSideMiniViewChange?.(sideMiniVisible); }
    if (!previewMode && limbDrag) {
      const { x: miniX, y: miniY, size: miniSize } = getSideMiniRect(); const miniViewportY = fullHeight - miniY - miniSize; updateSideCamera();
      const moveVisible = moveGroup.visible; const rotateVisible = rotateGroup.visible; const pinVisible = pinGroup.visible; const handVisible = handZoomGroup.visible; const guideVisible = dragGuide.visible;
      moveGroup.visible = false; rotateGroup.visible = false; pinGroup.visible = false; handZoomGroup.visible = false; dragGuide.visible = false;
      renderer.setClearColor(0x1c1e22, 1); renderer.setViewport(miniX, miniViewportY, miniSize, miniSize); renderer.setScissor(miniX, miniViewportY, miniSize, miniSize); renderer.setScissorTest(true); renderer.clear(true, true, true); renderer.render(scene, sideCamera);
      moveGroup.visible = moveVisible; rotateGroup.visible = rotateVisible; pinGroup.visible = pinVisible; handZoomGroup.visible = handVisible; dragGuide.visible = guideVisible;
    }
    renderer.setClearColor(clearColor, clearAlpha);
    if (!pivotDebug.enabled && !previewMode && handZoomOpen && controlTree.branch?.startsWith('hand')) { const { x: zoomX, y: zoomY, size: zoom } = getHandZoomRect(); const zoomViewportY = fullHeight - zoomY - zoom; const side = controlTree.branch.endsWith('L') ? 'L' : 'R'; const moveVisible = moveGroup.visible; const pinVisible = pinGroup.visible; const rotateVisible = rotateGroup.visible; const tipVisibility = new Map([...handZoomControls].map(([jointId, marker]) => [jointId, marker.visible])); updateHandCamera(); updateHandTipControlPositions(); moveGroup.visible = false; pinGroup.visible = false; rotateGroup.visible = false; handZoomGroup.visible = true; handZoomControls.forEach((marker, jointId) => { marker.visible = jointId.endsWith(side); }); renderer.setClearColor(0x1c1e22, 1); renderer.setViewport(zoomX, zoomViewportY, zoom, zoom); renderer.setScissor(zoomX, zoomViewportY, zoom, zoom); renderer.setScissorTest(true); renderer.clear(true, true, true); renderer.render(scene, handCamera); moveGroup.visible = moveVisible; pinGroup.visible = pinVisible; rotateGroup.visible = rotateVisible; handZoomGroup.visible = false; tipVisibility.forEach((visible, jointId) => { const marker = handZoomControls.get(jointId); if (marker) marker.visible = visible; }); renderer.setClearColor(clearColor, clearAlpha); }
    renderer.setScissorTest(false);
  };
  const requestRender = () => { if (disposed || renderingOutput || renderFrame !== undefined) return; renderFrame = requestAnimationFrame(() => { renderFrame = undefined; if (!disposed) renderPreview(); }); };
  const setSize = (width: number, height: number) => { renderer.setSize(Math.max(1, width), Math.max(1, height), false); updateProjection(Math.max(1, width) / Math.max(1, height)); };
  const resizeObserver = new ResizeObserver(() => { setSize(canvas.clientWidth, canvas.clientHeight); requestRender(); }); resizeObserver.observe(canvas);

  const softLimit = (value: number, min: number, max: number) => {
    const hard = THREE.MathUtils.clamp(value, min, max); const width = max - min; const softWidth = Math.min(.24, width * .22);
    if (softWidth <= 1e-6 || hard === min || hard === max) return hard;
    if (hard < min + softWidth) { const t = THREE.MathUtils.clamp((hard - min) / softWidth, 0, 1); return min + softWidth * t * t * (3 - 2 * t); }
    if (hard > max - softWidth) { const t = THREE.MathUtils.clamp((max - hard) / softWidth, 0, 1); return max - softWidth * t * t * (3 - 2 * t); }
    return hard;
  };
  const usesSwingTwist = (jointId: BjdJointId) => /^(shoulder|hip|wrist|ankle|neck|head)/.test(jointId);
  const clampSwingTwist = (inBasis: InstanceType<typeof THREE.Quaternion>, limits: NonNullable<BjdRigV1['jointLimits'][BjdJointId]>, soft: boolean) => {
    const value = inBasis.clone().normalize(); if (value.w < 0) value.set(-value.x, -value.y, -value.z, -value.w);
    const twistAxis = new THREE.Vector3(0, 1, 0);
    const projected = twistAxis.clone().multiplyScalar(value.x * twistAxis.x + value.y * twistAxis.y + value.z * twistAxis.z);
    const twist = new THREE.Quaternion(projected.x, projected.y, projected.z, value.w).normalize();
    let twistAngle = 2 * Math.atan2(twist.x * twistAxis.x + twist.y * twistAxis.y + twist.z * twistAxis.z, twist.w);
    while (twistAngle > Math.PI) twistAngle -= Math.PI * 2; while (twistAngle < -Math.PI) twistAngle += Math.PI * 2;
    const twistClamped = soft ? softLimit(twistAngle, limits.min.y, limits.max.y) : THREE.MathUtils.clamp(twistAngle, limits.min.y, limits.max.y);
    const swing = value.clone().multiply(twist.clone().invert()).normalize();
    const swingAngle = 2 * Math.acos(THREE.MathUtils.clamp(swing.w, -1, 1));
    const cone = THREE.MathUtils.clamp(Math.max(Math.abs(limits.min.x), Math.abs(limits.max.x), Math.abs(limits.min.z), Math.abs(limits.max.z)), 0, Math.PI);
    const targetSwing = soft ? softLimit(swingAngle, 0, cone) : THREE.MathUtils.clamp(swingAngle, 0, cone);
    const swingAxis = new THREE.Vector3(swing.x, swing.y, swing.z);
    const swingClamped = swingAxis.lengthSq() > 1e-10
      ? new THREE.Quaternion().setFromAxisAngle(swingAxis.normalize(), targetSwing)
      : new THREE.Quaternion();
    return swingClamped.multiply(new THREE.Quaternion().setFromAxisAngle(twistAxis, twistClamped)).normalize();
  };
  const clampedJointDelta = (jointId: BjdJointId, desiredLocal: ThreeQuaternion, soft = false) => {
    const rest = rig.restPose[jointId]; const basisValue = rig.axisBasis[jointId]; if (!rest || !basisValue) return desiredLocal.clone(); const restQuaternion = new THREE.Quaternion(rest.x, rest.y, rest.z, rest.w); const delta = restQuaternion.clone().invert().multiply(desiredLocal.clone()).normalize(); const basis = new THREE.Quaternion(basisValue.x, basisValue.y, basisValue.z, basisValue.w).normalize(); const basisInverse = basis.clone().invert(); const inBasis = basisInverse.clone().multiply(delta).multiply(basis); const euler = new THREE.Euler().setFromQuaternion(inBasis, 'XYZ'); const limits = rig.jointLimits[jointId];
    if (limits && usesSwingTwist(jointId)) return basis.clone().multiply(clampSwingTwist(inBasis, limits, soft)).multiply(basisInverse).normalize();
    if (limits) { const clampAngle = (value: number, min: number, max: number) => soft ? softLimit(value, min, max) : THREE.MathUtils.clamp(value, min, max); euler.x = clampAngle(euler.x, limits.min.x, limits.max.x); euler.y = clampAngle(euler.y, limits.min.y, limits.max.y); euler.z = clampAngle(euler.z, limits.min.z, limits.max.z); }
    return basis.clone().multiply(new THREE.Quaternion().setFromEuler(euler)).multiply(basisInverse).normalize();
  };
  const limitedJointDelta = (jointId: BjdJointId, delta: ThreeQuaternion) => {
    if (jointId.startsWith('thumb')) return delta.clone().normalize();
    const rest = rig.restPose[jointId];
    if (!rest) return delta.clone().normalize();
    const restQuaternion = new THREE.Quaternion(rest.x, rest.y, rest.z, rest.w);
    return clampedJointDelta(jointId, restQuaternion.multiply(delta.clone()).normalize());
  };
  const applyJointWorldQuaternion = (next: PoseDocumentV1, jointId: BjdJointId, desiredWorld: ThreeQuaternion) => {
    const object = jointObjects.get(jointId); if (!object) return; const parentWorld = new THREE.Quaternion(); object.parent?.getWorldQuaternion(parentWorld); const desiredLocal = parentWorld.invert().multiply(desiredWorld.clone()).normalize(); const rest = rig.restPose[jointId] ?? { x: 0, y: 0, z: 0, w: 1 }; const delta = hingeChainForJoint(jointId) ? new THREE.Quaternion(rest.x, rest.y, rest.z, rest.w).invert().multiply(desiredLocal).normalize() : clampedJointDelta(jointId, desiredLocal, true); next.jointRotations[jointId] = { x: delta.x, y: delta.y, z: delta.z, w: delta.w }; applyPoseState(next);
  };
  const setJointDelta = (next: PoseDocumentV1, jointId: BjdJointId, desired: ThreeQuaternion) => {
    const rest = rig.restPose[jointId] ?? { x: 0, y: 0, z: 0, w: 1 }; const limited = hingeChainForJoint(jointId) ? desired.clone().normalize() : clampedJointDelta(jointId, new THREE.Quaternion(rest.x, rest.y, rest.z, rest.w).multiply(desired).normalize(), true);
    next.jointRotations[jointId] = { x: limited.x, y: limited.y, z: limited.z, w: limited.w };
  };
  const applyJointDelta = (next: PoseDocumentV1, jointId: BjdJointId, delta: ThreeQuaternion) => { setJointDelta(next, jointId, delta); applyPoseState(next); };
  const setSemanticBend = (next: PoseDocumentV1, chainId: BjdIkChainId, angle: number) => {
    const chain = rigAdapter.semanticIkChain(chainId); const constrained = THREE.MathUtils.clamp(angle, chain.minBend ?? 0, chain.maxBend ?? Math.PI);
    Object.assign(next.jointRotations, rigAdapter.rotationDeltasFor({ joint: chain.middle, bendAngle: constrained }, (jointId, value) => {
      const delta = semanticHingeDelta(jointId, value); return { x: delta.x, y: delta.y, z: delta.z, w: delta.w };
    }));
  };
  const writeSemanticRotation = (next: PoseDocumentV1, joint: SemanticJointId, rotation: InstanceType<typeof THREE.Quaternion>) => {
    Object.assign(next.jointRotations, rigAdapter.rotationDeltasFor({ joint, rotationDelta: { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w } }, () => ({ x: 0, y: 0, z: 0, w: 1 })));
  };
  const writeFingerRotation = (next: PoseDocumentV1, jointId: BjdJointId, desired: InstanceType<typeof THREE.Quaternion>) => {
    if (jointId.startsWith('thumb')) { writeSemanticRotation(next, jointId as SemanticJointId, desired.clone().normalize()); return; }
    const semantic = jointId as SemanticJointId; const authored = rigAdapter.authoredJoint(semantic); const rest = rig.restPose[authored] ?? { x: 0, y: 0, z: 0, w: 1 };
    const limited = clampedJointDelta(authored, new THREE.Quaternion(rest.x, rest.y, rest.z, rest.w).multiply(desired).normalize(), true);
    writeSemanticRotation(next, semantic, limited);
  };
  const fingerAxis = (jointId: BjdJointId, axis: InstanceType<typeof THREE.Vector3>) => {
    const value = rig.axisBasis[jointId]; return value ? axis.applyQuaternion(new THREE.Quaternion(value.x, value.y, value.z, value.w)).normalize() : axis;
  };
  const fingerFlexAxis = (jointId: BjdJointId) => fingerAxis(jointId, new THREE.Vector3(0, 0, 1));
  const fingerSpreadAxis = (jointId: BjdJointId) => fingerAxis(jointId, new THREE.Vector3(1, 0, 0));
  const fingerCurlAngles = () => [1.15, 1.35, .95];
  const fingerCurlRotation = (jointId: BjdJointId, angle: number, curl: number) => new THREE.Quaternion().setFromAxisAngle(fingerFlexAxis(jointId), angle * curl);
  const applyThumbCurvePosition = (next: PoseDocumentV1, side: 'L' | 'R', position: number) => {
    const last = rig.thumbPoseCurve.length - 1; const value = THREE.MathUtils.clamp(position, 0, last); const segment = Math.min(Math.floor(value), last - 1); const amount = value - segment;
    const first = rig.thumbPoseCurve[segment]![side === 'L' ? 'left' : 'right']; const second = rig.thumbPoseCurve[segment + 1]![side === 'L' ? 'left' : 'right'];
    FINGER_JOINTS[`thumb${side}`].forEach((jointId) => {
      const a = first[jointId]!; const b = second[jointId]!;
      writeFingerRotation(next, jointId, new THREE.Quaternion(a.x, a.y, a.z, a.w).normalize().slerp(new THREE.Quaternion(b.x, b.y, b.z, b.w).normalize(), amount));
    });
  };
  const applyToePose = (next: PoseDocumentV1, side: 'L' | 'R', curl: number, spread: number, bigToe: number) => {
    const sign = side === 'L' ? 1 : -1; const curlAngle = -THREE.MathUtils.clamp(curl, -1, 1) * .7; const spreadAngle = THREE.MathUtils.clamp(spread, -1, 1) * .18 * sign;
    const bigToeOffset = -THREE.MathUtils.clamp(bigToe, -1, 1) * .35;
    writeSemanticRotation(next, `toe${side}` as SemanticJointId, new THREE.Quaternion().setFromEuler(new THREE.Euler(curlAngle + bigToeOffset * .22, 0, spreadAngle, 'XYZ')));
    writeSemanticRotation(next, `bigToe${side}` as SemanticJointId, new THREE.Quaternion().setFromEuler(new THREE.Euler(curlAngle * .7 + bigToeOffset, 0, -spreadAngle * .75, 'XYZ')));
  };
  const solveFingerPosition = (next: PoseDocumentV1, distal: BjdJointId, target: InstanceType<typeof THREE.Vector3>) => {
    const finger = Object.values(FINGER_JOINTS).find((joints) => joints[2] === distal);
    if (!finger) return Number.POSITIVE_INFINITY;
    const base = worldPosition(finger[0]); const middle = worldPosition(finger[1]); const distalPivot = worldPosition(finger[2]); const tip = fingertipPosition(distal);
    const maxReach = Math.max(.001, base.distanceTo(middle) + middle.distanceTo(distalPivot) + distalPivot.distanceTo(tip)); const reach = base.distanceTo(target);
    const fingerId = FINGER_IDS.find((id) => distal.startsWith(id))!;
    if (fingerId === 'thumb') return Number.POSITIVE_INFINITY;
    const applyFingerPose = (curl: number, spread: number) => {
      finger.forEach((jointId, index) => {
        const flex = fingerCurlRotation(jointId, fingerCurlAngles()[index], THREE.MathUtils.clamp(curl, 0, 1));
        const lateral = index === 0 ? new THREE.Quaternion().setFromAxisAngle(fingerSpreadAxis(jointId), THREE.MathUtils.clamp(spread, -.4, .4)) : new THREE.Quaternion();
        writeFingerRotation(next, jointId, flex.multiply(lateral));
      });
      applyPoseState(next);
    };
    const curl = fingerCurlFromReach(reach, maxReach);
    let spread = 0; const score = (value: number) => { applyFingerPose(curl, value); return fingertipPosition(distal).distanceToSquared(target); }; let bestScore = score(spread);
    for (const step of [.2, .1, .05, .025]) {
      for (const direction of [-1, 1]) {
        const candidate = THREE.MathUtils.clamp(spread + step * direction, -.4, .4); const candidateScore = score(candidate);
        if (candidateScore < bestScore) { spread = candidate; bestScore = candidateScore; }
      }
    }
    applyFingerPose(curl, spread);
    return Math.sqrt(bestScore);
  };
  const solveThumbPosition = (next: PoseDocumentV1, distal: BjdJointId, target: InstanceType<typeof THREE.Vector3>) => {
    const side = distal.endsWith('L') ? 'L' : 'R'; const points = rig.thumbPoseCurve.map((_, index) => {
      applyThumbCurvePosition(next, side, index); applyPoseState(next); const point = fingertipPosition(distal); return { x: point.x, y: point.y, z: point.z };
    });
    const projection = projectThumbPoseCurve({ x: target.x, y: target.y, z: target.z }, points);
    applyThumbCurvePosition(next, side, projection.segment + projection.amount); applyPoseState(next);
    return fingertipPosition(distal).distanceTo(target);
  };
  // Three.js' setFromUnitVectors() has no deterministic rotation axis when
  // the two vectors are opposite. An IK target can reach that case, so a tiny
  // pointer movement could otherwise choose the other bend solution and
  // mirror the whole limb. Keep the bend plane as the continuation axis.
  const rotationBetweenStable = (
    from: InstanceType<typeof THREE.Vector3>,
    to: InstanceType<typeof THREE.Vector3>,
    preferredAxis?: InstanceType<typeof THREE.Vector3>,
  ) => {
    const source = from.clone().normalize();
    const target = to.clone().normalize();
    const dot = THREE.MathUtils.clamp(source.dot(target), -1, 1);
    // Keep a little margin around the antiparallel case. Near 180° the cross
    // product used by setFromUnitVectors becomes numerically tiny, so its
    // fallback axis can change between adjacent pointer events.
    if (dot > -0.95) return new THREE.Quaternion().setFromUnitVectors(source, target);

    let axis = preferredAxis?.clone();
    if (!axis || axis.lengthSq() < 1e-8) axis = Math.abs(source.y) < .9
      ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    axis.addScaledVector(source, -axis.dot(source));
    if (axis.lengthSq() < 1e-8) {
      axis = Math.abs(source.x) < .9
        ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
      axis.addScaledVector(source, -axis.dot(source));
    }
    return new THREE.Quaternion().setFromAxisAngle(axis.normalize(), Math.acos(dot));
  };
  const applyTwoBoneTarget = (
    next: PoseDocumentV1,
    chainId: BjdIkChainId,
    target: InstanceType<typeof THREE.Vector3>,
    poleOverride?: InstanceType<typeof THREE.Vector3>,
    bendOverride?: PoseBendState,
  ) => {
    const chain = rigAdapter.semanticIkChain(chainId); const rootJoint = rigAdapter.authoredJoint(chain.root); const middleJoint = rigAdapter.authoredJoint(chain.middle); const endJoint = rigAdapter.authoredJoint(chain.end);
    const root = worldPosition(rootJoint); const previousBend = next.ikState?.[chainId]?.bendState ?? bendOverride;
    const stableNormal = previousBend ? new THREE.Vector3(previousBend.planeNormal.x, previousBend.planeNormal.y, previousBend.planeNormal.z) : undefined;
    const pole = poleOverride ?? next.ikState?.[chainId]?.poleDirection ?? defaultPoleWorldDirection(chainId);
    const solution = solveTwoBoneIk({
      root, target, poleDirection: pole,
      bendNormal: stableNormal && stableNormal.lengthSq() > 1e-8 ? { x: stableNormal.x, y: stableNormal.y, z: stableNormal.z } : undefined,
      upperLength: chain.upperLength, lowerLength: chain.lowerLength, minBend: chain.minBend, maxBend: chain.maxBend,
    });
    next.ikState ??= {};
    const desiredMiddle = new THREE.Vector3(solution.middle.x, solution.middle.y, solution.middle.z); const bendDirection = desiredMiddle.clone().sub(root).normalize();
    const bendAxis = new THREE.Vector3(solution.clampedTarget.x, solution.clampedTarget.y, solution.clampedTarget.z).sub(root).normalize(); const reference = defaultPoleWorldDirection(chainId);
    const frame = createBendPlaneFrame({ x: bendAxis.x, y: bendAxis.y, z: bendAxis.z }, { x: reference.x, y: reference.y, z: reference.z });
    const wrappedPlaneAngle = bendPlaneAngle(frame, { x: bendDirection.x, y: bendDirection.y, z: bendDirection.z });
    const planeAngle = previousBend?.bendPlaneAngle === undefined ? wrappedPlaneAngle : unwrapBendPlaneAngle(previousBend.bendPlaneAngle, wrappedPlaneAngle);
    const planeNormal = new THREE.Vector3(solution.bendNormal.x, solution.bendNormal.y, solution.bendNormal.z).normalize();
    const bendSide = previousBend?.bendSide ?? (bendDirection.dot(frame.reference) >= 0 ? 1 : -1) as -1 | 1;
    const stablePrevious = previousBend && previousBend.bendAngle > 0.02 ? stableBendSnapshot(previousBend) : previousBend?.previousStable;
    next.ikState[chainId] = { ...next.ikState[chainId], poleDirection: { x: bendDirection.x, y: bendDirection.y, z: bendDirection.z }, bendState: {
      planeNormal: { x: planeNormal.x, y: planeNormal.y, z: planeNormal.z }, bendSide, bendAngle: solution.middleBend, bendPlaneAngle: planeAngle,
      ...(stablePrevious ? { previousStable: stablePrevious } : {}),
    } };
    setSemanticBend(next, chainId, solution.middleBend); applyPoseState(next);
    const adjustedRoot = worldPosition(rootJoint); const adjustedMiddle = worldPosition(middleJoint); const adjustedEnd = worldPosition(endJoint); const adjustedUpper = adjustedMiddle.clone().sub(adjustedRoot); const adjustedLower = adjustedEnd.clone().sub(adjustedMiddle); const adjustedDesiredUpper = desiredMiddle.clone().sub(adjustedRoot);
    if (adjustedUpper.lengthSq() > 1e-8 && adjustedDesiredUpper.lengthSq() > 1e-8) {
      const currentNormal = adjustedUpper.clone().cross(adjustedLower).normalize(); const correction = currentNormal.lengthSq() > 1e-8
        ? rotationBetweenBendFrames(adjustedUpper, currentNormal, adjustedDesiredUpper, planeNormal.clone().negate())
        : rotationBetweenStable(adjustedUpper, adjustedDesiredUpper, planeNormal); const rootObject = jointObjects.get(rootJoint); const rootWorld = new THREE.Quaternion(); rootObject?.getWorldQuaternion(rootWorld);
      if (rootObject) applyJointWorldQuaternion(next, rootJoint, correction.multiply(rootWorld));
    }
    const targetOrientation = next.ikState?.[chainId]?.targetOrientation;
    if (targetOrientation) {
      applyJointWorldQuaternion(next, endJoint, new THREE.Quaternion(
        targetOrientation.x, targetOrientation.y, targetOrientation.z, targetOrientation.w,
      ).normalize());
      gltf.scene.updateMatrixWorld(true);
    }
    gltf.scene.updateMatrixWorld(true);
    const currentRoot = worldPosition(rootJoint); const end = worldPosition(endJoint); const maxReach = chain.upperLength + chain.lowerLength; const limitDeadband = Math.min(chain.upperLength, chain.lowerLength) * .02;
    return (solution.clamped && target.distanceTo(currentRoot) > maxReach + limitDeadband) || end.distanceTo(target) >= .003;
  };
  const applyPinnedTargets = (next: PoseDocumentV1) => {
    let worst = 0; for (let iteration = 0; iteration < 8; iteration += 1) { worst = 0; IK_ORDER.forEach((chainId) => { const branch = ROOT_CONTROLS.find((control) => control.ikChain === chainId)?.branch; if (branchLocked(branch) || !next.ikState?.[chainId]?.pinned) return; const target = pinnedTargets.get(chainId); if (!target) return; if (applyTwoBoneTarget(next, chainId, target)) worst = Math.max(worst, 1); }); gltf.scene.updateMatrixWorld(true); IK_ORDER.forEach((chainId) => { const branch = ROOT_CONTROLS.find((control) => control.ikChain === chainId)?.branch; if (branchLocked(branch) || !next.ikState?.[chainId]?.pinned) return; const target = pinnedTargets.get(chainId); if (target) worst = Math.max(worst, worldPosition(rig.ikChains[chainId].end).distanceTo(target)); }); if (worst < .001) break; }
    gltf.scene.updateMatrixWorld(true); IK_ORDER.forEach((chainId) => { const branch = ROOT_CONTROLS.find((control) => control.ikChain === chainId)?.branch; const target = pinnedTargets.get(chainId); if (!branchLocked(branch) && next.ikState?.[chainId]?.pinned && target && worldPosition(rig.ikChains[chainId].end).distanceTo(target) >= .001) unreachableChains.add(chainId); else unreachableChains.delete(chainId); });
    return worst;
  };
  const applyDocumentMutation = (next: PoseDocumentV1, constraint?: string) => { applyPoseState(next); document = next; documentApplied = true; updateControlVisibility(); refreshHoverAppearance(); events.onDocumentChange?.(next); setConstraint(constraint); requestRender(); };
  const updateSelection = (jointId?: BjdJointId, branchOverride?: PoseBranchId, control?: PoseSelection['control']) => {
    selectedJointId = jointId; selectedControl = control; controlTree = jointId || branchOverride ? { branch: branchOverride ?? branchForJoint(jointId!), detail: jointId ? detailForJoint(jointId) : undefined } : {};
    // Keep the five-tip detail view open while selecting and dragging a tip.
    if (!controlTree.branch?.startsWith('hand')) updateHandZoomState(false);
    emitSelection();
    events.onDetailChange?.(FINGER_IDS.includes(controlTree.detail as PoseFingerId) ? controlTree.detail as PoseFingerId : undefined);
    updateControlVisibility(); refreshHoverAppearance(); requestRender();
  };
  const toggleSelectedLock = () => {
    const branch = selection?.branch ?? controlTree.branch;
    if (!branch || !editable) return;
    events.onInteractionStart?.();
    const next = structuredClone(document);
    next.lockedBranches = { ...next.lockedBranches, [branch]: !branchLocked(branch) };
    if (!next.lockedBranches[branch]) delete next.lockedBranches[branch];
    if (Object.keys(next.lockedBranches).length === 0) next.lockedBranches = undefined;
    setDocument(next); if (next.lockedBranches?.[branch]) updateHandZoomState(false); events.onDocumentChange?.(next); emitSelection(); events.onInteractionEnd?.();
  };
  const setPinnedState = (next: PoseDocumentV1, chainId: BjdIkChainId, locked: boolean) => {
    next.ikState ??= {};
    if (!locked) {
      if (next.ikState[chainId]) next.ikState[chainId] = { ...next.ikState[chainId]!, pinned: false };
      pinnedTargets.delete(chainId); unreachableChains.delete(chainId); return;
    }
    const chain = rig.ikChains[chainId]; const end = worldPosition(chain.end); const pole = currentPoleWorldDirection(chainId);
    const endOrientation = jointObjects.get(chain.end)?.getWorldQuaternion(new THREE.Quaternion());
    pinnedTargets.set(chainId, end.clone());
    next.ikState[chainId] = { ...next.ikState[chainId], poleDirection: next.ikState[chainId]?.poleDirection ?? { x: pole.x, y: pole.y, z: pole.z }, targetOrientation: next.ikState[chainId]?.targetOrientation ?? (endOrientation ? { x: endOrientation.x, y: endOrientation.y, z: endOrientation.z, w: endOrientation.w } : undefined), pinned: true };
  };
  const setFootLocks = (sides: Array<'L' | 'R'>, locked: boolean) => {
    if (!editable) return; events.onInteractionStart?.(); const next = structuredClone(document);
    sides.forEach((side) => setPinnedState(next, `leg${side}` as BjdIkChainId, locked));
    setDocument(next); events.onDocumentChange?.(next); events.onInteractionEnd?.();
  };
  const setFootLock = (side: 'L' | 'R', locked: boolean) => setFootLocks([side], locked);
  const setBothFootLocks = (locked: boolean) => setFootLocks(['L', 'R'], locked);
  const togglePinnedState = (chainId: BjdIkChainId) => {
    if (!editable) return;
    if (chainId.startsWith('leg')) setFootLock(chainId.endsWith('L') ? 'L' : 'R', !Boolean(document.ikState?.[chainId]?.pinned));
    else { events.onInteractionStart?.(); const next = structuredClone(document); setPinnedState(next, chainId, !Boolean(document.ikState?.[chainId]?.pinned)); setDocument(next); events.onDocumentChange?.(next); events.onInteractionEnd?.(); }
  };
  const mirrorPose = () => {
    if (!editable || Object.values(document.ikState ?? {}).some((value) => value?.pinned) || Object.values(document.lockedBranches ?? {}).some(Boolean)) return;
    events.onInteractionStart?.(); let next = flipPoseLimbs(document, 'arm'); next = flipPoseLimbs(next, 'leg');
    next.rootTransform.position.x = -next.rootTransform.position.x; next.rootTransform.rotation = mirrorPoseQuaternion(next.rootTransform.rotation);
    (['pelvis', 'spineLower', 'spineUpper', 'neck', 'head'] as const).forEach((jointId) => {
      const value = next.jointRotations[jointId]; if (value) next.jointRotations[jointId] = mirrorPoseQuaternion(value);
    });
    setDocument(next); events.onDocumentChange?.(next); events.onInteractionEnd?.();
  };
  const poleLabel = (chainId: BjdIkChainId) => chainId.startsWith('arm')
    ? `${chainId.endsWith('L') ? '左' : '右'}肘`
    : `${chainId.endsWith('L') ? '左' : '右'}膝`;
  const targetDescription = (target?: InteractionTarget) => !target ? undefined : target.kind === 'move' ? `${BRANCH_LABELS[target.branch]} · 拖动调整` : target.kind === 'pole' ? `${poleLabel(target.chainId)} · 调整弯曲方向` : target.kind === 'direction' ? `${target.chainId.startsWith('arm') ? '手掌方向' : '脚尖方向'} · 拖动朝向，Alt 拖动 Roll` : target.kind === 'hand-tip' ? target.jointId.startsWith('thumb') ? `${jointLabel(target.jointId)} · 拖动调整拇指` : `${jointLabel(target.jointId)} · 靠近掌心弯曲，左右拖张合` : target.kind === 'pin' ? `${target.chainId.startsWith('arm') ? '手掌' : '脚掌'} · ${document.ikState?.[target.chainId]?.pinned ? '取消固定' : '固定'}` : `${jointLabel(target.jointId)} · ${isHingeJoint(target.jointId) ? '屈伸' : target.zone === 'inner' ? '摆动' : '扭转'}`;
  const getFrame = () => { const bounds = canvas.getBoundingClientRect(); return { bounds, frame: { x: 0, y: 0, width: bounds.width, height: bounds.height } }; };
  const setPointerFromEvent = (event: PointerEvent, bounds: DOMRect, frame: { x: number; y: number; width: number; height: number }) => { const x = event.clientX - bounds.left; const y = event.clientY - bounds.top; pointer.set((x - frame.x) / Math.max(1, frame.width) * 2 - 1, -(y - frame.y) / Math.max(1, frame.height) * 2 + 1); raycaster.setFromCamera(pointer, camera); return new THREE.Vector2(x, y); };
  const setPointerFromHandZoom = (event: PointerEvent, bounds: DOMRect) => { const rect = getHandZoomRect(); const x = event.clientX - bounds.left - rect.x; const y = event.clientY - bounds.top - rect.y; pointer.set(x / Math.max(1, rect.size) * 2 - 1, -(y / Math.max(1, rect.size)) * 2 + 1); raycaster.setFromCamera(pointer, handCamera); return new THREE.Vector2(x + rect.x, y + rect.y); };
  const pointerInHandZoom = (event: PointerEvent, bounds: DOMRect) => { if (!handZoomOpen || !controlTree.branch?.startsWith('hand')) return false; const rect = getHandZoomRect(); const x = event.clientX - bounds.left; const y = event.clientY - bounds.top; return x >= rect.x && x <= rect.x + rect.size && y >= rect.y && y <= rect.y + rect.size; };
  const projectedControlPosition = (position: InstanceType<typeof THREE.Vector3>, inHandZoom: boolean) => {
    const projected = position.clone().project(inHandZoom ? handCamera : camera); if (inHandZoom) { const rect = getHandZoomRect(); return new THREE.Vector2(rect.x + (projected.x + 1) * rect.size / 2, rect.y + (1 - projected.y) * rect.size / 2); }
    return new THREE.Vector2((projected.x + 1) * canvas.clientWidth / 2, (1 - projected.y) * canvas.clientHeight / 2);
  };
  const updateDragGuide = (target: InteractionTarget, point: InstanceType<typeof THREE.Vector3>) => {
    let origin: InstanceType<typeof THREE.Vector3> | undefined;
    if (target.kind === 'direction') origin = worldPosition(target.jointId);
    else if ((target.kind === 'move' || target.kind === 'pole') && target.chainId) origin = worldPosition(rig.ikChains[target.chainId].root);
    else if (target.kind === 'move' || target.kind === 'hand-tip') origin = interaction?.center.clone();
    if (!origin) { dragGuide.visible = false; return; }
    const positions = guideGeometry.getAttribute('position'); positions.setXYZ(0, origin.x, origin.y, origin.z); positions.setXYZ(1, point.x, point.y, point.z); positions.needsUpdate = true; guideGeometry.computeBoundingSphere(); dragGuide.visible = true;
  };
  const nearestTarget = <T extends InteractionTarget>(screen: InstanceType<typeof THREE.Vector2>, candidates: Array<{ center: InstanceType<typeof THREE.Vector3>; radius: number; target: T }>) => candidates.map((candidate) => ({ ...candidate, distance: screen.distanceTo(projectedControlPosition(candidate.center, false)) })).filter((candidate) => candidate.distance <= candidate.radius).sort((a, b) => a.distance - b.distance)[0]?.target;
  const findRotationTarget = (screen: InstanceType<typeof THREE.Vector2>, inHandZoom = false): RotateTarget | undefined => {
    if (inHandZoom) return undefined;
    const ids = mainRotateJointIds();
    const candidates = [...ids].map((jointId) => {
      const center = worldPosition(jointId); const distance = screen.distanceTo(projectedControlPosition(center, inHandZoom));
      return { distance, target: { kind: 'rotate', jointId, zone: distance <= 22 ? 'inner' : 'outer' } as RotateTarget };
    });
    // The center remains a move handle; the ring begins just outside it.
    return candidates.filter((candidate) => {
      const controls = rotateControls.get(candidate.target.jointId); const visible = candidate.target.zone === 'inner' ? controls?.inner.visible : controls?.outer.visible;
      return Boolean(visible) && candidate.distance >= 8 && candidate.distance <= 36;
    })
      .sort((a, b) => a.distance - b.distance)[0]?.target;
  };
  const findControlTarget = (screen: InstanceType<typeof THREE.Vector2>, inHandZoom = false): InteractionTarget | undefined => {
    const rotationTarget = findRotationTarget(screen, inHandZoom);
    if (inHandZoom) {
      const side = controlTree.branch?.endsWith('L') ? 'L' : 'R';
      return [...handZoomControls.entries()]
        .filter(([jointId]) => jointId.endsWith(side))
        .map(([jointId, marker]) => ({ jointId, distance: screen.distanceTo(projectedControlPosition(marker.position, true)) }))
        .filter((candidate) => candidate.distance <= 28)
        .sort((left, right) => left.distance - right.distance)
        .map(({ jointId }) => ({ kind: 'hand-tip', jointId } as HandTipTarget))[0];
    }
    if (editMode === 'move') {
      const pins = [...pinControls.entries()].filter(([, marker]) => marker.visible).map(([chainId, marker]) => ({ center: marker.position, radius: 22, target: { kind: 'pin', chainId } as PinTarget })); const pin = nearestTarget(screen, pins); if (pin) return pin;
      const candidates: Array<{ center: InstanceType<typeof THREE.Vector3>; radius: number; target: MoveTarget | DirectionTarget | PoleTarget }> = [];
      directionControls.forEach(({ handle }, chainId) => {
        const branch = ROOT_CONTROLS.find((control) => control.ikChain === chainId)?.branch; if (!branch || !handle.visible) return;
        candidates.push({ center: handle.position, radius: 28, target: { kind: 'direction', branch, chainId, jointId: rig.ikChains[chainId].end } });
      });
      moveControls.forEach((marker, branch) => { if (marker.visible) { const chainId = chainForBranch(branch); candidates.push({ center: marker.position, radius: 28, target: { kind: 'move', branch, chainId, jointId: chainId ? rig.ikChains[chainId].end : branch === 'cog' ? 'pelvis' : undefined, handle: chainId ? 'end' : undefined } }); } });
      if (cogControl.visible) candidates.push({ center: cogControl.position, radius: 28, target: { kind: 'move', branch: 'cog', jointId: 'pelvis' } });
      limbJointControls.forEach(({ middle }, chainId) => {
        const branch = ROOT_CONTROLS.find((control) => control.ikChain === chainId)?.branch; if (!branch || !middle.visible) return;
        const chain = rig.ikChains[chainId];
        candidates.push({ center: middle.position, radius: 28, target: { kind: 'pole', branch, chainId, jointId: chain.middle[1] } });
      });
      const screenHit = nearestTarget(screen, candidates); if (screenHit) return screenHit;
      if (rotationTarget) return rotationTarget;
      const objects = [...moveControls.values(), cogControl, ...[...limbJointControls.values()].map(({ middle }) => middle), ...[...directionControls.values()].flatMap(({ handle, pick }) => [handle, pick])];
      const hit = raycaster.intersectObjects(objects.filter((value) => value.visible), false)[0]?.object as ControlMesh | undefined;
      if (hit?.userData.controlType === 'pole-control' && hit.userData.branch && hit.userData.chainId && hit.userData.jointId) return { kind: 'pole', branch: hit.userData.branch, chainId: hit.userData.chainId, jointId: hit.userData.jointId };
      if ((hit?.userData.controlType === 'direction' || hit?.userData.controlType === 'direction-pick') && hit.userData.branch && hit.userData.chainId && hit.userData.jointId) return { kind: 'direction', branch: hit.userData.branch, chainId: hit.userData.chainId, jointId: hit.userData.jointId };
      if (hit?.userData.controlType === 'move-target' && hit.userData.branch) { const chainId = chainForBranch(hit.userData.branch); return { kind: 'move', branch: hit.userData.branch, chainId, jointId: chainId ? rig.ikChains[chainId].end : hit.userData.branch === 'cog' ? 'pelvis' : undefined, handle: chainId ? 'end' : undefined }; }
      return undefined;
    }
    return rotationTarget;
  };
  const targetFromBody = (forceRotate = false): InteractionTarget | undefined => {
    const hit = raycaster.intersectObjects(boundMeshes.map((entry) => entry.mesh), true)[0]?.object; let target: Object3D | null = hit ?? null; let jointId: BjdJointId | undefined;
    while (target && !jointId) { jointId = rig.pickTargets[target.name]; target = target.parent; } if (!jointId) return undefined;
    const branch = branchForJoint(jointId); if (branchLocked(branch)) return undefined;
    if (isFingerJoint(jointId)) return undefined;
    const chain = Object.entries(rig.ikChains).find(([, value]) => value.root === jointId || value.middle.includes(jointId) || value.end === jointId) as [BjdIkChainId, BjdRigV1['ikChains'][BjdIkChainId]] | undefined;
    if (chain) {
      if (forceRotate) return { kind: 'rotate', jointId: chain[1].middle.includes(jointId) ? chain[1].root : jointId, zone: 'inner' };
      if (chain[1].middle.includes(jointId)) return { kind: 'pole', branch, chainId: chain[0], jointId: chain[1].middle[1] };
      if (chain[1].root === jointId && jointId.startsWith('shoulder')) {
        return editMode === 'rotate'
          ? { kind: 'rotate', jointId, zone: 'inner' }
          : { kind: 'move', branch, chainId: chain[0], jointId, handle: 'root' };
      }
      return { kind: 'move', branch, chainId: chain[0], jointId: chain[1].end, handle: 'end' };
    }
    if (branch === 'pelvis' || branch === 'waist' || branch === 'chest' || branch === 'head') return forceRotate
      ? { kind: 'rotate', jointId, zone: 'inner' }
      : { kind: 'move', branch, jointId };
    return undefined;
  };
  const targetAtPointer = (event: PointerEvent) => { const { bounds, frame } = getFrame(); if (pointerInHandZoom(event, bounds)) { const screen = setPointerFromHandZoom(event, bounds); return findControlTarget(screen, true); } const x = event.clientX - bounds.left; const y = event.clientY - bounds.top; if (x < frame.x || x > frame.x + frame.width || y < frame.y || y > frame.y + frame.height) return undefined; const screen = setPointerFromEvent(event, bounds, frame); return findControlTarget(screen) ?? targetFromBody(); };
  const finishPointerInteraction = (pointerId?: number) => { const active = interaction; if (!active || (pointerId !== undefined && active.pointerId !== pointerId)) return; interaction = undefined; dragGuide.visible = false; unreachableChains.clear(); controls.enabled = true; if (canvas.hasPointerCapture?.(active.pointerId)) canvas.releasePointerCapture?.(active.pointerId); events.onInteractionEnd?.(); setConstraint(undefined); updateControlVisibility(); requestRender(); };
  const cancelPointerInteraction = () => {
    const active = interaction; if (!active) return;
    interaction = undefined; dragGuide.visible = false; unreachableChains.clear(); controls.enabled = true;
    if (canvas.hasPointerCapture?.(active.pointerId)) canvas.releasePointerCapture?.(active.pointerId);
    const restored = structuredClone(active.startDocument); applyPoseState(restored); pinnedTargets.clear(); active.startPinnedTargets.forEach((target, chainId) => pinnedTargets.set(chainId, target.clone())); document = restored; documentApplied = true;
    updateControlVisibility(); events.onDocumentChange?.(restored); events.onInteractionEnd?.(); setConstraint(undefined); requestRender();
  };
  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || !editable || renderingOutput || pivotDebug.enabled) return; if (interaction && interaction.pointerId !== event.pointerId) finishPointerInteraction(); if (interaction) return; const { bounds, frame } = getFrame(); const zoom = pointerInHandZoom(event, bounds); const localX = event.clientX - bounds.left; const localY = event.clientY - bounds.top; if (!zoom && (localX < frame.x || localX > frame.x + frame.width || localY < frame.y || localY > frame.y + frame.height)) { updateSelection(); return; }
    if (zoom) { event.preventDefault(); event.stopPropagation(); }
    const screen = zoom ? setPointerFromHandZoom(event, bounds) : setPointerFromEvent(event, bounds, frame); const controlTarget = findControlTarget(screen, zoom); const target = controlTarget ?? (event.altKey && !zoom ? targetFromBody(true) : zoom ? undefined : targetFromBody()); if (!target || targetLocked(target)) { if (!zoom) updateSelection(); return; }
    setConstraint(undefined);
    if (target.kind === 'pin') { togglePinnedState(target.chainId); setHoveredTarget(target); event.preventDefault(); return; }
    event.stopPropagation(); if (target.kind !== 'hand-tip') updateSelection(targetJointId(target), targetBranch(target), target.kind === 'direction' ? 'direction' : target.kind === 'move' ? 'position' : undefined);
    gltf.scene.updateMatrixWorld(true);
    const chain = (target.kind === 'move' || target.kind === 'direction' || target.kind === 'pole') && target.chainId ? rig.ikChains[target.chainId] : undefined;
    const isRootHandle = target.kind === 'move' && target.chainId && (target.handle === 'root' || target.jointId === chain?.root);
    const isMiddleHandle = target.kind === 'move' && target.chainId && (target.handle === 'middle' || Boolean(target.jointId && chain?.middle.includes(target.jointId)));
    const center = target.kind === 'move'
      ? target.branch === 'cog' ? cogPosition()
        : target.chainId ? isRootHandle ? worldPosition(chain!.root) : isMiddleHandle ? worldPosition(chain!.middle[1]) : pinnedTargets.get(target.chainId) ?? worldPosition(chain!.end)
          : worldPosition(ROOT_CONTROLS.find((control) => control.branch === target.branch)!.joint)
      : target.kind === 'direction' ? directionControls.get(target.chainId)?.handle.position.clone() ?? worldPosition(target.jointId)
        : target.kind === 'pole' ? worldPosition(target.jointId) : fingertipPosition(target.jointId);
    const interactionCamera = zoom ? handCamera : camera; const normal = new THREE.Vector3(); interactionCamera.getWorldDirection(normal); const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, center); const start = raycaster.ray.intersectPlane(plane, new THREE.Vector3()) ?? center.clone();
    const poleDirection = (target.kind === 'move' || target.kind === 'direction' || target.kind === 'pole') && target.chainId ? currentPoleWorldDirection(target.chainId) : undefined;
    const endTarget = (target.kind === 'pole' || (target.kind === 'move' && target.chainId && !isRootHandle && !isMiddleHandle)) && target.chainId
      ? pinnedTargets.get(target.chainId)?.clone() ?? worldPosition(chain!.end) : undefined;
    const cogLegTargets = target.kind === 'move' && target.branch === 'cog'
      ? new Map(contactLegIds().map((chainId) => [chainId, worldPosition(rig.ikChains[chainId].end)] as const)) : undefined;
    const cogPoles = target.kind === 'move' && target.branch === 'cog'
      ? new Map(contactLegIds().map((chainId) => [chainId, currentPoleWorldDirection(chainId)] as const)) : undefined;
    const bendChainIds = target.kind === 'move' && target.branch === 'cog'
      ? contactLegIds()
      : (target.kind === 'move' || target.kind === 'direction' || target.kind === 'pole') && target.chainId ? [target.chainId] : [];
    const bendStates = new Map(bendChainIds.map((chainId) => [chainId, currentBendState(chainId)] as const));
    const bendPlaneAngles = new Map([...bendStates].map(([chainId, state]) => [chainId, state.bendPlaneAngle ?? 0] as const));
    const savedEndOrientation = (target.kind === 'move' || target.kind === 'direction') && target.chainId ? document.ikState?.[target.chainId]?.targetOrientation : undefined;
    const endOrientation = (target.kind === 'direction' || target.kind === 'move' && target.chainId && !isRootHandle && !isMiddleHandle) && target.chainId
      ? savedEndOrientation ? new THREE.Quaternion(savedEndOrientation.x, savedEndOrientation.y, savedEndOrientation.z, savedEndOrientation.w)
        : jointObjects.get(rig.ikChains[target.chainId].end)?.getWorldQuaternion(new THREE.Quaternion()) : undefined;
    interaction = { pointerId: event.pointerId, target, start, startScreen: screen.clone(), lastScreen: screen, plane, startRoot: rootNode.position.clone(), center, dragStarted: false, zoom, depthOffset: 0, startDocument: structuredClone(document), startPinnedTargets: new Map([...pinnedTargets].map(([id, value]) => [id, value.clone()])), poleDirection, endTarget, bendStates, bendPlaneAngles, cogLegTargets, cogPoles, endOrientation }; updateDragGuide(target, center); canvas.setPointerCapture?.(event.pointerId); controls.enabled = false; events.onInteractionStart?.(); setHoveredTarget(target); event.preventDefault();
  };
  const intersectInteractionPlane = () => { if (!interaction) return undefined; return raycaster.ray.intersectPlane(interaction.plane, new THREE.Vector3()) ?? undefined; };
  const basisAxis = (jointId: BjdJointId, axis: InstanceType<typeof THREE.Vector3>) => { const basisValue = rig.axisBasis[jointId]; return basisValue ? axis.clone().applyQuaternion(new THREE.Quaternion(basisValue.x, basisValue.y, basisValue.z, basisValue.w).normalize()).normalize() : axis.clone().normalize(); };
  const hingeAxis = (jointId: BjdJointId) => {
    for (const chain of Object.values(rig.ikChains)) if (chain.middle.includes(jointId)) return basisAxis(jointId, new THREE.Vector3(chain.flexionAxis.x, chain.flexionAxis.y, chain.flexionAxis.z));
    if (!isHingeJoint(jointId)) return undefined; const limits = rig.jointLimits[jointId]; if (!limits) return undefined; const ranges = [limits.max.x - limits.min.x, limits.max.y - limits.min.y, limits.max.z - limits.min.z]; const dominant = ranges.indexOf(Math.max(...ranges)); const axis = dominant === 0 ? new THREE.Vector3(1, 0, 0) : dominant === 1 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1); return basisAxis(jointId, axis);
  };
  const currentJointDelta = (source: PoseDocumentV1, jointId: BjdJointId) => { const value = source.jointRotations[jointId]; return value ? new THREE.Quaternion(value.x, value.y, value.z, value.w).normalize() : new THREE.Quaternion(); };
  const applyHingeStep = (next: PoseDocumentV1, jointId: BjdJointId, angle: number) => {
    const chainId = rigAdapter.semanticChainForCompoundJoint(jointId);
    if (chainId) { setSemanticBend(next, chainId, compoundBendAngle(next, chainId) + angle); applyPoseState(next); return; }
    const hinge = hingeAxis(jointId); if (!hinge) return;
    applyJointDelta(next, jointId, currentJointDelta(next, jointId).multiply(new THREE.Quaternion().setFromAxisAngle(hinge, angle)).normalize());
  };
  const syncIkTargetOrientation = (next: PoseDocumentV1, jointId: BjdJointId) => {
    const entry = (Object.entries(rig.ikChains) as Array<[BjdIkChainId, BjdRigV1['ikChains'][BjdIkChainId]]>)
      .find(([, chain]) => chain.end === jointId);
    if (!entry || !next.ikState?.[entry[0]]) return;
    gltf.scene.updateMatrixWorld(true); const orientation = jointObjects.get(jointId)?.getWorldQuaternion(new THREE.Quaternion()); if (!orientation) return;
    next.ikState[entry[0]] = { ...next.ikState[entry[0]]!, targetOrientation: { x: orientation.x, y: orientation.y, z: orientation.z, w: orientation.w } };
  };
  const applyEndWorldOrientation = (next: PoseDocumentV1, chainId: BjdIkChainId, desiredWorld: InstanceType<typeof THREE.Quaternion>) => {
    const jointId = rig.ikChains[chainId].end;
    const parentWorld = new THREE.Quaternion(); jointObjects.get(jointId)?.parent?.getWorldQuaternion(parentWorld);
    const desiredLocal = parentWorld.invert().multiply(desiredWorld.clone()).normalize();
    const delta = clampedJointDelta(jointId, desiredLocal, true);
    Object.assign(next.jointRotations, rigAdapter.rotationDeltasFor({ joint: rigAdapter.semanticIkChain(chainId).end, rotationDelta: {
      x: delta.x, y: delta.y, z: delta.z, w: delta.w,
    } }, () => ({ x: 0, y: 0, z: 0, w: 1 })));
    applyPoseState(next); next.ikState ??= {}; const pole = next.ikState[chainId]?.poleDirection ?? currentPoleWorldDirection(chainId);
    const applied = jointObjects.get(jointId)?.getWorldQuaternion(new THREE.Quaternion()) ?? desiredWorld;
    next.ikState[chainId] = { ...next.ikState[chainId], poleDirection: { x: pole.x, y: pole.y, z: pole.z }, targetOrientation: { x: applied.x, y: applied.y, z: applied.z, w: applied.w } };
    if (chainId.startsWith('leg')) {
      const side = chainId.endsWith('L') ? 'L' : 'R'; const forward = basisAxis(jointId, endForwardAxis(chainId)).applyQuaternion(applied).normalize(); const heelLift = THREE.MathUtils.clamp((-forward.y - .75) / .2, 0, 1);
      if (heelLift > .05) {
        for (const semantic of [`toe${side}`, `bigToe${side}`] as SemanticJointId[]) {
          const authored = rigAdapter.authoredJoint(semantic); const euler = new THREE.Euler().setFromQuaternion(currentJointDelta(next, authored), 'XYZ'); euler.x = Math.max(euler.x, heelLift * .55); writeSemanticRotation(next, semantic, new THREE.Quaternion().setFromEuler(euler));
        }
        applyPoseState(next);
      }
    }
  };
  const applyRotationInteraction = (next: PoseDocumentV1, state: NonNullable<typeof interaction>, screen: InstanceType<typeof THREE.Vector2>) => {
    if (state.target.kind !== 'rotate') return; const jointId = state.target.jointId; const jointObject = jointObjects.get(jointId); if (!jointObject) return; const dx = screen.x - state.lastScreen.x; const dy = screen.y - state.lastScreen.y; const hinge = hingeAxis(jointId);
    if (hinge) { applyHingeStep(next, jointId, (dx - dy) * .012); return; }
    const currentWorld = new THREE.Quaternion(); jointObject.getWorldQuaternion(currentWorld); let rotation: InstanceType<typeof THREE.Quaternion>;
    if (state.target.zone === 'outer') { const twistWorld = basisAxis(jointId, new THREE.Vector3(0, 1, 0)).applyQuaternion(currentWorld).normalize(); rotation = new THREE.Quaternion().setFromAxisAngle(twistWorld, (dx - dy) * .012); }
    else { const interactionCamera = state.zoom ? handCamera : camera; const right = new THREE.Vector3(1, 0, 0).applyQuaternion(interactionCamera.quaternion); const up = new THREE.Vector3(0, 1, 0).applyQuaternion(interactionCamera.quaternion); const axis = up.multiplyScalar(dx).add(right.multiplyScalar(dy)); const angle = axis.length() * .012; if (angle < 1e-8) return; axis.normalize(); rotation = new THREE.Quaternion().setFromAxisAngle(axis, angle); }
    applyJointWorldQuaternion(next, jointId, rotation.multiply(currentWorld)); syncIkTargetOrientation(next, jointId);
  };
  const applyJointMoveInteraction = (next: PoseDocumentV1, state: NonNullable<typeof interaction>, screen: InstanceType<typeof THREE.Vector2>) => {
    if (state.target.kind !== 'move' || !state.target.jointId || !state.target.chainId) return;
    const jointId = state.target.jointId; const jointObject = jointObjects.get(jointId); if (!jointObject) return;
    const dx = screen.x - state.lastScreen.x; const dy = screen.y - state.lastScreen.y; const hinge = hingeAxis(jointId);
    if (hinge) { applyHingeStep(next, jointId, (dx - dy) * .012); return; }
    const currentWorld = new THREE.Quaternion(); jointObject.getWorldQuaternion(currentWorld); const interactionCamera = state.zoom ? handCamera : camera;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(interactionCamera.quaternion); const up = new THREE.Vector3(0, 1, 0).applyQuaternion(interactionCamera.quaternion); const axis = up.multiplyScalar(dx).add(right.multiplyScalar(dy)); const angle = axis.length() * .012;
    if (angle < 1e-8) return; axis.normalize(); applyJointWorldQuaternion(next, jointId, new THREE.Quaternion().setFromAxisAngle(axis, angle).multiply(currentWorld)); syncIkTargetOrientation(next, jointId);
  };
  const applyBodyDragRotation = (next: PoseDocumentV1, state: NonNullable<typeof interaction>, jointId: BjdJointId, screen: InstanceType<typeof THREE.Vector2>) => {
    const jointObject = jointObjects.get(jointId); if (!jointObject) return;
    const dx = screen.x - state.startScreen.x; const dy = screen.y - state.startScreen.y;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    const axis = up.multiplyScalar(dx).add(right.multiplyScalar(dy)); const angle = axis.length() * .008;
    if (angle < 1e-8) return; axis.normalize(); const currentWorld = new THREE.Quaternion(); jointObject.getWorldQuaternion(currentWorld);
    applyJointWorldQuaternion(next, jointId, new THREE.Quaternion().setFromAxisAngle(axis, angle).multiply(currentWorld));
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!interaction || event.pointerId !== interaction.pointerId) { if (!interaction && editable) setHoveredTarget(targetAtPointer(event)); return; }
    if ((event.buttons & 1) === 0) { finishPointerInteraction(event.pointerId); return; }
    const activeInteraction = interaction; const { bounds, frame } = getFrame(); const screen = activeInteraction.zoom ? setPointerFromHandZoom(event, bounds) : setPointerFromEvent(event, bounds, frame); if (!activeInteraction.dragStarted && screen.distanceTo(activeInteraction.lastScreen) < 1.5) return; activeInteraction.dragStarted = true; const directPose = activeInteraction.target.kind !== 'rotate'; const next = structuredClone(directPose ? activeInteraction.startDocument : document); if (directPose) { applyPoseState(next); activeInteraction.bendStates?.forEach((state, chainId) => writeBendState(next, chainId, state, activeInteraction.poleDirection)); } const planePoint = intersectInteractionPlane() ?? activeInteraction.start.clone(); const dragDelta = planePoint.clone().sub(activeInteraction.start); let point = activeInteraction.center.clone().add(dragDelta); if (event.shiftKey && directPose) { const depthStep = (screen.y - activeInteraction.lastScreen.y) * worldPerPixel(activeInteraction.center, frame.height); activeInteraction.depthOffset += depthStep; const cameraDirection = new THREE.Vector3(); (activeInteraction.zoom ? handCamera : camera).getWorldDirection(cameraDirection); point = activeInteraction.center.clone().addScaledVector(cameraDirection, activeInteraction.depthOffset); } updateDragGuide(activeInteraction.target, point); let constraint: string | undefined;
    if (activeInteraction.target.kind === 'pole') {
      const chainId = activeInteraction.target.chainId; const previous = activeInteraction.bendStates?.get(chainId) ?? currentBendState(chainId, next); const currentAngle = activeInteraction.bendPlaneAngles?.get(chainId) ?? previous.bendPlaneAngle ?? 0; const bend = bendStateAtPlaneAngle(chainId, currentAngle + (screen.x - activeInteraction.lastScreen.x - (screen.y - activeInteraction.lastScreen.y)) * .012, previous);
      activeInteraction.bendPlaneAngles?.set(chainId, bend.bendPlaneAngle ?? currentAngle); activeInteraction.bendStates?.set(chainId, cloneBendState(bend)!); writeBendState(next, chainId, bend, activeInteraction.poleDirection);
      const clamped = applyTwoBoneTarget(next, chainId, activeInteraction.endTarget ?? worldPosition(rig.ikChains[chainId].end), undefined, bend); const solved = next.ikState?.[chainId]?.bendState; if (solved) activeInteraction.bendStates?.set(chainId, cloneBendState(solved)!); if (clamped) constraint = '已到关节极限';
    } else if (activeInteraction.target.kind === 'direction') {
      const chainId = activeInteraction.target.chainId; const jointId = rig.ikChains[chainId].end; const end = worldPosition(jointId);
      const startOrientation = activeInteraction.endOrientation ?? jointObjects.get(jointId)?.getWorldQuaternion(new THREE.Quaternion()) ?? new THREE.Quaternion();
      const localForward = basisAxis(jointId, endForwardAxis(chainId)); let desired = startOrientation.clone();
      if (event.altKey) desired = rollEndOrientation(startOrientation, localForward, (screen.x - activeInteraction.startScreen.x - (screen.y - activeInteraction.startScreen.y)) * .012);
      else { const direction = point.clone().sub(end); if (direction.lengthSq() > 1e-8) desired = orientationTowardDirection(startOrientation, localForward, direction); }
      applyEndWorldOrientation(next, chainId, desired);
    } else if (activeInteraction.target.kind === 'hand-tip') {
      const target = point;
      const error = activeInteraction.target.jointId.startsWith('thumb')
        ? solveThumbPosition(next, activeInteraction.target.jointId, target)
        : solveFingerPosition(next, activeInteraction.target.jointId, target);
      if (error >= .001) constraint = '已到指关节极限';
    } else if (activeInteraction.target.kind === 'move') {
      if (activeInteraction.target.branch === 'cog') {
        const requestedDelta = event.shiftKey ? point.clone().sub(activeInteraction.center) : dragDelta;
        const rootDelta = activeInteraction.cogLegTargets ? clampCogDelta(requestedDelta, activeInteraction.cogLegTargets) : requestedDelta;
        const rootPosition = activeInteraction.startRoot.clone().add(rootDelta); next.rootTransform.position = { x: rootPosition.x, y: rootPosition.y, z: rootPosition.z }; applyPoseState(next);
        activeInteraction.cogLegTargets?.forEach((target, chainId) => {
          const clamped = applyTwoBoneTarget(next, chainId, target, activeInteraction.cogPoles?.get(chainId), activeInteraction.bendStates?.get(chainId));
          if (clamped) constraint = '腿部已到可用范围';
        });
        if (applyPinnedTargets(next) >= .001) constraint = '固定脚已到可用范围';
      } else if (activeInteraction.target.branch === 'pelvis') {
        applyBodyDragRotation(next, activeInteraction, 'pelvis', screen); if (applyPinnedTargets(next) >= .001) constraint = '固定目标已到关节极限';
      }
      else if (activeInteraction.target.chainId) {
        const chainId = activeInteraction.target.chainId;
        const chain = rig.ikChains[chainId]; const jointMove = Boolean(activeInteraction.target.jointId && activeInteraction.target.jointId !== chain.end && (activeInteraction.target.handle !== 'end'));
        if (jointMove) {
          applyJointMoveInteraction(next, activeInteraction, screen);
        }
        if (activeInteraction.endOrientation) {
          next.ikState ??= {}; const pole = next.ikState[chainId]?.poleDirection ?? activeInteraction.poleDirection ?? defaultPoleWorldDirection(chainId); next.ikState[chainId] = { ...next.ikState[chainId], poleDirection: { x: pole.x, y: pole.y, z: pole.z }, targetOrientation: {
            x: activeInteraction.endOrientation.x, y: activeInteraction.endOrientation.y, z: activeInteraction.endOrientation.z, w: activeInteraction.endOrientation.w,
          } };
        }
        if (!jointMove) { const bend = activeInteraction.bendStates?.get(chainId); const clamped = applyTwoBoneTarget(next, chainId, point, undefined, bend); const solved = next.ikState?.[chainId]?.bendState; if (solved) activeInteraction.bendStates?.set(chainId, cloneBendState(solved)!); if (next.ikState?.[chainId]?.pinned) pinnedTargets.set(chainId, point.clone()); if (clamped || applyPinnedTargets(next) >= .001) constraint = '已到关节极限'; }
      }
      else if (activeInteraction.target.branch === 'waist') applyBodyDragRotation(next, activeInteraction, 'spineLower', screen);
      else if (activeInteraction.target.branch === 'chest') applyBodyDragRotation(next, activeInteraction, 'spineUpper', screen);
      else if (activeInteraction.target.branch === 'head') applyBodyDragRotation(next, activeInteraction, 'head', screen);
    } else applyRotationInteraction(next, activeInteraction, screen);
    activeInteraction.bendStates?.forEach((_, chainId) => {
      const solved = next.ikState?.[chainId]?.bendState;
      if (!solved) return;
      const snapshot = cloneBendState(solved)!; activeInteraction.bendStates?.set(chainId, snapshot);
      activeInteraction.bendPlaneAngles?.set(chainId, snapshot.bendPlaneAngle ?? activeInteraction.bendPlaneAngles?.get(chainId) ?? 0);
    });
    activeInteraction.lastScreen.copy(screen);
    applyDocumentMutation(next, constraint);
  };
  const onPointerUp = (event: PointerEvent) => finishPointerInteraction(event.pointerId);
  const onWindowBlur = () => finishPointerInteraction();
  // Keep the drag stream alive even when the pointer leaves the canvas or a small
  // control marker. Pointer capture is not equally reliable in every WebView.
  canvas.addEventListener('pointerdown', onPointerDown, true); canvas.addEventListener('lostpointercapture', onPointerUp); window.addEventListener('pointermove', onPointerMove); window.addEventListener('pointerup', onPointerUp); window.addEventListener('pointercancel', onPointerUp); window.addEventListener('blur', onWindowBlur);

  const visibleBodyBounds = () => { gltf.scene.updateMatrixWorld(true); const bounds = new THREE.Box3(); boundMeshes.forEach(({ mesh }) => bounds.expandByObject(mesh, true)); return bounds; };
  const fitDocumentToPerson = (source: PoseDocumentV1) => { const bounds = visibleBodyBounds(); if (bounds.isEmpty()) return structuredClone(source); perspective.setFocalLength(source.camera.focalLengthMm); const fitted = fitBounds({ min: { x: bounds.min.x, y: bounds.min.y, z: bounds.min.z }, max: { x: bounds.max.x, y: bounds.max.y, z: bounds.max.z } }, aspectValue(source.frame.aspect), THREE.MathUtils.degToRad(perspective.getEffectiveFOV())); const direction = new THREE.Vector3(source.camera.position.x - source.camera.target.x, source.camera.position.y - source.camera.target.y, source.camera.position.z - source.camera.target.z); if (direction.lengthSq() < 1e-8) direction.set(0, 0, -1); direction.normalize(); const distance = source.camera.projection === 'perspective' ? fitted.perspectiveDistance : Math.max(direction.length(), fitted.perspectiveDistance); const next = structuredClone(source); next.camera.target = fitted.center; next.camera.position = { x: fitted.center.x + direction.x * distance, y: fitted.center.y + direction.y * distance, z: fitted.center.z + direction.z * distance }; next.camera.orthographicHeight = fitted.orthographicHeight; next.camera.horizon = 0; next.camera.lensShift = { x: 0, y: 0 }; return next; };
  const setDocument = (next: PoseDocumentV1) => {
    if (documentApplied && next === document) return;
    applyingDocument = true; if (pivotDebug.enabled) { pivotDebug.angle = 0; pivotDebug.baselineGeometry = undefined; } applyPoseState(next); if (pivotDebug.enabled) resetPivotDebugBaseline(); document = next;
    const sourceCamera = next.camera.projection === 'orthographic' ? orthographic : perspective; camera = sourceCamera; sourceCamera.position.set(next.camera.position.x, next.camera.position.y, next.camera.position.z); controls.object = sourceCamera; controls.target.set(next.camera.target.x, next.camera.target.y, next.camera.target.z); controls.update(); perspective.setFocalLength(next.camera.focalLengthMm);
    const intensity = lightingIntensities(next.lighting.contrast); ambient.intensity = intensity.ambient; directional.intensity = intensity.directional; renderer.setClearColor(next.appearance.background.type === 'solid' ? next.appearance.background.color : 0x000000, next.appearance.background.type === 'solid' ? 1 : 0); bodyMaterial.color.set(next.appearance.bodyColor); jointMaterial.color.copy(bodyMaterial.color); slotMaterial.color.copy(bodyMaterial.color); outlineUniforms.forEach((uniform) => { uniform.value = next.appearance.outline ? .48 : 0; });
    gltf.scene.traverse((object) => { const mesh = object as Mesh; if (!mesh.isMesh || mesh.material) return; mesh.material = bodyMaterial; });
    boundMeshes.forEach(({ mesh, role }) => { mesh.material = next.appearance.mode === 'silhouette' ? silhouetteMaterial : role === 'body' ? bodyMaterial : role === 'joint' ? jointMaterial : slotMaterial; mesh.castShadow = next.appearance.shadows; mesh.receiveShadow = next.appearance.shadows; });
    gltf.scene.updateMatrixWorld(true); const bodyCenter = visibleBodyBounds().getCenter(new THREE.Vector3()); const lightDirection = normalizeDirection(next.lighting.directionalDirection); directional.position.set(bodyCenter.x + lightDirection.x * 5, bodyCenter.y + lightDirection.y * 5, bodyCenter.z + lightDirection.z * 5); directional.target.position.copy(bodyCenter); directional.target.updateMatrixWorld(); directional.castShadow = next.appearance.shadows; ground.visible = false;
    (Object.keys(rig.ikChains) as BjdIkChainId[]).forEach((chainId) => { const chain = rig.ikChains[chainId]; const end = worldPosition(chain.end); const state = next.ikState?.[chainId]; if (state?.pinned) pinnedTargets.set(chainId, end.clone()); else { pinnedTargets.delete(chainId); unreachableChains.delete(chainId); } });
    emitSelection(); updateControlVisibility(); refreshHoverAppearance(); setSize(canvas.clientWidth, canvas.clientHeight); documentApplied = true; applyingDocument = false; requestRender();
  };
  const commitDocumentAction = (next: PoseDocumentV1) => {
    events.onInteractionStart?.(); setDocument(next); events.onDocumentChange?.(next); events.onInteractionEnd?.();
  };
  const focusPoint = (point: InstanceType<typeof THREE.Vector3>) => {
    const offset = camera.position.clone().sub(controls.target); if (offset.lengthSq() < 1e-8) offset.set(0, 0, -4);
    const next = structuredClone(document); next.camera.target = { x: point.x, y: point.y, z: point.z };
    next.camera.position = { x: point.x + offset.x, y: point.y + offset.y, z: point.z + offset.z };
    commitDocumentAction(next);
  };
  const setCameraView = (view: 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'threeQuarter' | 'low' | 'high') => {
    const bounds = visibleBodyBounds(); const center = bounds.isEmpty() ? controls.target.clone() : bounds.getCenter(new THREE.Vector3());
    const distance = Math.max(.01, camera.position.distanceTo(controls.target));
    const directions = { front: new THREE.Vector3(0, 0, -1), back: new THREE.Vector3(0, 0, 1),
      left: new THREE.Vector3(-1, 0, 0), right: new THREE.Vector3(1, 0, 0), top: new THREE.Vector3(0, 1, 0), bottom: new THREE.Vector3(0, -1, 0),
      threeQuarter: new THREE.Vector3(.7, 0, -.7), low: new THREE.Vector3(0, -.36, -.93), high: new THREE.Vector3(0, .36, -.93) } as const;
    const direction = directions[view].clone().normalize(); const next = structuredClone(document);
    next.camera.target = { x: center.x, y: center.y, z: center.z };
    next.camera.position = { x: center.x + direction.x * distance, y: center.y + direction.y * distance, z: center.z + direction.z * distance };
    const up = view === 'top' ? new THREE.Vector3(0, 0, 1) : view === 'bottom' ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0);
    perspective.up.copy(up); orthographic.up.copy(up); commitDocumentAction(next);
  };
  const setProjection = (projection: PoseDocumentV1['camera']['projection']) => {
    if (document.camera.projection === projection) return;
    const next = structuredClone(document); next.camera.projection = projection; commitDocumentAction(next);
  };
  const setFocalLength = (focalLengthMm: number) => {
    const next = structuredClone(document); next.camera.focalLengthMm = THREE.MathUtils.clamp(focalLengthMm, 18, 120); commitDocumentAction(next);
  };
  const setToePose = (curl: number, spread: number, bigToe: number) => {
    if (!controlTree.branch?.startsWith('foot') || branchLocked(controlTree.branch)) return;
    const next = structuredClone(document); applyToePose(next, controlTree.branch.endsWith('L') ? 'L' : 'R', curl, spread, bigToe); applyDocumentMutation(next);
  };
  const selectHand = (side: 'L' | 'R') => {
    if (!editable) return;
    const branch = `hand${side}` as PoseBranchId;
    if (branchLocked(branch)) return;
    updateSelection(`wrist${side}` as BjdJointId, branch);
  };
  const selectedLimb = () => controlTree.branch?.startsWith('hand') ? { kind: 'arm' as const, side: controlTree.branch.endsWith('L') ? 'L' as const : 'R' as const }
    : controlTree.branch?.startsWith('foot') ? { kind: 'leg' as const, side: controlTree.branch.endsWith('L') ? 'L' as const : 'R' as const } : undefined;
  const onCameraStart = () => { if (!applyingDocument && editable) events.onInteractionStart?.(); }; const onCameraChange = () => { requestRender(); if (applyingDocument || !editable) return; const next = structuredClone(document); next.camera.position = { x: camera.position.x, y: camera.position.y, z: camera.position.z }; next.camera.target = { x: controls.target.x, y: controls.target.y, z: controls.target.z }; document = next; events.onDocumentChange?.(next); }; const onCameraEnd = () => { if (!applyingDocument && editable) events.onInteractionEnd?.(); };
  const onDoubleClick = (event: MouseEvent) => {
    if (renderingOutput) return; const target = targetAtPointer(event as PointerEvent); const jointId = targetJointId(target);
    if (!jointId) return; updateSelection(jointId); focusPoint(worldPosition(jointId)); event.preventDefault();
  };
  canvas.addEventListener('dblclick', onDoubleClick);
  controls.addEventListener('start', onCameraStart); controls.addEventListener('change', onCameraChange); controls.addEventListener('end', onCameraEnd); setDocument(document); if (events.centerOnLoad) { const fitted = fitDocumentToPerson(document); setDocument(fitted); events.onInitialDocument?.(fitted); }

  const renderPng = async (next: PoseDocumentV1) => { finishPointerInteraction(); renderingOutput = true; dragGuide.visible = false; if (renderFrame !== undefined) { cancelAnimationFrame(renderFrame); renderFrame = undefined; } if (pivotDebug.enabled) { pivotDebug.angle = 0; pivotDebug.baselineGeometry = undefined; applyPoseState(document); resetPivotDebugBaseline(); } setDocument(next); const previous = { width: canvas.clientWidth, height: canvas.clientHeight, pixelRatio: renderer.getPixelRatio() }; const moveVisible = moveGroup.visible; const rotateVisible = rotateGroup.visible; const pinVisible = pinGroup.visible; const handZoomVisible = handZoomGroup.visible; const pivotDebugVisible = pivotDebugGroup.visible;
    try { const size = outputSize(next.frame.aspect); renderer.setPixelRatio(1); renderer.setSize(size.width, size.height, false); moveGroup.visible = false; rotateGroup.visible = false; pinGroup.visible = false; handZoomGroup.visible = false; pivotDebugGroup.visible = false; updateProjection(size.width / size.height); renderer.setViewport(0, 0, size.width, size.height); renderer.setScissorTest(false); renderer.render(scene, camera); return await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('PNG 编码失败')), 'image/png')); }
      finally { moveGroup.visible = moveVisible; rotateGroup.visible = rotateVisible; pinGroup.visible = pinVisible; handZoomGroup.visible = handZoomVisible; pivotDebugGroup.visible = pivotDebugVisible; dragGuide.visible = false; renderer.setPixelRatio(previous.pixelRatio); setSize(previous.width, previous.height); renderingOutput = false; requestRender(); }
  };
  const setPivotDebugMode = (enabled: boolean) => {
    finishPointerInteraction(); pivotDebug.enabled = enabled; pivotDebug.angle = 0; pivotDebug.baselineGeometry = undefined; applyPoseState(document);
    if (enabled) resetPivotDebugBaseline(); updateControlVisibility(); updatePivotDebugMarkers(); events.onPivotDebugChange?.(readPivotDebugState()); requestRender();
  };
  const setPivotDebugJoint = (jointId: BjdJointId) => {
    if (!jointObjects.has(jointId)) return; pivotDebug.jointId = jointId; pivotDebug.angle = 0; pivotDebug.baselineGeometry = undefined; applyPoseState(document);
    if (pivotDebug.enabled) resetPivotDebugBaseline(); updatePivotDebugMarkers(); events.onPivotDebugChange?.(readPivotDebugState()); requestRender();
  };
  const setPivotDebugRotation = (axis: PosePivotDebugAxis, angle: number) => {
    pivotDebug.axis = axis; pivotDebug.angle = THREE.MathUtils.clamp(angle, -90, 90); applyPoseState(document);
    updatePivotDebugMarkers(); const state = readPivotDebugState(); logInfo('pose.bjd.single-joint', state); events.onPivotDebugChange?.(state); requestRender();
  };
  const setManipulatorMode = (mode: PoseEditMode) => { finishPointerInteraction(); editMode = mode; updateControlVisibility(); requestRender(); };

  return {
    setDocument, setManipulatorMode, setEditMode: setManipulatorMode,
    setHandMode: (enabled) => { updateHandZoomState(Boolean(enabled && controlTree.branch?.startsWith('hand') && !branchLocked(controlTree.branch))); },
    setPivotDebugMode, setPivotDebugJoint, setPivotDebugRotation,
    setProjection, setFocalLength,
    toggleSelectedLock,
    getSelection: () => selection,
    selectHand,
    setPreviewMode: (enabled) => { finishPointerInteraction(); previewMode = enabled; if (enabled) setHoveredTarget(undefined); updateControlVisibility(); requestRender(); },
    cancelInteraction: cancelPointerInteraction,
     setCameraView,
     focusSelection: () => { if (selectedJointId) focusPoint(worldPosition(selectedJointId)); else { const bounds = visibleBodyBounds(); if (!bounds.isEmpty()) focusPoint(bounds.getCenter(new THREE.Vector3())); } },
     mirrorSelectedLimb: () => { const limb = selectedLimb(); const otherBranch = limb ? `${limb.kind === 'arm' ? 'hand' : 'foot'}${limb.side === 'L' ? 'R' : 'L'}` as PoseBranchId : undefined; if (!limb || branchLocked(controlTree.branch) || branchLocked(otherBranch)) return; pinnedTargets.delete(`${limb.kind}${limb.side === 'L' ? 'R' : 'L'}` as BjdIkChainId); unreachableChains.clear(); commitDocumentAction(mirrorPoseLimb(document, limb.kind, limb.side)); },
     flipSelectedLimbs: () => { const limb = selectedLimb(); if (!limb) return; const leftBranch = `${limb.kind === 'arm' ? 'hand' : 'foot'}L` as PoseBranchId; const rightBranch = `${limb.kind === 'arm' ? 'hand' : 'foot'}R` as PoseBranchId; if (branchLocked(leftBranch) || branchLocked(rightBranch)) return; pinnedTargets.delete(`${limb.kind}L` as BjdIkChainId); pinnedTargets.delete(`${limb.kind}R` as BjdIkChainId); unreachableChains.clear(); commitDocumentAction(flipPoseLimbs(document, limb.kind)); },
     setToePose,
     resetSelectedJoint: () => { if (!selectedJointId || jointLocked(selectedJointId)) return; events.onInteractionStart?.(); const next = structuredClone(document); const natural = NATURAL_STANDING_ROTATIONS[selectedJointId]; if (natural) next.jointRotations[selectedJointId] = structuredClone(natural); else delete next.jointRotations[selectedJointId]; setDocument(next); events.onDocumentChange?.(next); events.onInteractionEnd?.(); },
      resetSelectedLimb: () => { if (!controlTree.branch || branchLocked(controlTree.branch)) return; events.onInteractionStart?.(); let next = structuredClone(document); const chainId = chainForBranch(); if (chainId) next = resetIkChain(next, rig, chainId); const joints: BjdJointId[] = controlTree.branch === 'head' ? ['head', 'neck'] : controlTree.branch === 'chest' ? ['spineLower', 'spineUpper', 'neck'] : controlTree.branch === 'waist' ? ['pelvis', 'spineLower', 'spineUpper'] : controlTree.branch === 'pelvis' ? ['pelvis', 'hipL', 'hipR'] : controlTree.branch.startsWith('hand') ? [`shoulder${controlTree.branch.endsWith('L') ? 'L' : 'R'}` as BjdJointId, ...Object.entries(FINGER_JOINTS).filter(([key]) => key.endsWith(controlTree.branch!.endsWith('L') ? 'L' : 'R')).flatMap(([, values]) => values)] : controlTree.branch.startsWith('foot') ? [`toeBase${controlTree.branch.endsWith('L') ? 'L' : 'R'}` as BjdJointId, `bigToe${controlTree.branch.endsWith('L') ? 'L' : 'R'}` as BjdJointId] : []; new Set(joints).forEach((jointId) => { const natural = NATURAL_STANDING_ROTATIONS[jointId]; if (natural) next.jointRotations[jointId] = structuredClone(natural); else delete next.jointRotations[jointId]; }); if (chainId) { delete next.ikState?.[chainId]; pinnedTargets.delete(chainId); } setDocument(next); events.onDocumentChange?.(next); events.onInteractionEnd?.(); },
      resetWholePose: () => { events.onInteractionStart?.(); const next = structuredClone(document); next.rootTransform = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }; next.jointRotations = structuredClone(NATURAL_STANDING_ROTATIONS); const lockedLegs = Object.fromEntries((['legL', 'legR'] as BjdIkChainId[]).filter((chainId) => document.ikState?.[chainId]?.pinned).map((chainId) => [chainId, document.ikState?.[chainId]])); next.ikState = Object.keys(lockedLegs).length ? lockedLegs as PoseDocumentV1['ikState'] : undefined; pinnedTargets.clear(); unreachableChains.clear(); setDocument(next); events.onDocumentChange?.(next); events.onInteractionEnd?.(); },
      centerPerson: () => { events.onInteractionStart?.(); const next = fitDocumentToPerson(document); setDocument(next); events.onDocumentChange?.(next); events.onInteractionEnd?.(); },
      setLightDirectionFromView: (x, y) => { const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion).normalize(); const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion).normalize(); const front = new THREE.Vector3(0, 0, 1).applyQuaternion(camera.quaternion).normalize(); const radial = Math.min(.98, Math.hypot(x, y)); const z = Math.sqrt(Math.max(.04, 1 - radial * radial)); const direction = right.multiplyScalar(x).add(up.multiplyScalar(y)).add(front.multiplyScalar(z)).normalize(); const next = structuredClone(document); next.lighting.directionalDirection = { x: direction.x, y: direction.y, z: direction.z }; setDocument(next); events.onDocumentChange?.(next); },
      setFootLock, setBothFootLocks, mirrorPose,
      togglePinned: (requestedChain) => { const chainId = requestedChain ?? chainForBranch(); if (chainId) togglePinnedState(chainId); },
      setHandZoomOpen: (open) => { updateHandZoomState(Boolean(open && controlTree.branch?.startsWith('hand') && !branchLocked(controlTree.branch))); }, beginInteraction: () => events.onInteractionStart?.(), endInteraction: () => events.onInteractionEnd?.(), renderPng,
  dispose: () => { if (disposed) return; disposed = true; finishPointerInteraction(); if (renderFrame !== undefined) cancelAnimationFrame(renderFrame); resizeObserver.disconnect(); controls.removeEventListener('start', onCameraStart); controls.removeEventListener('change', onCameraChange); controls.removeEventListener('end', onCameraEnd); controls.dispose(); canvas.removeEventListener('pointerdown', onPointerDown, true); canvas.removeEventListener('lostpointercapture', onPointerUp); canvas.removeEventListener('dblclick', onDoubleClick); window.removeEventListener('pointermove', onPointerMove); window.removeEventListener('pointerup', onPointerUp); window.removeEventListener('pointercancel', onPointerUp); window.removeEventListener('blur', onWindowBlur); gltf.scene.traverse((object: Object3D) => { const mesh = object as Mesh; mesh.geometry?.dispose(); }); originalMaterials.forEach((material) => material.dispose()); bodyMaterial.dispose(); jointMaterial.dispose(); slotMaterial.dispose(); activeChainMaterial.dispose(); silhouetteMaterial.dispose(); ground.geometry.dispose(); groundMaterial.dispose(); moveGeometry.dispose(); jointMoveGeometry.dispose(); rotateInnerGeometry.dispose(); rotateOuterGeometry.dispose(); directionHandleGeometry.dispose(); directionPickGeometry.dispose(); directionControls.forEach(({ line }) => line.geometry.dispose()); guideGeometry.dispose(); guideMaterial.dispose(); moveMaterial.dispose(); cogMaterial.dispose(); selectedMoveMaterial.dispose(); pinnedMoveMaterial.dispose(); limitedMoveMaterial.dispose(); rotateMaterial.dispose(); rotateOuterMaterial.dispose(); rotateHoverMaterial.dispose(); rotateOuterHoverMaterial.dispose(); directionMaterial.dispose(); directionHoverMaterial.dispose(); pickMaterial.dispose(); pinMaterial.dispose(); pinTexture.dispose(); pivotDebugGeometry.dispose(); pivotDebugOriginMaterial.dispose(); pivotDebugPivotMaterial.dispose(); pivotDebugGeometryMaterial.dispose(); renderer.dispose(); },
  };
}
