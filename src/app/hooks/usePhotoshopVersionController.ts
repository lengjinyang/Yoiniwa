import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { serializeProjectScene } from '../../canvas/persistence/ProjectSerializer';
import type {
  ImportedImage,
  PhotoshopProjectMetadata,
  PhotoshopVersionRecord,
  Scene,
} from '../../types';
import type { ComparisonMode, ComparisonPreviewState } from '../components/PhotoshopVersionComparePanel';

interface ComparisonPreview {
  url?: string;
  state: ComparisonPreviewState;
  error?: string;
  capturedAt?: string;
  documentName?: string;
}

interface UsePhotoshopVersionControllerOptions {
  api: Window['refCanvas'];
  metadata: PhotoshopProjectMetadata;
  metadataRef: { current: PhotoshopProjectMetadata };
  onMetadataChange(metadata: PhotoshopProjectMetadata): void;
  projectSessionIdRef: { current: string | undefined };
  liveViewportRef: { current: Scene['viewport'] };
  drawingCollaborationMode: boolean;
  documentBlocked: boolean;
  flushViewport(viewport: Scene['viewport']): { scene: Scene; revision: number };
  markSaved(scene?: Scene, revision?: number): boolean;
  prepareAndAddImages(
    sources: ImportedImage[],
    placement?: { screenX: number; screenY: number; pack?: boolean },
  ): Promise<void>;
  renderProjectPreview(scene: Scene): Promise<ArrayBuffer | undefined>;
  beginOperation(kind: 'photoshop', message: string): number;
  settleOperation(requestId: number, status: 'success' | 'error', message: string): void;
  clearOperation(requestId: number): void;
  setStatus(message: string): void;
}

