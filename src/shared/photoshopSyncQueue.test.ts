import { describe, expect, it, vi } from 'vitest';
import type { PhotoshopColorSyncResult } from '../types';
import { createPhotoshopSyncQueue, type PhotoshopSyncRequest } from './photoshopSyncQueue';

describe('createPhotoshopSyncQueue', () => {
  it('coalesces overlapping syncs to the latest color', async () => {
    const calls: string[] = [];
    const execute = vi.fn(async (request: PhotoshopSyncRequest): Promise<PhotoshopColorSyncResult> => {
      calls.push(request.color.hex);
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        ok: true,
        status: 'synced',
        syncStatus: 'synced',
        focusStatus: 'skipped',
        copied: false,
        syncLatencyMs: 1,
      };
    });
    const queue = createPhotoshopSyncQueue(execute);
    const first = queue.enqueue({ color: { r: 1, g: 2, b: 3, hex: '#010203' }, returnFocus: false });
    const second = queue.enqueue({ color: { r: 4, g: 5, b: 6, hex: '#040506' }, returnFocus: false });
    const third = queue.enqueue({ color: { r: 7, g: 8, b: 9, hex: '#070809' }, returnFocus: false });
    await Promise.all([first, second, third]);
    expect(calls).toEqual(['#010203', '#070809']);
  });
});
