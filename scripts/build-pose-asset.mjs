import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

class NodeFileReader {
  result = null;
  onloadend = null;

  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((value) => {
      this.result = value;
      this.onloadend?.();
    });
  }

  readAsDataURL(blob) {
    blob.arrayBuffer().then((value) => {
      this.result = `data:${blob.type};base64,${Buffer.from(value).toString('base64')}`;
      this.onloadend?.();
    });
  }
}

globalThis.FileReader ??= NodeFileReader;
globalThis.ProgressEvent ??= class ProgressEvent {
  constructor(type, init = {}) { this.type = type; Object.assign(this, init); }
};

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  throw new Error('Usage: node scripts/build-pose-asset.mjs <source.glb> <output.glb>');
}

const bytes = fs.readFileSync(path.resolve(inputPath));
const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const source = await new Promise((resolve, reject) => new GLTFLoader().parse(buffer, '', resolve, reject));
source.scene.updateMatrixWorld(true);

// The public Sketchfab package contains three presentation copies. The third copy is the
// upright A-pose. It is centered around Z=-1.983865 and its feet are 0.003358 below Y=0.
const NORMALIZE = new THREE.Vector3(0, 0.0033583579742512723, 1.983865240771661);
const q = (value) => new THREE.Vector3(value[0], value[1], value[2]);
const pivots = {
  pelvis: q([0, 0.963, -0.0397]), spineLower: q([0, 1.0994, -0.0585]),
  spineUpper: q([0, 1.195, -0.056]), neck: q([0, 1.417, -0.026]), head: q([0, 1.5041, -0.0157]),
  shoulderL: q([0.1351, 1.2987, 0.0158]), shoulderR: q([-0.1351, 1.2987, 0.0158]),
  elbowUpperL: q([0.1596, 1.0951, 0.1036]), elbowUpperR: q([-0.1596, 1.0951, 0.1036]),
  elbowLowerL: q([0.1596, 1.0951, 0.1036]), elbowLowerR: q([-0.1596, 1.0951, 0.1036]),
  wristL: q([0.2057, 0.8814, 0.1056]), wristR: q([-0.2057, 0.8814, 0.1056]),
  hipL: q([0.0881, 0.928, -0.036]), hipR: q([-0.0881, 0.928, -0.036]),
  kneeUpperL: q([0.0669, 0.5227, -0.0185]), kneeUpperR: q([-0.0669, 0.5227, -0.0185]),
  kneeLowerL: q([0.0669, 0.5227, -0.0185]), kneeLowerR: q([-0.0669, 0.5227, -0.0185]),
  ankleL: q([0.0573, 0.132, -0.01]), ankleR: q([-0.0573, 0.132, -0.01]),
  thumbMetacarpalL: q([0.2028, 0.8249, 0.0778]), thumbMetacarpalR: q([-0.2028, 0.8249, 0.0778]),
  thumbProximalL: q([0.1973, 0.7978, 0.0694]), thumbProximalR: q([-0.1973, 0.7978, 0.0694]),
  thumbDistalL: q([0.1924, 0.7758, 0.0638]), thumbDistalR: q([-0.1924, 0.7758, 0.0638]),
  indexProximalL: q([0.2283, 0.7742, 0.0762]), indexProximalR: q([-0.2283, 0.7742, 0.0762]),
  indexMiddleL: q([0.2296, 0.7489, 0.0785]), indexMiddleR: q([-0.2296, 0.7489, 0.0785]),
  indexDistalL: q([0.2301, 0.7278, 0.0805]), indexDistalR: q([-0.2301, 0.7278, 0.0805]),
  middleProximalL: q([0.2302, 0.7722, 0.0956]), middleProximalR: q([-0.2302, 0.7722, 0.0956]),
  middleMiddleL: q([0.2313, 0.7431, 0.0965]), middleMiddleR: q([-0.2313, 0.7431, 0.0965]),
  middleDistalL: q([0.2318, 0.7196, 0.0974]), middleDistalR: q([-0.2318, 0.7196, 0.0974]),
  ringProximalL: q([0.2311, 0.7739, 0.1146]), ringProximalR: q([-0.2311, 0.7739, 0.1146]),
  ringMiddleL: q([0.2322, 0.7483, 0.1135]), ringMiddleR: q([-0.2322, 0.7483, 0.1135]),
  ringDistalL: q([0.2324, 0.727, 0.113]), ringDistalR: q([-0.2324, 0.727, 0.113]),
  littleProximalL: q([0.2316, 0.7773, 0.1335]), littleProximalR: q([-0.2316, 0.7773, 0.1335]),
  littleMiddleL: q([0.2327, 0.7545, 0.1309]), littleMiddleR: q([-0.2327, 0.7545, 0.1309]),
  littleDistalL: q([0.2334, 0.7352, 0.1284]), littleDistalR: q([-0.2334, 0.7352, 0.1284]),
};

