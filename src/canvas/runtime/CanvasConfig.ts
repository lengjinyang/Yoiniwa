export const CANVAS_DPR_MAX = 2;
export const CAMERA_MIN_SCALE = 0.02;
export const CAMERA_MAX_SCALE = 32;
export const CAMERA_ZOOM_STEP = 1.12;

export function boundedDevicePixelRatio(value = window.devicePixelRatio || 1) {
  return Math.max(1, Math.min(CANVAS_DPR_MAX, value));
}
