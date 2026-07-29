import type { AnnotationItem } from './types';

interface Point { x: number; y: number }

function segmentDistance(point: Point, start: Point, end: Point) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (!lengthSquared) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}

function polylineHit(points: number[], point: Point, radius: number) {
  for (let index = 2; index < points.length; index += 2) {
    if (segmentDistance(point, { x: points[index - 2], y: points[index - 1] }, { x: points[index], y: points[index + 1] }) <= radius) return true;
  }
  return false;
}

function shapeHit(annotation: AnnotationItem, point: Point, radius: number) {
  if (annotation.points) return polylineHit(annotation.points, point, radius + annotation.strokeWidth / 2);
  const x = annotation.x ?? 0; const y = annotation.y ?? 0;
  const width = annotation.width ?? 0; const height = annotation.height ?? 0;
  if (annotation.type === 'rectangle') {
    const edges = [
      [{ x, y }, { x: x + width, y }], [{ x: x + width, y }, { x: x + width, y: y + height }],
      [{ x: x + width, y: y + height }, { x, y: y + height }], [{ x, y: y + height }, { x, y }],
    ] as const;
    return edges.some(([start, end]) => segmentDistance(point, start, end) <= radius + annotation.strokeWidth / 2);
  }
  const rx = Math.max(0.5, Math.abs(width) / 2); const ry = Math.max(0.5, Math.abs(height) / 2);
  const normalized = Math.hypot((point.x - x - width / 2) / rx, (point.y - y - height / 2) / ry);
  return Math.abs(normalized - 1) * Math.min(rx, ry) <= radius + annotation.strokeWidth / 2;
}

export interface AnnotationEraseResult {
  annotations: AnnotationItem[];
  removedIds: string[];
  splitMembers: Array<{ sourceId: string; newId: string }>;
  changed: boolean;
}

export function eraseAnnotationsAt(
  annotations: AnnotationItem[], x: number, y: number, radius: number,
  createId: () => string = () => crypto.randomUUID(),
): AnnotationEraseResult {
  const output: AnnotationItem[] = [];
  const removedIds: string[] = [];
  const splitMembers: Array<{ sourceId: string; newId: string }> = [];
  let changed = false;
  for (const annotation of annotations) {
    if (annotation.type !== 'pen' || !annotation.points) {
      if (shapeHit(annotation, { x, y }, radius)) { removedIds.push(annotation.id); changed = true; }
      else output.push(annotation);
      continue;
    }
    const source = annotation.points;
    if (!polylineHit(source, { x, y }, radius + annotation.strokeWidth / 2)) { output.push(annotation); continue; }
    changed = true;
    const runs: number[][] = [];
    let run: number[] = [];
    const flush = () => { if (run.length >= 4) runs.push(run); run = []; };
    for (let index = 0; index < source.length; index += 2) {
      const current = { x: source[index], y: source[index + 1] };
      const currentInside = Math.hypot(current.x - x, current.y - y) <= radius + annotation.strokeWidth / 2;
      const previous = index >= 2 ? { x: source[index - 2], y: source[index - 1] } : undefined;
      const crossing = previous && segmentDistance({ x, y }, previous, current) <= radius + annotation.strokeWidth / 2;
      if (currentInside || crossing) {
        flush();
        if (!currentInside) run = [current.x, current.y];
      } else run.push(current.x, current.y);
    }
    flush();
    if (!runs.length) { removedIds.push(annotation.id); continue; }
    runs.forEach((points, index) => {
      const id = index === 0 ? annotation.id : createId();
      output.push({ ...annotation, id, points });
      if (index > 0) splitMembers.push({ sourceId: annotation.id, newId: id });
    });
  }
  return { annotations: output, removedIds, splitMembers, changed };
}
