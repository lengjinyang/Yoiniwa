import { MAX_ZOOM, MIN_ZOOM } from '../../shared/pointerPolicy';

const CANVAS_DPR_MAX = 2;
export const CAMERA_MIN_SCALE = MIN_ZOOM;
export const CAMERA_MAX_SCALE = MAX_ZOOM;
export const CAMERA_ZOOM_STEP = 1.12;
export const CAMERA_SETTLE_MS = 160;

export function boundedDevicePixelRatio(value = window.devicePixelRatio || 1) {
  return Math.max(1, Math.min(CANVAS_DPR_MAX, value));
}
