const { contextBridge, ipcRenderer, webUtils } = require('electron');
import type { IpcArgs, IpcChannel, IpcResult } from '../src/shared/ipcContracts';

const invoke = <C extends IpcChannel>(channel: C, ...args: IpcArgs<C>): Promise<IpcResult<C>> => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('refCanvas', {
  importImages: (requestId) => invoke('images:import', requestId),
  registerImagePaths: (paths, sourceType) => invoke('images:register-paths', paths, sourceType),
  registerImageUrls: (urls) => invoke('images:register-urls', urls),
  registerClipboardImage: () => invoke('images:register-clipboard'),
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
  saveScene: (scene, saveAs, revision) => invoke('scene:save', scene, saveAs, revision),
  autosaveScene: (scene, revision) => invoke('scene:autosave', scene, revision),
  resetScenePath: () => ipcRenderer.send('scene:reset-path'),
  consumeStartupPath: () => invoke('scene:startup-path'),
  onExternalOpen: (callback) => {
    const handler = (_event, path) => callback(path);
    ipcRenderer.on('scene:external-open', handler);
    return () => ipcRenderer.removeListener('scene:external-open', handler);
  },
  openScene: (path) => invoke('scene:open', path),
  importScene: () => invoke('scene:import'),
  recentScenes: () => invoke('scene:recent'),
  getCacheInfo: () => invoke('cache:info'),
  chooseCacheLocation: () => invoke('cache:choose-location'),
  resetCacheLocation: () => invoke('cache:reset-location'),
  getImagePerformanceStats: () => invoke('images:performance-stats'),
  sampleImagePixel: (assetId, x, y) => invoke('images:sample-pixel', assetId, x, y),
  recordManualWheelSession: (payload) => invoke('performance:record-manual-wheel', payload),
  writeLogEntries: (entries) => invoke('logs:write', entries),
  openLogsFolder: () => invoke('logs:open-folder'),
  copyDiagnostics: () => invoke('logs:copy-diagnostics'),
  exportImage: (data, suggestedName) => invoke('image:export', data, suggestedName),
  copyImage: (data) => invoke('image:copy', data),
  showSourceInFolder: (path) => invoke('image:show-source', path),
  syncPhotoshopForeground: (color, returnFocus) => invoke('photoshop:set-foreground', color, returnFocus),
  setWindowMode: (mode) => invoke('window:set-mode', mode),
  getWindowMode: () => invoke('window:get-mode'),
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
  setDirty: (dirty, revision) => ipcRenderer.send('window:dirty', { dirty, revision }),
  onClickThroughDisabled: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('window:click-through-disabled', handler);
    return () => ipcRenderer.removeListener('window:click-through-disabled', handler);
  },
});
