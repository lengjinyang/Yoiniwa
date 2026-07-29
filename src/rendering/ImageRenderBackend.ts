import type { ImageRenderCommand } from './renderPlan';
import type { Viewport } from '../types';

export type ResolvedImageRenderCommand = ImageRenderCommand & { image?: CanvasImageSource };

export interface ImageSyncResult {
  uploadedIds: string[];
  pendingIds: string[];
  blockedIds: string[];
  evictedIds: string[];
  needsRetry: boolean;
}

export const emptyImageSyncResult = (): ImageSyncResult => ({
  uploadedIds: [], pendingIds: [], blockedIds: [], evictedIds: [], needsRetry: false,
});

export interface ImageRenderStats {
  drawCalls: number;
  instances: number;
  gpuBytes: number;
  textureUploads: number;
  textureCount: number;
  bindTextureCalls: number;
  bufferDataCalls: number;
  bufferSubDataCalls: number;
  texImage2DCalls: number;
  texSubImage2DCalls: number;
  textureUploadMs: number;
  frameUploadBytes?: number;
  uploadQueueLength?: number;
  gestureUniformUpdates?: number;
  fullInstanceUploads?: number;
  atlasFreeArea?: number;
  atlasUsedArea?: number;
  atlasLargestFreeRectArea?: number;
  textureCommandCount?: number;
  activeTextureCount?: number;
  renderedViewportX: number;
  renderedViewportY: number;
  renderedViewportScale: number;
}

export interface ImageRenderBackend {
  readonly kind: 'webgl2' | 'canvas2d';
  resize(width: number, height: number, pixelRatio: number): void;
  /** Describes resource progress so deferred and capacity-blocked work can converge. */
  syncImages(
    images: ReadonlyMap<string, HTMLImageElement>,
    activeIds: ReadonlySet<string>,
    protectedIds?: ReadonlySet<string>,
  ): ImageSyncResult;
  setUploadsPaused?(paused: boolean): void;
  /** Changes eviction ownership without uploading or redrawing. */
  setActiveResources?(activeIds: ReadonlySet<string>): void;
  setSelection?(selectedIds: ReadonlySet<string>): void;
  setGesture?(matrix: readonly number[], opacity?: number): void;
  clearGesture?(): void;
  isImageResident?(id: string): boolean;
  getResidentImageSize?(id: string): { width: number; height: number } | undefined;
  render(commands: readonly ResolvedImageRenderCommand[], viewport: Viewport): void;
  renderViewport?(viewport: Viewport): void;
  getStats(): ImageRenderStats;
  destroy(): void;
}
