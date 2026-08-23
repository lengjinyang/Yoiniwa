import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type {
  ImagePrewarmProgress, ImageThumbnailReady, ImageDerivativeReady, NativePointerInput, RefCanvasAPI,
  VideoFrameTimingIndex, VideoPreparationProgress, VideoProxyFailed, VideoProxyReady,
} from '../types';
import { createPhotoshopSyncQueue } from '../shared/photoshopSyncQueue';

type EventPayloads = {
  'images:prewarm-progress': ImagePrewarmProgress;
  'images:thumbnail-ready': ImageThumbnailReady;
  'images:derivative-ready': ImageDerivativeReady;
  'videos:proxy-ready': VideoProxyReady;
  'videos:proxy-failed': VideoProxyFailed;
  'videos:preparation-progress': VideoPreparationProgress;
  'scene:external-open': string;
  'window:move-finished': void;
  'window:close-requested': void;
  'window:click-through-disabled': void;
  'window:toggle-collaboration-requested': void;
  'window:native-pointer': NativePointerInput;
  'window:native-zoom': 'in' | 'out';
  'window:file-drop': { paths: string[]; clientX: number; clientY: number };
};

function onEvent<K extends keyof EventPayloads>(name: K, callback: (payload: EventPayloads[K]) => void) {
  let disposed = false;
  let unlisten: (() => void) | undefined;
  void listen<EventPayloads[K]>(name, ({ payload }) => {
    if (!disposed) callback(payload);
  }).then((next) => {
    if (disposed) next(); else unlisten = next;
  });
  return () => { disposed = true; unlisten?.(); };
}

function command<T>(name: string, args?: Record<string, unknown>) {
  return invoke<T>(name, args);
}

function onFilesDropped(callback: (drop: { paths: string[]; clientX: number; clientY: number }) => void) {
  return onEvent('window:file-drop', callback);
}

function bytes(value: ArrayBuffer) {
  return Array.from(new Uint8Array(value));
}

function rawCommand<T>(name: string, value: ArrayBuffer | Uint8Array, headers: Record<string, string> = {}) {
  return invoke<T>(name, value instanceof Uint8Array ? value : new Uint8Array(value), { headers });
}

function encodedHeader(value: string) {
  return encodeURIComponent(value);
}

function renderedLayersFrame(images: Array<{ data: ArrayBuffer; name: string }>) {
  const encoder = new TextEncoder();
  const layers = images.map((image) => ({ name: encoder.encode(image.name), data: new Uint8Array(image.data) }));
  const length = 4 + layers.reduce((total, layer) => total + 12 + layer.name.byteLength + layer.data.byteLength, 0);
  const frame = new Uint8Array(length);
  const view = new DataView(frame.buffer);
  let offset = 0;
  view.setUint32(offset, layers.length, true); offset += 4;
  layers.forEach((layer) => {
    view.setUint32(offset, layer.name.byteLength, true); offset += 4;
    view.setBigUint64(offset, BigInt(layer.data.byteLength), true); offset += 8;
    frame.set(layer.name, offset); offset += layer.name.byteLength;
    frame.set(layer.data, offset); offset += layer.data.byteLength;
  });
  return frame;
}