const scene = new THREE.Scene();
scene.name = 'BJD_Female_A_Pose';
const root = new THREE.Group();
root.name = 'BJD_Root';
scene.add(root);

const nodes = new Map();
function addJoint(id, parentId) {
  const node = new THREE.Group();
  node.name = `joint_${id}`;
  const parent = parentId ? nodes.get(parentId) : root;
  node.position.copy(pivots[id]).sub(parentId ? pivots[parentId] : new THREE.Vector3());
  parent.add(node);
  nodes.set(id, node);
}

addJoint('pelvis');
addJoint('spineLower', 'pelvis'); addJoint('spineUpper', 'spineLower');
addJoint('neck', 'spineUpper'); addJoint('head', 'neck');
for (const side of ['L', 'R']) {
  addJoint(`shoulder${side}`, 'spineUpper');
  addJoint(`elbowUpper${side}`, `shoulder${side}`); addJoint(`elbowLower${side}`, `elbowUpper${side}`);
  addJoint(`wrist${side}`, `elbowLower${side}`);
  addJoint(`hip${side}`, 'pelvis');
  addJoint(`kneeUpper${side}`, `hip${side}`); addJoint(`kneeLower${side}`, `kneeUpper${side}`);
  addJoint(`ankle${side}`, `kneeLower${side}`);
  for (const finger of ['thumb', 'index', 'middle', 'ring', 'little']) {
    const parts = finger === 'thumb' ? ['Metacarpal', 'Proximal', 'Distal'] : ['Proximal', 'Middle', 'Distal'];
    let parent = `wrist${side}`;
    for (const part of parts) {
      const id = `${finger}${part}${side}`;
      addJoint(id, parent); parent = id;
    }
  }
}

const bodyMaterial = new THREE.MeshStandardMaterial({ name: 'body', color: 0xe3ded4, roughness: 0.82 });
const jointMaterial = new THREE.MeshStandardMaterial({ name: 'joint', color: 0x918d86, roughness: 0.88 });
const slotMaterial = new THREE.MeshStandardMaterial({ name: 'joint-slot', color: 0x444446, roughness: 0.9 });
const materials = { body: bodyMaterial, joint: jointMaterial, 'joint-slot': slotMaterial };

function findSourceMesh(name) {
  const group = source.scene.getObjectByName(name);
  if (!group) throw new Error(`Missing source node: ${name}`);
  let result;
  group.traverse((object) => {
    if (object.isMesh && object.material?.name === 'check') result = object;
  });
  if (!result) throw new Error(`Missing check mesh below source node: ${name}`);
  return result;
}

