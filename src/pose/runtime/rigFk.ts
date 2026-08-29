import { Quaternion as ThreeQuaternion, type Object3D } from 'three';
import type { BjdJointId, PoseDocumentV1, Quaternion } from '../../domain/sceneTypes';

/** The sole runtime writer for authored BJD joint transforms. */
export function applyBjdFk(
  root: Object3D,
  joints: ReadonlyMap<BjdJointId, Object3D>,
  restPose: Partial<Record<BjdJointId, Quaternion>>,
  pose: Pick<PoseDocumentV1, 'rootTransform' | 'jointRotations'>,
) {
  root.position.set(pose.rootTransform.position.x, pose.rootTransform.position.y, pose.rootTransform.position.z);
  root.quaternion.set(pose.rootTransform.rotation.x, pose.rootTransform.rotation.y, pose.rootTransform.rotation.z, pose.rootTransform.rotation.w).normalize();
  joints.forEach((joint, jointId) => {
    const rest = restPose[jointId]; if (!rest) return;
    const delta = pose.jointRotations[jointId]; joint.quaternion.set(rest.x, rest.y, rest.z, rest.w);
    if (delta) joint.quaternion.multiply(new ThreeQuaternion(delta.x, delta.y, delta.z, delta.w));
    joint.quaternion.normalize();
  });
  root.updateMatrixWorld(true);
}
