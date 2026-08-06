import { describe, expect, it } from 'vitest';
import type { PhotoshopColorSyncResult } from '../../src/types';
import { createPhotoshopSyncQueue } from './photoshop-sync-queue';

const success = (hex: string): PhotoshopColorSyncResult => ({
  ok: true, status: 'synced', syncStatus: 'synced', focusStatus: 'activated', copied: false,
  syncLatencyMs: 1, message: hex,
});

describe('Photoshop latest-wins queue', () => {
  it('runs the active request and only the newest pending color', async () => {
    const runs: string[] = [];
    const releases: Array<() => void> = [];
    const queue = createPhotoshopSyncQueue(async ({ color }) => {
      runs.push(color.hex);
      await new Promise<void>((resolve) => releases.push(resolve));
      return success(color.hex);
    });
    const first = queue.enqueue({ color: { r: 1, g: 1, b: 1, hex: '#010101' }, returnFocus: true });
    const second = queue.enqueue({ color: { r: 2, g: 2, b: 2, hex: '#020202' }, returnFocus: true });
    const third = queue.enqueue({ color: { r: 3, g: 3, b: 3, hex: '#030303' }, returnFocus: true });
    expect(runs).toEqual(['#010101']);
    releases.shift()?.();
    await Promise.resolve(); await Promise.resolve();
    expect(runs).toEqual(['#010101', '#030303']);
    releases.shift()?.();
    await expect(first).resolves.toMatchObject({ message: '#010101' });
    await expect(second).resolves.toMatchObject({ message: '#030303' });
    await expect(third).resolves.toMatchObject({ message: '#030303' });
  });
});
