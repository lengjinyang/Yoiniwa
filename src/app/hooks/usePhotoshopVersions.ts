import { useCallback, useState } from 'react';
import { serializeProjectScene } from '../../persistence/ProjectSerializer';
import type {
  ImportedImage,
  PhotoshopProjectMetadata,
  PhotoshopVersionRecord,
  Scene,
} from '../../types';
import { renderProjectPreview } from '../projectPreview';
import type { ProjectSaveContext } from './useProjectLifecycle';

interface UsePhotoshopVersionsOptions {
  api: Window['refCanvas'];
  captureProjectSave(exclusive?: boolean): ProjectSaveContext | undefined;
  onMetadataChange(metadata: PhotoshopProjectMetadata): void;
  projectSessionIdRef: { current: string | undefined };
  liveViewportRef: { current: Scene['viewport'] };
  documentBlocked: boolean;
  flushViewport(viewport: Scene['viewport']): { scene: Scene; revision: number };
  markSaved(scene?: Scene, revision?: number): boolean;
  prepareAndAddImages(
    sources: ImportedImage[],
    placement?: { screenX: number; screenY: number; pack?: boolean },
  ): Promise<void>;
  beginOperation(kind: 'photoshop', message: string): number;
  settleOperation(requestId: number, status: 'success' | 'error', message: string): void;
  clearOperation(requestId: number): void;
  setStatus(message: string): void;
  onBeforeOpenPanel(): void;
}

export function usePhotoshopVersions({
  api,
  captureProjectSave,
  onMetadataChange,
  projectSessionIdRef,
  liveViewportRef,
  documentBlocked,
  flushViewport,
  markSaved,
  prepareAndAddImages,
  beginOperation,
  settleOperation,
  clearOperation,
  setStatus,
  onBeforeOpenPanel,
}: UsePhotoshopVersionsOptions) {
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [versionName, setVersionName] = useState('');
  const [versionNote, setVersionNote] = useState('');

  const closeVersionsPanel = useCallback(() => setVersionsOpen(false), []);
  const toggleVersionsPanel = useCallback(() => {
    if (!versionsOpen) onBeforeOpenPanel();
    setVersionsOpen(!versionsOpen);
  }, [onBeforeOpenPanel, versionsOpen]);
  const closeSaveDialog = useCallback(() => setSaveDialogOpen(false), []);

  const savePhotoshopVersion = useCallback(async () => {
    if (!api || documentBlocked) return;
    const name = versionName.trim();
    if (!name) { setStatus('请输入版本名称'); return; }
    const context = captureProjectSave(true);
    if (!context) return;
    setSaveDialogOpen(false);
    const flushed = flushViewport(liveViewportRef.current);
    const requestId = beginOperation('photoshop', '正在保存 Photoshop 分层版本…');
    try {
      const preview = await renderProjectPreview(flushed.scene);
      if (!context.isCurrent()) { clearOperation(requestId); return; }
      const result = await api.createPhotoshopVersion(
        context.sessionId,
        serializeProjectScene(flushed.scene),
        context.photoshopProject,
        name,
        versionNote,
        flushed.revision,
        preview,
      );
      if (!context.isCurrent()) { clearOperation(requestId); return; }
      if (result.canceled) { clearOperation(requestId); setSaveDialogOpen(true); return; }
      if (!result.version || !result.metadata) throw new Error(result.message ?? 'Photoshop 版本保存失败');
      if (result.sessionId) projectSessionIdRef.current = result.sessionId;
      if (result.scene) markSaved(result.scene, result.committedRevision ?? flushed.revision);
      onMetadataChange(result.metadata);
      setSaveDialogOpen(false);
      setVersionName('');
      setVersionNote('');
      settleOperation(requestId, 'success', `已保存 Photoshop 版本 ${result.version.name}`);
    } catch (error) {
      if (!context.isCurrent()) { clearOperation(requestId); return; }
      setSaveDialogOpen(true);
      settleOperation(requestId, 'error', `保存 Photoshop 版本失败：${String(error)}`);
    } finally {
      context.release();
    }
  }, [api, beginOperation, captureProjectSave, clearOperation, documentBlocked, flushViewport, liveViewportRef, markSaved,
    onMetadataChange, projectSessionIdRef, settleOperation, setStatus, versionName, versionNote]);

  const openPhotoshopVersionSaveDialog = useCallback(async () => {
    if (!api || documentBlocked) return;
    const result = await api.getPhotoshopDocumentInfo();
    if (!result.ok || !result.documentName) {
      setStatus(result.message ?? '无法读取 Photoshop 当前文档名称');
      return;
    }
    setVersionName(result.documentName);
    setVersionNote('');
    setSaveDialogOpen(true);
  }, [api, documentBlocked, setStatus]);

  const openPhotoshopVersion = useCallback(async (version: PhotoshopVersionRecord) => {
    if (!api || documentBlocked) return;
    const result = await api.openPhotoshopVersion(projectSessionIdRef.current, version.id);
    setStatus(result.ok ? (result.message ?? `已打开 ${version.name}`) : (result.message ?? '无法打开 Photoshop 版本'));
  }, [api, documentBlocked, projectSessionIdRef, setStatus]);

  const deletePhotoshopVersion = useCallback(async (version: PhotoshopVersionRecord) => {
    if (!api || documentBlocked
      || !window.confirm(`确定删除版本“${version.name}”？此操作会从 .yoi 中移除完整分层文件。`)) return;
    const context = captureProjectSave(true);
    if (!context) return;
    try {
      const flushed = flushViewport(liveViewportRef.current);
      const preview = await renderProjectPreview(flushed.scene);
      if (!context.isCurrent()) return;
      const result = await api.deletePhotoshopVersion(
        context.sessionId,
        serializeProjectScene(flushed.scene),
        context.photoshopProject,
        version.id,
        flushed.revision,
        preview,
      );
      if (!context.isCurrent()) return;
      if (result.metadata) onMetadataChange(result.metadata);
      if (result.sessionId) projectSessionIdRef.current = result.sessionId;
      if (result.scene) markSaved(result.scene, result.committedRevision ?? flushed.revision);
      setStatus(result.metadata ? `已删除版本 ${version.name}` : (result.message ?? '删除 Photoshop 版本失败'));
    } catch (error) {
      if (context.isCurrent()) setStatus(`删除 Photoshop 版本失败：${String(error)}`);
    } finally {
      context.release();
    }
  }, [api, captureProjectSave, documentBlocked, flushViewport, liveViewportRef, markSaved, onMetadataChange,
    projectSessionIdRef, setStatus]);

  const placePhotoshopVersionPreview = useCallback(async (
    version: PhotoshopVersionRecord,
    placement?: { screenX: number; screenY: number },
  ) => {
    const source: ImportedImage = {
      name: `${version.name}.png`,
      assetId: version.previewAssetId,
      asset: version.previewAsset,
      sourceType: 'file',
    };
    await prepareAndAddImages(
      [source],
      placement ?? { screenX: window.innerWidth / 2, screenY: window.innerHeight / 2 },
    );
    setStatus(`已将版本 ${version.name} 的预览放入画板`);
  }, [prepareAndAddImages, setStatus]);

  return {
    versionsOpen,
    closeVersionsPanel,
    toggleVersionsPanel,
    saveDialogOpen,
    versionName,
    versionNote,
    setVersionName,
    setVersionNote,
    closeSaveDialog,
    savePhotoshopVersion,
    openPhotoshopVersionSaveDialog,
    openPhotoshopVersion,
    deletePhotoshopVersion,
    placePhotoshopVersionPreview,
  };
}
