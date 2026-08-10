import { describe, expect, it } from 'vitest';
import { createImageJobQueue } from '../electron/services/image-jobs.js';

describe('image job queue', () => {
  it('single-flights matching tasks', async () => {
    const queue = createImageJobQueue({ concurrency: 1 });
    let calls = 0;
    const task = async () => { calls += 1; return 'thumbnail'; };
    const [first, second] = await Promise.all([queue.enqueue('thumb:a', task), queue.enqueue('thumb:a', task)]);
    expect(first).toBe('thumbnail');
    expect(second).toBe('thumbnail');
    expect(calls).toBe(1);
  });

  it('honors priority for queued jobs', async () => {
    const queue = createImageJobQueue({ concurrency: 1 });
    const seen: string[] = [];
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => { release = resolve; });
    const first = queue.enqueue('blocker', async () => { await blocker; seen.push('blocker'); }, 0);
    const low = queue.enqueue('low', async () => { seen.push('low'); }, 0);
    const high = queue.enqueue('high', async () => { seen.push('high'); }, 10);
    release();
    await Promise.all([first, low, high]);
    expect(seen).toEqual(['blocker', 'high', 'low']);
  });

  it('promotes a queued single-flight job when it becomes visible', async () => {
    const queue = createImageJobQueue({ concurrency: 1 });
    const seen: string[] = [];
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => { release = resolve; });
    const first = queue.enqueue('blocker', async () => { await blocker; }, 20);
    const tile = queue.enqueue('tile', async () => { seen.push('tile'); }, 0);
    const ordinary = queue.enqueue('ordinary', async () => { seen.push('ordinary'); }, 5);
    const promoted = queue.enqueue('tile', async () => { throw new Error('single-flight task replaced'); }, 10);
    release();
    await Promise.all([first, tile, ordinary, promoted]);
    expect(seen).toEqual(['tile', 'ordinary']);
  });

  it('boosts an existing speculative job without creating a second task', async () => {
    const queue = createImageJobQueue({ concurrency: 1 });
    const seen: string[] = [];
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => { release = resolve; });
    const first = queue.enqueue('blocker', async () => { await blocker; }, 20);
    const tile = queue.enqueue('tile:visible', async () => { seen.push('tile'); }, 0);
    const ordinary = queue.enqueue('ordinary', async () => { seen.push('ordinary'); }, 5);
    expect(queue.boost((key) => key === 'tile:visible', 10)).toBe(1);
    release();
    await Promise.all([first, tile, ordinary]);
    expect(seen).toEqual(['tile', 'ordinary']);
  });

  it('cancels queued work by key', async () => {
    const queue = createImageJobQueue({ concurrency: 1 });
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => { release = resolve; });
    const first = queue.enqueue('blocker', async () => { await blocker; });
    const canceled = queue.enqueue('stale', async () => 'unexpected');
    const rejection = expect(canceled).rejects.toMatchObject({ name: 'ImageJobCanceledError' });
    expect(queue.cancel((key) => key === 'stale')).toBe(1);
    release();
    await first;
    await rejection;
  });

  it('waits for active work after canceling the pending migration queue', async () => {
    const queue = createImageJobQueue({ concurrency: 1 });
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => { release = resolve; });
    const active = queue.enqueue('active', async () => blocker);
    const pending = queue.enqueue('old-cache-path', async () => 'unexpected');
    const activeRejection = expect(active).rejects.toMatchObject({ name: 'ImageJobCanceledError' });
    const rejection = expect(pending).rejects.toMatchObject({ name: 'ImageJobCanceledError' });
    expect(queue.cancel(() => true)).toBe(2);
    let idle = false;
    const waiting = queue.whenIdle().then(() => { idle = true; });
    await Promise.resolve();
    expect(idle).toBe(false);
    release();
    await activeRejection;
    await rejection;
    await waiting;
    expect(queue.stats()).toMatchObject({ active: 0, pending: 0, inFlight: 0 });
  });

  it('aborts active work and discards its eventual result', async () => {
    const queue = createImageJobQueue({ concurrency: 1 });
    let observedAbort = false;
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => { release = resolve; });
    const active = queue.enqueue('active:asset', async (signal) => {
      signal.addEventListener('abort', () => { observedAbort = true; }, { once: true });
      await blocker;
      return 'stale-result';
    });
    await Promise.resolve();
    const rejection = expect(active).rejects.toMatchObject({ name: 'ImageJobCanceledError' });
    expect(queue.cancel((key) => key === 'active:asset')).toBe(1);
    expect(observedAbort).toBe(true);
    release();
    await rejection;
    await queue.whenIdle();
    expect(queue.stats()).toMatchObject({ active: 0, inFlight: 0 });
  });
});
