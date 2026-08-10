import type { ArrowVisualMark, BrushVisualMark, ImageItem, VisualMark, VisualNotePoint } from '../types';
import { markWorldPoints, pointToAnchor, type Point } from './VisualNoteGeometry';

function segmentDistance(point: Point, start: Point, end: Point) {
  const dx = end.x - start.x; const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared ? Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared)) : 0;
  return Math.hypot(point.x - (start.x + dx * t), point.y - (start.y + dy * t));
}

function orientation(a: Point, b: Point, c: Point) {
  return Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point) {
  return orientation(a, b, c) !== orientation(a, b, d)
    && orientation(c, d, a) !== orientation(c, d, b);
}

function segmentToSegmentDistance(a: Point, b: Point, c: Point, d: Point) {
  if (segmentsIntersect(a, b, c, d)) return 0;
  return Math.min(segmentDistance(a, c, d), segmentDistance(b, c, d),
    segmentDistance(c, a, b), segmentDistance(d, a, b));
}

function pointInTriangle(point: Point, a: Point, b: Point, c: Point) {
  const d1 = orientation(point, a, b); const d2 = orientation(point, b, c); const d3 = orientation(point, c, a);
  return (d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0);
}

function arrowHead(mark: ArrowVisualMark, images: readonly ImageItem[]) {
  const [start, end] = markWorldPoints(mark, images);
  const angle = Math.atan2(end.y - start.y, end.x - start.x);
  // Keep the semantic hit region slightly wider than the painted chevron so a
  // normal pen/eraser contact near the tip is not missed between samples.
  const size = Math.max(8, mark.style.baseWidth * 4.5);
  return { start, end, left: { x: end.x - Math.cos(angle - 0.48) * size, y: end.y - Math.sin(angle - 0.48) * size },
    right: { x: end.x - Math.cos(angle + 0.48) * size, y: end.y - Math.sin(angle + 0.48) * size } };
}

function eraserHitsArrowHead(mark: ArrowVisualMark, images: readonly ImageItem[], eraserPath: readonly Point[], radius: number) {
  const { end, left, right } = arrowHead(mark, images);
  const edges: Array<[Point, Point]> = [[end, left], [left, right], [right, end]];
  const tipRadius = Math.max(radius, mark.style.baseWidth * 2.5);
  const pointHit = (point: Point) => Math.hypot(point.x - end.x, point.y - end.y) <= tipRadius
    || pointInTriangle(point, end, left, right)
    || edges.some(([a, b]) => segmentDistance(point, a, b) <= radius);
  if (eraserPath.some(pointHit)) return true;
  return eraserPath.slice(1).some((point, index) => edges.some(([a, b]) =>
    segmentToSegmentDistance(eraserPath[index], point, a, b) <= radius));
}

/** Arrows remain semantic objects: touching their shaft or head removes the whole arrow. */
export function eraserHitsArrow(
  mark: ArrowVisualMark, images: readonly ImageItem[], eraserPath: readonly Point[], radius: number,
) {
  if (!eraserPath.length) return false;
  const [start, end] = markWorldPoints(mark, images);
  const shaftRadius = mark.style.baseWidth * Math.max(start.widthFactor, end.widthFactor) / 2;
  if (eraserHitsArrowHead(mark, images, eraserPath, radius)) return true;
  if (eraserPath.length === 1) return segmentDistance(eraserPath[0], start, end) <= radius + shaftRadius;
  return eraserPath.slice(1).some((point, index) => segmentToSegmentDistance(
    eraserPath[index], point, start, end,
  ) <= radius + shaftRadius);
}

/** Locally erases an arrow. The surviving segment that still owns the tip
 * remains an arrow; detached shaft fragments become ordinary brush strokes. */
