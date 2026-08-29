import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

class NodeFileReader {
  result = null; onloadend = null;
  readAsArrayBuffer(blob) { blob.arrayBuffer().then((value) => { this.result = value; this.onloadend?.(); }); }
  readAsDataURL(blob) { blob.arrayBuffer().then((value) => { this.result = `data:${blob.type};base64,${Buffer.from(value).toString('base64')}`; this.onloadend?.(); }); }
}
globalThis.FileReader ??= NodeFileReader;
globalThis.ProgressEvent ??= class ProgressEvent { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } };

const [assetPath, rigPath] = process.argv.slice(2);
if (!assetPath || !rigPath) throw new Error('Usage: node scripts/add-pose-toes.mjs <pose.glb> <bjd-rig-v1.json>');

const bytes = fs.readFileSync(path.resolve(assetPath));
const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const gltf = await new Promise((resolve, reject) => new GLTFLoader().parse(buffer, '', resolve, reject));

function partition(geometry, classify) {
  const source = geometry.index ? geometry.toNonIndexed() : geometry.clone(); const position = source.getAttribute('position'); const normal = source.getAttribute('normal');
  const buckets = { heel: [[], []], toes: [[], []], bigToe: [[], []] };
  for (let index = 0; index < position.count; index += 3) {
    const x = (position.getX(index) + position.getX(index + 1) + position.getX(index + 2)) / 3;
    const z = (position.getZ(index) + position.getZ(index + 1) + position.getZ(index + 2)) / 3; const bucket = buckets[classify(x, z)];
    for (let vertex = index; vertex < index + 3; vertex += 1) {
      bucket[0].push(position.getX(vertex), position.getY(vertex), position.getZ(vertex));
      bucket[1].push(normal.getX(vertex), normal.getY(vertex), normal.getZ(vertex));
    }
  }
  source.dispose();
  return Object.fromEntries(Object.entries(buckets).map(([key, [positions, normals]]) => {
    const result = new THREE.BufferGeometry(); result.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); result.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3)); result.computeBoundingBox(); result.computeBoundingSphere(); return [key, result];
  }));
}

const rig = JSON.parse(fs.readFileSync(path.resolve(rigPath), 'utf8')); const identity = { x: 0, y: 0, z: 0, w: 1 }; const deg = (value) => value * Math.PI / 180;
for (const side of ['L', 'R']) {
  const ankle = gltf.scene.getObjectByName(`joint_ankle${side}`); const foot = gltf.scene.getObjectByName(`segment_foot${side}`);
  if (!ankle || !foot?.isMesh) throw new Error(`Missing authored foot ${side}`);
  if (gltf.scene.getObjectByName(`joint_toeBase${side}`)) continue;
  const medial = side === 'L' ? -1 : 1; const parts = partition(foot.geometry, (x, z) => z >= -.045 ? 'heel' : medial * x > .006 ? 'bigToe' : 'toes');
  foot.geometry = parts.heel;
  const toeBase = new THREE.Group(); toeBase.name = `joint_toeBase${side}`; toeBase.position.set(0, -.085, -.045); ankle.add(toeBase);
  const toeMesh = new THREE.Mesh(parts.toes.translate(0, .085, .045), foot.material); toeMesh.name = `segment_toes${side}`; toeMesh.castShadow = foot.castShadow; toeMesh.receiveShadow = foot.receiveShadow; toeBase.add(toeMesh);
  const bigToe = new THREE.Group(); bigToe.name = `joint_bigToe${side}`; bigToe.position.set(medial * .012, -.02, -.025); toeBase.add(bigToe);
  const bigMesh = new THREE.Mesh(parts.bigToe.translate(-medial * .012, .105, .07), foot.material); bigMesh.name = `segment_bigToe${side}`; bigMesh.castShadow = foot.castShadow; bigMesh.receiveShadow = foot.receiveShadow; bigToe.add(bigMesh);

  const anklePivot = rig.jointPivots[`ankle${side}`]; const toeId = `toeBase${side}`; const bigId = `bigToe${side}`;
  rig.restPose[toeId] = identity; rig.restPose[bigId] = identity; rig.axisBasis[toeId] = identity; rig.axisBasis[bigId] = identity;
  rig.jointNodes[toeId] = toeBase.name; rig.jointNodes[bigId] = bigToe.name;
  rig.jointPivots[toeId] = { x: anklePivot.x, y: anklePivot.y - .085, z: anklePivot.z - .045 };
  rig.jointPivots[bigId] = { x: anklePivot.x + medial * .012, y: anklePivot.y - .105, z: anklePivot.z - .07 };
  rig.jointLimits[toeId] = { min: { x: deg(-55), y: deg(-12), z: deg(-15) }, max: { x: deg(40), y: deg(12), z: deg(15) } };
  rig.jointLimits[bigId] = { min: { x: deg(-55), y: deg(-18), z: deg(-20) }, max: { x: deg(40), y: deg(18), z: deg(20) } };
  rig.segmentBindings[`toes${side}`] = { node: toeMesh.name, joint: toeId, materialRole: 'body' };
  rig.segmentBindings[`bigToe${side}`] = { node: bigMesh.name, joint: bigId, materialRole: 'body' };
  rig.pickTargets[toeMesh.name] = toeId; rig.pickTargets[bigMesh.name] = bigId;
}
if (!rig.mirrorPairs.some((pair) => pair.left === 'toeBaseL')) rig.mirrorPairs.push({ left: 'toeBaseL', right: 'toeBaseR', axisTransform: { x: 1, y: -1, z: -1 } }, { left: 'bigToeL', right: 'bigToeR', axisTransform: { x: 1, y: -1, z: -1 } });
if (rig.grounding?.footNodes) rig.grounding.footNodes = ['segment_footL', 'segment_toesL', 'segment_bigToeL', 'segment_footR', 'segment_toesR', 'segment_bigToeR'];

const output = await new GLTFExporter().parseAsync(gltf.scene, { binary: true, onlyVisible: true, includeCustomExtensions: false, maxTextureSize: 1024 });
fs.writeFileSync(path.resolve(assetPath), Buffer.from(output)); fs.writeFileSync(path.resolve(rigPath), `${JSON.stringify(rig, null, 2)}\n`);
