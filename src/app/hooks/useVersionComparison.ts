import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PhotoshopProjectMetadata, PhotoshopVersionRecord } from '../../types';
import type { ComparisonMode, ComparisonPreviewState } from '../components/PhotoshopVersionComparePanel';

interface ComparisonPreview {
  url?: string;
  state: ComparisonPreviewState;
  error?: string;
  capturedAt?: string;
  documentName?: string;
}

interface UseVersionComparisonOptions {
  api: Window['refCanvas'];
  metadata: PhotoshopProjectMetadata;
  drawingCollaborationMode: boolean;
  documentBlocked: boolean;
}

export function useVersionComparison({
  api,
  metadata,
  drawingCollaborationMode,
  documentBlocked,
}: UseVersionComparisonOptions) {
  const [comparisonVersionId, setComparisonVersionId] = useState<string>();
  const [comparisonBaseVersionId, setComparisonBaseVersionId] = useState<string>();
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
    setComparisonBaseVersionId(undefined);
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
    if (comparisonVersionId) void captureComparisonPreview();
  }, [captureComparisonPreview, comparisonVersionId]);

  const openVersionComparison = useCallback((version: PhotoshopVersionRecord) => {
    if (documentBlocked) return;
    resetComparisonPreview();
    setComparisonBaseVersionId(undefined);
    setComparisonVersionId(version.id);
    setComparisonMode('ab');
    setComparisonSplit(50);
    setComparisonOpacity(50);
    void captureComparisonPreview();
  }, [captureComparisonPreview, documentBlocked, resetComparisonPreview]);

  const comparisonVersions = useMemo(() => [...metadata.versions].reverse(), [metadata.versions]);
  const comparisonBaseVersion = comparisonBaseVersionId
    ? metadata.versions.find((version) => version.id === comparisonBaseVersionId)
    : undefined;
  const comparisonVersion = comparisonVersionId
    ? metadata.versions.find((version) => version.id === comparisonVersionId)
    : undefined;

  useEffect(() => () => {
    comparisonPreviewRequestRef.current += 1;
    revokeComparisonPreview();
  }, [revokeComparisonPreview]);

  useEffect(() => {
    if (comparisonVersionId && !comparisonVersion) closeVersionComparison();
  }, [closeVersionComparison, comparisonVersion, comparisonVersionId]);

  useEffect(() => {
    if (comparisonBaseVersionId && !comparisonBaseVersion) setComparisonBaseVersionId(undefined);
  }, [comparisonBaseVersion, comparisonBaseVersionId]);

  useEffect(() => {
    if (drawingCollaborationMode && comparisonVersionId) closeVersionComparison();
  }, [closeVersionComparison, comparisonVersionId, drawingCollaborationMode]);

  return {
    comparisonVersionId,
    comparisonVersion,
    comparisonBaseVersionId,
    comparisonBaseVersion,
    comparisonVersions,
    comparisonMode,
    comparisonSplit,
    comparisonOpacity,
    comparisonPreview,
    setComparisonMode,
    setComparisonSplit,
    setComparisonOpacity,
    setComparisonVersionId,
    setComparisonBaseVersionId,
    openVersionComparison,
    refreshComparisonPreview,
    closeVersionComparison,
  };
}
