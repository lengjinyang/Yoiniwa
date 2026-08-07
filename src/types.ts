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

export interface VisualNoteStyle {
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

export interface NumberVisualMark extends VisualNoteBase {
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
  autosaveScene(scene: Scene, revision?: number): Promise<{ skipped?: boolean; path?: string; scene?: Scene; revision?: number }>;
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
  syncPhotoshopForeground(
    color: Pick<PickedColor, 'r' | 'g' | 'b' | 'hex'>,
    returnFocus?: boolean,
  ): Promise<PhotoshopColorSyncResult>;
  setWindowMode(mode: Partial<WindowState>): Promise<WindowState>;
  getWindowMode(): Promise<WindowState>;
  isKeyDown(key: 'Space'): Promise<boolean>;
  setTitle(title: string): Promise<void>;
  minimize(): void;
  toggleMaximize(): void;
  beginWindowMove(): void;
  updateWindowMove(): void;
  endWindowMove(): void;
  onWindowMoveFinished(callback: () => void): () => void;
  close(): void;
  setDirty(dirty: boolean, revision?: number): void;
  onClickThroughDisabled(callback: () => void): () => void;
  onToggleCollaborationRequested(callback: () => void): () => void;
  onNativePointer(callback: (input: NativePointerInput) => void): () => void;
}

declare global { interface Window { refCanvas?: RefCanvasAPI } }
