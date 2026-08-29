import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';
import { parseBjdRigV1 } from './rigContract';
import { createThumbBendBases } from './thumbAxes';

const rig = parseBjdRigV1(JSON.parse(readFileSync(new URL('../../../public/pose/chambersu-bjd-female-v1/bjd-rig-v1.json', import.meta.url), 'utf8')));
const vector = (value: { x: number; y: number; z: number }) => new THREE.Vector3(value.x, value.y, value.z);
const asset = readFileSync(new URL('../../../public/pose/chambersu-bjd-female-v1/chambersu-bjd-female-v1.glb', import.meta.url));
const scenePromise = new GLTFLoader().parseAsync(asset.buffer.slice(asset.byteOffset, asset.byteOffset + asset.byteLength), '').then((gltf) => { gltf.scene.updateMatrixWorld(true); return gltf.scene; });
const bases = async (side: 'L' | 'R') => {
  const scene = await scenePromise; const joint = scene.getObjectByName(`joint_thumbDistal${side}`)!; const segment = scene.getObjectByName(`segment_thumbDistal${side}`)!;
  const inverse = joint.matrixWorld.clone().invert(); const point = new THREE.Vector3(); let farthest = new THREE.Vector3(); let distance = 0;
  segment.traverse((object) => {
    const mesh = object as THREE.Mesh; const positions = mesh.geometry?.getAttribute('position'); if (!positions) return;
    for (let index = 0; index < positions.count; index += 1) {
      point.fromBufferAttribute(positions, index).applyMatrix4(mesh.matrixWorld).applyMatrix4(inverse);
      if (point.lengthSq() > distance) { distance = point.lengthSq(); farthest = point.clone(); }
    }
  });
  return createThumbBendBases(rig.jointPivots, side, farthest);
};

describe('authored thumb bend bases', () => {
  it('makes positive Curl bend every thumb joint toward the palm target', async () => {
    for (const side of ['L', 'R'] as const) for (const basis of await bases(side)) {
      const child = vector(basis.childDirection); const axis = vector(basis.flexAxis); const target = vector(basis.palmTargetDirection);
      const positive = child.clone().applyAxisAngle(axis, .25).dot(target);
      const negative = child.clone().applyAxisAngle(axis, -.25).dot(target);
      expect(positive, basis.joint).toBeGreaterThan(negative);
    }
  });

  it('mirrors axial Curl directions and does not share one XYZ axis across Thumb1/2/3', async () => {
    const left = await bases('L'); const right = await bases('R');
    left.forEach((basis, index) => {
      expect(right[index].flexAxis.x).toBeCloseTo(basis.flexAxis.x, 4);
      expect(right[index].flexAxis.y).toBeCloseTo(-basis.flexAxis.y, 4);
      expect(right[index].flexAxis.z).toBeCloseTo(-basis.flexAxis.z, 4);
    });
    expect(Math.abs(vector(left[0].flexAxis).dot(vector(left[1].flexAxis)))).toBeLessThan(.999);
    expect(Math.abs(vector(left[1].flexAxis).dot(vector(left[2].flexAxis)))).toBeLessThan(.99999);
  });
});
