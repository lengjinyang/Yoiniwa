import { describe, expect, it } from 'vitest';
import { clearOperation, settleOperation, startOperation, type OperationState } from './operationState';

const running: OperationState = {
  requestId: 4,
  kind: 'save',
  status: 'running',
  message: '正在保存…',
};

describe('operation state', () => {
  it('starts a new operation with its request identity', () => {
    const next = { ...running, requestId: 5, kind: 'open' as const, message: '正在打开画板…' };
    expect(startOperation(next)).toEqual(next);
  });

  it('ignores a stale completion after a newer operation replaced it', () => {
    const newer = { ...running, requestId: 5, kind: 'open' as const };
    expect(settleOperation(newer, 4, 'success', '已保存')).toEqual(newer);
  });

  it('settles and clears only the matching operation', () => {
    const settled = settleOperation(running, 4, 'success', '已保存');
    expect(settled).toEqual({ ...running, status: 'success', message: '已保存' });
    expect(clearOperation(settled, 3)).toEqual(settled);
    expect(clearOperation(settled, 4)).toBeUndefined();
  });
});
