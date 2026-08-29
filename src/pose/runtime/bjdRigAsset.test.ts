import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';
import type { BjdJointId } from '../../domain/sceneTypes';
import { parseBjdRigV1 } from '../domain/rigContract';
import { createPoseRigAdapter } from '../domain/rigAdapter';
import { solveTwoBoneIk } from '../domain/twoBoneIk';
import { applyBjdFk } from './rigFk';
import { rotationBetweenBendFrames } from './rigKinematics';

const assetRoot = path.resolve('public/pose/chambersu-bjd-female-v1');
const cases: Array<{ joint: BjdJointId; shell: string }> = [
  { joint: 'spineUpper', shell: 'segment_chest' },
  { joint: 'shoulderL', shell: 'segment_upperArmL' },
  { joint: 'elbowUpperL', shell: 'segment_foreArmL' },
  { joint: 'hipL', shell: 'segment_thighL' },
  { joint: 'kneeUpperL', shell: 'segment_calfL' },
];

async function loadRigScene() {
  const rig = parseBjdRigV1(JSON.parse(fs.readFileSync(path.join(assetRoot, 'bjd-rig-v1.json'), 'utf8')));
  const bytes = fs.readFileSync(path.join(assetRoot, 'chambersu-bjd-female-v1.glb'));
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const gltf = await new Promise<Awaited<ReturnType<GLTFLoader['parseAsync']>>>((resolve, reject) => {
    new GLTFLoader().parse(buffer, '', resolve, reject);
  });
  return { rig, scene: gltf.scene };
}

