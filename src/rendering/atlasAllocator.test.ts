import { describe, expect, it } from 'vitest';
import { AtlasAllocator } from './atlasAllocator';

describe('atlas allocator', () => {
  it('never overlaps live allocations and conserves page area', () => {
    const allocator = new AtlasAllocator(64);
    allocator.addPage(0);
    const allocations = Array.from({ length: 8 }, (_, index) => allocator.allocate(8 + index % 3, 7 + index % 2)!).filter(Boolean);
    for (let left = 0; left < allocations.length; left += 1) {
      for (let right = left + 1; right < allocations.length; right += 1) {
        const a = allocations[left]; const b = allocations[right];
        const overlaps = a.paddedX < b.paddedX + b.paddedWidth && a.paddedX + a.paddedWidth > b.paddedX
          && a.paddedY < b.paddedY + b.paddedHeight && a.paddedY + a.paddedHeight > b.paddedY;
        expect(overlaps).toBe(false);
      }
    }
    const stats = allocator.stats();
    expect(stats.freeArea + stats.usedArea).toBe(64 * 64);
  });

  it('coalesces released neighbors so the complete page is reusable', () => {
    const allocator = new AtlasAllocator(64);
    allocator.addPage(0);
    const first = allocator.allocate(14, 30)!;
    const second = allocator.allocate(14, 30)!;
    allocator.free(first); allocator.free(second);
    expect(allocator.allocate(62, 62)).toBeDefined();
  });
});

