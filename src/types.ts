export type CropRect = { x: number; y: number; width: number; height: number };

export type MediaKind = 'image' | 'video';

export interface AssetRecord {
  id: string;
  /** Canonical identity. `id` remains serialized for version-2 scene compatibility. */
  assetId?: string;
  hash: string;
  mimeType: string;
  byteLength: number;
  sourceSize?: number;
  sourceMtimeMs?: number;
  naturalWidth: number;
  naturalHeight: number;
  orientation?: number;
  hasAlpha?: boolean;
  contentHash?: string;
  cacheVersion?: number;
  originalName: string;
  sourcePath?: string;
  /** Defaults to image when omitted (legacy scenes). */
  kind?: MediaKind;
  durationSec?: number;
}

export interface ImageItem {
  id: string;
  name: string;
  sourcePath?: string;
  sourceType: 'file' | 'clipboard' | 'drop';
  assetId?: string;
  /** Still-frame image asset used for board LOD, outline thumbs, and export. */
  posterAssetId?: string;
  /** Defaults to image when omitted (legacy scenes). */
  mediaKind?: MediaKind;
  durationSec?: number;
  muted?: boolean;
  loop?: boolean;
  /** Only used by small unit-test fixtures. Version 2 scene files never persist data URLs. */
  dataUrl?: string;
  naturalWidth: number;
  naturalHeight: number;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  flipX: boolean;
  flipY: boolean;
  opacity: number;
  zIndex: number;
  locked: boolean;
  hidden?: boolean;
  grayscale?: boolean;
  grayscaleContrast?: number;
  tags?: string[];
  groupId?: string;
  crop: CropRect;
}

type GroupMemberType = 'image' | 'group' | 'mark' | 'video';

export interface GroupMember {
  type: GroupMemberType;
  id: string;
}

export interface ImageGroup {
  /** Version 2 stores the content-frame bounds; the expanded header lives outside them. */
  headerLayoutVersion?: 2;
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  opacity: number;
  titleColor: string;
  titleOpacity?: number;
  collapsed: boolean;
  sizeLocked: boolean;
  contentsHidden: boolean;
  /** Default layout mode keeps the content frame fitted to its members. */
  autoFit?: boolean;
  /** Images explicitly detached while still inside this frame. */
  detachedImageIds?: string[];
  /** Legacy fields read by the scene migrator. */
  locked?: boolean;
  hidden?: boolean;
  parentId?: string;
  tags?: string[];
  members: GroupMember[];
}

export interface Viewport { x: number; y: number; scale: number }

export type VisualNoteTool = 'brush' | 'arrow' | 'eraser';
export type VisualNoteWidth = 'thin' | 'medium' | 'thick';
export type EraserSize = 'small' | 'medium' | 'large';

interface VisualNoteStyle {
  color: string;
  opacity: number;
  width: VisualNoteWidth;
  baseWidth: number;
}

export interface VisualNotePoint { x: number; y: number; widthFactor: number }

export type VisualNoteAnchor =
  | { type: 'scene' }
  | { type: 'image'; imageId: string };

interface VisualNoteBase {
  id: string;
  anchor: VisualNoteAnchor;
  createdAt: number;
  style: VisualNoteStyle;
}

export interface BrushVisualMark extends VisualNoteBase {
  kind: 'stroke';
  points: VisualNotePoint[];
}

export interface ArrowVisualMark extends VisualNoteBase {
  kind: 'arrow';
  start: VisualNotePoint;
  end: VisualNotePoint;
}

interface NumberVisualMark extends VisualNoteBase {
  kind: 'number';
  point: VisualNotePoint;
  number: number;
}

export type VisualMark = BrushVisualMark | ArrowVisualMark | NumberVisualMark;

export interface VisualNotesState {
  visible: boolean;
  nextNumber: number;
  marks: VisualMark[];
}

interface CanvasSettings {
  background: string;
  backgroundOpacity?: number;
  padding: number;
  snap: boolean;
  includeBackgroundOnExport: boolean;
}

export interface Scene {
  format: 'refcanvas';
  version: 3;
  name: string;
  savedAt: string;
  viewport: Viewport;
  canvas: CanvasSettings;
  assets: Record<string, AssetRecord>;
  items: ImageItem[];
  groups: ImageGroup[];
  visualNotes: VisualNotesState;
}

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

export interface PhotoshopDocumentResult {
  ok: boolean;
  status: 'completed' | 'not-running' | 'no-document' | 'automation-error' | 'unsupported' | 'blocked';
  message?: string;
}

export interface PhotoshopDocumentInfoResult {
  ok: boolean;
  status: PhotoshopDocumentResult['status'];
  documentName?: string;
  message?: string;
}

export interface PhotoshopDocumentPreviewResult extends PhotoshopDocumentResult {
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

export interface ProjectCommitRequest {
  sessionId?: string;
  scene: Scene;
  photoshopProject: PhotoshopProjectMetadata;
  rendererRevision?: number;
  preview?: ArrayBuffer;
  reason: ProjectCommitReason;
}

export interface ProjectCommitResult {
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

export interface ProjectOpenResult extends ProjectCommitResult {
  canceled: boolean;
  recoverySource?: string;
  readOnly?: boolean;
}

export interface ProjectStorageStats {
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
}

export interface VideoPreparationResult {
  assetId: string;
  path?: string | null;
  fps: number;
  frameCount?: number | null;
  ready: boolean;
  indexReady: boolean;
  playbackReady: boolean;
  scrubReady: boolean;
  frameAccurate?: boolean;
  vfr: boolean;
  unsupportedReason?: string | null;
  state: 'ready' | 'queued' | 'running';
  queuePosition?: number | null;
}

export interface VideoPreparationProgress {
  assetId: string;
  stage: 'indexing' | 'index-ready' | 'transcoding' | 'validating' | 'ready' | 'failed';
  fraction: number;
  fps?: number;
  frameCount?: number;
  vfr?: boolean;
  frameAccurate?: boolean;
  message?: string;
}

export interface VideoProxyReady {
  assetId: string;
  path: string;
  fps?: number;
  frameCount?: number;
  indexReady?: boolean;
  playbackReady?: boolean;
  scrubReady?: boolean;
  vfr?: boolean;
}

export interface VideoProxyFailed {
  assetId: string;
  message: string;
  indexReady?: boolean;
  unsupportedReason?: string | null;
}

export interface RefCanvasAPI {
  importImages(requestId?: string): Promise<ImportedImage[]>;
  registerImagePaths(paths: string[], sourceType: ImageItem['sourceType'], requestId?: string): Promise<ImportedImage[]>;
  registerImageUrls(urls: string[]): Promise<ImportedImage[]>;
  registerClipboardImage(): Promise<ImportedImage[]>;
  registerImageBytes?(name: string, data: ArrayBuffer, sourceType?: ImageItem['sourceType']): Promise<ImportedImage>;
  assetFilePath?(assetId: string): Promise<string>;
  ensureVideoPlayback?(assetId: string): Promise<VideoPreparationResult>;
  ensureVideoScrub?(assetId: string): Promise<VideoPreparationResult>;
  cancelVideoPlayback?(assetId: string): void;
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