function extractGeometry(sourceName, side, pivot) {
  const mesh = findSourceMesh(sourceName);
  let geometry = mesh.geometry.clone();
  geometry.applyMatrix4(mesh.matrixWorld);
  geometry.translate(NORMALIZE.x, NORMALIZE.y, NORMALIZE.z);
  for (const attribute of Object.keys(geometry.attributes)) {
    if (attribute !== 'position' && attribute !== 'normal') geometry.deleteAttribute(attribute);
  }
  if (side) {
    geometry = geometry.index ? geometry.toNonIndexed() : geometry;
    const position = geometry.getAttribute('position');
    const normal = geometry.getAttribute('normal');
    const positions = []; const normals = [];
    for (let index = 0; index < position.count; index += 3) {
      const centroidX = (position.getX(index) + position.getX(index + 1) + position.getX(index + 2)) / 3;
      const keep = side === 'L' ? centroidX >= 0 : centroidX < 0;
      if (!keep) continue;
      for (let vertex = index; vertex < index + 3; vertex++) {
        positions.push(position.getX(vertex), position.getY(vertex), position.getZ(vertex));
        normals.push(normal.getX(vertex), normal.getY(vertex), normal.getZ(vertex));
      }
    }
    geometry.dispose();
    geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry = mergeVertices(geometry, 1e-5);
  }
  geometry.translate(-pivot.x, -pivot.y, -pivot.z);
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  return geometry;
}

const bindings = [];
function addSegment(id, sourceName, jointId, role = 'body', side) {
  const mesh = new THREE.Mesh(extractGeometry(sourceName, side, pivots[jointId]), materials[role]);
  mesh.name = `segment_${id}`;
  mesh.castShadow = true; mesh.receiveShadow = true;
  nodes.get(jointId).add(mesh);
  bindings.push({ id, node: mesh.name, joint: jointId, materialRole: role });
  return mesh;
}

function addJointBall(id, jointId, scale) {
  const geometry = new THREE.SphereGeometry(1, 32, 20).scale(scale.x, scale.y, scale.z);
  const mesh = new THREE.Mesh(geometry, jointMaterial);
  mesh.name = `segment_${id}`;
  mesh.castShadow = true; mesh.receiveShadow = true;
  nodes.get(jointId).add(mesh);
  bindings.push({ id, node: mesh.name, joint: jointId, materialRole: 'joint' });
}

addSegment('pelvis', 'hip001', 'pelvis');
addSegment('abdomen', 'waist002', 'spineLower');
addSegment('chest', 'chest001', 'spineUpper');
addJointBall('torsoJoint', 'spineUpper', { x: .072, y: .068, z: .07 });
addSegment('head', 'head001', 'head');
for (const side of ['L', 'R']) {
  addSegment(`shoulderSocket${side}`, 'clavicleKnot001', 'spineUpper', 'joint-slot', side);
  addSegment(`shoulderJoint${side}`, 'shoulder001', `shoulder${side}`, 'joint', side).geometry.scale(1.04, 1.04, 1.04);
  addSegment(`upperArm${side}`, 'upperArm001', `shoulder${side}`, 'body', side);
  addSegment(`elbowJoint${side}`, 'elbow001', `elbowUpper${side}`, 'joint', side);
  addSegment(`foreArm${side}`, 'foreArm001', `elbowLower${side}`, 'body', side);
  addSegment(`wristJoint${side}`, 'forearmKnot001', `wrist${side}`, 'joint', side);
  addSegment(`palm${side}`, 'palm001', `wrist${side}`, 'body', side);
  addSegment(`thigh${side}`, 'tight001', `hip${side}`, 'body', side);
  addSegment(`kneeJoint${side}`, 'knee001', `kneeUpper${side}`, 'joint', side);
  addSegment(`calf${side}`, 'calf001', `kneeLower${side}`, 'body', side);
  addSegment(`foot${side}`, 'foot001', `ankle${side}`, 'body', side);
  const fingerSources = {
    thumb: ['thumbRoot001', 'thumbMid001', 'thumbTip001', 'thunbKnot001'],
    index: ['indexRoot001', 'inderMid001', 'indexTip001', 'indexKnot001'],
    middle: ['middleRoot001', 'middleMid001', 'middleTip001', 'middleKnot001'],
    ring: ['ringRoot001', 'ringMid001', 'ringTip001', 'ringKnot001'],
    little: ['pinkyRoot001', 'pinkyMid001', 'pinkyTip001', 'pinkyKnot001'],
  };
  for (const [finger, sources] of Object.entries(fingerSources)) {
    const parts = finger === 'thumb' ? ['Metacarpal', 'Proximal', 'Distal'] : ['Proximal', 'Middle', 'Distal'];
    parts.forEach((part, index) => addSegment(`${finger}${part}${side}`, sources[index], `${finger}${part}${side}`, 'body', side));
    addSegment(`${finger}Knuckle${side}`, sources[3], `${finger}${parts[0]}${side}`, 'joint', side);
  }
}

