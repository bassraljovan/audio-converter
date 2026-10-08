const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  pickFiles: () => ipcRenderer.invoke('pick-files'),
  pickFolder: purpose => ipcRenderer.invoke('pick-folder', purpose),
  expandPaths: paths => ipcRenderer.invoke('expand-paths', paths),
  pathForFile: file => webUtils.getPathForFile(file),
  probe: file => ipcRenderer.invoke('probe', file),
  convert: job => ipcRenderer.invoke('convert', job),
  cancel: id => ipcRenderer.invoke('cancel', id),
  reveal: p => ipcRenderer.invoke('reveal', p),
  openPath: p => ipcRenderer.invoke('open-path', p),
  systemInfo: () => ipcRenderer.invoke('system-info'),
  onProgress: cb => ipcRenderer.on('progress', (_e, data) => cb(data)),
});
