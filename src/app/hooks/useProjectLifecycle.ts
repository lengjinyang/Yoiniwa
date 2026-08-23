import { useCallback, useEffect, useRef, useState } from 'react';
import { AutosaveCoordinator } from '../../persistence/AutosaveCoordinator';
import { loadProjectScene } from '../../persistence/ProjectLoader';
import { serializeProjectScene } from '../../persistence/ProjectSerializer';
import { createScene, validateScene } from '../../domain/scene';
import { mergeSceneInto } from '../../domain/sceneMerge';
import { EMPTY_PHOTOSHOP_PROJECT_METADATA } from '../../shared/photoshopVersions';
import type { PhotoshopProjectMetadata, RecentScene, Scene } from '../../types';
import { renderProjectPreview } from '../projectPreview';

interface ProjectHistory {
  scene: Scene;
  dirty: boolean;
  revision: number;
  commit(updater: (scene: Scene) => void): void;
  load(scene: Scene): void;
  updateViewport(viewport: Scene['viewport']): void;
  flushViewport(viewport: Scene['viewport']): { scene: Scene; revision: number };
  markSaved(scene?: Scene, revision?: number): boolean;
}

interface UseProjectLifecycleOptions {
  api: Window['refCanvas'];
  history: ProjectHistory;
  beforeProjectChangeRef: { current: () => void };
  setSelectedIds(ids: string[]): void;
  setSelectedGroupId(id?: string): void;
  setStatus(message: string): void;
  beginOperation(kind: 'save' | 'open' | 'import', message: string): number;
  settleOperation(requestId: number, status: 'success' | 'error', message: string): void;
  clearOperation(requestId: number): void;
}

type PendingProjectChange = { kind: 'open'; path?: string } | { kind: 'new' };

