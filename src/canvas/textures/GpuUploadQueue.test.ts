import { describe, expect, it, vi } from 'vitest';
import { GpuUploadQueue } from './GpuUploadQueue';

describe('GpuUploadQueue', () => {
  it('deduplicates and obeys the item/byte frame budget', async () => {
    const queue = new GpuUploadQueue();
    const upload = vi.fn(async () => 'ready');
    const one = queue.request({ key: 'same', estimatedBytes: 6 * 1024 * 1024, priority: 1, upload });
    const duplicate = queue.request({ key: 'same', estimatedBytes: 6 * 1024 * 1024, priority: 9, upload });
    queue.request({ key: 'later', estimatedBytes: 4 * 1024 * 1024, priority: 0, upload });
    expect(queue.processFrame(() => 0)).toEqual({ items: 1, bytes: 6 * 1024 * 1024 });
    await expect(Promise.all([one, duplicate])).resolves.toEqual(['ready', 'ready']);
    expect(upload).toHaveBeenCalledOnce();
    expect(queue.length).toBe(1);
  });
});
