import type { Vec3 } from '../../domain/sceneTypes';

export function lightingIntensities(contrast: number) {
  const c = Math.min(1, Math.max(0, contrast));
  return { ambient: 1 - 0.8 * c, directional: 0.8 + 2.4 * c };
}

export function normalizeDirection(direction: Vec3): Vec3 {
  const length = Math.hypot(direction.x, direction.y, direction.z) || 1;
  return { x: direction.x / length, y: direction.y / length, z: direction.z / length };
}
