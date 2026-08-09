import type {
  CacheInfo, ImageItem, ImagePipelinePerformanceStats, ImagePrewarmProgress, ImageThumbnailReady, ImportedImage,
  NativePointerInput, PhotoshopColorSyncResult, PhotoshopDocumentPreviewResult, PhotoshopDocumentResult, PhotoshopProjectMetadata, PhotoshopVersionRecord,
  PickedColor, ProjectCommitRequest, ProjectCommitResult, ProjectOpenResult, ProjectStorageStats, RecentScene, Scene,
  WindowState, PhotoshopDocumentInfoResult,
} from '../types.js';

export interface IpcContract<Args extends unknown[], Result> {
  args: Args;
  result: Result;
}

export interface IpcContractMap {
  'images:import': IpcContract<[requestId?: string], ImportedImage[]>;
  'images:register-paths': IpcContract<[paths: string[], sourceType: ImageItem['sourceType']], ImportedImage[]>;
  'images:register-urls': IpcContract<[urls: string[]], ImportedImage[]>;
  'images:register-clipboard': IpcContract<[], ImportedImage[]>;
  'images:prewarm': IpcContract<[ids: string[], requestId: string], { canceled: boolean; completed: number; total: number; failed: number; detailFailed?: number }>;
  'images:performance-stats': IpcContract<[], ImagePipelinePerformanceStats>;
  'images:sample-pixel': IpcContract<[assetId: string, x: number, y: number], { r: number; g: number; b: number; a: number }>;
  'project:open': IpcContract<[path?: string], ProjectOpenResult>;
  'project:commit': IpcContract<[request: ProjectCommitRequest], ProjectCommitResult>;
  'project:save-as': IpcContract<[request: ProjectCommitRequest], ProjectCommitResult>;
  'project:close': IpcContract<[sessionId?: string], void>;
  'project:compact': IpcContract<[sessionId?: string], ProjectStorageStats | { skipped: true; message?: string }>;
  'project:stats': IpcContract<[sessionId?: string], ProjectStorageStats>;
  'project:recover': IpcContract<[sessionId?: string], { recovered: boolean; sessionId: string }>;
  'scene:import': IpcContract<[], { canceled: boolean; path?: string; scene?: Scene }>;
  'scene:recent': IpcContract<[], RecentScene[]>;
  'scene:startup-path': IpcContract<[], string | null>;
  'cache:info': IpcContract<[], CacheInfo>;
  'cache:choose-location': IpcContract<[], { canceled: boolean; info?: CacheInfo }>;
  'cache:reset-location': IpcContract<[], CacheInfo>;
  'cache:clear': IpcContract<[], CacheInfo>;
  'image:export': IpcContract<[data: ArrayBuffer, suggestedName: string], { canceled: boolean; path?: string }>;
  'image:copy': IpcContract<[data: ArrayBuffer], void>;
  'image:show-source': IpcContract<[path: string], { ok: boolean; message?: string }>;
  'photoshop:set-foreground': IpcContract<[
    color: Pick<PickedColor, 'r' | 'g' | 'b' | 'hex'>,
    returnFocus?: boolean,
  ], PhotoshopColorSyncResult>;
  'photoshop:place-rendered': IpcContract<[data: ArrayBuffer, name: string], PhotoshopDocumentResult>;
  'photoshop:place-rendered-layers': IpcContract<[images: Array<{ data: ArrayBuffer; name: string }>], PhotoshopDocumentResult>;
  'photoshop:open-rendered': IpcContract<[data: ArrayBuffer, name: string], PhotoshopDocumentResult>;
  'photoshop:get-document-info': IpcContract<[], PhotoshopDocumentInfoResult>;
  'photoshop:capture-preview': IpcContract<[], PhotoshopDocumentPreviewResult>;
  'photoshop:create-version': IpcContract<[
    sessionId: string | undefined, scene: Scene, metadata: PhotoshopProjectMetadata, name: string, note?: string,
    revision?: number, preview?: ArrayBuffer,
  ], ProjectCommitResult & { version?: PhotoshopVersionRecord; message?: string }>;
  'photoshop:open-version': IpcContract<[sessionId: string | undefined, versionId: string], PhotoshopDocumentResult>;
  'photoshop:delete-version': IpcContract<[
    sessionId: string | undefined, scene: Scene, metadata: PhotoshopProjectMetadata, versionId: string,
    revision?: number, preview?: ArrayBuffer,
  ], ProjectCommitResult & { message?: string }>;
  'window:set-mode': IpcContract<[mode: Partial<WindowState>], WindowState>;
  'window:get-mode': IpcContract<[], WindowState>;
  'window:get-work-area': IpcContract<[point?: { x: number; y: number }], { left: number; top: number; right: number; bottom: number }>;
  'window:set-collaboration-shortcut': IpcContract<[shortcut: string], { ok: boolean; shortcut: string; message?: string }>;
  'window:get-collaboration-shortcut': IpcContract<[], { shortcut: string }>;
  'window:is-key-down': IpcContract<[key: 'Space'], boolean>;
  'window:set-title': IpcContract<[title: string], void>;
  'logs:write': IpcContract<[entries: Array<{ level: string; event: string; data?: unknown }>], void>;
  'logs:open-folder': IpcContract<[], { path: string }>;
  'logs:copy-diagnostics': IpcContract<[], { sessionId: string; path?: string }>;
  'performance:record-manual-wheel': IpcContract<[payload: unknown], { path: string }>;
}

export interface IpcEventMap {
  'images:prewarm-progress': ImagePrewarmProgress;
  'images:thumbnail-ready': ImageThumbnailReady;
  'scene:external-open': string;
  'window:move-finished': void;
  'window:close-requested': void;
  'window:click-through-disabled': void;
  'window:toggle-collaboration-requested': void;
  'window:native-pointer': NativePointerInput;
  'window:native-zoom': 'in' | 'out';
}

export type IpcChannel = keyof IpcContractMap;
export type IpcArgs<C extends IpcChannel> = IpcContractMap[C]['args'];
export type IpcResult<C extends IpcChannel> = IpcContractMap[C]['result'];