export function eraseArrow(
  mark: ArrowVisualMark, images: readonly ImageItem[], eraserPath: readonly Point[], radius: number,
  createId: () => string = () => crypto.randomUUID(), precision = radius / 12,
): VisualMark[] {
  if (!eraserHitsArrow(mark, images, eraserPath, radius)) return [mark];
  const headWasHit = eraserHitsArrowHead(mark, images, eraserPath, radius);
  const shaft: BrushVisualMark = { ...mark, kind: 'stroke', points: [mark.start, mark.end] };
  const fragments = eraseStroke(shaft, images, eraserPath, radius, createId, precision);
  if (headWasHit) return fragments;
  const originalEnd = markWorldPoints(mark, images)[1];
  return fragments.map<VisualMark>((fragment) => {
    const points = markWorldPoints(fragment, images);
    const last = points.at(-1);
    if (!last || Math.hypot(last.x - originalEnd.x, last.y - originalEnd.y) > precision * 2) return fragment;
    return { ...mark, id: fragment.id, start: fragment.points[0], end: fragment.points.at(-1)! };
  });
}

export function eraseStroke(
  mark: BrushVisualMark, images: readonly ImageItem[], eraserPath: readonly Point[], radius: number,
  createId: () => string = () => crypto.randomUUID(), precision = radius / 12,
) {
  if (!eraserPath.length) return [mark];
  const world = markWorldPoints(mark, images);
  const hit = (point: VisualNotePoint) => {
    const hitRadius = radius + mark.style.baseWidth * point.widthFactor / 2;
    if (eraserPath.length === 1) return Math.hypot(point.x - eraserPath[0].x, point.y - eraserPath[0].y) <= hitRadius;
    return eraserPath.slice(1).some((end, index) => segmentDistance(point, eraserPath[index], end) <= hitRadius);
  };
  // Brush samples may be far apart. Densifying in screen-sized increments and
  // refining transitions prevents an entire long sample interval disappearing
  // when only a small part intersects the eraser capsule.
  const step = Math.max(1e-4, precision);
  const dense: VisualNotePoint[] = [];
  world.forEach((point, index) => {
    if (!index) { dense.push(point); return; }
    const start = world[index - 1];
    const count = Math.max(1, Math.ceil(Math.hypot(point.x - start.x, point.y - start.y) / step));
    for (let sample = 1; sample <= count; sample += 1) {
      const t = sample / count;
      dense.push({ x: start.x + (point.x - start.x) * t, y: start.y + (point.y - start.y) * t,
        widthFactor: start.widthFactor + (point.widthFactor - start.widthFactor) * t });
    }
  });
  const erased = dense.map(hit);
  if (!erased.some(Boolean)) return [mark];
  const boundary = (outside: VisualNotePoint, inside: VisualNotePoint) => {
    let safe = outside; let erasedPoint = inside;
    for (let iteration = 0; iteration < 8; iteration += 1) {
      const middle = { x: (safe.x + erasedPoint.x) / 2, y: (safe.y + erasedPoint.y) / 2,
        widthFactor: (safe.widthFactor + erasedPoint.widthFactor) / 2 };
      if (hit(middle)) erasedPoint = middle; else safe = middle;
    }
    return safe;
  };
  const runs: VisualNotePoint[][] = [];
  let current: VisualNotePoint[] = [];
  dense.forEach((point, index) => {
    const previous = index ? dense[index - 1] : undefined;
    const wasErased = index ? erased[index - 1] : erased[index];
    if (!erased[index]) {
      if (wasErased && previous) current = [boundary(point, previous)];
      current.push(point);
    } else if (!wasErased && previous) {
      current.push(boundary(previous, point));
      if (current.length >= 2) runs.push(current);
      current = [];
    }
  });
  if (current.length >= 2) runs.push(current);
  return runs.map((points, index) => ({ ...mark, id: index === 0 ? mark.id : createId(),
    points: points.map((point) => ({ ...pointToAnchor(point, mark.anchor, images), widthFactor: point.widthFactor })) }));
}
