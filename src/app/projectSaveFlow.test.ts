import { describe, expect, it, vi } from 'vitest';
import type { ProjectCommitRequest } from '../types';
import { runProjectSaveFlow } from './projectSaveFlow';

const request = { reason: 'explicit' } as ProjectCommitRequest;

describe('project save flow', () => {
  it('opens Save As before preparing the expensive project request', async () => {
    const order: string[] = [];
    const api = {
      chooseProjectSavePath: vi.fn(async () => { order.push('dialog'); return { canceled: false, token: 'token' }; }),
      saveProjectAs: vi.fn(async () => { order.push('save'); return { canceled: false }; }),
      commitProject: vi.fn(async () => ({ canceled: false })),
    };
    const createRequest = vi.fn(async () => { order.push('preview'); return request; });

    await runProjectSaveFlow({ api, useSaveAs: true, suggestedName: '画板.yoi', createRequest });

    expect(order).toEqual(['dialog', 'preview', 'save']);
    expect(api.saveProjectAs).toHaveBeenCalledWith(request, 'token');
  });

  it('does not prepare a preview when the Save As dialog is canceled', async () => {
    const api = {
      chooseProjectSavePath: vi.fn(async () => ({ canceled: true })),
      saveProjectAs: vi.fn(async () => ({ canceled: false })),
      commitProject: vi.fn(async () => ({ canceled: false })),
    };
    const createRequest = vi.fn(async () => request);

    const result = await runProjectSaveFlow({ api, useSaveAs: true, suggestedName: '画板.yoi', createRequest });

    expect(result).toEqual({ canceled: true });
    expect(createRequest).not.toHaveBeenCalled();
    expect(api.saveProjectAs).not.toHaveBeenCalled();
  });

  it('keeps direct commits on the existing request-first path', async () => {
    const order: string[] = [];
    const api = {
      chooseProjectSavePath: vi.fn(async () => ({ canceled: false, token: 'unused' })),
      saveProjectAs: vi.fn(async () => ({ canceled: false })),
      commitProject: vi.fn(async () => { order.push('commit'); return { canceled: false }; }),
    };

    await runProjectSaveFlow({
      api, useSaveAs: false, suggestedName: '画板.yoi',
      createRequest: async () => { order.push('preview'); return request; },
    });

    expect(order).toEqual(['preview', 'commit']);
    expect(api.chooseProjectSavePath).not.toHaveBeenCalled();
  });
});
