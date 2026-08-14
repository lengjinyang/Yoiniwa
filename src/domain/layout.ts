import type { BoardItem } from '../types';
import { itemBounds } from './scene';

export type LayoutAction =
  | 'pack' | 'align-left' | 'align-right' | 'align-top' | 'align-bottom'
  | 'distribute-horizontal' | 'distribute-vertical'
  | 'normalize-width' | 'normalize-height' | 'normalize-size';

function moveVisualBounds(item: BoardItem, x?: number, y?: number) {
  const bounds = itemBounds(item);
  if (x !== undefined) item.x += x - bounds.x;
  if (y !== undefined) item.y += y - bounds.y;
}

function resizeAroundCenter(item: BoardItem, width: number, height: number) {
  const centerX = item.x + item.width / 2;
  const centerY = item.y + item.height / 2;
  item.width = width;
  item.height = height;
  item.x = centerX - width / 2;
  item.y = centerY - height / 2;
}

function boundsOverlap(a: ReturnType<typeof itemBounds>, b: ReturnType<typeof itemBounds>) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function separateIfOverlapping<T extends BoardItem>(items: T[], padding: number) {
  const values = items.map((item) => ({ item, bounds: itemBounds(item) }));
  const overlaps = values.some((left, index) => values.slice(index + 1).some((right) => boundsOverlap(left.bounds, right.bounds)));
  if (!overlaps) return;
  const left = Math.min(...values.map((value) => value.bounds.x));
  const right = Math.max(...values.map((value) => value.bounds.x + value.bounds.width));
  const top = Math.min(...values.map((value) => value.bounds.y));
  const bottom = Math.max(...values.map((value) => value.bounds.y + value.bounds.height));
  const horizontal = right - left >= bottom - top;
  const sorted = [...values].sort((a, b) => horizontal ? a.bounds.x - b.bounds.x : a.bounds.y - b.bounds.y);
  let cursor = horizontal ? left : top;
  sorted.forEach((value) => {
    moveVisualBounds(value.item, horizontal ? cursor : undefined, horizontal ? undefined : cursor);
    cursor += (horizontal ? value.bounds.width : value.bounds.height) + padding;
  });
}

export function applyLayout<T extends BoardItem>(items: T[], action: LayoutAction, padding: number, targetAspect = 1.6): T[] {
  if (!items.length) return items;
  const result = items.map((item) => ({ ...item }));
  const gapSize = Math.max(0, padding);
  if (action === 'pack') {
    const visual = result.map((item) => ({ item, bounds: itemBounds(item) }));
    const packGap = 0;
    const totalArea = visual.reduce((sum, value) => sum + value.bounds.width * value.bounds.height, 0);
    const targetWidth = Math.max(...visual.map((value) => value.bounds.width), Math.sqrt(totalArea * Math.max(0.25, targetAspect)));
    let x = Math.min(...visual.map((value) => value.bounds.x));
    let y = Math.min(...visual.map((value) => value.bounds.y));
    const startX = x;
    let rowHeight = 0;
    for (const value of [...visual].sort((a, b) => b.bounds.height - a.bounds.height || b.bounds.width - a.bounds.width)) {
      if (x > startX && x + value.bounds.width > startX + targetWidth) {
        x = startX;
        y += rowHeight + packGap;
        rowHeight = 0;
      }
      moveVisualBounds(value.item, x, y);
      x += value.bounds.width + packGap;
      rowHeight = Math.max(rowHeight, value.bounds.height);
    }
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

  if (action === 'distribute-horizontal' && result.length > 1) {
    const sorted = [...bounds].sort((a, b) => a.bounds.x - b.bounds.x);
    let cursor = left;
    sorted.forEach((value) => { moveVisualBounds(value.item, cursor); cursor += value.bounds.width + gapSize; });
  }
  if (action === 'distribute-vertical' && result.length > 1) {
    const sorted = [...bounds].sort((a, b) => a.bounds.y - b.bounds.y);
    let cursor = top;
    sorted.forEach((value) => { moveVisualBounds(value.item, undefined, cursor); cursor += value.bounds.height + gapSize; });
  }

  if (action.startsWith('normalize')) {
    const first = result[0];
    result.forEach((item) => {
      if (action === 'normalize-width') {
        const ratio = first.width / item.width;
        resizeAroundCenter(item, first.width, item.height * ratio);
      } else if (action === 'normalize-height') {
        const ratio = first.height / item.height;
        resizeAroundCenter(item, item.width * ratio, first.height);
      } else {
        const target = Math.max(first.width, first.height);
        const ratio = target / Math.max(item.width, item.height);
        resizeAroundCenter(item, item.width * ratio, item.height * ratio);
      }
    });
    separateIfOverlapping(result, gapSize);
  }
  return result;
}
