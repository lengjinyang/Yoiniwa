import type { ImageItem, VisualMark, VisualNoteAnchor, VisualNotePoint } from '../types';

export interface Point { x: number; y: number }

export function worldToImageSource(item: ImageItem, point: Point): Point {
  const centerX = item.x + item.width / 2;
  const centerY = item.y + item.height / 2;
  const radians = -item.rotation * Math.PI / 180;
  const dx = point.x - centerX;
  const dy = point.y - centerY;
  let localX = dx * Math.cos(radians) - dy * Math.sin(radians);
  let localY = dx * Math.sin(radians) + dy * Math.cos(radians);
  if (item.flipX) localX *= -1;
  if (item.flipY) localY *= -1;
  return {
    x: item.crop.x + (localX / Math.max(1e-6, item.width) + 0.5) * item.crop.width,
    y: item.crop.y + (localY / Math.max(1e-6, item.height) + 0.5) * item.crop.height,
  };
}

export function imageSourceToWorld(item: ImageItem, point: Point): Point {
  let localX = ((point.x - item.crop.x) / Math.max(1e-6, item.crop.width) - 0.5) * item.width;
  let localY = ((point.y - item.crop.y) / Math.max(1e-6, item.crop.height) - 0.5) * item.height;
  if (item.flipX) localX *= -1;
  if (item.flipY) localY *= -1;
  const radians = item.rotation * Math.PI / 180;
  const centerX = item.x + item.width / 2;
  const centerY = item.y + item.height / 2;
  return {
    x: centerX + localX * Math.cos(radians) - localY * Math.sin(radians),
    y: centerY + localX * Math.sin(radians) + localY * Math.cos(radians),
  };
}

export function pointToAnchor(point: Point, anchor: VisualNoteAnchor, images: readonly ImageItem[]): Point {
  if (anchor.type === 'scene') return point;
  const image = images.find((item) => item.id === anchor.imageId);
  return image ? worldToImageSource(image, point) : point;
}

export function pointFromAnchor(point: Point, anchor: VisualNoteAnchor, images: readonly ImageItem[]): Point {
  if (anchor.type === 'scene') return point;
  const image = images.find((item) => item.id === anchor.imageId);
  return image ? imageSourceToWorld(image, point) : point;
}

export function markWorldPoints(mark: VisualMark, images: readonly ImageItem[]): VisualNotePoint[] {
  const raw = mark.kind === 'stroke' ? mark.points : mark.kind === 'arrow' ? [mark.start, mark.end] : [mark.point];
  return raw.map((point) => ({ ...point, ...pointFromAnchor(point, mark.anchor, images) }));
}

export function markWorldBounds(mark: VisualMark, images: readonly ImageItem[]) {
  const points = markWorldPoints(mark, images);
  const padding = mark.style.baseWidth * 2;
  const x = Math.min(...points.map((point) => point.x)) - padding;
  const y = Math.min(...points.map((point) => point.y)) - padding;
  const right = Math.max(...points.map((point) => point.x)) + padding;
  const bottom = Math.max(...points.map((point) => point.y)) + padding;
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}

export function moveSceneMark(mark: VisualMark, deltaX: number, deltaY: number): VisualMark {
  if (mark.anchor.type !== 'scene') return mark;
  const move = (point: VisualNotePoint) => ({ ...point, x: point.x + deltaX, y: point.y + deltaY });
  if (mark.kind === 'stroke') return { ...mark, points: mark.points.map(move) };
  if (mark.kind === 'arrow') return { ...mark, start: move(mark.start), end: move(mark.end) };
  return { ...mark, point: move(mark.point) };
}

/** Move either scene- or image-anchored marks in world space, then map back to their stable anchor coordinates. */
export function moveMarkInWorld(mark: VisualMark, images: readonly ImageItem[], deltaX: number, deltaY: number): VisualMark {
  const move = (point: VisualNotePoint) => {
    const world = pointFromAnchor(point, mark.anchor, images);
    const anchored = pointToAnchor({ x: world.x + deltaX, y: world.y + deltaY }, mark.anchor, images);
    return { ...point, ...anchored };
  };
  if (mark.kind === 'stroke') return { ...mark, points: mark.points.map(move) };
  if (mark.kind === 'arrow') return { ...mark, start: move(mark.start), end: move(mark.end) };
  return { ...mark, point: move(mark.point) };
}
