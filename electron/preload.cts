const { contextBridge, ipcRenderer, webUtils } = require('electron');
import type { IpcArgs, IpcChannel, IpcResult } from '../src/shared/ipcContracts';

const invoke = <C extends IpcChannel>(channel: C, ...args: IpcArgs<C>): Promise<IpcResult<C>> => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('refCanvas', {
  importImages: (requestId) => invoke('images:import', requestId),
  registerImagePaths: (paths, sourceType) => invoke('images:register-paths', paths, sourceType),
  registerImageUrls: (urls) => invoke('images:register-urls', urls),
  registerClipboardImage: () => invoke('images:register-clipboard'),
  startImageDrag: (assetIds) => ipcRenderer.send('images:start-native-drag', assetIds),
  prewarmImages: (ids, requestId) => invoke('images:prewarm', ids, requestId),
  boostImageResource: (key, priority) => ipcRenderer.send('images:boost-resource', key, priority),
  cancelPrewarmImages: (requestId) => ipcRenderer.send('images:cancel-prewarm', requestId),
  onPrewarmProgress: (callback) => {
    const handler = (_event, progress) => callback(progress);
    ipcRenderer.on('images:prewarm-progress', handler);
    return () => ipcRenderer.removeListener('images:prewarm-progress', handler);
  },
  onThumbnailReady: (callback) => {
    const handler = (_event, thumbnail) => callback(thumbnail);
    ipcRenderer.on('images:thumbnail-ready', handler);
    return () => ipcRenderer.removeListener('images:thumbnail-ready', handler);
  },
  pathForFile: (file) => { try { return webUtils.getPathForFile(file) || undefined; } catch { return undefined; } },
  openProject: (path) => invoke('project:open', path),
  commitProject: (request) => invoke('project:commit', request),
  chooseProjectSavePath: (suggestedName) => invoke('project:choose-save-path', suggestedName),
  saveProjectAs: (request, pathToken) => invoke('project:save-as', request, pathToken),
  closeProject: (sessionId) => invoke('project:close', sessionId),
  compactProject: (sessionId) => invoke('project:compact', sessionId),
  projectStats: (sessionId) => invoke('project:stats', sessionId),
  recoverProject: (sessionId) => invoke('project:recover', sessionId),
  consumeStartupPath: () => invoke('scene:startup-path'),
  onExternalOpen: (callback) => {
    const handler = (_event, path) => callback(path);
    ipcRenderer.on('scene:external-open', handler);
    return () => ipcRenderer.removeListener('scene:external-open', handler);
  },
  importScene: () => invoke('scene:import'),
  recentScenes: () => invoke('scene:recent'),
  getCacheInfo: () => invoke('cache:info'),
  chooseCacheLocation: () => invoke('cache:choose-location'),
  resetCacheLocation: () => invoke('cache:reset-location'),
  clearCache: () => invoke('cache:clear'),
  getImagePerformanceStats: () => invoke('images:performance-stats'),
  sampleImagePixel: (assetId, x, y) => invoke('images:sample-pixel', assetId, x, y),
  recordManualWheelSession: (payload) => invoke('performance:record-manual-wheel', payload),
  writeLogEntries: (entries) => invoke('logs:write', entries),
  openLogsFolder: () => invoke('logs:open-folder'),
  copyDiagnostics: () => invoke('logs:copy-diagnostics'),
  exportImage: (data, suggestedName) => invoke('image:export', data, suggestedName),
  exportOriginalImages: (items) => invoke('image:export-originals', items),
  copyImage: (data) => invoke('image:copy', data),
  copyOriginalImage: (assetId) => invoke('image:copy-original', assetId),
  showSourceInFolder: (path) => invoke('image:show-source', path),
  syncPhotoshopForeground: (color, returnFocus) => invoke('photoshop:set-foreground', color, returnFocus),
  placeRenderedInPhotoshop: (data, name) => invoke('photoshop:place-rendered', data, name),
  placeRenderedLayersInPhotoshop: (images) => invoke('photoshop:place-rendered-layers', images),
  openRenderedInPhotoshop: (data, name) => invoke('photoshop:open-rendered', data, name),
  getPhotoshopDocumentInfo: () => invoke('photoshop:get-document-info'),
  capturePhotoshopPreview: () => invoke('photoshop:capture-preview'),
  createPhotoshopVersion: (sessionId, scene, metadata, name, note, revision, preview) => invoke('photoshop:create-version', sessionId, scene, metadata, name, note, revision, preview),
  openPhotoshopVersion: (sessionId, versionId) => invoke('photoshop:open-version', sessionId, versionId),
  deletePhotoshopVersion: (sessionId, scene, metadata, versionId, revision, preview) => invoke('photoshop:delete-version', sessionId, scene, metadata, versionId, revision, preview),
  setWindowMode: (mode) => invoke('window:set-mode', mode),
  getWindowMode: () => invoke('window:get-mode'),
  getWindowWorkArea: (point) => invoke('window:get-work-area', point),
  setCollaborationShortcut: (shortcut) => invoke('window:set-collaboration-shortcut', shortcut),
  getCollaborationShortcut: () => invoke('window:get-collaboration-shortcut'),
  isKeyDown: (key) => invoke('window:is-key-down', key),
  setTitle: (title) => invoke('window:set-title', title),
  minimize: () => ipcRenderer.send('window:minimize'),
  toggleMaximize: () => ipcRenderer.send('window:maximize'),
  beginWindowMove: () => ipcRenderer.send('window:move-start'),
  updateWindowMove: () => ipcRenderer.send('window:move-update'),
  endWindowMove: () => ipcRenderer.send('window:move-end'),
  onWindowMoveFinished: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('window:move-finished', handler);
    return () => ipcRenderer.removeListener('window:move-finished', handler);
  },
  close: () => ipcRenderer.send('window:close'),
  respondToClose: (shouldClose) => ipcRenderer.send('window:close-response', shouldClose),
  onCloseRequested: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('window:close-requested', handler);
    return () => ipcRenderer.removeListener('window:close-requested', handler);
  },
  setDirty: (dirty, revision) => ipcRenderer.send('window:dirty', { dirty, revision }),
  onClickThroughDisabled: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('window:click-through-disabled', handler);
    return () => ipcRenderer.removeListener('window:click-through-disabled', handler);
  },
  onToggleCollaborationRequested: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('window:toggle-collaboration-requested', handler);
    return () => ipcRenderer.removeListener('window:toggle-collaboration-requested', handler);
  },
  onNativePointer: (callback) => {
    const handler = (_event, input) => callback(input);
    ipcRenderer.on('window:native-pointer', handler);
    return () => ipcRenderer.removeListener('window:native-pointer', handler);
  },
  onNativeZoom: (callback) => {
    const handler = (_event, direction) => callback(direction);
    ipcRenderer.on('window:native-zoom', handler);
    return () => ipcRenderer.removeListener('window:native-zoom', handler);
  },
});
