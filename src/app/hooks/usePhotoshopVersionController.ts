import { useCallback } from 'react';
import type { ImportedImage, PhotoshopProjectMetadata, PhotoshopVersionRecord, Scene } from '../../types';
import { usePhotoshopVersions } from './usePhotoshopVersions';
import { useVersionComparison } from './useVersionComparison';
import type { ProjectSaveContext } from './useProjectLifecycle';

interface UsePhotoshopVersionControllerOptions {
  api: Window['refCanvas'];
  metadata: PhotoshopProjectMetadata;
  captureProjectSave(exclusive?: boolean): ProjectSaveContext | undefined;
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
  beginOperation(kind: 'photoshop', message: string): number;
  settleOperation(requestId: number, status: 'success' | 'error', message: string): void;
  clearOperation(requestId: number): void;
  setStatus(message: string): void;
}

export function usePhotoshopVersionController(options: UsePhotoshopVersionControllerOptions) {
  const comparison = useVersionComparison({
    api: options.api,
    metadata: options.metadata,
    drawingCollaborationMode: options.drawingCollaborationMode,
    documentBlocked: options.documentBlocked,
  });
  const versions = usePhotoshopVersions({
    api: options.api,
    captureProjectSave: options.captureProjectSave,
    onMetadataChange: options.onMetadataChange,
    projectSessionIdRef: options.projectSessionIdRef,
    liveViewportRef: options.liveViewportRef,
    documentBlocked: options.documentBlocked,
    flushViewport: options.flushViewport,
    markSaved: options.markSaved,
    prepareAndAddImages: options.prepareAndAddImages,
    beginOperation: options.beginOperation,
    settleOperation: options.settleOperation,
    clearOperation: options.clearOperation,
    setStatus: options.setStatus,
    onBeforeOpenPanel: comparison.closeVersionComparison,
  });
  const openVersionComparison = useCallback((version: PhotoshopVersionRecord) => {
    if (options.documentBlocked) return;
    versions.closeVersionsPanel();
    comparison.openVersionComparison(version);
  }, [comparison, options.documentBlocked, versions]);

  return { ...versions, ...comparison, openVersionComparison };
}
