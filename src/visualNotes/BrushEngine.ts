import type { VisualNotePoint } from '../types';

export interface RawBrushSample { x: number; y: number; pressure: number; time: number; pointerType: string }

export function widthFactorForSample(sample: RawBrushSample, previous: RawBrushSample | undefined, pressureEnabled: boolean) {
  if (!pressureEnabled) return 1;
  if (sample.pointerType === 'pen' && sample.pressure > 0) return Math.max(0.24, Math.min(1.65, 0.18 + sample.pressure * 1.47));
  if (!previous) return 1;
  const distance = Math.hypot(sample.x - previous.x, sample.y - previous.y);
  const elapsed = Math.max(1, sample.time - previous.time);
  const speed = distance / elapsed;
  return Math.max(0.72, Math.min(1.18, 1.16 - speed * 0.18));
}

export function appendBrushSample(
  points: VisualNotePoint[], sample: RawBrushSample, previous: RawBrushSample | undefined,
  pressureEnabled: boolean, minimumDistance: number,
) {
  const last = points.at(-1);
  if (last && Math.hypot(sample.x - last.x, sample.y - last.y) < minimumDistance) return false;
  const rawFactor = widthFactorForSample(sample, previous, pressureEnabled);
  const factor = last ? last.widthFactor * 0.55 + rawFactor * 0.45 : rawFactor;
  points.push({ x: sample.x, y: sample.y, widthFactor: factor });
  return true;
}

export function simplifyBrushPoints(points: readonly VisualNotePoint[], tolerance: number) {
  if (points.length <= 2) return [...points];
  const keep = new Uint8Array(points.length); keep[0] = 1; keep[points.length - 1] = 1;
  const visit = (start: number, end: number) => {
    const a = points[start]; const b = points[end];
    const dx = b.x - a.x; const dy = b.y - a.y; const lengthSquared = dx * dx + dy * dy;
    let best = 0; let index = -1;
    for (let cursor = start + 1; cursor < end; cursor += 1) {
      const point = points[cursor];
      const t = lengthSquared ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared)) : 0;
      const distance = Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t));
      if (distance > best) { best = distance; index = cursor; }
    }
    if (best <= tolerance || index < 0) return;
    keep[index] = 1; visit(start, index); visit(index, end);
  };
  visit(0, points.length - 1);
  return points.filter((_, index) => keep[index]);
}
