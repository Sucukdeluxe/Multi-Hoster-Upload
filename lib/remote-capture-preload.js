const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('capture', {
  // Get capture source ID from main process (desktopCapturer runs in main)
  getSourceId: () => ipcRenderer.invoke('remote:get-capture-source-id'),

  // Signaling: receive offer/ICE from main process (relayed from dashboard)
  onSignaling: (callback) => {
    ipcRenderer.on('remote:signaling-to-capture', (_event, data) => callback(data));
  },

  // Signaling: send answer/ICE back to main process (relayed to dashboard)
  sendSignaling: (data) => ipcRenderer.send('remote:signaling-from-capture', data),

  // Input: forward input events from DataChannel to main process
  sendInput: (data) => ipcRenderer.send('remote:input-event', data),

  // Notify main process of client connection/disconnection
  notifyClientCount: (count) => ipcRenderer.send('remote:client-count', count),

  // Debug logging to main process
  log: (...args) => ipcRenderer.send('remote:capture-log', args.join(' '))
});
