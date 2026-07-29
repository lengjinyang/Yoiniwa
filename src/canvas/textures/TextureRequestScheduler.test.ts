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
});
