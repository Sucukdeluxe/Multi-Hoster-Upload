const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dropTargetApi', {
  sendFiles: (paths) => ipcRenderer.send('drop-target:files', paths)
});
