const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('taskbarPenInput', {
  start: (input) => ipcRenderer.invoke('window:taskbar-pen-start', input),
  send: (input) => ipcRenderer.send('window:taskbar-pen-pointer', input),
});
