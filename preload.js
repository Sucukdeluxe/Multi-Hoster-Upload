const { contextBridge, ipcRenderer, webUtils } = require('electron');

let folderMonitorCandidateListenerReady = false;
let folderMonitorRendererGeneration = null;
let folderMonitorReadySentGeneration = null;

function signalFolderMonitorReady() {
  if (!folderMonitorCandidateListenerReady || !Number.isSafeInteger(folderMonitorRendererGeneration) || folderMonitorRendererGeneration <= 0 || folderMonitorReadySentGeneration === folderMonitorRendererGeneration) return false;
  folderMonitorReadySentGeneration = folderMonitorRendererGeneration;
  ipcRenderer.send('folder-monitor:renderer-ready', folderMonitorRendererGeneration);
  return true;
}

ipcRenderer.on('folder-monitor:renderer-generation', (_event, generation) => {
  if (!Number.isSafeInteger(generation) || generation <= 0 || (folderMonitorRendererGeneration !== null && generation <= folderMonitorRendererGeneration)) return;
  folderMonitorRendererGeneration = generation;
  signalFolderMonitorReady();
});

contextBridge.exposeInMainWorld('api', {
  // Config
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  getHistory: () => ipcRenderer.invoke('get-history'),
  clearHistory: () => ipcRenderer.invoke('clear-history'),
  pruneHistory: (retention, opts) => ipcRenderer.invoke('prune-history', { retention, dryRun: !!(opts && opts.dryRun) }),
  exportHistory: (format) => ipcRenderer.invoke('export-history', format),
  exportSessionReport: (format) => ipcRenderer.invoke('export-session-report', format),
  saveTextFile: (defaultName, content, filters) => ipcRenderer.invoke('save-text-file', defaultName, content, filters),

  // Hoster settings
  getHosterSettings: () => ipcRenderer.invoke('get-hoster-settings'),
  saveHosterSettings: (settings) => ipcRenderer.invoke('save-hoster-settings', settings),

  // Global settings
  getGlobalSettings: () => ipcRenderer.invoke('get-global-settings'),
  saveGlobalSettings: (settings) => ipcRenderer.invoke('save-global-settings', settings),
  savePendingQueue: (pendingQueue) => ipcRenderer.invoke('save-pending-queue', pendingQueue),
  finishClosePreparation: (payload = true) => ipcRenderer.invoke('app:finish-close', payload),
  onPrepareClose: (callback) => {
    ipcRenderer.on('app:prepare-close', (_event, attempt) => {
      ipcRenderer.send('app:close-preparation-started', attempt);
      callback(attempt);
    });
  },
  signalCloseHandshakeReady: () => ipcRenderer.send('app:close-handshake-ready'),

  // Always on top
  setAlwaysOnTop: (value) => ipcRenderer.invoke('set-always-on-top', value),
  getAlwaysOnTop: () => ipcRenderer.invoke('get-always-on-top'),

  // Shutdown after finish
  setShutdownAfterFinish: (mode) => ipcRenderer.invoke('set-shutdown-after-finish', mode),
  getShutdownAfterFinish: () => ipcRenderer.invoke('get-shutdown-after-finish'),
  cancelShutdown: () => ipcRenderer.invoke('cancel-shutdown'),

  // File selection
  selectFiles: () => ipcRenderer.invoke('select-files'),
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  selectFolderWithSizes: () => ipcRenderer.invoke('select-folder-with-sizes'),
  resolveFolderFiles: (folderPath) => ipcRenderer.invoke('resolve-folder-files', folderPath),
  getFileSizes: (paths) => ipcRenderer.invoke('get-file-sizes', paths),
  inspectImportFiles: (entries, existingPaths) => ipcRenderer.invoke('inspect-import-files', { entries, existingPaths }),

  // Upload control
  startUpload: (payload) => ipcRenderer.invoke('start-upload', payload),
  cancelUpload: () => ipcRenderer.invoke('cancel-upload'),
  cancelSelectedJobs: (jobIds) => ipcRenderer.invoke('cancel-selected-jobs', jobIds),
  addJobsToBatch: (payload) => ipcRenderer.invoke('add-jobs-to-batch', payload),
  completeUploadFinalization: (payload) => ipcRenderer.invoke('complete-upload-finalization', payload),
  finishAfterActive: () => ipcRenderer.invoke('finish-after-active'),
  runHealthCheck: (payload) => ipcRenderer.invoke('run-health-check', payload),
  onHealthCheckResult: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('health-check:result', listener);
    return () => ipcRenderer.removeListener('health-check:result', listener);
  },
  validateCredentials: (payload) => ipcRenderer.invoke('validate-credentials', payload),

  // Log import
  readOwnUploadLog: () => ipcRenderer.invoke('read-own-upload-log'),
  importUploadLog: () => ipcRenderer.invoke('import-upload-log'),

  // Clipboard
  copyToClipboard: (text) => ipcRenderer.invoke('copy-to-clipboard', text),

  // Updates
  checkForUpdate: (options = {}) => ipcRenderer.invoke('app:check-updates', { forceRefresh: options && options.forceRefresh === true }),
  installUpdate: () => ipcRenderer.invoke('app:install-update'),
  abortUpdate: () => ipcRenderer.invoke('app:abort-update'),
  getVersion: () => ipcRenderer.invoke('app:get-version'),
  restartApp: () => ipcRenderer.invoke('app:restart'),
  quitApp: () => ipcRenderer.invoke('app:quit'),
  onUpdateAvailable: (callback) => {
    ipcRenderer.on('app:update-available', (_event, data) => callback(data));
  },
  onUpdateProgress: (callback) => {
    ipcRenderer.on('app:update-progress', (_event, data) => callback(data));
  },

  // Backup
  exportBackup: (options) => ipcRenderer.invoke('export-backup', options),
  importBackup: (legacyPassword) => ipcRenderer.invoke('import-backup', legacyPassword),
  listManagedOnlineBackups: () => ipcRenderer.invoke('online-backup:list-managed'),
  createManagedOnlineBackup: (retention) => ipcRenderer.invoke('online-backup:create-managed', retention),
  copyManagedOnlineBackup: (id) => ipcRenderer.invoke('online-backup:copy-managed', id),
  deleteManagedOnlineBackup: (id) => ipcRenderer.invoke('online-backup:delete-managed', id),
  restoreOnlineBackup: (key) => ipcRenderer.invoke('online-backup:restore', key),

  // Folder Monitor
  folderMonitorStart: (settings) => ipcRenderer.invoke('folder-monitor:start', settings),
  folderMonitorStop: () => ipcRenderer.invoke('folder-monitor:stop'),
  folderMonitorStatus: () => ipcRenderer.invoke('folder-monitor:status'),
  folderMonitorSelectFolder: () => ipcRenderer.invoke('folder-monitor:select-folder'),
  folderMonitorTestScan: () => ipcRenderer.invoke('folder-monitor:test-scan'),
  folderMonitorReconcile: () => ipcRenderer.invoke('folder-monitor:reconcile'),
  automationGetStatus: () => ipcRenderer.invoke('automation:get-status'),
  getAutomationCompletions: () => ipcRenderer.invoke('automation:get-completions'),
  recordAutomationCompletions: (entries) => ipcRenderer.invoke('automation:record-completions', entries),
  automationPauseAfterActive: () => ipcRenderer.invoke('automation:pause-after-active'),
  automationResume: () => ipcRenderer.invoke('automation:resume'),
  onFolderMonitorNewFiles: (callback) => {
    ipcRenderer.on('folder-monitor:new-files', (_event, data) => callback(data));
    folderMonitorCandidateListenerReady = true;
  },
  signalFolderMonitorReady,
  onAutomationStatus: (callback) => {
    ipcRenderer.on('automation:status', (_event, data) => callback(data));
  },

  // Account switched event
  onAccountSwitched: (callback) => {
    ipcRenderer.on('account-switched', (_event, data) => callback(data));
  },

  // Drop Target
  showDropTarget: () => ipcRenderer.invoke('show-drop-target'),
  hideDropTarget: () => ipcRenderer.invoke('hide-drop-target'),
  onDropTargetFiles: (callback) => {
    ipcRenderer.on('drop-target:files', (_event, paths) => callback(paths));
  },

  // Debug
  debugTestUpload: () => ipcRenderer.invoke('debug-test-upload'),
  debugLog: (msg) => ipcRenderer.invoke('debug-log', msg),

  // Events (main -> renderer)
  onUploadProgress: (callback) => {
    ipcRenderer.on('upload-progress', (_event, data) => callback(data));
  },
  onUploadProgressBatch: (callback) => {
    ipcRenderer.on('upload-progress-batch', (_event, batch) => callback(batch));
  },
  onUploadBatchDone: (callback) => {
    ipcRenderer.on('upload-batch-done', (_event, data) => callback(data));
  },
  onUploadStats: (callback) => {
    ipcRenderer.on('upload-stats', (_event, data) => callback(data));
  },
  onShutdownCountdown: (callback) => {
    ipcRenderer.on('shutdown-countdown', (_event, data) => callback(data));
  },
  onUploadLogFallback: (callback) => {
    ipcRenderer.on('upload-log-fallback', (_event, data) => callback(data));
  },
  onAccountRotationLog: (callback) => {
    ipcRenderer.on('account-rotation-log', (_event, data) => callback(data));
  },
  openLogFolder: () => ipcRenderer.invoke('open-log-folder'),
  getJobLog: (jobId) => ipcRenderer.invoke('get-job-log', jobId),
  getSessionFailedAccounts: () => ipcRenderer.invoke('get-session-failed-accounts'),
  getSessionFailedAccountStates: () => ipcRenderer.invoke('get-session-failed-account-states'),
  resetSessionFailedAccount: (payload) => ipcRenderer.invoke('reset-session-failed-account', payload),
  resetAllSessionFailedAccounts: () => ipcRenderer.invoke('reset-all-session-failed-accounts'),
  onSessionFailedAccountsChanged: (callback) => {
    ipcRenderer.on('session-failed-accounts-changed', (_event, data) => callback(data));
  },
  getLogPaths: () => ipcRenderer.invoke('get-log-paths'),
  testWebhook: (payload) => ipcRenderer.invoke('test-webhook', payload),
  revealLogFile: (target) => ipcRenderer.invoke('reveal-log-file', target),
  setLogVerbose: (enabled) => ipcRenderer.invoke('set-log-verbose', enabled),
  createSupportBundle: () => ipcRenderer.invoke('create-support-bundle'),
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),
  onLogPathAutoUpdated: (callback) => {
    ipcRenderer.on('log-path-auto-updated', (_event, data) => callback(data));
  },
  // Remote Control
  remoteGetSettings: () => ipcRenderer.invoke('remote:get-settings'),
  remoteSaveSettings: (settings) => ipcRenderer.invoke('remote:save-settings', settings),
  remoteGenerateToken: () => ipcRenderer.invoke('remote:generate-token'),
  remoteStatus: () => ipcRenderer.invoke('remote:status'),
  onRemoteClientCount: (callback) => {
    ipcRenderer.on('remote:client-count', (_event, count) => callback(count));
  },

  // Remote Diagnostics (read-only)
  diagnosticsGetSettings: () => ipcRenderer.invoke('diagnostics:get-settings'),
  diagnosticsSaveSettings: (settings) => ipcRenderer.invoke('diagnostics:save-settings', settings),
  diagnosticsRegenerate: () => ipcRenderer.invoke('diagnostics:regenerate'),
  diagnosticsStatus: () => ipcRenderer.invoke('diagnostics:status'),

  // File path from drag & drop (Electron 33+ compatible)
  getPathForFile: (file) => webUtils.getPathForFile(file),
  removeAllListeners: () => {
    folderMonitorCandidateListenerReady = false;
    folderMonitorRendererGeneration = null;
    folderMonitorReadySentGeneration = null;
    ipcRenderer.removeAllListeners('folder-monitor:renderer-generation');
    ipcRenderer.removeAllListeners('upload-progress');
    ipcRenderer.removeAllListeners('upload-batch-done');
    ipcRenderer.removeAllListeners('upload-stats');
    ipcRenderer.removeAllListeners('app:update-available');
    ipcRenderer.removeAllListeners('app:update-progress');
    ipcRenderer.removeAllListeners('app:prepare-close');
    ipcRenderer.removeAllListeners('shutdown-countdown');
    ipcRenderer.removeAllListeners('folder-monitor:new-files');
    ipcRenderer.removeAllListeners('automation:status');
    ipcRenderer.removeAllListeners('drop-target:files');
    ipcRenderer.removeAllListeners('account-switched');
    ipcRenderer.removeAllListeners('session-failed-accounts-changed');
    ipcRenderer.removeAllListeners('remote:client-count');
  }
});