const exporter = new GLTFExporter();
const result = await exporter.parseAsync(scene, {
  binary: true,
  onlyVisible: true,
  includeCustomExtensions: false,
  maxTextureSize: 1024,
});
fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
fs.writeFileSync(path.resolve(outputPath), Buffer.from(result));

const identity = { x: 0, y: 0, z: 0, w: 1 };
const vec = (value) => ({ x: value.x, y: value.y, z: value.z });
const segmentLength = (from, to) => pivots[from].distanceTo(pivots[to]);
const jointIds = [...nodes.keys()];
const pairs = [
  'shoulder', 'elbowUpper', 'elbowLower', 'wrist', 'hip', 'kneeUpper', 'kneeLower', 'ankle',
  'thumbMetacarpal', 'thumbProximal', 'thumbDistal',
  'indexProximal', 'indexMiddle', 'indexDistal',
  'middleProximal', 'middleMiddle', 'middleDistal',
  'ringProximal', 'ringMiddle', 'ringDistal',
  'littleProximal', 'littleMiddle', 'littleDistal',
];
const mirrorPairs = pairs.map((name) => ({
  left: `${name}L`, right: `${name}R`, axisTransform: { x: 1, y: -1, z: -1 },
}));
const limits = {};
const setLimit = (ids, min, max) => ids.forEach((id) => { limits[id] = { min, max }; });
const deg = (value) => value * Math.PI / 180;
const vecDeg = (x, y, z) => ({ x: deg(x), y: deg(y), z: deg(z) });
// These are active human-range limits in the rig's local XYZ convention.
// The source site documents the controller/limit behavior, but does not
// publish its internal numeric table, so keep the assumptions explicit here.
setLimit(['pelvis'], vecDeg(-30, -45, -25), vecDeg(30, 45, 25));
setLimit(['spineLower', 'spineUpper'], vecDeg(-25, -25, -20), vecDeg(30, 25, 20));
setLimit(['neck'], vecDeg(-45, -80, -45), vecDeg(45, 80, 45));
setLimit(['head'], vecDeg(-50, -90, -50), vecDeg(50, 90, 50));
setLimit(['shoulderL', 'shoulderR'], vecDeg(-45, -90, -155), vecDeg(75, 90, 155));
setLimit(['elbowUpperL', 'elbowUpperR', 'elbowLowerL', 'elbowLowerR'],
  vecDeg(-5, -10, -10), vecDeg(90, 10, 10));
setLimit(['wristL', 'wristR'], vecDeg(-70, -30, -50), vecDeg(70, 30, 50));
setLimit(['hipL', 'hipR'], vecDeg(-120, -40, -50), vecDeg(25, 40, 50));
setLimit(['kneeUpperL', 'kneeUpperR', 'kneeLowerL', 'kneeLowerR'],
  vecDeg(-75, -8, -8), vecDeg(5, 8, 8));
setLimit(['ankleL', 'ankleR'], vecDeg(-20, -25, -25), vecDeg(45, 25, 25));
const setFingerLimit = (pattern, degrees) => {
  setLimit(jointIds.filter((id) => pattern.test(id)), vecDeg(-15, -15, -10), vecDeg(15, 15, degrees));
};
setLimit(jointIds.filter((id) => /thumbMetacarpal/.test(id)), vecDeg(-80, -50, -55), vecDeg(25, 25, 60));
setLimit(jointIds.filter((id) => /thumbProximal/.test(id)), vecDeg(-80, -20, -25), vecDeg(25, 20, 70));
setLimit(jointIds.filter((id) => /thumbDistal/.test(id)), vecDeg(-5, -5, 0), vecDeg(5, 5, 25));
setFingerLimit(/(index|middle|ring|little)Proximal/, 100);
setFingerLimit(/(index|middle|ring|little)Middle/, 100);
setFingerLimit(/(index|middle|ring|little)Distal/, 80);

