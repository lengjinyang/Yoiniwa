import type { AssetRecord, ImageItem, Scene } from './domain/sceneTypes';

export type {
  AssetRecord,
  ArrowVisualMark,
  BoardItem,
  BrushVisualMark,
  DisplayableMedia,
  EraserSize,
  ImageGroup,
  ImageItem,
  Scene,
  SceneItem,
  SceneItemPatch,
  VideoItem,
  Viewport,
  VisualMark,
  VisualNotePoint,
  VisualNotesState,
  VisualNoteTool,
  VisualNoteWidth,
} from './domain/sceneTypes';

export interface ImportedImage {
  name: string;
  path?: string;
  assetId: string;
  asset: AssetRecord;
  dataUrl?: string;
  sourceType?: ImageItem['sourceType'];
  /** Still poster registered alongside a video import. */
  poster?: ImportedImage;
}

export interface PickedColor { r: number; g: number; b: number; a: number; hex: string }

export interface PhotoshopColorSyncResult {
  ok: boolean;
  status: 'synced' | 'not-running' | 'automation-error' | 'unsupported';
  syncStatus: 'synced' | 'not-running' | 'automation-error' | 'unsupported';
  focusStatus: 'activated' | 'not-found' | 'automation-error' | 'skipped';
  copied: boolean;
  syncLatencyMs: number;
  message?: string;
}

interface PhotoshopDocumentResult {
  ok: boolean;
  status: 'completed' | 'not-running' | 'no-document' | 'automation-error' | 'unsupported' | 'blocked';
  message?: string;
}

interface PhotoshopDocumentInfoResult {
  ok: boolean;
  status: PhotoshopDocumentResult['status'];
  documentName?: string;
  message?: string;
}

interface PhotoshopDocumentPreviewResult extends PhotoshopDocumentResult {
  preview?: ArrayBuffer;
  documentName?: string;
  width?: number;
  height?: number;
  colorMode?: string;
  bitDepth?: number;
  layerCount?: number;
  format?: 'psd' | 'psb';
}

export interface PhotoshopVersionRecord {
  id: string;
  name: string;
  note?: string;
  createdAt: string;
  documentName: string;
  width: number;
  height: number;
  colorMode: string;
  bitDepth: number;
  layerCount: number;
  format: 'psd' | 'psb';
  byteLength: number;
  sha256: string;
  /** SHA-256 content address used by YoiStorage v4. */
  blobId?: string;
  /** ZIP entry retained only while reading a legacy project. */
  archiveEntry?: string;
  previewAssetId: string;
  previewAsset: AssetRecord;
}

export interface PhotoshopProjectMetadata { versions: PhotoshopVersionRecord[] }

type ProjectCommitReason = 'explicit' | 'autosave' | 'version-add' | 'version-delete';

interface ProjectCommitRequest {
  sessionId?: string;
  scene: Scene;
  photoshopProject: PhotoshopProjectMetadata;
  rendererRevision?: number;
  preview?: ArrayBuffer;
  reason: ProjectCommitReason;
}

interface ProjectCommitResult {
  canceled?: boolean;
  skipped?: boolean;
  path?: string;
  sessionId?: string;
  scene?: Scene;
  metadata?: PhotoshopProjectMetadata;
  generation?: number;
  committedRevision?: number;
  bytesAppended?: number;
  compactionScheduled?: boolean;
  recovered?: boolean;
  upgraded?: 'refcanvas' | 'legacy-yoi';
}

interface ProjectOpenResult extends ProjectCommitResult {
  canceled: boolean;
  recoverySource?: string;
  readOnly?: boolean;
}

interface ProjectStorageStats {
  generation: number;
  fileBytes: number;
  liveBytes: number;
  staleBytes: number;
  staleRatio: number;
  blobCount: number;
  readOnly?: boolean;
  recovered?: boolean;
  recoverySource?: string;
}

export interface RecentScene { path: string; name: string; openedAt: string; assetIds?: string[] }

export interface AppUpdateInfo {
  available: boolean;
  version?: string;
  currentVersion?: string;
  notes?: string;
  date?: string;
}

export interface CacheInfo {
  root: string;
  isDefault: boolean;
  assetBytes: number;
  derivedBytes: number;
  warning?: string;
}
export interface ImagePipelinePerformanceStats {
  metadataCount: number;
  metadataMs: number;
  thumbnailCount: number;
  thumbnailMs: number;
  thumbnailFailures: number;
  jobsActive?: number;
  jobsPending?: number;
  jobsInflight?: number;
  jobsConcurrency?: number;
  jobsCompleted?: number;
  proxyActive?: number;
  proxyQueued?: number;
}
export interface ImagePrewarmProgress {
  requestId: string;
  completed: number;
  total: number;
  stage?: 'metadata' | 'hash' | 'decode' | 'mip' | 'commit' | 'scene' | 'preview' | 'detail';
  fraction?: number;
  stageCompleted?: number;
  stageTotal?: number;
  failed?: number;
  detailFailed?: number;
  lastFailedName?: string;
}