export function useProjectLifecycle({
  api,
  history,
  beforeProjectChangeRef,
  setSelectedIds,
  setSelectedGroupId,
  setStatus,
  beginOperation,
  settleOperation,
  clearOperation,
}: UseProjectLifecycleOptions) {
  const [recent, setRecent] = useState<RecentScene[]>([]);
  const [pendingChange, setPendingChange] = useState<PendingProjectChange>();
  const [pendingChangeSaving, setPendingChangeSaving] = useState(false);
  const [photoshopMetadata, setPhotoshopMetadata] = useState<PhotoshopProjectMetadata>(EMPTY_PHOTOSHOP_PROJECT_METADATA);
  const photoshopMetadataRef = useRef(photoshopMetadata);
  const projectSessionIdRef = useRef<string | undefined>(undefined);
  const liveViewportRef = useRef(history.scene.viewport);
  const saveInFlightRef = useRef(false);
  const autosaveExecuteRef = useRef<(scene: Scene, revision: number) => Promise<void>>(async () => undefined);
  const autosaveCoordinatorRef = useRef<AutosaveCoordinator | undefined>(undefined);
  const openRef = useRef<(path?: string) => Promise<void>>(async () => undefined);
  photoshopMetadataRef.current = photoshopMetadata;

  if (!autosaveCoordinatorRef.current) {
    autosaveCoordinatorRef.current = new AutosaveCoordinator((scene, revision) => autosaveExecuteRef.current(scene, revision));
  }

  autosaveExecuteRef.current = async (scene, revision) => {
    const preview = await renderProjectPreview(scene);
    const result = await api?.commitProject({
      sessionId: projectSessionIdRef.current,
      scene: serializeProjectScene(scene),
      photoshopProject: photoshopMetadataRef.current,
      rendererRevision: revision,
      preview,
      reason: 'autosave',
    });
    if (result?.scene) {
      if (result.sessionId) projectSessionIdRef.current = result.sessionId;
      history.markSaved(result.scene, result.committedRevision ?? revision);
    }
  };

  useEffect(() => {
    liveViewportRef.current = history.scene.viewport;
  }, [history.scene.viewport]);

  useEffect(() => {
    const autosave = autosaveCoordinatorRef.current;
    if (!history.dirty) autosave?.cancel();
    else autosave?.schedule(history.scene, history.revision);
    return () => autosave?.cancel();
  }, [history.dirty, history.revision, history.scene]);

  useEffect(() => () => autosaveCoordinatorRef.current?.destroy(), []);

  const refreshRecent = useCallback(() => {
    if (!api) return;
    void api.recentScenes().then(setRecent).catch((error) => setStatus(`刷新最近画板失败：${String(error)}`));
  }, [api, setStatus]);

  const removeRecent = useCallback(async (path: string) => {
    if (!api) return;
    try {
      setRecent(await api.removeRecentScene(path));
      setStatus('已从最近文件中移除');
    } catch (error) {
      setStatus(`移除最近文件失败：${String(error)}`);
    }
  }, [api, setStatus]);

  useEffect(() => {
    if (!api) return;
    void api.recentScenes().then(setRecent).catch((error) => setStatus(`读取最近画板失败：${String(error)}`));
  }, [api, setStatus]);

  useEffect(() => {
    api?.setDirty(history.dirty, history.revision);
  }, [api, history.dirty, history.revision]);

  const save = useCallback(async (saveAs = false) => {
    if (!api || saveInFlightRef.current) return false;
    saveInFlightRef.current = true;
    const flushed = history.flushViewport(liveViewportRef.current);
    const saveRevision = flushed.revision;
    const requestId = beginOperation('save', '正在保存…');
    try {
      const preview = await renderProjectPreview(flushed.scene);
      const request = {
        sessionId: projectSessionIdRef.current,
        scene: serializeProjectScene(flushed.scene),
        photoshopProject: photoshopMetadataRef.current,
        rendererRevision: saveRevision,
        preview,
        reason: 'explicit' as const,
      };
      const result = saveAs || !projectSessionIdRef.current
        ? await api.saveProjectAs(request)
        : await api.commitProject(request);
      if (!result.canceled) {
        if (result.sessionId) projectSessionIdRef.current = result.sessionId;
        const savedCurrentRevision = result.scene
          ? history.markSaved(result.scene, result.committedRevision ?? saveRevision) : false;
        if (result.metadata) setPhotoshopMetadata(result.metadata);
        const upgrade = result.upgraded === 'legacy-yoi' ? '（旧 .yoi 已升级并保留 legacy 备份）'
          : result.upgraded === 'refcanvas' ? '（已从 .refcanvas 升级，旧文件保留）' : '';
        settleOperation(requestId, 'success', `已保存至 ${result.path}${upgrade}`);
        setStatus(savedCurrentRevision ? '' : '保存完成，但保存期间产生了新修改');
        refreshRecent();
        return savedCurrentRevision;
      }
      clearOperation(requestId);
      return false;
    } catch (error) {
      settleOperation(requestId, 'error', `保存失败：${String(error)}`);
      return false;
    } finally {
      saveInFlightRef.current = false;
    }
  }, [api, beginOperation, clearOperation, history, refreshRecent, setStatus, settleOperation]);

  const openNow = useCallback(async (path?: string) => {
    if (!api) return;
    beforeProjectChangeRef.current();
    const requestId = beginOperation('open', '正在打开画板…');
    try {
      const result = await api.openProject(path);
      const loaded = loadProjectScene(result.scene);
      if (!result.canceled && validateScene(loaded)) {
        history.load(loaded);
        projectSessionIdRef.current = result.sessionId;
        setPhotoshopMetadata(result.metadata ?? EMPTY_PHOTOSHOP_PROJECT_METADATA);
        setSelectedIds([]);
        setSelectedGroupId(undefined);
        const recovery = result.recovered ? `（已从 ${result.recoverySource ?? '最后一个完整提交'} 恢复）` : '';
        const readOnly = result.readOnly ? '（只读；保存时请使用另存为）' : '';
        settleOperation(requestId, 'success', `已打开 ${result.path}${recovery}${readOnly}`);
        refreshRecent();
      } else if (!result.canceled) settleOperation(requestId, 'error', '无法打开：不是有效的 Yoiniwa 画板');
      else clearOperation(requestId);
    } catch (error) {
      settleOperation(requestId, 'error', `打开失败：${String(error)}`);
    }
  }, [api, beforeProjectChangeRef, beginOperation, clearOperation, history, refreshRecent, setSelectedGroupId,
    setSelectedIds, settleOperation]);

  const open = useCallback(async (path?: string) => {
    if (history.dirty) {
      setPendingChange({ kind: 'open', path });
      return;
    }
    await openNow(path);
  }, [history.dirty, openNow]);
  openRef.current = open;

  useEffect(() => {
    if (!api) return undefined;
    let active = true;
    void api.consumeStartupPath().then(async (path) => {
      if (!active) return;
      if (path) await openRef.current(path);
    }).catch((error) => {
      if (active) setStatus(`读取启动信息失败：${String(error)}`);
    });
    const dispose = api.onExternalOpen((path) => { void openRef.current(path); });
    return () => { active = false; dispose(); };
  }, [api, setStatus]);

  const importScene = useCallback(async () => {
    if (!api) return;
    const requestId = beginOperation('import', '正在导入画板…');
    try {
      const result = await api.importScene();
      if (result.canceled || !result.scene) {
        clearOperation(requestId);
        return;
      }
      const imported = loadProjectScene(result.scene);
      if (!validateScene(imported)) {
        settleOperation(requestId, 'error', '无法导入：不是有效的 Yoiniwa 画板');
        return;
      }
      const viewport = history.scene.viewport;
      let merged: ReturnType<typeof mergeSceneInto> | undefined;
      history.commit((scene) => {
        merged = mergeSceneInto(scene, imported, {
          x: (window.innerWidth / 2 - viewport.x) / viewport.scale,
          y: (window.innerHeight / 2 - viewport.y) / viewport.scale,
        });
      });
      setSelectedIds(merged?.imageIds ?? []);
      setSelectedGroupId(merged?.rootGroupIds[0]);
      const count = (merged?.imageIds.length ?? 0) + (merged?.groupIds.length ?? 0);
      settleOperation(requestId, 'success', `已导入 ${count} 个对象`);
    } catch (error) {
      settleOperation(requestId, 'error', `导入画板失败：${String(error)}`);
    }
  }, [api, beginOperation, clearOperation, history, setSelectedGroupId, setSelectedIds, settleOperation]);

  const newSceneNow = useCallback(async () => {
    beforeProjectChangeRef.current();
    try {
      await api?.closeProject(projectSessionIdRef.current);
    } catch (error) {
      setStatus(`无法关闭当前画板：${String(error)}`);
      return;
    }
    projectSessionIdRef.current = undefined;
    history.load(createScene());
    setPhotoshopMetadata(EMPTY_PHOTOSHOP_PROJECT_METADATA);
    setSelectedIds([]);
    setSelectedGroupId(undefined);
    setStatus('已新建画板');
  }, [api, beforeProjectChangeRef, history, setSelectedGroupId, setSelectedIds, setStatus]);

  const newScene = useCallback(() => {
    if (history.dirty) {
      setPendingChange({ kind: 'new' });
      return;
    }
    void newSceneNow();
  }, [history.dirty, newSceneNow]);

  const cancelPendingChange = useCallback(() => {
    if (pendingChangeSaving) return;
    setPendingChange(undefined);
  }, [pendingChangeSaving]);

  const continuePendingChange = useCallback(async (pending: PendingProjectChange) => {
    if (pending.kind === 'open') await openNow(pending.path);
    else await newSceneNow();
  }, [newSceneNow, openNow]);

  const discardPendingChange = useCallback(() => {
    if (!pendingChange || pendingChangeSaving) return;
    const next = pendingChange;
    setPendingChange(undefined);
    void continuePendingChange(next);
  }, [continuePendingChange, pendingChange, pendingChangeSaving]);

  const saveAndContinuePendingChange = useCallback(async () => {
    if (!pendingChange || pendingChangeSaving) return;
    setPendingChangeSaving(true);
    const next = pendingChange;
    const saved = await save(false);
    if (saved) {
      setPendingChange(undefined);
      await continuePendingChange(next);
    }
    setPendingChangeSaving(false);
  }, [continuePendingChange, pendingChange, pendingChangeSaving, save]);

  const displaySceneName = history.scene.name === '未命名画板' ? history.scene.name : `${history.scene.name}.yoi`;
  useEffect(() => {
    const title = `${displaySceneName}${history.dirty ? ' •' : ''} · Yoiniwa`;
    document.title = title;
    void api?.setTitle(title).catch(() => undefined);
  }, [api, displaySceneName, history.dirty]);

  const onViewportCommit = useCallback((viewport: Scene['viewport']) => {
    liveViewportRef.current = viewport;
    history.updateViewport(viewport);
  }, [history]);

  return {
    recent,
    removeRecent,
    photoshopMetadata,
    setPhotoshopMetadata,
    photoshopMetadataRef,
    projectSessionIdRef,
    liveViewportRef,
    displaySceneName,
    pendingChange,
    pendingChangeSaving,
    save,
    open,
    cancelPendingChange,
    discardPendingChange,
    saveAndContinuePendingChange,
    importScene,
    newScene,
    onViewportCommit,
  };
}
