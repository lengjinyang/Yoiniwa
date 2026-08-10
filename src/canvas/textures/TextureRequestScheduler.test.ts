import { describe, expect, it, vi } from 'vitest';
import { StaleTextureRequestError, TextureRequestScheduler } from './TextureRequestScheduler';

describe('TextureRequestScheduler', () => {
  it('merges duplicate asset+mip requests', async () => {
    const run = vi.fn(async () => 42);
    const scheduler = new TextureRequestScheduler();
    const request = { key: 'asset:mip:512', generation: 0, priority: 1, run };
    await Promise.all([scheduler.request(request), scheduler.request({ ...request, priority: 10 })]);
    expect(run).toHaveBeenCalledOnce();
  });

  it('rejects results from an obsolete generation', async () => {
    let finish!: (value: number) => void;
    const scheduler = new TextureRequestScheduler();
    const result = scheduler.request({ key: 'old', generation: 0, priority: 1, run: () => new Promise((resolve) => { finish = resolve; }) });
    await Promise.resolve();
    scheduler.advanceGeneration();
    finish(1);
    await expect(result).rejects.toBeInstanceOf(StaleTextureRequestError);
  });

  it('limits concurrent decode work', async () => {
    const scheduler = new TextureRequestScheduler(2);
    let running = 0;
    let peak = 0;
    const make = (key: string) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const result = scheduler.request({
        key, generation: 0, priority: 1,
        run: async () => {
          running += 1;
          peak = Math.max(peak, running);
          await gate;
          running -= 1;
          return key;
        },
      });
      return { result, release: () => release() };
    };
    const first = make('a');
    const second = make('b');
    const third = make('c');
    await Promise.resolve();
    await Promise.resolve();
    expect(peak).toBe(2);
    first.release();
    second.release();
    third.release();
    await Promise.all([first.result, second.result, third.result]);
    expect(peak).toBe(2);
  });
});