export interface ImageThumbnailReady {
  assetId: string;
  variant: 'thumb128' | 'thumb256' | 'thumb512' | 'thumb768' | 'thumb1024';
}

export interface ImageDerivativeReady {
  assetId: string;
  kind: 'mip' | 'tile' | 'thumb' | 'video-poster';
  edge?: number;
  level?: number;
  column?: number;
  row?: number;
}

export interface WindowState {
  alwaysOnTop: boolean;
  clickThrough: boolean;
  locked: boolean;
  collaborationMode: boolean;
  opacity: number;
}

export interface NativePointerInput {
  kind: 'down' | 'move' | 'up' | 'cancel' | 'hover' | 'wheel' | 'hwheel';
  clientX: number;
  clientY: number;
  altKey: boolean;
  spaceKey: boolean;
  pointerType: 'mouse' | 'pen';
  delta: number;
  visibleBounds?: { left: number; top: number; right: number; bottom: number };
  screenX?: number;
  screenY?: number;
  hitBounds?: { left: number; top: number; right: number; bottom: number };
}

export interface VideoPreparationResult {
  fps: number;
  frameCount?: number | null;
  ready: boolean;
  unsupportedReason?: string | null;
}

export interface VideoPreparationProgress {
  assetId: string;
  stage: 'indexing' | 'index-ready' | 'transcoding' | 'validating' | 'ready' | 'failed';
  fraction: number;
  fps?: number;
  frameCount?: number;
  message?: string;
}

export interface VideoProxyReady {
  assetId: string;
  fps?: number;
  frameCount?: number;
}

export interface VideoProxyFailed {
  assetId: string;
  message: string;
  indexReady?: boolean;
  unsupportedReason?: string | null;
}

export interface VideoFrameTimingIndex {
  assetId: string;
  fps: number;
  frameCount: number;
  durationUs: number;
  vfr: boolean;
  /** Ordered [presentation timestamp µs, presentation duration µs] pairs. */
  frames: Array<[number, number]>;
}

