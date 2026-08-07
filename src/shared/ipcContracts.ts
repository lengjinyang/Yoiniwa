import type {
  CacheInfo, ImageItem, ImagePipelinePerformanceStats, ImagePrewarmProgress, ImageThumbnailReady, ImportedImage,
  PhotoshopColorSyncResult, PickedColor, RecentScene, Scene, WindowState,
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
  'scene:save': IpcContract<[scene: Scene, saveAs?: boolean, revision?: number], { canceled: boolean; path?: string; scene?: Scene; revision?: number }>;
  'scene:autosave': IpcContract<[scene: Scene, revision?: number], { skipped?: boolean; path?: string; scene?: Scene; revision?: number }>;
  'scene:open': IpcContract<[path?: string], { canceled: boolean; path?: string; scene?: Scene }>;
  'scene:import': IpcContract<[], { canceled: boolean; path?: string; scene?: Scene }>;
  'scene:recent': IpcContract<[], RecentScene[]>;
  'scene:startup-path': IpcContract<[], string | null>;
  'cache:info': IpcContract<[], CacheInfo>;
  'cache:choose-location': IpcContract<[], { canceled: boolean; info?: CacheInfo }>;
  'cache:reset-location': IpcContract<[], CacheInfo>;
  'image:export': IpcContract<[data: ArrayBuffer, suggestedName: string], { canceled: boolean; path?: string }>;
  'image:copy': IpcContract<[data: ArrayBuffer], void>;
  'image:show-source': IpcContract<[path: string], { ok: boolean; message?: string }>;
  'photoshop:set-foreground': IpcContract<[
    color: Pick<PickedColor, 'r' | 'g' | 'b' | 'hex'>,
    returnFocus?: boolean,
  ], PhotoshopColorSyncResult>;
  'window:set-mode': IpcContract<[mode: Partial<WindowState>], WindowState>;
  'window:get-mode': IpcContract<[], WindowState>;
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
  'window:click-through-disabled': void;
}

export type IpcChannel = keyof IpcContractMap;
export type IpcArgs<C extends IpcChannel> = IpcContractMap[C]['args'];
export type IpcResult<C extends IpcChannel> = IpcContractMap[C]['result'];
