import type { Bounds } from './scene';
import type { Viewport } from './types';
import { performanceMonitor } from './performanceMonitor';

export interface SpatialEntry extends Bounds { id: string }

const intersects = (a: Bounds, b: Bounds) => a.x <= b.x + b.width && a.x + a.width >= b.x
  && a.y <= b.y + b.height && a.y + a.height >= b.y;

export function viewportWorldBounds(viewport: Viewport, size: { width: number; height: number }, overscanPx = 320): Bounds {
  const scale = Math.max(1e-9, viewport.scale);
  return {
    x: (-viewport.x - overscanPx) / scale,
    y: (-viewport.y - overscanPx) / scale,
    width: (size.width + overscanPx * 2) / scale,
    height: (size.height + overscanPx * 2) / scale,
  };
}

/** A compact uniform-grid index. It avoids an extra dependency and keeps 2k–20k item queries predictable. */
export class SpatialIndex {
  private readonly cells = new Map<string, SpatialEntry[]>();
  private readonly large: SpatialEntry[] = [];
  private readonly entries: SpatialEntry[];

  constructor(entries: SpatialEntry[], private readonly cellSize = 1024) {
    this.entries = entries;
    for (const entry of entries) {
      const minX = Math.floor(entry.x / cellSize); const maxX = Math.floor((entry.x + entry.width) / cellSize);
      const minY = Math.floor(entry.y / cellSize); const maxY = Math.floor((entry.y + entry.height) / cellSize);
      if ((maxX - minX + 1) * (maxY - minY + 1) > 256) { this.large.push(entry); continue; }
      for (let x = minX; x <= maxX; x += 1) for (let y = minY; y <= maxY; y += 1) {
        const key = `${x}:${y}`;
        const cell = this.cells.get(key);
        if (cell) cell.push(entry); else this.cells.set(key, [entry]);
      }
    }
  }

  query(bounds: Bounds): string[] {
    const startedAt = performanceMonitor.enabled ? performance.now() : 0;
    const found = new Map<string, SpatialEntry>();
    const minX = Math.floor(bounds.x / this.cellSize); const maxX = Math.floor((bounds.x + bounds.width) / this.cellSize);
    const minY = Math.floor(bounds.y / this.cellSize); const maxY = Math.floor((bounds.y + bounds.height) / this.cellSize);
    const columns = maxX - minX + 1;
    const rows = maxY - minY + 1;
    if (!Number.isFinite(columns * rows) || columns * rows > 100_000) {
      const result = this.entries.filter((entry) => intersects(entry, bounds)).map((entry) => entry.id);
      if (performanceMonitor.enabled) performanceMonitor.recordSpatialQuery(performance.now() - startedAt);
      return result;
    }
    for (let x = minX; x <= maxX; x += 1) for (let y = minY; y <= maxY; y += 1) {
      for (const entry of this.cells.get(`${x}:${y}`) ?? []) if (intersects(entry, bounds)) found.set(entry.id, entry);
    }
    for (const entry of this.large) if (intersects(entry, bounds)) found.set(entry.id, entry);
    const result = [...found.keys()];
    if (performanceMonitor.enabled) performanceMonitor.recordSpatialQuery(performance.now() - startedAt);
    return result;
  }
}
