import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createScene } from '../../domain/scene';
import type { Scene } from '../../types';
import { renderProjectPreview } from '../projectPreview';
import { useProjectLifecycle } from './useProjectLifecycle';

const autosave = vi.hoisted(() => ({
  execute: null as ((scene: Scene, revision: number) => Promise<void>) | null,
  cancel: vi.fn(),
}));
vi.mock('../../persistence/AutosaveCoordinator', () => ({
  AutosaveCoordinator: class {
    constructor(save: (scene: Scene, revision: number) => Promise<void>) { autosave.execute = save; }
    cancel = autosave.cancel;
  },
}));
vi.mock('../projectPreview', () => ({ renderProjectPreview: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup() {
  const scene = { ...createScene(), name: 'A' };
  const api = {
    openProject: vi.fn(async () => ({ canceled: false, sessionId: 'B', path: 'B.yoi', scene: { ...scene, name: 'B' } })),
    closeProject: vi.fn(async () => undefined),
    commitProject: vi.fn<NonNullable<Window['refCanvas']>['commitProject']>(async () => ({
      sessionId: 'A', scene, path: 'A.yoi', committedRevision: 20,
    })),
    saveProjectAs: vi.fn(),
    recentScenes: vi.fn(async () => []),
  };
  const history = {
    scene, dirty: false, revision: 20, commit: vi.fn(), load: vi.fn(), updateViewport: vi.fn(),
    flushViewport: vi.fn(() => ({ scene, revision: 20 })), markSaved: vi.fn(() => true),
  };
  const options = {
    api: api as unknown as Window['refCanvas'], history, beforeProjectChangeRef: { current: vi.fn() },
    setSelectedIds: vi.fn(), setSelectedGroupId: vi.fn(), setStatus: vi.fn(),
    beginOperation: vi.fn(() => 1), settleOperation: vi.fn(), clearOperation: vi.fn(),
  };
  let controller!: ReturnType<typeof useProjectLifecycle>;
  function Probe() { controller = useProjectLifecycle(options); return null; }
  renderToString(createElement(Probe));
  controller.projectSessionIdRef.current = 'A';
  return { controller, api, history, options };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(renderProjectPreview).mockResolvedValue(undefined);
});

describe('project save isolation', () => {
  it('discards old autosave previews and responses when another project opens', async () => {
    for (const stage of ['preview', 'commit']) {
      const { controller, api, history } = setup();
      const preview = deferred<ArrayBuffer | undefined>();
      const result = deferred<Awaited<ReturnType<typeof api.commitProject>>>();
      if (stage === 'preview') vi.mocked(renderProjectPreview).mockReturnValueOnce(preview.promise);
      else api.commitProject.mockReturnValueOnce(result.promise);
      const saving = autosave.execute!(history.scene, 20);
      await Promise.resolve();
      await controller.open('B.yoi');
      preview.resolve(undefined);
      result.resolve({ scene: history.scene, sessionId: 'A', committedRevision: 20 });
      await saving;
      expect(api.commitProject).toHaveBeenCalledTimes(stage === 'preview' ? 0 : 1);
      if (stage === 'commit') expect(api.commitProject).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'A' }));
      expect(history.markSaved).not.toHaveBeenCalled();
      expect(controller.projectSessionIdRef.current).toBe('B');
      expect(autosave.cancel).toHaveBeenCalled();
    }
  });

  it('serializes manual saves with project changes and invalidates unsaved-board contexts', async () => {
    const { controller, api, history, options } = setup();
    const preview = deferred<ArrayBuffer | undefined>();
    vi.mocked(renderProjectPreview).mockReturnValueOnce(preview.promise);
    const saving = controller.save();
    await controller.newScene();
    expect(api.closeProject).not.toHaveBeenCalled();
    expect(options.setStatus).toHaveBeenCalledWith('请等待保存完成后再切换画板');
    preview.resolve(undefined);
    expect(await saving).toBe(true);
    expect(api.commitProject).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'A', reason: 'explicit' }));
    expect(history.markSaved).toHaveBeenCalledWith(history.scene, 20);
    await controller.newScene();
    const unsavedContext = controller.captureProjectSave()!;
    expect(unsavedContext.sessionId).toBeUndefined();
    await controller.newScene();
    expect(unsavedContext.isCurrent()).toBe(false);
    expect(controller.captureProjectSave()?.isCurrent()).toBe(true);
    api.commitProject.mockClear();
    await autosave.execute!(history.scene, 20);
    expect(api.commitProject).not.toHaveBeenCalled();
  });
});
