import { describe, expect, it, vi } from 'vitest';
import { WorkerAssetRegistrations } from '../electron/services/worker-asset-registrations.js';

describe('image worker asset registrations', () => {
  it('single-flights within a generation and registers again after migration clear', async () => {
    const registrations = new WorkerAssetRegistrations();
    const register = vi.fn(async () => undefined);
    await Promise.all([
      registrations.getOrCreate(1, 'asset', register),
      registrations.getOrCreate(1, 'asset', register),
    ]);
    expect(register).toHaveBeenCalledTimes(1);
    registrations.clear();
    await registrations.getOrCreate(2, 'asset', register);
    expect(register).toHaveBeenCalledTimes(2);
  });

  it('does not let a rejected obsolete registration delete its replacement', async () => {
    const registrations = new WorkerAssetRegistrations();
    let rejectOld!: (reason?: unknown) => void;
    const old = new Promise<void>((_resolve, reject) => { rejectOld = reject; });
    void registrations.getOrCreate(1, 'asset', () => old).catch(() => undefined);
    registrations.clear();
    await registrations.getOrCreate(2, 'asset', async () => undefined);
    rejectOld(new Error('old worker stopped'));
    await Promise.resolve();
    expect(registrations.size).toBe(1);
  });
});
