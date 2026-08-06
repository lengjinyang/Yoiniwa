export type ImageDragMode = 'move' | 'pan' | 'rotate' | 'scale' | 'opacity';
export type ColorPickerShortcut = 's' | 'alt';
// These are numerical guardrails rather than user-facing zoom limits. They are
// far outside practical use but keep matrices finite after extreme wheel input.
export const MIN_ZOOM = 1e-9;
export const MAX_ZOOM = 1e9;

export interface ViewportTransform { x: number; y: number; scale: number }
export interface Point { x: number; y: number }

export function zoomViewportAtPoint(viewport: ViewportTransform, pointer: Point, deltaY: number) {
  const factor = Math.max(0.78, Math.min(1.28, Math.exp(-deltaY * 0.0018)));
  const scale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, viewport.scale * factor));
  const worldX = (pointer.x - viewport.x) / viewport.scale;
  const worldY = (pointer.y - viewport.y) / viewport.scale;
  return { x: pointer.x - worldX * scale, y: pointer.y - worldY * scale, scale };
}

export function offsetPointOutward(point: Point, center: Point, screenDistance: number, viewportScale: number) {
  const distance = screenDistance / Math.max(0.001, viewportScale);
  const deltaX = point.x - center.x;
  const deltaY = point.y - center.y;
  const length = Math.max(0.001, Math.hypot(deltaX, deltaY));
  return { x: point.x + deltaX / length * distance, y: point.y + deltaY / length * distance };
}

export function isPrimaryPointerButton(button: number) {
  return button === 0;
}

export interface PointerModifiers { ctrlKey: boolean; altKey: boolean; shiftKey: boolean }

export function matchesColorPickerShortcut(shortcut: ColorPickerShortcut, event: PointerModifiers & { key: string; code: string }) {
  if (event.ctrlKey || event.shiftKey) return false;
  if (shortcut === 'alt') return event.key === 'Alt' || event.code === 'AltLeft' || event.code === 'AltRight';
  return !event.altKey && (event.key.toLowerCase() === 's' || event.code === 'KeyS');
}

export function isAltColorPickerPointer(
  shortcut: ColorPickerShortcut,
  event: PointerModifiers & { button: number; buttons?: number; pointerType?: string },
) {
  const buttons = event.buttons ?? (event.button === 0 ? 1 : 0);
  const penTip = event.pointerType === 'pen'
    && (event.button === 0 || (event.button === -1 && (buttons & 1) !== 0))
    && (buttons & ~1) === 0;
  const primaryContact = event.pointerType === 'pen' ? penTip : event.button === 0;
  return shortcut === 'alt' && primaryContact && event.altKey && !event.ctrlKey && !event.shiftKey;
}

export function getImageDragMode(modifiers: PointerModifiers): ImageDragMode {
  if (modifiers.altKey && !modifiers.ctrlKey) return 'pan';
  if (modifiers.ctrlKey && modifiers.altKey && modifiers.shiftKey) return 'opacity';
  if (modifiers.ctrlKey && modifiers.altKey) return 'scale';
  if (modifiers.ctrlKey) return 'rotate';
  return 'move';
}

export function exceededWindowMoveThreshold(startX: number, startY: number, currentX: number, currentY: number, threshold = 5) {
  return Math.hypot(currentX - startX, currentY - startY) >= threshold;
}

export function edgeAutoPanDelta(value: number, extent: number, threshold: number) {
  if (value < threshold) return Math.min(18, 2 + (threshold - value) * 0.35);
  if (value > extent - threshold) return -Math.min(18, 2 + (value - extent + threshold) * 0.35);
  return 0;
}