export function usePhotoshopVersionController({
  api,
  metadata,
  metadataRef,
  onMetadataChange,
  projectSessionIdRef,
  liveViewportRef,
  drawingCollaborationMode,
  documentBlocked,
  flushViewport,
  markSaved,
  prepareAndAddImages,
  renderProjectPreview,
  beginOperation,
  settleOperation,
  clearOperation,
  setStatus,
}: UsePhotoshopVersionControllerOptions) {
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [versionName, setVersionName] = useState('');
  const [versionNote, setVersionNote] = useState('');
  const [comparisonVersionId, setComparisonVersionId] = useState<string>();
  const [comparisonMode, setComparisonMode] = useState<ComparisonMode>('ab');
  const [comparisonSplit, setComparisonSplit] = useState(50);
  const [comparisonOpacity, setComparisonOpacity] = useState(50);
  const [comparisonPreview, setComparisonPreview] = useState<ComparisonPreview>({ state: 'loading' });
  const comparisonPreviewUrlRef = useRef<string | undefined>(undefined);
  const comparisonPreviewRequestRef = useRef(0);

  const revokeComparisonPreview = useCallback(() => {
    const url = comparisonPreviewUrlRef.current;
    comparisonPreviewUrlRef.current = undefined;
    if (url) URL.revokeObjectURL(url);
  }, []);

  const resetComparisonPreview = useCallback(() => {
    comparisonPreviewRequestRef.current += 1;
    revokeComparisonPreview();
    setComparisonPreview({ state: 'loading' });
  }, [revokeComparisonPreview]);

  const closeVersionComparison = useCallback(() => {
    resetComparisonPreview();
    setComparisonVersionId(undefined);
  }, [resetComparisonPreview]);

  const captureComparisonPreview = useCallback(async () => {
    const request = ++comparisonPreviewRequestRef.current;
    setComparisonPreview((current) => ({ ...current, state: 'loading', error: undefined }));
    try {
      const result = await api?.capturePhotoshopPreview();
      if (!result?.ok || !result.preview) throw new Error(result?.message ?? '无法捕获 Photoshop 当前文档预览');
      const url = URL.createObjectURL(new Blob([result.preview], { type: 'image/png' }));
      if (request !== comparisonPreviewRequestRef.current) {
        URL.revokeObjectURL(url);
        return;
      }
      revokeComparisonPreview();
      comparisonPreviewUrlRef.current = url;
      setComparisonPreview({
        url,
        state: 'ready',
        capturedAt: new Date().toISOString(),
        documentName: result.documentName,
      });
    } catch (error) {
      if (request !== comparisonPreviewRequestRef.current) return;
      setComparisonPreview((current) => ({ ...current, state: 'error', error: String(error) }));
    }
  }, [api, revokeComparisonPreview]);

  const refreshComparisonPreview = useCallback(() => {
    if (!comparisonVersionId) return;
    void captureComparisonPreview();
  }, [captureComparisonPreview, comparisonVersionId]);

  const openVersionComparison = useCallback((version: PhotoshopVersionRecord) => {
    if (documentBlocked) return;
    resetComparisonPreview();
    setComparisonVersionId(version.id);
    setComparisonMode('ab');
    setComparisonSplit(50);
    setComparisonOpacity(50);
    setVersionsOpen(false);
    void captureComparisonPreview();
  }, [captureComparisonPreview, documentBlocked, resetComparisonPreview]);

  const comparisonVersions = useMemo(() => [...metadata.versions].reverse(), [metadata.versions]);
  const comparisonVersion = comparisonVersionId
    ? metadata.versions.find((version) => version.id === comparisonVersionId) : undefined;

  useEffect(() => () => {
    comparisonPreviewRequestRef.current += 1;
    revokeComparisonPreview();
  }, [revokeComparisonPreview]);

  useEffect(() => {
    if (comparisonVersionId && !comparisonVersion) closeVersionComparison();
  }, [closeVersionComparison, comparisonVersion, comparisonVersionId]);

  useEffect(() => {
    if (drawingCollaborationMode && comparisonVersionId) closeVersionComparison();
  }, [closeVersionComparison, comparisonVersionId, drawingCollaborationMode]);

  const closeVersionsPanel = useCallback(() => setVersionsOpen(false), []);
  const toggleVersionsPanel = useCallback(() => {
    if (!versionsOpen) closeVersionComparison();
    setVersionsOpen(!versionsOpen);
  }, [closeVersionComparison, versionsOpen]);

  const closeSaveDialog = useCallback(() => setSaveDialogOpen(false), []);

  const savePhotoshopVersion = useCallback(async () => {
    if (!api || documentBlocked) return;
    const name = versionName.trim();
    if (!name) {
      setStatus('请输入版本名称');
      return;
    }
    const flushed = flushViewport(liveViewportRef.current);
    const requestId = beginOperation('photoshop', '正在保存 Photoshop 分层版本…');
    try {
      const preview = await renderProjectPreview(flushed.scene);
      const result = await api.createPhotoshopVersion(
        projectSessionIdRef.current,
        serializeProjectScene(flushed.scene),
        metadataRef.current,
        name,
        versionNote,
        flushed.revision,
        preview,
      );
      if (result.canceled) {
        clearOperation(requestId);
        return;
      }
      if (!result.version || !result.metadata) throw new Error(result.message ?? 'Photoshop 版本保存失败');
      if (result.sessionId) projectSessionIdRef.current = result.sessionId;
      if (result.scene) markSaved(result.scene, result.committedRevision ?? flushed.revision);
      onMetadataChange(result.metadata);
      setSaveDialogOpen(false);
      setVersionName('');
      setVersionNote('');
      settleOperation(requestId, 'success', `已保存 Photoshop 版本 ${result.version.name}`);
    } catch (error) {
      settleOperation(requestId, 'error', `保存 Photoshop 版本失败：${String(error)}`);
    }
  }, [api, beginOperation, clearOperation, documentBlocked, flushViewport, liveViewportRef, markSaved, metadataRef,
    onMetadataChange, projectSessionIdRef, renderProjectPreview, settleOperation, setStatus, versionName, versionNote]);

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
    const flushed = flushViewport(liveViewportRef.current);
    const preview = await renderProjectPreview(flushed.scene);
    const result = await api.deletePhotoshopVersion(
      projectSessionIdRef.current,
      serializeProjectScene(flushed.scene),
      metadataRef.current,
      version.id,
      flushed.revision,
      preview,
    );
    if (result.metadata) onMetadataChange(result.metadata);
    if (result.sessionId) projectSessionIdRef.current = result.sessionId;
    if (result.scene) markSaved(result.scene, result.committedRevision ?? flushed.revision);
    setStatus(result.metadata ? `已删除版本 ${version.name}` : (result.message ?? '删除 Photoshop 版本失败'));
  }, [api, documentBlocked, flushViewport, liveViewportRef, markSaved, metadataRef, onMetadataChange,
    projectSessionIdRef, renderProjectPreview, setStatus]);

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
    comparisonVersionId,
    comparisonVersion,
    comparisonVersions,
    comparisonMode,
    comparisonSplit,
    comparisonOpacity,
    comparisonPreview,
    setComparisonMode,
    setComparisonSplit,
    setComparisonOpacity,
    setComparisonVersionId,
    openVersionComparison,
    refreshComparisonPreview,
    closeVersionComparison,
  };
}
