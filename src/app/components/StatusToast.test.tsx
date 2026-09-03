import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StatusToast } from './StatusToast';
import { UnsavedChangesDialog } from './UnsavedChangesDialog';
import type { OperationState } from '../operationState';

describe('save progress', () => {
  it('shows an indeterminate bar only while saving and keeps completion/error feedback', () => {
    const operation: OperationState = { requestId: 1, kind: 'save', status: 'running', message: '正在保存…' };
    const saving = renderToStaticMarkup(<StatusToast status="" operation={operation} />);
    expect(saving).toContain('<progress');
    expect(saving).toContain('aria-label="正在保存画板"');
    expect(saving).not.toContain('value=');
    for (const status of ['success', 'error'] as const) {
      const settled = renderToStaticMarkup(<StatusToast status="" operation={{ ...operation, status, message: status }} />);
      expect(settled).not.toContain('<progress');
      expect(settled).toContain(status);
    }
    expect(renderToStaticMarkup(<StatusToast status="" />)).toBe('');
    expect(renderToStaticMarkup(<StatusToast status="" operation={{ ...operation, kind: 'open' }} />)).not.toContain('<progress');
  });

  it('also shows progress inside the save-before-exit/switch dialog', () => {
    const props = { open: true, sceneName: '画板', onCancel() {}, onDiscard() {}, onSave() {} };
    expect(renderToStaticMarkup(<UnsavedChangesDialog {...props} saving />)).toContain('<progress');
    expect(renderToStaticMarkup(<UnsavedChangesDialog {...props} saving={false} />)).not.toContain('<progress');
  });
});
