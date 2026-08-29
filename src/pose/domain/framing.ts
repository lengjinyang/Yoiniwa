export interface Bounds3 { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }

export interface FittedCamera {
  center: { x: number; y: number; z: number };
  perspectiveDistance: number;
  orthographicHeight: number;
}

/** Fits both axes with a 12% margin; callers preserve their current viewing direction. */
export function fitBounds(bounds: Bounds3, aspect: number, verticalFovRadians: number, margin = 0.12): FittedCamera {
  const width = Math.max(0.001, bounds.max.x - bounds.min.x);
  const height = Math.max(0.001, bounds.max.y - bounds.min.y);
  const depth = Math.max(0.001, bounds.max.z - bounds.min.z);
  const safeAspect = Math.max(0.001, aspect);
  const paddedWidth = width * (1 + margin * 2);
  const paddedHeight = height * (1 + margin * 2);
  const requiredHeight = Math.max(paddedHeight, paddedWidth / safeAspect);
  return {
    center: {
      x: (bounds.min.x + bounds.max.x) / 2,
      y: (bounds.min.y + bounds.max.y) / 2,
      z: (bounds.min.z + bounds.max.z) / 2,
    },
    perspectiveDistance: requiredHeight / (2 * Math.tan(Math.max(0.001, verticalFovRadians) / 2)) + depth / 2,
    orthographicHeight: requiredHeight,
  };
}

export function outputFrameRect(width: number, height: number, aspect: number, fill = 0.86) {
  const frameWidth = Math.max(1, Math.min(width * fill, height * fill * aspect));
  const frameHeight = Math.max(1, frameWidth / aspect);
  return { x: (width - frameWidth) / 2, y: (height - frameHeight) / 2, width: frameWidth, height: frameHeight };
}
