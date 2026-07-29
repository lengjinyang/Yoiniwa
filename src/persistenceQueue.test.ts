import { describe, expect, it } from 'vitest';
import { createRecoveringQueue } from '../electron/services/persistence-queue.js';

describe('persistence queue', () => {
  it('continues processing work after a failed task', async () => {
    const enqueue = createRecoveringQueue();
    const failure = enqueue(async () => { throw new Error('disk full'); });
    const success = enqueue(async () => 'recovered');

    await expect(failure).rejects.toThrow('disk full');
    await expect(success).resolves.toBe('recovered');
  });

  it('runs queued tasks in submission order', async () => {
    const enqueue = createRecoveringQueue();
    const seen: number[] = [];
    const first = enqueue(async () => { seen.push(1); });
    const second = enqueue(async () => { seen.push(2); });

    await Promise.all([first, second]);
    expect(seen).toEqual([1, 2]);
  });
});