export function installTauriRefCanvasApi() {
  if (window.refCanvas || !('__TAURI_INTERNALS__' in window)) return;
  const photoshopSyncQueue = createPhotoshopSyncQueue((request) => command('photoshop_set_foreground', {
    color: {
      r: request.color.r,
      g: request.color.g,
      b: request.color.b,
      a: request.color.a ?? 1,
      hex: request.color.hex,
    },
    returnFocus: request.returnFocus ?? false,
  }));
  const api: RefCanvasAPI = {
    importImages: (requestId) => command('images_import', { requestId }),
    registerImagePaths: (paths, sourceType, requestId) => command('images_register_paths', { paths, sourceType, requestId }),
    registerImageUrls: (urls) => command('images_register_urls', { urls }),
    registerClipboardImage: () => command('images_register_clipboard'),
    registerImageBytes: (name, data, sourceType) => rawCommand('images_register_bytes', data, {
      'x-yoiniwa-name': encodedHeader(name),
      'x-yoiniwa-source-type': encodedHeader(sourceType ?? 'drop'),
    }),
    assetFilePath: (assetId) => command('images_asset_path', { assetId }),
    ensureVideoPlayback: (assetId) => command('videos_ensure_playback', { assetId }),
    cancelVideoPlayback: (assetId) => { void command('videos_cancel_playback', { assetId }); },
    // Best-effort background work: a missing or unreadable asset must not surface
    // as an unhandled rejection every time the user selects a video.
    prepareVideoIndex: (assetId) => { void command('videos_prepare_index', { assetId }).catch(() => undefined); },
    getVideoFrameIndex: (assetId) => command<VideoFrameTimingIndex | null>('videos_frame_index', { assetId }),
    onVideoProxyReady: (callback) => onEvent('videos:proxy-ready', callback),
    onVideoProxyFailed: (callback) => onEvent('videos:proxy-failed', callback),
    onVideoPreparationProgress: (callback) => onEvent('videos:preparation-progress', callback),
    startImageDrag: (assetIds) => { void command('images_start_native_drag', { assetIds }); },
    prewarmImages: (ids, requestId) => command('images_prewarm', { ids, requestId }),
    boostImageResource: (key, priority) => { void command('images_boost_resource', { key, priority }); },
    cancelPrewarmImages: (requestId) => { void command('images_cancel_prewarm', { requestId }); },
    onPrewarmProgress: (callback) => onEvent('images:prewarm-progress', callback),
    onThumbnailReady: (callback) => onEvent('images:thumbnail-ready', callback),
    onDerivativeReady: (callback) => onEvent('images:derivative-ready', callback),
    onFilesDropped,
    pathForFile: (file) => (file as File & { path?: string }).path,
    openProject: (path) => command('project_open', { path }),
    commitProject: (request) => command('project_commit', {
      request: { ...request, preview: request.preview ? bytes(request.preview) : undefined },
    }),
    saveProjectAs: (request) => command('project_save_as', {
      request: { ...request, preview: request.preview ? bytes(request.preview) : undefined },
    }),
    closeProject: (sessionId) => command('project_close', { sessionId }),
    compactProject: (sessionId) => command('project_compact', { sessionId }),
    projectStats: (sessionId) => command('project_stats', { sessionId }),
    recoverProject: (sessionId) => command('project_recover', { sessionId }),
    consumeStartupPath: () => command('scene_startup_path'),
    onExternalOpen: (callback) => onEvent('scene:external-open', callback),
    importScene: () => command('scene_import'),
    recentScenes: () => command('scene_recent'),
    removeRecentScene: (path) => command('scene_recent_remove', { path }),
    checkForUpdates: () => command('app_update_check'),
    installUpdate: () => command('app_update_install'),
    getCacheInfo: () => command('cache_info'),
    chooseCacheLocation: () => command('cache_choose_location'),
    resetCacheLocation: () => command('cache_reset_location'),
    clearCache: () => command('cache_clear'),
    getImagePerformanceStats: () => command('images_performance_stats'),
    sampleImagePixel: (assetId, x, y) => command('images_sample_pixel', { assetId, x, y }),
    recordManualWheelSession: (payload) => command('performance_record_manual_wheel', { payload }),
    writeLogEntries: (entries) => command('logs_write', { entries }),
    openLogsFolder: () => command('logs_open_folder'),
    copyDiagnostics: () => command('logs_copy_diagnostics'),
    recentLogProblems: (limit) => command('logs_recent_problems', { limit }),
    exportImage: (data, suggestedName) => rawCommand('image_export', data, { 'x-yoiniwa-name': encodedHeader(suggestedName) }),
    exportOriginalImages: (items) => command('image_export_originals', { items }),
    copyImage: (data) => rawCommand('image_copy', data),
    copyOriginalImage: (assetId) => command('image_copy_original', { assetId }),
    showSourceInFolder: (path) => command('image_show_source', { path }),
    syncPhotoshopForeground: (color, returnFocus) => photoshopSyncQueue.enqueue({
      color,
      returnFocus: returnFocus ?? false,
    }),
    placeRenderedInPhotoshop: (data, name) => rawCommand('photoshop_place_rendered', data, { 'x-yoiniwa-name': encodedHeader(name) }),
    placeRenderedLayersInPhotoshop: (images) => rawCommand('photoshop_place_rendered_layers', renderedLayersFrame(images)),
    openRenderedInPhotoshop: (data, name) => rawCommand('photoshop_open_rendered', data, { 'x-yoiniwa-name': encodedHeader(name) }),
    getPhotoshopDocumentInfo: () => command('photoshop_get_document_info'),
    capturePhotoshopPreview: async () => {
      type Result = Omit<Awaited<ReturnType<RefCanvasAPI['capturePhotoshopPreview']>>, 'preview'> & { previewPath?: string };
      const result = await command<Result>('photoshop_capture_preview');
      const preview = result.previewPath
        ? await rawCommand<ArrayBuffer>('photoshop_take_preview', new Uint8Array(), { 'x-yoiniwa-token': encodedHeader(result.previewPath) })
        : undefined;
      const { previewPath: _previewPath, ...publicResult } = result;
      return { ...publicResult, preview };
    },
    createPhotoshopVersion: (sessionId, scene, metadata, name, note, revision, preview) => command('photoshop_create_version', {
      sessionId, scene, metadata, name, note, revision, preview: preview ? bytes(preview) : undefined,
    }),
    openPhotoshopVersion: (sessionId, versionId) => command('photoshop_open_version', { sessionId, versionId }),
    deletePhotoshopVersion: (sessionId, scene, metadata, versionId, revision, preview) => command('photoshop_delete_version', {
      sessionId, scene, metadata, versionId, revision, preview: preview ? bytes(preview) : undefined,
    }),
    setWindowMode: (mode) => command('window_set_mode', { mode }),
    getWindowMode: () => command('window_get_mode'),
    getWindowWorkArea: (point) => command('window_get_work_area', { point }),
    setCollaborationShortcut: (shortcut) => command('window_set_collaboration_shortcut', { shortcut }),
    getCollaborationShortcut: () => command('window_get_collaboration_shortcut'),
    isKeyDown: (key) => command('window_is_key_down', { key }),
    setTitle: (title) => command('window_set_title', { title }),
    minimize: () => { void command('window_minimize'); },
    toggleMaximize: () => { void command('window_toggle_maximize'); },
    beginWindowMove: () => { void command('window_move_start'); },
    updateWindowMove: () => { void command('window_move_update'); },
    endWindowMove: () => { void command('window_move_end'); },
    onWindowMoveFinished: (callback) => onEvent('window:move-finished', callback),
    close: () => { void command('window_close'); },
    respondToClose: (shouldClose) => { void command('window_close_response', { shouldClose }); },
    onCloseRequested: (callback) => onEvent('window:close-requested', callback),
    setDirty: (dirty, revision) => { void command('window_dirty', { dirty, revision }); },
    onClickThroughDisabled: (callback) => onEvent('window:click-through-disabled', callback),
    onToggleCollaborationRequested: (callback) => onEvent('window:toggle-collaboration-requested', callback),
    onNativePointer: (callback) => onEvent('window:native-pointer', callback),
    onNativeZoom: (callback) => onEvent('window:native-zoom', callback),
  };
  window.refCanvas = api;
}
