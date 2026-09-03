import type { BoardItem } from '../../types';
import type { SceneBounds } from './SceneNode';
import { boundsIntersect, imageBounds } from '../selection/HitTestService';

const CELL_SIZE = 1024;
const MAX_INDEXED_CELLS = 4096;

function cellRange(area: SceneBounds) {
  const left = Math.floor(area.x / CELL_SIZE), top = Math.floor(area.y / CELL_SIZE);
  const right = Math.floor((area.x + area.width) / CELL_SIZE), bottom = Math.floor((area.y + area.height) / CELL_SIZE);
  const safe = [left, top, right, bottom].every(Number.isSafeInteger);
  return { left, top, right, bottom, count: safe ? (right - left + 1) * (bottom - top + 1) : Infinity };
}

export class SpatialIndex {
  private readonly cells = new Map<string, Set<string>>();
  private readonly bounds = new Map<string, SceneBounds>();
  private hasUnindexedItems = false;

  rebuild(items: BoardItem[]) {
    this.cells.clear();
    this.bounds.clear();
    this.hasUnindexedItems = false;
    items.forEach((item) => this.insert(item));
  }

  query(area: SceneBounds) {
    const result = new Set<string>();
    const range = cellRange(area);
    // At overview scales, scan actual objects instead of billions of empty cells.
    if (this.hasUnindexedItems || range.count > Math.max(1, this.bounds.size)) {
      this.bounds.forEach((bounds, id) => { if (boundsIntersect(bounds, area)) result.add(id); });
      return result;
    }
    for (let y = range.top; y <= range.bottom; y += 1) {
      for (let x = range.left; x <= range.right; x += 1) {
        this.cells.get(`${x}:${y}`)?.forEach((id) => {
          const bounds = this.bounds.get(id);
          if (bounds && boundsIntersect(bounds, area)) result.add(id);
        });
      }
    }
    return result;
  }

  private insert(item: BoardItem) {
    const bounds = imageBounds(item);
    this.bounds.set(item.id, bounds);
    const range = cellRange(bounds);
    if (range.count > MAX_INDEXED_CELLS) { this.hasUnindexedItems = true; return; }
    for (let y = range.top; y <= range.bottom; y += 1) {
      for (let x = range.left; x <= range.right; x += 1) {
        const key = `${x}:${y}`;
        const ids = this.cells.get(key) ?? new Set<string>();
        ids.add(item.id);
        this.cells.set(key, ids);
      }
    }
  }
}
