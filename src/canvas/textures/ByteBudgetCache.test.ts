import { describe, expect, it } from 'vitest';
import { ByteBudgetCache } from './ByteBudgetCache';

describe('ByteBudgetCache', () => {
  it('evicts by bytes and never evicts a pinned entry', () => {
    const disposed: string[] = [];
    const cache = new ByteBudgetCache<{ estimatedBytes: number; pinCount: number; dispose(): void }>(10);
    cache.set('a', { estimatedBytes: 6, pinCount: 1, dispose: () => disposed.push('a') });
    cache.set('b', { estimatedBytes: 6, pinCount: 0, dispose: () => disposed.push('b') });
    expect(disposed).toEqual(['b']);
    expect(cache.bytes).toBe(6);
    cache.unpin('a');
    cache.clear();
    expect(disposed).toEqual(['b', 'a']);
  });
});
