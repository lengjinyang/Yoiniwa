import { CAMERA_MAX_SCALE, CAMERA_MIN_SCALE } from '../runtime/CanvasConfig';

export function clampCameraScale(scale: number, minimum = CAMERA_MIN_SCALE, maximum = CAMERA_MAX_SCALE) {
  if (!Number.isFinite(scale)) return 1;
  return Math.max(minimum, Math.min(maximum, scale));
}
