export type CropRect = { x: number; y: number; width: number; height: number };

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
}

export interface ImageItem {
  id: string;
  name: string;
  sourcePath?: string;
  sourceType: 'file' | 'clipboard' | 'drop';
  assetId?: string;
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
  comment?: string;
  tags?: string[];
  groupId?: string;
  crop: CropRect;
}

type GroupMemberType = 'image' | 'annotation' | 'group' | 'video';

export interface GroupMember {
  type: GroupMemberType;
  id: string;
}

export interface ImageGroup {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  opacity: number;
  titleColor: string;
  collapsed: boolean;
  sizeLocked: boolean;
  contentsHidden: boolean;
  /** Legacy fields read by the scene migrator. */
  locked?: boolean;
  hidden?: boolean;
  parentId?: string;
  tags?: string[];
  members: GroupMember[];
}

export interface Viewport { x: number; y: number; scale: number }

interface CanvasSettings {
  background: string;
  padding: number;
  snap: boolean;
  includeBackgroundOnExport: boolean;
}

export type AnnotationTool = 'pen' | 'arrow' | 'rectangle' | 'ellipse' | 'eraser';

export interface AnnotationItem {
  id: string;
  type: Exclude<AnnotationTool, 'eraser'>;
  color: string;
  strokeWidth: number;
  locked?: boolean;
  hidden?: boolean;
  tags?: string[];
  points?: number[];
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface Scene {
  format: 'refcanvas';
  version: 2;
  name: string;
  savedAt: string;
  viewport: Viewport;
  canvas: CanvasSettings;
  assets: Record<string, AssetRecord>;
  items: ImageItem[];
  groups: ImageGroup[];
  annotations: AnnotationItem[];
}

export interface ImportedImage {
  name: string;
  path?: string;
  assetId: string;
  asset: AssetRecord;
  dataUrl?: string;
  sourceType?: ImageItem['sourceType'];
}

export interface PickedColor { r: number; g: number; b: number; a: number; hex: string }

export interface PhotoshopColorSyncResult {
  ok: boolean;
  status: 'synced' | 'not-running' | 'automation-error' | 'unsupported';
  copied: boolean;
  message?: string;
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

export interface WindowState {
  alwaysOnTop: boolean;
  clickThrough: boolean;
  locked: boolean;
  opacity: number;
}

interface RefCanvasAPI {
  importImages(requestId?: string): Promise<ImportedImage[]>;
  registerImagePaths(paths: string[], sourceType: ImageItem['sourceType']): Promise<ImportedImage[]>;
  registerImageUrls(urls: string[]): Promise<ImportedImage[]>;
  registerClipboardImage(): Promise<ImportedImage[]>;
  prewarmImages(ids: string[], requestId: string): Promise<{ canceled: boolean; completed: number; total: number; failed: number; detailFailed?: number }>;
  boostImageResource(key: string, priority: number): void;
  cancelPrewarmImages(requestId: string): void;
  onPrewarmProgress(callback: (progress: ImagePrewarmProgress) => void): () => void;
  onThumbnailReady(callback: (thumbnail: ImageThumbnailReady) => void): () => void;
  pathForFile(file: File): string | undefined;
  saveScene(scene: Scene, saveAs?: boolean, revision?: number): Promise<{ canceled: boolean; path?: string; scene?: Scene; revision?: number }>;
  resetScenePath(): void;
  consumeStartupPath(): Promise<string | null>;
  onExternalOpen(callback: (path: string) => void): () => void;
  openScene(path?: string): Promise<{ canceled: boolean; path?: string; scene?: Scene }>;
  importScene(): Promise<{ canceled: boolean; path?: string; scene?: Scene }>;
  recentScenes(): Promise<RecentScene[]>;
  getCacheInfo(): Promise<CacheInfo>;
  chooseCacheLocation(): Promise<{ canceled: boolean; info?: CacheInfo }>;
  resetCacheLocation(): Promise<CacheInfo>;
  getImagePerformanceStats(): Promise<ImagePipelinePerformanceStats>;
  sampleImagePixel(assetId: string, x: number, y: number): Promise<{ r: number; g: number; b: number; a: number }>;
  recordManualWheelSession(payload: unknown): Promise<{ path: string }>;
  writeLogEntries(entries: Array<{ level: string; event: string; data?: unknown }>): Promise<void>;
  openLogsFolder(): Promise<{ path: string }>;
  copyDiagnostics(): Promise<{ sessionId: string; path?: string }>;
  exportImage(data: ArrayBuffer, suggestedName: string): Promise<{ canceled: boolean; path?: string }>;
  copyImage(data: ArrayBuffer): Promise<void>;
  showSourceInFolder(path: string): Promise<{ ok: boolean; message?: string }>;
  syncPhotoshopForeground(color: Pick<PickedColor, 'r' | 'g' | 'b' | 'hex'>): Promise<PhotoshopColorSyncResult>;
  setWindowMode(mode: Partial<WindowState>): Promise<WindowState>;
  getWindowMode(): Promise<WindowState>;
  minimize(): void;
  toggleMaximize(): void;
  beginWindowMove(): void;
  updateWindowMove(): void;
  endWindowMove(): void;
  onWindowMoveFinished(callback: () => void): () => void;
  close(): void;
  setDirty(dirty: boolean, revision?: number): void;
  onClickThroughDisabled(callback: () => void): () => void;
}

declare global { interface Window { refCanvas?: RefCanvasAPI } }
