import type { SceneItem, SceneItemPatch } from '../../types';
import type { SceneBounds } from '../scene/SceneNode';
import type { TransformHandle } from './SelectionOverlay';

export type ImageTransformChange = SceneItemPatch;

export function transformImageSelection(options: {
  start: { x: number; y: number };
  current: { x: number; y: number };
  originals: SceneItem[];
  bounds: SceneBounds;
  handle: TransformHandle;
}): ImageTransformChange[] {
  const { start, current, originals, bounds, handle } = options;
  const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  if (handle === 'rotate') {
    const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
    const currentAngle = Math.atan2(current.y - center.y, current.x - center.x);
    const delta = (currentAngle - startAngle) * 180 / Math.PI;
    const radians = delta * Math.PI / 180;
    return originals.map((item) => {
      const itemCenter = { x: item.x + item.width / 2, y: item.y + item.height / 2 };
      const dx = itemCenter.x - center.x;
      const dy = itemCenter.y - center.y;
      const nextCenter = { x: center.x + dx * Math.cos(radians) - dy * Math.sin(radians), y: center.y + dx * Math.sin(radians) + dy * Math.cos(radians) };
      return { id: item.id, x: nextCenter.x - item.width / 2, y: nextCenter.y - item.height / 2, rotation: item.rotation + delta };
    });
  }
  const fixed = {
    x: handle.includes('west') ? bounds.x + bounds.width : bounds.x,
    y: handle.includes('north') ? bounds.y + bounds.height : bounds.y,
  };
  const initialDistance = Math.max(1, Math.hypot(start.x - fixed.x, start.y - fixed.y));
  const factor = Math.max(0.02, Math.hypot(current.x - fixed.x, current.y - fixed.y) / initialDistance);
  return originals.map((item) => {
    const itemCenter = { x: item.x + item.width / 2, y: item.y + item.height / 2 };
    const nextCenter = { x: fixed.x + (itemCenter.x - fixed.x) * factor, y: fixed.y + (itemCenter.y - fixed.y) * factor };
    return { id: item.id, x: nextCenter.x - item.width * factor / 2, y: nextCenter.y - item.height * factor / 2, width: item.width * factor, height: item.height * factor };
  });
}