describe('BJD rigid single-joint rig', () => {
  it('keeps Chest, Shoulder, Elbow, Hip and Knee rigid around a fixed center through ±90°', async () => {
    const { rig, scene } = await loadRigScene();
    scene.updateMatrixWorld(true);

    const ownedNodes = new Set<string>();
    for (const [segmentId, binding] of Object.entries(rig.segmentBindings)) {
      expect(ownedNodes.has(binding.node), `${segmentId} duplicate owner`).toBe(false); ownedNodes.add(binding.node);
      const segment = scene.getObjectByName(binding.node)!;
      expect(segment.parent?.name, segmentId).toBe(rig.jointNodes[binding.joint]);
      segment.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        expect(object instanceof THREE.SkinnedMesh, segmentId).toBe(false);
        expect(object.geometry.getAttribute('skinIndex'), segmentId).toBeUndefined();
        expect(object.geometry.getAttribute('skinWeight'), segmentId).toBeUndefined();
      });
    }

    for (const { joint, shell } of cases) {
      for (const [jointId, nodeName] of Object.entries(rig.jointNodes) as Array<[BjdJointId, string]>) {
        const node = scene.getObjectByName(nodeName)!; const rest = rig.restPose[jointId]!;
        node.quaternion.set(rest.x, rest.y, rest.z, rest.w);
      }
      scene.updateMatrixWorld(true);
      const node = scene.getObjectByName(rig.jointNodes[joint])!;
      const mesh = scene.getObjectByName(shell) as THREE.Mesh;
      mesh.geometry.computeBoundingSphere();
      const pivot = node.getWorldPosition(new THREE.Vector3());
      const center = mesh.geometry.boundingSphere!.center.clone().applyMatrix4(mesh.matrixWorld);
      const offset = center.clone().sub(pivot);
      const socket = joint === 'shoulderL' ? scene.getObjectByName('segment_shoulderSocketL') as THREE.Mesh : undefined;
      socket?.geometry.computeBoundingSphere();
      const socketCenter = socket?.geometry.boundingSphere?.center.clone().applyMatrix4(socket.matrixWorld);

      for (const degrees of [-90, 0, 90]) {
        const rest = rig.restPose[joint]!; node.quaternion.set(rest.x, rest.y, rest.z, rest.w)
          .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), THREE.MathUtils.degToRad(degrees)));
        scene.updateMatrixWorld(true);
        const actualPivot = node.getWorldPosition(new THREE.Vector3());
        const actualCenter = mesh.geometry.boundingSphere!.center.clone().applyMatrix4(mesh.matrixWorld);
        const expectedCenter = offset.clone().applyAxisAngle(new THREE.Vector3(1, 0, 0), THREE.MathUtils.degToRad(degrees)).add(pivot);
        expect(actualPivot.distanceTo(pivot), `${joint} ${degrees}° pivot drift`).toBeLessThan(1e-6);
        expect(actualCenter.distanceTo(expectedCenter), `${joint} ${degrees}° rigid shell`).toBeLessThan(1e-6);
        if (socket && socketCenter) {
          const actualSocket = socket.geometry.boundingSphere!.center.clone().applyMatrix4(socket.matrixWorld);
          expect(actualSocket.distanceTo(socketCenter), `${joint} ${degrees}° fixed socket`).toBeLessThan(1e-6);
        }
      }
    }
  });

  it('rebuilds every rigid world transform from rest pose plus rotation deltas', async () => {
    const { rig, scene } = await loadRigScene();
    const joints = new Map((Object.entries(rig.jointNodes) as Array<[BjdJointId, string]>).map(([jointId, nodeName]) => [jointId, scene.getObjectByName(nodeName)!]));
    const deltas: Partial<Record<BjdJointId, { x: number; y: number; z: number; w: number }>> = {};
    (Object.keys(rig.jointNodes) as BjdJointId[]).forEach((jointId, index) => {
      const axis = new THREE.Vector3((index % 3) === 0 ? 1 : 0, (index % 3) === 1 ? 1 : 0, (index % 3) === 2 ? 1 : 0);
      const delta = new THREE.Quaternion().setFromAxisAngle(axis, ((index % 7) - 3) * .07); deltas[jointId] = { x: delta.x, y: delta.y, z: delta.z, w: delta.w };
    });
    const root = scene.getObjectByName(rig.rootNode)!; const rootTransform = { position: { x: root.position.x, y: root.position.y, z: root.position.z }, rotation: { x: root.quaternion.x, y: root.quaternion.y, z: root.quaternion.z, w: root.quaternion.w } };
    const localPositions = new Map(Object.values(rig.segmentBindings).map(({ node }) => [node, scene.getObjectByName(node)!.position.clone()]));
    const apply = (withDeltas: boolean) => applyBjdFk(root, joints, rig.restPose, { rootTransform, jointRotations: withDeltas ? deltas : {} });
    apply(true);
    const expected = new Map(Object.values(rig.segmentBindings).map(({ node }) => [node, scene.getObjectByName(node)!.matrixWorld.clone()]));
    apply(false); apply(true);
    expected.forEach((matrix, nodeName) => {
      const actual = scene.getObjectByName(nodeName)!.matrixWorld.elements;
      matrix.elements.forEach((value, index) => expect(Math.abs(actual[index] - value), `${nodeName} matrix[${index}]`).toBeLessThan(1e-6));
      expect(scene.getObjectByName(nodeName)!.position.distanceTo(localPositions.get(nodeName)!), `${nodeName} local translation`).toBeLessThan(1e-12);
    });
  });

  it('drives wrist and ankle IK through rotation deltas without translating authored nodes', async () => {
    const { rig, scene } = await loadRigScene(); const adapter = createPoseRigAdapter(rig);
    const joints = new Map((Object.entries(rig.jointNodes) as Array<[BjdJointId, string]>).map(([jointId, nodeName]) => [jointId, scene.getObjectByName(nodeName)!]));
    const root = scene.getObjectByName(rig.rootNode)!; const rootTransform = { position: { x: root.position.x, y: root.position.y, z: root.position.z }, rotation: { x: root.quaternion.x, y: root.quaternion.y, z: root.quaternion.z, w: root.quaternion.w } };
    const localPositions = new Map([...joints, ...Object.values(rig.segmentBindings).map(({ node }) => [node as BjdJointId, scene.getObjectByName(node)!] as const)].map(([id, object]) => [String(id), object.position.clone()]));
    for (const chainId of ['armL', 'armR', 'legL', 'legR'] as const) {
      applyBjdFk(root, joints, rig.restPose, { rootTransform, jointRotations: {} });
      const chain = adapter.semanticIkChain(chainId); const rootJoint = adapter.authoredJoint(chain.root); const middleJoint = adapter.authoredJoint(chain.middle); const endJoint = adapter.authoredJoint(chain.end);
      const rootPosition = joints.get(rootJoint)!.getWorldPosition(new THREE.Vector3()); const endPosition = joints.get(endJoint)!.getWorldPosition(new THREE.Vector3());
      const target = endPosition.clone().add(chainId.startsWith('arm')
        ? new THREE.Vector3(chainId.endsWith('L') ? -.08 : .08, .05, .04)
        : new THREE.Vector3(chainId.endsWith('L') ? .04 : -.04, .08, .03));
      const solution = solveTwoBoneIk({ root: rootPosition, target, poleDirection: chain.defaultPoleDirection, upperLength: chain.upperLength, lowerLength: chain.lowerLength, minBend: chain.minBend, maxBend: chain.maxBend });
      const rotations = adapter.rotationDeltasFor({ joint: chain.middle, bendAngle: solution.middleBend }, (jointId, angle) => {
        const basisValue = rig.axisBasis[jointId]; const basis = new THREE.Quaternion(basisValue.x, basisValue.y, basisValue.z, basisValue.w); const axis = new THREE.Vector3(chain.flexionAxis.x, chain.flexionAxis.y, chain.flexionAxis.z);
        const value = basis.clone().multiply(new THREE.Quaternion().setFromAxisAngle(axis, angle)).multiply(basis.clone().invert()).normalize(); return { x: value.x, y: value.y, z: value.z, w: value.w };
      });
      applyBjdFk(root, joints, rig.restPose, { rootTransform, jointRotations: rotations });
      const currentRoot = joints.get(rootJoint)!.getWorldPosition(new THREE.Vector3()); const currentMiddle = joints.get(middleJoint)!.getWorldPosition(new THREE.Vector3()); const currentEnd = joints.get(endJoint)!.getWorldPosition(new THREE.Vector3()); const desiredMiddle = new THREE.Vector3(solution.middle.x, solution.middle.y, solution.middle.z);
      const currentUpper = currentMiddle.clone().sub(currentRoot); const correction = rotationBetweenBendFrames(currentUpper, currentUpper.clone().cross(currentEnd.clone().sub(currentMiddle)), desiredMiddle.clone().sub(currentRoot), new THREE.Vector3(solution.bendNormal.x, solution.bendNormal.y, solution.bendNormal.z).negate()); const rootWorld = joints.get(rootJoint)!.getWorldQuaternion(new THREE.Quaternion()); const parentWorld = joints.get(rootJoint)!.parent!.getWorldQuaternion(new THREE.Quaternion()); const desiredLocal = parentWorld.invert().multiply(correction.multiply(rootWorld)); const rest = rig.restPose[rootJoint]!; const delta = new THREE.Quaternion(rest.x, rest.y, rest.z, rest.w).invert().multiply(desiredLocal).normalize(); rotations[rootJoint] = { x: delta.x, y: delta.y, z: delta.z, w: delta.w };
      applyBjdFk(root, joints, rig.restPose, { rootTransform, jointRotations: rotations });
      expect(joints.get(endJoint)!.getWorldPosition(new THREE.Vector3()).distanceTo(new THREE.Vector3(solution.clampedTarget.x, solution.clampedTarget.y, solution.clampedTarget.z)), chainId).toBeLessThan(.003);
      localPositions.forEach((position, id) => { const object = joints.get(id as BjdJointId) ?? scene.getObjectByName(id); expect(object!.position.distanceTo(position), `${chainId} translated ${id}`).toBeLessThan(1e-12); });
    }
  });
});
