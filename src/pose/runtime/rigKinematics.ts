import { Matrix4, Quaternion, Vector3 } from 'three';

const frameRotation = (forwardValue: Vector3, upValue: Vector3) => {
  const forward = forwardValue.clone().normalize(); const up = upValue.clone().addScaledVector(forward, -upValue.dot(forward)).normalize();
  const right = up.clone().cross(forward).normalize(); const correctedUp = forward.clone().cross(right).normalize();
  return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(right, correctedUp, forward));
};

/** Maps both limb direction and bend plane, including the shoulder/hip twist needed to keep the endpoint in-plane. */
export function rotationBetweenBendFrames(fromDirection: Vector3, fromNormal: Vector3, toDirection: Vector3, toNormal: Vector3) {
  return frameRotation(toDirection, toNormal).multiply(frameRotation(fromDirection, fromNormal).invert()).normalize();
}

/** Points an end effector at a direction with the minimum rotation, preserving its natural roll. */
export function orientationTowardDirection(start: Quaternion, localForward: Vector3, direction: Vector3) {
  const from = localForward.clone().applyQuaternion(start).normalize(); const to = direction.clone().normalize(); const dot = from.dot(to);
  let correction: Quaternion;
  if (dot < -.999999) {
    const axis = Math.abs(from.x) < .9 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0); axis.addScaledVector(from, -axis.dot(from)).normalize();
    correction = new Quaternion().setFromAxisAngle(axis, Math.PI);
  } else correction = new Quaternion().setFromUnitVectors(from, to);
  return correction.multiply(start.clone()).normalize();
}

/** Hidden advanced roll: twists around the end effector's current pointing direction. */
export function rollEndOrientation(start: Quaternion, localForward: Vector3, angle: number) {
  const forward = localForward.clone().applyQuaternion(start).normalize();
  return new Quaternion().setFromAxisAngle(forward, angle).multiply(start.clone()).normalize();
}
