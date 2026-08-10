import { describe, expect, it, vi } from 'vitest';
import { RuntimeLifecycle } from './RuntimeLifecycle';

describe('RuntimeLifecycle', () => {
  it('releases resources once in reverse registration order', () => {
    const calls: number[] = [];
    const lifecycle = new RuntimeLifecycle();
    lifecycle.add(() => calls.push(1));
    lifecycle.add(() => calls.push(2));

    lifecycle.destroy();
    lifecycle.destroy();

    expect(calls).toEqual([2, 1]);
  });

  it('immediately releases resources registered after shutdown', () => {
    const dispose = vi.fn();
    const lifecycle = new RuntimeLifecycle();
    lifecycle.destroy();
    lifecycle.add(dispose);
    expect(dispose).toHaveBeenCalledOnce();
  });
});
