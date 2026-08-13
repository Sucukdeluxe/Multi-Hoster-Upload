const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('dropTargetApi', {
  sendFiles: (paths) => ipcRenderer.send('drop-target:files', paths),
  getPathForFile: (file) => webUtils.getPathForFile(file)
});
