import { describe, expect, it } from 'vitest';
import { parsePhotoshopBridgeResponse, runPhotoshopCommitSequence } from './photoshop-color-bridge';

describe('Photoshop bridge protocol', () => {
  it('parses independent sync and focus outcomes', () => {
    expect(parsePhotoshopBridgeResponse('7|SYNCED|ACTIVATED')).toEqual({
      id: '7', result: { syncStatus: 'synced', focusStatus: 'activated' },
    });
    expect(parsePhotoshopBridgeResponse('8|SYNCED|SKIPPED')).toEqual({
      id: '8', result: { syncStatus: 'synced', focusStatus: 'skipped' },
    });
    expect(parsePhotoshopBridgeResponse('9|NOT_RUNNING|NOT_FOUND')).toEqual({
      id: '9', result: { syncStatus: 'not-running', focusStatus: 'not-found' },
    });
    expect(parsePhotoshopBridgeResponse('10|SYNC_ERROR|FOCUS_ERROR')).toEqual({
      id: '10', result: { syncStatus: 'automation-error', focusStatus: 'automation-error' },
    });
  });

  it('ignores incomplete helper output', () => {
    expect(parsePhotoshopBridgeResponse('')).toBeUndefined();
    expect(parsePhotoshopBridgeResponse('1|SYNCED')).toBeUndefined();
  });

  it('finishes COM color sync before returning focus without injecting keyboard input', async () => {
    const order: string[] = [];
    let finishSync: (() => void) | undefined;
    const commit = runPhotoshopCommitSequence(true, {
      sync: async () => {
        order.push('sync:start');
        await new Promise<void>((resolve) => { finishSync = resolve; });
        order.push('sync:done');
        return { syncStatus: 'synced', focusStatus: 'skipped' };
      },
      focus: async () => {
        order.push('focus');
        return { syncStatus: 'synced', focusStatus: 'activated' };
      },
    });
    await Promise.resolve();
    expect(order).toEqual(['sync:start']);
    finishSync?.();
    await expect(commit).resolves.toEqual({ syncStatus: 'synced', focusStatus: 'activated' });
    expect(order).toEqual(['sync:start', 'sync:done', 'focus']);
  });

  it('retries automation before focus and skips focus when round-trip is disabled', async () => {
    const order: string[] = [];
    let attempts = 0;
    const operations = {
      sync: async () => {
        order.push(`sync:${++attempts}`);
        return { syncStatus: attempts === 1 ? 'automation-error' as const : 'synced' as const, focusStatus: 'skipped' as const };
      },
      focus: async () => {
        order.push('focus');
        return { syncStatus: 'synced' as const, focusStatus: 'activated' as const };
      },
    };
    await expect(runPhotoshopCommitSequence(true, operations)).resolves.toEqual({
      syncStatus: 'synced', focusStatus: 'activated',
    });
    expect(order).toEqual(['sync:1', 'sync:2', 'focus']);

    order.length = 0;
    attempts = 1;
    await expect(runPhotoshopCommitSequence(false, operations)).resolves.toEqual({
      syncStatus: 'synced', focusStatus: 'skipped',
    });
    expect(order).toEqual(['sync:2']);
  });
});
