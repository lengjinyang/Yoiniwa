import type { ImageItem } from './types';
import { itemBounds } from './scene';

export type LayoutAction =
  | 'pack' | 'align-left' | 'align-right' | 'align-top' | 'align-bottom'
  | 'normalize-width' | 'normalize-height' | 'normalize-size';

function moveVisualBounds(item: ImageItem, x?: number, y?: number) {
  const bounds = itemBounds(item);
  if (x !== undefined) item.x += x - bounds.x;
  if (y !== undefined) item.y += y - bounds.y;
}

function resizeAroundCenter(item: ImageItem, width: number, height: number) {
  const centerX = item.x + item.width / 2;
  const centerY = item.y + item.height / 2;
  item.width = width;
  item.height = height;
  item.x = centerX - width / 2;
  item.y = centerY - height / 2;
}

interface PackedValue {
  item: ImageItem;
  bounds: ReturnType<typeof itemBounds>;
}

interface PackedRow {
  values: PackedValue[];
  width: number;
  height: number;
}

function shelfRows(values: PackedValue[], targetWidth: number) {
  const rows: PackedRow[] = [];
  let row: PackedRow = { values: [], width: 0, height: 0 };
  values.forEach((value) => {
    if (row.values.length && row.width + value.bounds.width > targetWidth + 0.001) {
      rows.push(row);
      row = { values: [], width: 0, height: 0 };
    }
    row.values.push(value);
    row.width += value.bounds.width;
    row.height = Math.max(row.height, value.bounds.height);
  });
  if (row.values.length) rows.push(row);
  return rows;
}

function compactShelf(values: PackedValue[], targetAspect: number) {
  const sorted = [...values].sort((a, b) => b.bounds.height - a.bounds.height
    || b.bounds.width - a.bounds.width || a.item.zIndex - b.item.zIndex);
  const totalArea = sorted.reduce((sum, value) => sum + value.bounds.width * value.bounds.height, 0);
  const maximumWidth = Math.max(...sorted.map((value) => value.bounds.width));
  const candidateWidths = new Set<number>([maximumWidth, Math.sqrt(totalArea * targetAspect)]);
  const candidateStep = Math.max(1, Math.floor(sorted.length / 512));
  let cumulativeWidth = 0;
  sorted.forEach((value, index) => {
    cumulativeWidth += value.bounds.width;
    if ((index + 1) % candidateStep === 0 || index === sorted.length - 1) candidateWidths.add(cumulativeWidth);
  });
  let best: { rows: PackedRow[]; width: number; height: number; score: number } | undefined;
  candidateWidths.forEach((candidateWidth) => {
    const rows = shelfRows(sorted, Math.max(maximumWidth, candidateWidth));
    const width = Math.max(...rows.map((row) => row.width));
    const height = rows.reduce((sum, row) => sum + row.height, 0);
    const aspectError = Math.abs(Math.log((width / Math.max(1, height)) / targetAspect));
    const unusedRatio = Math.max(0, 1 - totalArea / Math.max(1, width * height));
    const score = aspectError + unusedRatio * 0.2;
    if (!best || score < best.score - 0.0001
      || (Math.abs(score - best.score) <= 0.0001 && width * height <= best.width * best.height)) {
      best = { rows, width, height, score };
    }
  });
  return best!;
}

export function applyLayout(items: ImageItem[], action: LayoutAction, padding: number, targetAspect = 1.6): ImageItem[] {
  if (!items.length) return items;
  const result = items.map((item) => ({ ...item }));
  const gapSize = Math.max(0, padding);
  if (action === 'pack') {
    const visual = result.map((item) => ({ item, bounds: itemBounds(item) }));
    const startX = Math.min(...visual.map((value) => value.bounds.x));
    let y = Math.min(...visual.map((value) => value.bounds.y));
    const packed = compactShelf(visual, Math.max(0.25, targetAspect));
    packed.rows.forEach((row) => {
      let x = startX;
      row.values.forEach((value) => {
        moveVisualBounds(value.item, x, y);
        x += value.bounds.width;
      });
      y += row.height;
    });
    return result;
  }

  const bounds = result.map((item) => ({ item, bounds: itemBounds(item) }));
  const left = Math.min(...bounds.map((value) => value.bounds.x));
  const right = Math.max(...bounds.map((value) => value.bounds.x + value.bounds.width));
  const top = Math.min(...bounds.map((value) => value.bounds.y));
  const bottom = Math.max(...bounds.map((value) => value.bounds.y + value.bounds.height));
  if (action === 'align-left' || action === 'align-right') {
    const sorted = [...bounds].sort((a, b) => a.bounds.y - b.bounds.y);
    let cursor = top;
    sorted.forEach((value) => {
      moveVisualBounds(value.item, action === 'align-left' ? left : right - value.bounds.width, cursor);
      cursor += value.bounds.height + gapSize;
    });
  }
  if (action === 'align-top' || action === 'align-bottom') {
    const sorted = [...bounds].sort((a, b) => a.bounds.x - b.bounds.x);
    let cursor = left;
    sorted.forEach((value) => {
      moveVisualBounds(value.item, cursor, action === 'align-top' ? top : bottom - value.bounds.height);
      cursor += value.bounds.width + gapSize;
    });
  }

  if (action.startsWith('normalize')) {
    const first = result[0];
    const referenceBounds = itemBounds(first);
    result.forEach((item) => {
      if (action === 'normalize-width') {
        const ratio = referenceBounds.width / Math.max(1, itemBounds(item).width);
        resizeAroundCenter(item, item.width * ratio, item.height * ratio);
      } else if (action === 'normalize-height') {
        const ratio = referenceBounds.height / Math.max(1, itemBounds(item).height);
        resizeAroundCenter(item, item.width * ratio, item.height * ratio);
      } else {
        const target = Math.max(first.width, first.height);
        const ratio = target / Math.max(1, item.width, item.height);
        resizeAroundCenter(item, item.width * ratio, item.height * ratio);
      }
    });
  }
  return result;
}