export interface RefCanvasAPI {
  importImages(requestId?: string): Promise<ImportedImage[]>;
  registerImagePaths(paths: string[], sourceType: ImageItem['sourceType'], requestId?: string): Promise<ImportedImage[]>;
  registerImageUrls(urls: string[]): Promise<ImportedImage[]>;
  registerClipboardImage(): Promise<ImportedImage[]>;
  registerImageBytes?(name: string, data: ArrayBuffer, sourceType?: ImageItem['sourceType']): Promise<ImportedImage>;
  assetFilePath?(assetId: string): Promise<string>;
  ensureVideoPlayback?(assetId: string): Promise<VideoPreparationResult>;
  cancelVideoPlayback?(assetId: string): void;
  prepareVideoIndex?(assetId: string): void;
  getVideoFrameIndex?(assetId: string): Promise<VideoFrameTimingIndex | null>;
  onVideoProxyReady?(callback: (payload: VideoProxyReady) => void): () => void;
  onVideoProxyFailed?(callback: (payload: VideoProxyFailed) => void): () => void;
  onVideoPreparationProgress?(callback: (payload: VideoPreparationProgress) => void): () => void;
  startImageDrag(assetIds: string[]): void;
  prewarmImages(ids: string[], requestId: string): Promise<{ canceled: boolean; completed: number; total: number; failed: number; detailFailed?: number }>;
  boostImageResource(key: string, priority: number): void;
  cancelPrewarmImages(requestId: string): void;
  onPrewarmProgress(callback: (progress: ImagePrewarmProgress) => void): () => void;
  onThumbnailReady(callback: (thumbnail: ImageThumbnailReady) => void): () => void;
  onDerivativeReady?(callback: (derivative: ImageDerivativeReady) => void): () => void;
  onFilesDropped(callback: (drop: { paths: string[]; clientX: number; clientY: number }) => void): () => void;
  pathForFile(file: File): string | undefined;
  openProject(path?: string): Promise<ProjectOpenResult>;
  commitProject(request: ProjectCommitRequest): Promise<ProjectCommitResult>;
  saveProjectAs(request: ProjectCommitRequest): Promise<ProjectCommitResult>;
  closeProject(sessionId?: string): Promise<void>;
  compactProject(sessionId?: string): Promise<ProjectStorageStats | { skipped: true; message?: string }>;
  projectStats(sessionId?: string): Promise<ProjectStorageStats>;
  recoverProject(sessionId?: string): Promise<{ recovered: boolean; sessionId: string }>;
  consumeStartupPath(): Promise<string | null>;
  onExternalOpen(callback: (path: string) => void): () => void;
  importScene(): Promise<{ canceled: boolean; path?: string; scene?: Scene }>;
  recentScenes(): Promise<RecentScene[]>;
  removeRecentScene(path: string): Promise<RecentScene[]>;
  checkForUpdates(): Promise<AppUpdateInfo>;
  installUpdate(): Promise<void>;
  getCacheInfo(): Promise<CacheInfo>;
  chooseCacheLocation(): Promise<{ canceled: boolean; info?: CacheInfo }>;
  resetCacheLocation(): Promise<CacheInfo>;
  clearCache(): Promise<CacheInfo>;
  getImagePerformanceStats(): Promise<ImagePipelinePerformanceStats>;
  sampleImagePixel(assetId: string, x: number, y: number): Promise<{ r: number; g: number; b: number; a: number }>;
  recordManualWheelSession(payload: unknown): Promise<{ path: string }>;
  writeLogEntries(entries: Array<{ level: string; event: string; data?: unknown }>): Promise<void>;
  openLogsFolder(): Promise<{ path: string }>;
  copyDiagnostics(): Promise<{ sessionId: string; path?: string; mirrorPath?: string; problemCount?: number }>;
  recentLogProblems?(limit?: number): Promise<{ sessionId: string; path: string; mirrorPath?: string; problems: unknown[] }>;
  exportImage(data: ArrayBuffer, suggestedName: string): Promise<{ canceled: boolean; path?: string }>;
  exportOriginalImages(items: Array<{ assetId: string; suggestedName: string }>): Promise<{
    canceled: boolean; path?: string; count?: number;
  }>;
  copyImage(data: ArrayBuffer): Promise<void>;
  copyOriginalImage(assetId: string): Promise<void>;
  showSourceInFolder(path: string): Promise<{ ok: boolean; message?: string }>;
  syncPhotoshopForeground(
    color: Pick<PickedColor, 'r' | 'g' | 'b' | 'hex'>,
    returnFocus?: boolean,
  ): Promise<PhotoshopColorSyncResult>;
  placeRenderedInPhotoshop(data: ArrayBuffer, name: string): Promise<PhotoshopDocumentResult>;
  placeRenderedLayersInPhotoshop(images: Array<{ data: ArrayBuffer; name: string }>): Promise<PhotoshopDocumentResult>;
  openRenderedInPhotoshop(data: ArrayBuffer, name: string): Promise<PhotoshopDocumentResult>;
  getPhotoshopDocumentInfo(): Promise<PhotoshopDocumentInfoResult>;
  capturePhotoshopPreview(): Promise<PhotoshopDocumentPreviewResult>;
  createPhotoshopVersion(
    sessionId: string | undefined, scene: Scene, metadata: PhotoshopProjectMetadata, name: string, note?: string,
    revision?: number, preview?: ArrayBuffer,
  ): Promise<ProjectCommitResult & { version?: PhotoshopVersionRecord; message?: string }>;
  openPhotoshopVersion(sessionId: string | undefined, versionId: string): Promise<PhotoshopDocumentResult>;
  deletePhotoshopVersion(
    sessionId: string | undefined, scene: Scene, metadata: PhotoshopProjectMetadata, versionId: string,
    revision?: number, preview?: ArrayBuffer,
  ): Promise<ProjectCommitResult & { message?: string }>;
  setWindowMode(mode: Partial<WindowState>): Promise<WindowState>;
  getWindowMode(): Promise<WindowState>;
  getWindowWorkArea(point?: { x: number; y: number }): Promise<{ left: number; top: number; right: number; bottom: number }>;
  setCollaborationShortcut(shortcut: string): Promise<{ ok: boolean; shortcut: string; message?: string }>;
  getCollaborationShortcut(): Promise<{ shortcut: string }>;
  isKeyDown(key: 'Space'): Promise<boolean>;
  setTitle(title: string): Promise<void>;
  minimize(): void;
  toggleMaximize(): void;
  beginWindowMove(): void;
  updateWindowMove(): void;
  endWindowMove(): void;
  onWindowMoveFinished(callback: () => void): () => void;
  close(): void;
  respondToClose(shouldClose: boolean): void;
  onCloseRequested(callback: () => void): () => void;
  setDirty(dirty: boolean, revision?: number): void;
  onClickThroughDisabled(callback: () => void): () => void;
  onToggleCollaborationRequested(callback: () => void): () => void;
  onNativePointer(callback: (input: NativePointerInput) => void): () => void;
  onNativeZoom(callback: (direction: 'in' | 'out') => void): () => void;
}

declare global { interface Window { refCanvas?: RefCanvasAPI } }