const fingerRotation = (angle, side, finger, index, curl = 0) => {
  const flex = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, side === 'L' ? -1 : 1), angle);
  if (finger !== 'thumb') return { x: flex.x, y: flex.y, z: flex.z, w: flex.w };
  const value = index === 0
    ? new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, side === 'L' ? -1 : 1, 0), -.8 * curl)
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -.9 * curl)).multiply(flex).normalize()
    : index === 1 ? new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -.18 * curl).multiply(flex).normalize() : flex;
  return { x: value.x, y: value.y, z: value.z, w: value.w };
};
const restBend = (root, middle, end, axis) => {
  const upper = pivots[middle].clone().sub(pivots[root]).normalize(); const lower = pivots[end].clone().sub(pivots[middle]).normalize();
  return Math.atan2(new THREE.Vector3(axis.x, axis.y, axis.z).normalize().dot(new THREE.Vector3().crossVectors(upper, lower)), upper.dot(lower));
};
const handSide = (side, values) => Object.fromEntries(Object.entries(values).flatMap(([finger, angles]) => {
  const parts = finger === 'thumb' ? ['Metacarpal', 'Proximal', 'Distal'] : ['Proximal', 'Middle', 'Distal'];
  const curl = finger === 'thumb' ? Math.max(0, Math.min(1, Math.abs(angles[1]) / 1.4)) : 0;
  return parts.map((part, index) => [`${finger}${part}${side}`, fingerRotation(angles[index], side, finger, index, curl)]);
}));
const handValues = {
  relaxed: { thumb: [.063, .252, .04], index: [0.22, 0.28, 0.22], middle: [0.28, 0.35, 0.28], ring: [0.34, 0.43, 0.35], little: [0.4, 0.5, 0.42] },
  open: { thumb: [0, 0, 0], index: [0, 0, 0], middle: [0, 0, 0], ring: [0, 0, 0], little: [0, 0, 0] },
  fist: { thumb: [.252, 1.008, .2], index: [1.15, 1.3, 1.15], middle: [1.2, 1.35, 1.2], ring: [1.25, 1.4, 1.25], little: [1.3, 1.45, 1.3] },
  point: { thumb: [.0875, .35, .055], index: [0, 0, 0], middle: [1.2, 1.35, 1.2], ring: [1.25, 1.4, 1.25], little: [1.3, 1.45, 1.3] },
};
const thumbPoseCurve = [
  { id: 'open', left: [
    { x: 0, y: 0, z: 0, w: 1 }, { x: 0, y: 0, z: 0, w: 1 }, { x: 0, y: 0, z: 0, w: 1 },
  ] },
  { id: 'relaxed', left: [
    { x: -.0829200265, y: .0691246879, z: -.0254924918, w: .9938290495 },
    { x: -.0160708715, y: -.0020357142, z: -.1256503789, w: .9919423195 },
    { x: 0, y: 0, z: -.0199986667, w: .9998000067 },
  ] },
  { id: 'halfCurl', left: [
    { x: -.2021599886, y: .1443483077, z: -.0253469608, w: .9683245513 },
    { x: -.0354177508, y: -.0157821891, z: -.2950074682, w: .9547078606 },
    { x: 0, y: 0, z: -.0567694632, w: .9983873136 },
  ] },
  { id: 'opposition', left: [
    { x: -.27, y: .30, z: -.03, w: .9144397192 },
    { x: -.04, y: -.02, z: -.30, w: .9528903400 },
    { x: 0, y: 0, z: -.07, w: .9975469914 },
  ] },
  { id: 'fist', left: [
    { x: -.3366657004, y: .2287624835, z: -.0245130664, w: .9130843564 },
    { x: -.0567029259, y: -.0312720990, z: -.4819184534, w: .8738200263 },
    { x: 0, y: 0, z: -.0998334166, w: .9950041653 },
  ] },
].map(({ id, left }) => {
  const joints = ['thumbMetacarpal', 'thumbProximal', 'thumbDistal'];
  const side = (suffix) => Object.fromEntries(joints.map((joint, index) => {
    const value = left[index]; return [`${joint}${suffix}`, suffix === 'L' ? value : { x: value.x, y: -value.y, z: -value.z, w: value.w }];
  }));
  return { id, left: side('L'), right: side('R') };
});
const rig = {
  schemaVersion: 1,
  modelId: 'chambersu-bjd-female-v1',
  rigVersion: 1,
  rootNode: 'BJD_Root',
  restPose: Object.fromEntries(jointIds.map((id) => [id, identity])),
  segmentBindings: Object.fromEntries(bindings.map((binding) => [binding.id, {
    node: binding.node, joint: binding.joint, materialRole: binding.materialRole,
  }])),
  jointNodes: Object.fromEntries(jointIds.map((id) => [id, `joint_${id}`])),
  jointPivots: Object.fromEntries(jointIds.map((id) => [id, vec(pivots[id])])),
  axisBasis: Object.fromEntries(jointIds.map((id) => [id, /^(thumb|index|middle|ring|little).+L$/.test(id) ? { x: 1, y: 0, z: 0, w: 0 } : identity])),
  rootMirrorAxisTransform: { x: 1, y: -1, z: -1 },
  jointLimits: limits,
  mirrorPairs,
  compoundJoints: [
    { id: 'elbowL', primary: 'elbowUpperL', secondary: 'elbowLowerL', distribution: [
      { angle: 0, primaryRatio: 0.5 }, { angle: 0.7, primaryRatio: 0.48 },
      { angle: 1.5, primaryRatio: 0.52 }, { angle: deg(150), primaryRatio: 0.6 },
    ] },
    { id: 'elbowR', primary: 'elbowUpperR', secondary: 'elbowLowerR', distribution: [
      { angle: 0, primaryRatio: 0.5 }, { angle: 0.7, primaryRatio: 0.48 },
      { angle: 1.5, primaryRatio: 0.52 }, { angle: deg(150), primaryRatio: 0.6 },
    ] },
    { id: 'kneeL', primary: 'kneeUpperL', secondary: 'kneeLowerL', distribution: [
      { angle: 0, primaryRatio: 0.52 }, { angle: 0.8, primaryRatio: 0.5 },
      { angle: 1.6, primaryRatio: 0.52 }, { angle: deg(145), primaryRatio: 0.55 },
    ] },
    { id: 'kneeR', primary: 'kneeUpperR', secondary: 'kneeLowerR', distribution: [
      { angle: 0, primaryRatio: 0.52 }, { angle: 0.8, primaryRatio: 0.5 },
      { angle: 1.6, primaryRatio: 0.52 }, { angle: deg(145), primaryRatio: 0.55 },
    ] },
  ],
  ikChains: {
    armL: { root: 'shoulderL', middle: ['elbowUpperL', 'elbowLowerL'], end: 'wristL', upperLength: segmentLength('shoulderL', 'elbowLowerL'),
      lowerLength: segmentLength('elbowLowerL', 'wristL'), restBend: restBend('shoulderL', 'elbowLowerL', 'wristL', { x: 1, y: 0, z: 0 }), compoundJointId: 'elbowL', maxBend: deg(150), flexionAxis: { x: 1, y: 0, z: 0 }, defaultPoleDirection: { x: 0, y: 0, z: 1 } },
    armR: { root: 'shoulderR', middle: ['elbowUpperR', 'elbowLowerR'], end: 'wristR', upperLength: segmentLength('shoulderR', 'elbowLowerR'),
      lowerLength: segmentLength('elbowLowerR', 'wristR'), restBend: restBend('shoulderR', 'elbowLowerR', 'wristR', { x: 1, y: 0, z: 0 }), compoundJointId: 'elbowR', maxBend: deg(150), flexionAxis: { x: 1, y: 0, z: 0 }, defaultPoleDirection: { x: 0, y: 0, z: 1 } },
    legL: { root: 'hipL', middle: ['kneeUpperL', 'kneeLowerL'], end: 'ankleL', upperLength: segmentLength('hipL', 'kneeLowerL'),
      lowerLength: segmentLength('kneeLowerL', 'ankleL'), restBend: restBend('hipL', 'kneeLowerL', 'ankleL', { x: -1, y: 0, z: 0 }), compoundJointId: 'kneeL', maxBend: deg(145), flexionAxis: { x: -1, y: 0, z: 0 }, defaultPoleDirection: { x: 0, y: 0, z: -1 } },
    legR: { root: 'hipR', middle: ['kneeUpperR', 'kneeLowerR'], end: 'ankleR', upperLength: segmentLength('hipR', 'kneeLowerR'),
      lowerLength: segmentLength('kneeLowerR', 'ankleR'), restBend: restBend('hipR', 'kneeLowerR', 'ankleR', { x: -1, y: 0, z: 0 }), compoundJointId: 'kneeR', maxBend: deg(145), flexionAxis: { x: -1, y: 0, z: 0 }, defaultPoleDirection: { x: 0, y: 0, z: -1 } },
  },
  handPresets: Object.fromEntries(Object.entries(handValues).map(([name, values]) => [name, {
    left: handSide('L', values), right: handSide('R', values),
  }])),
  thumbPoseCurve,
  pickTargets: Object.fromEntries(bindings.map((binding) => [binding.node, binding.joint])),
  grounding: { footNodes: ['segment_footL', 'segment_footR'] },
};

