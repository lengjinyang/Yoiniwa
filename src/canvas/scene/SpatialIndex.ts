import type { ImageItem } from '../../types';
import type { SceneBounds } from './SceneNode';
import { boundsIntersect, imageBounds } from '../selection/HitTestService';

const CELL_SIZE = 1024;

export class SpatialIndex {
  private readonly cells = new Map<string, Set<string>>();
  private readonly bounds = new Map<string, SceneBounds>();

  rebuild(items: ImageItem[]) {
    this.cells.clear();
    this.bounds.clear();
    items.forEach((item) => this.insert(item));
  }

  query(area: SceneBounds) {
    const result = new Set<string>();
    for (let y = Math.floor(area.y / CELL_SIZE); y <= Math.floor((area.y + area.height) / CELL_SIZE); y += 1) {
      for (let x = Math.floor(area.x / CELL_SIZE); x <= Math.floor((area.x + area.width) / CELL_SIZE); x += 1) {
        this.cells.get(`${x}:${y}`)?.forEach((id) => {
          const bounds = this.bounds.get(id);
          if (bounds && boundsIntersect(bounds, area)) result.add(id);
        });
      }
    }
    return result;
  }

  private insert(item: ImageItem) {
    const bounds = imageBounds(item);
    this.bounds.set(item.id, bounds);
    for (let y = Math.floor(bounds.y / CELL_SIZE); y <= Math.floor((bounds.y + bounds.height) / CELL_SIZE); y += 1) {
      for (let x = Math.floor(bounds.x / CELL_SIZE); x <= Math.floor((bounds.x + bounds.width) / CELL_SIZE); x += 1) {
        const key = `${x}:${y}`;
        const ids = this.cells.get(key) ?? new Set<string>();
        ids.add(item.id);
        this.cells.set(key, ids);
      }
    }
  }
}
