export interface AtlasAllocation {
  readonly handle: number;
  readonly page: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly paddedX: number;
  readonly paddedY: number;
  readonly paddedWidth: number;
  readonly paddedHeight: number;
}

interface Rect { page: number; x: number; y: number; width: number; height: number }

export interface AtlasAllocatorStats {
  freeArea: number;
  usedArea: number;
  largestFreeRectArea: number;
  freeRectCount: number;
}

/** Page-local guillotine allocator. Free and occupied rectangles never overlap. */
export class AtlasAllocator {
  private readonly freeRects: Rect[] = [];
  private readonly allocations = new Map<number, AtlasAllocation>();
  private nextHandle = 1;

  constructor(private readonly pageSize: number, private readonly gutter = 1) {}

  addPage(page: number) {
    if (this.freeRects.some((rect) => rect.page === page)
      || [...this.allocations.values()].some((entry) => entry.page === page)) return;
    this.freeRects.push({ page, x: 0, y: 0, width: this.pageSize, height: this.pageSize });
  }

  allocate(width: number, height: number): AtlasAllocation | undefined {
    const paddedWidth = width + this.gutter * 2;
    const paddedHeight = height + this.gutter * 2;
    if (paddedWidth > this.pageSize || paddedHeight > this.pageSize) return undefined;
    let bestIndex = -1;
    let bestWaste = Number.POSITIVE_INFINITY;
    for (let index = 0; index < this.freeRects.length; index += 1) {
      const rect = this.freeRects[index];
      if (rect.width < paddedWidth || rect.height < paddedHeight) continue;
      const waste = rect.width * rect.height - paddedWidth * paddedHeight;
      if (waste < bestWaste) { bestWaste = waste; bestIndex = index; }
    }
    if (bestIndex < 0) return undefined;
    const [rect] = this.freeRects.splice(bestIndex, 1);
    const rightWidth = rect.width - paddedWidth;
    const bottomHeight = rect.height - paddedHeight;
    // Split along the larger leftover axis. A fixed split direction leaves
    // narrow strips after mixing 1024px thumbnails and 512px tiles even when
    // the page still has ample total area.
    if (rightWidth > bottomHeight) {
      if (rightWidth > 0) this.freeRects.push({
        page: rect.page, x: rect.x + paddedWidth, y: rect.y,
        width: rightWidth, height: rect.height,
      });
      if (bottomHeight > 0) this.freeRects.push({
        page: rect.page, x: rect.x, y: rect.y + paddedHeight,
        width: paddedWidth, height: bottomHeight,
      });
    } else {
      if (rightWidth > 0) this.freeRects.push({
        page: rect.page, x: rect.x + paddedWidth, y: rect.y,
        width: rightWidth, height: paddedHeight,
      });
      if (bottomHeight > 0) this.freeRects.push({
        page: rect.page, x: rect.x, y: rect.y + paddedHeight,
        width: rect.width, height: bottomHeight,
      });
    }
    const allocation: AtlasAllocation = {
      handle: this.nextHandle++, page: rect.page,
      x: rect.x + this.gutter, y: rect.y + this.gutter, width, height,
      paddedX: rect.x, paddedY: rect.y, paddedWidth, paddedHeight,
    };
    this.allocations.set(allocation.handle, allocation);
    return allocation;
  }

  free(allocation: AtlasAllocation) {
    if (!this.allocations.delete(allocation.handle)) return false;
    this.freeRects.push({
      page: allocation.page, x: allocation.paddedX, y: allocation.paddedY,
      width: allocation.paddedWidth, height: allocation.paddedHeight,
    });
    this.coalesce();
    return true;
  }

  stats(): AtlasAllocatorStats {
    const freeArea = this.freeRects.reduce((sum, rect) => sum + rect.width * rect.height, 0);
    const usedArea = [...this.allocations.values()]
      .reduce((sum, value) => sum + value.paddedWidth * value.paddedHeight, 0);
    return {
      freeArea, usedArea,
      largestFreeRectArea: this.freeRects.reduce((largest, rect) => Math.max(largest, rect.width * rect.height), 0),
      freeRectCount: this.freeRects.length,
    };
  }

  private coalesce() {
    let changed = true;
    while (changed) {
      changed = false;
      outer: for (let leftIndex = 0; leftIndex < this.freeRects.length; leftIndex += 1) {
        const left = this.freeRects[leftIndex];
        for (let rightIndex = leftIndex + 1; rightIndex < this.freeRects.length; rightIndex += 1) {
          const right = this.freeRects[rightIndex];
          if (left.page !== right.page) continue;
          const horizontal = left.y === right.y && left.height === right.height
            && (left.x + left.width === right.x || right.x + right.width === left.x);
          const vertical = left.x === right.x && left.width === right.width
            && (left.y + left.height === right.y || right.y + right.height === left.y);
          if (!horizontal && !vertical) continue;
          const merged = horizontal ? {
            page: left.page, x: Math.min(left.x, right.x), y: left.y,
            width: left.width + right.width, height: left.height,
          } : {
            page: left.page, x: left.x, y: Math.min(left.y, right.y),
            width: left.width, height: left.height + right.height,
          };
          this.freeRects.splice(rightIndex, 1);
          this.freeRects.splice(leftIndex, 1, merged);
          changed = true;
          break outer;
        }
      }
    }
  }
}