const eulerQuaternion = (x = 0, y = 0, z = 0) => {
  const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, 'XYZ')).normalize();
  return { x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w };
};
const relaxedHandValues = { thumb: [.063, .252, .04], index: [.09, .12, .08], middle: [.11, .14, .09], ring: [.13, .16, .10], little: [.16, .19, .12] };
const relaxedHands = Object.fromEntries(['L', 'R'].flatMap((side) => Object.entries(handSide(side, relaxedHandValues))));
const pose = (id, label, rotations = {}, position = { x: 0, y: 0, z: 0 }, includeRelaxedHands = true) => ({
  id, label, rootTransform: { position, rotation: identity },
  jointRotations: Object.fromEntries(Object.entries({ ...(includeRelaxedHands ? relaxedHands : {}), ...rotations })
    .map(([joint, value]) => [joint, Array.isArray(value) ? eulerQuaternion(...(joint.startsWith('knee') ? [-value[0], value[1], value[2]] : value)) : value])),
});
const presets = {
  schemaVersion: 1, modelId: 'chambersu-bjd-female-v1', rigVersion: 1,
  presets: [
    // Neutral standing keeps the torso centered. The source mesh is a shallow
    // A-pose, so swing both shoulders forward to keep the hands beside the body
    // in side view; the intentional pelvis roll belongs to weight-shift.
    pose('natural-standing', '自然站立', { pelvis: [0.02, 0, 0], shoulderL: [0.28, 0, -0.08], shoulderR: [0.28, 0, 0.08], elbowUpperL: [.09, 0, 0], elbowLowerL: [.055, 0, 0], elbowUpperR: [.09, 0, 0], elbowLowerR: [.055, 0, 0], hipL: [.024, 0, .07], hipR: [.024, 0, -.07], kneeUpperL: [.035, 0, 0], kneeLowerL: [.022, 0, 0], kneeUpperR: [.035, 0, 0], kneeLowerR: [.022, 0, 0] }),
    pose('weight-shift', '重心站姿', { pelvis: [0, 0, 0.14], spineLower: [0, 0, -0.08], hipL: [0.05, 0, -0.08], hipR: [-0.08, 0, 0.05], kneeUpperR: [0.18, 0, 0] }),
    pose('walk', '行走', { hipL: [-0.48, 0, 0], hipR: [0.42, 0, 0], kneeUpperR: [0.72, 0, 0], kneeLowerR: [0.48, 0, 0], shoulderL: [0.34, 0, 0], shoulderR: [-0.34, 0, 0] }),
    pose('run', '跑步', { pelvis: [0.18, 0, 0], spineLower: [0.2, 0, 0], hipL: [-0.85, 0, 0], hipR: [0.7, 0, 0], kneeUpperL: [0.65, 0, 0], kneeLowerL: [0.5, 0, 0], kneeUpperR: [0.95, 0, 0], kneeLowerR: [0.75, 0, 0], toeBaseL: [.45, 0, 0], bigToeL: [.32, 0, 0], toeBaseR: [.45, 0, 0], bigToeR: [.32, 0, 0], shoulderL: [0.7, 0, 0], shoulderR: [-0.65, 0, 0] }, { x: 0, y: 0.08, z: 0 }),
    pose('squat', '下蹲', { pelvis: [0.22, 0, 0], spineLower: [-0.16, 0, 0], hipL: [-1.0, 0, -0.16], hipR: [-1.0, 0, 0.16], kneeUpperL: [0.55, 0, 0], kneeLowerL: [0.45, 0, 0], kneeUpperR: [0.55, 0, 0], kneeLowerR: [0.45, 0, 0] }, { x: 0, y: -0.34, z: 0 }),
    pose('sit', '坐姿', { pelvis: [0.12, 0, 0], hipL: [-1.45, 0, 0], hipR: [-1.45, 0, 0], kneeUpperL: [0.78, 0, 0], kneeLowerL: [0.62, 0, 0], kneeUpperR: [0.78, 0, 0], kneeLowerR: [0.62, 0, 0] }, { x: 0, y: -0.42, z: 0 }),
    pose('kneel', '跪姿', { hipL: [-0.7, 0, 0], hipR: [-0.25, 0, 0], kneeUpperL: [1.25, 0, 0], kneeLowerL: [0.95, 0, 0], kneeUpperR: [1.0, 0, 0], kneeLowerR: [0.8, 0, 0] }, { x: 0, y: -0.46, z: 0 }),
    pose('reach', '伸手', { spineUpper: [0.04, -0.12, 0], shoulderL: [0, 0.12, 1.75], elbowUpperL: [0.18, 0, 0], elbowLowerL: [0.12, 0, 0], head: [0, 0.16, 0] }),
    pose('jump', '跳跃', { pelvis: [-0.12, 0, 0], hipL: [-0.48, 0, -0.12], hipR: [-0.48, 0, 0.12], kneeUpperL: [0.72, 0, 0], kneeLowerL: [0.55, 0, 0], kneeUpperR: [0.72, 0, 0], kneeLowerR: [0.55, 0, 0], shoulderL: [0, 0, 2.55], shoulderR: [0, 0, -2.55] }, { x: 0, y: 0.32, z: 0 }),
    pose('a-pose', 'A-Pose（校准）', {}, undefined, false),
  ],
};

const outputDirectory = path.dirname(path.resolve(outputPath));
fs.writeFileSync(path.join(outputDirectory, 'bjd-rig-v1.json'), `${JSON.stringify(rig, null, 2)}\n`);
fs.writeFileSync(path.join(outputDirectory, 'pose-presets-v1.json'), `${JSON.stringify(presets, null, 2)}\n`);
execFileSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'add-pose-toes.mjs'), path.resolve(outputPath), path.join(outputDirectory, 'bjd-rig-v1.json')]);

const triangles = bindings.reduce((sum, binding) => {
  const mesh = scene.getObjectByName(binding.node);
  const geometry = mesh.geometry;
  return sum + (geometry.index ? geometry.index.count : geometry.getAttribute('position').count) / 3;
}, 0);
console.log(JSON.stringify({ output: path.resolve(outputPath), segments: bindings.length, triangles, bytes: result.byteLength }, null, 2));
