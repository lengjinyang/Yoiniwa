import { describe, expect, it, vi } from 'vitest';
import { boundedCpuImageBudget, imageRequestKey } from '../shared/imagePipelineConfig';
import { ByteLru } from './byteLru';
import { UploadBudgetQueue } from './uploadBudget';
import {
  calculateDesiredMip, requiredMipEdge, rotatedScreenBounds, selectMipWithHysteresis,
} from './textureSelection';

describe('texture selection', () => {
  it('includes devicePixelRatio and oversampling in the desired mip', () => {
    const base = { sourceWidth: 4096, sourceHeight: 2048, screenWidthCss: 700, screenHeightCss: 350 };
    expect(calculateDesiredMip({ ...base, devicePixelRatio: 1 })).toBe(1024);
    expect(calculateDesiredMip({ ...base, devicePixelRatio: 2 })).toBe(2048);
    expect(requiredMipEdge({ ...base, devicePixelRatio: 2 })).toBe(1750);
  });

  it('uses the rotated screen bounding box', () => {
    const bounds = rotatedScreenBounds(100, 50, 90, 2);
    expect(bounds.width).toBeCloseTo(100);
    expect(bounds.height).toBeCloseTo(200);
  });

  it('upgrades eagerly and downgrades only after the settled hysteresis delay', () => {
    expect(selectMipWithHysteresis(2048, 1500, { displayedMip: 1024 }, { now: 0, cameraMoving: true }).mip).toBe(2048);
    const first = selectMipWithHysteresis(512, 400, { displayedMip: 2048 }, { now: 10, cameraMoving: false });
    expect(first.mip).toBe(2048);
    expect(selectMipWithHysteresis(512, 400, first.state, { now: 200, cameraMoving: true }).mip).toBe(2048);
    expect(selectMipWithHysteresis(512, 400, first.state, { now: 400, cameraMoving: false }).mip).toBe(512);
  });
});

describe('byte-budget caches and upload queue', () => {
  it('evicts by bytes, disposes native resources, and protects pinned entries', () => {
    const disposed: string[] = [];
    const lru = new ByteLru<{ estimatedBytes: number; pinCount?: number; dispose(): void }>(10);
    lru.set('a', { estimatedBytes: 6, dispose: () => disposed.push('a') });
    lru.pin('a');
    lru.set('b', { estimatedBytes: 6, dispose: () => disposed.push('b') });
    expect(lru.peek('a')).toBeDefined();
    expect(lru.peek('b')).toBeUndefined();
    expect(disposed).toEqual(['b']);
    lru.unpin('a');
  });

  it('deduplicates uploads and honors per-frame item and byte budgets', () => {
    const queue = new UploadBudgetQueue();
    const upload = vi.fn();
    queue.request({ key: 'a', estimatedBytes: 4, priority: 1, upload });
    queue.request({ key: 'a', estimatedBytes: 4, priority: 10, upload });
    queue.request({ key: 'b', estimatedBytes: 7, priority: 5, upload });
    const result = queue.flush(() => 0, { items: 4, bytes: 8, ms: 2 });
    expect(result.uploaded).toEqual(['a']);
    expect(result.remaining).toBe(1);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('creates a stable versioned tile key and clamps CPU budgets', () => {
    expect(imageRequestKey('asset', 512, 3, 4)).toContain('asset:v3:a2:m512:3:4');
    expect(boundedCpuImageBudget(1)).toBe(256 * 1024 * 1024);
    expect(boundedCpuImageBudget(128)).toBe(1024 * 1024 * 1024);
  });
});
