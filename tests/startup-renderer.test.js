const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStartupWindow, resolveStartupLanguage, createStartupQuery } = require('../lib/startup-renderer');

class TestBrowserWindow extends EventEmitter {
  constructor(options) {
    super();
    this.webContents = new EventEmitter();
    this.options = options;
    this.showCalls = 0;
    this.startupEvents = [];
    this.loadError = new Error('renderer load failed');
    this.loadOptions = null;
  }

  once(eventName, listener) {
    this.startupEvents.push(`listen:${eventName}`);
    return super.once(eventName, listener);
  }

  show() {
    this.showCalls++;
  }

  loadFile(target, options) {
    this.startupEvents.push(`load:${target}`);
    this.loadOptions = options;
    return this.loadError ? Promise.reject(this.loadError) : Promise.resolve();
  }
}

test('production startup never forces software compositing', () => {
  const projectRoot = path.join(__dirname, '..');
  const pending = [path.join(projectRoot, 'main.js'), path.join(projectRoot, 'lib')];
  const sourceFiles = [];
  while (pending.length) {
    const target = pending.pop();
    const stat = fs.statSync(target);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(target)) pending.push(path.join(target, entry));
    } else if (target.endsWith('.js')) {
      sourceFiles.push(target);
    }
  }
  for (const sourceFile of sourceFiles) {
    const source = fs.readFileSync(sourceFile, 'utf8');
    assert.doesNotMatch(source, /disableHardwareAcceleration|disable-gpu(?:-compositing)?/u, path.relative(projectRoot, sourceFile));
  }
});

test('Windows compositor paints the full hidden surface with an RDP session environment', { skip: process.platform !== 'win32' }, () => {
  const projectRoot = path.join(__dirname, '..');
  const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mhu-rdp-compositor-'));
  const probePath = path.join(probeRoot, 'probe.cjs');
  const preloadPath = path.join(probeRoot, 'preload.cjs');
  const outputPath = path.join(probeRoot, 'result.json');
  const userDataPath = path.join(probeRoot, 'user-data');
  fs.writeFileSync(preloadPath, `
const { contextBridge } = require('electron');
const managedOnlineBackupProbeCalls = [];
const folderMonitorProbeCalls = [];
let automationProbe = {
  history: [],
  uploadLog: [],
  paused: false,
  automationStatusSequence: [],
  historyError: '',
  addResult: null,
  addMode: '',
  addError: '',
  startResult: null,
  startError: '',
  saveSettingsError: '',
  dryScan: { files: [], reachable: true, trigger: 'test' },
  readCalls: { history: 0, uploadLog: 0, inspect: 0, status: 0, testScan: 0, reconcile: 0 },
  mutationCalls: [],
  logs: [],
  savedSettings: []
};
const managedOnlineBackupIds = {
  a: 'AAAAAAAAAAAAAAAAAAAAAA',
  b: 'AQEBAQEBAQEBAQEBAQEBAQ',
  c: 'AgICAgICAgICAgICAgICAg',
  d: 'AwMDAwMDAwMDAwMDAwMDAw',
  e: 'BAQEBAQEBAQEBAQEBAQEBA'
};
const managedOnlineBackupListResponses = [
  { ok: true, warningCode: 'KEYRING_DECRYPT_FAILED', warning: 'Gespeicherter Online-Sicherungsschlüssel konnte nicht entschlüsselt werden', entries: [
    { id: managedOnlineBackupIds.a, displayKey: 'MHU2-ABCD…1234', createdAt: '2026-08-20T08:00:00.000Z' },
    { id: managedOnlineBackupIds.b, displayKey: 'MHU2-ZYXW…9876', createdAt: '2026-08-22T10:00:00.000Z' },
    { id: 'BBBBBBBBBBBBBBBBBBBBBB', displayKey: 'MHU2-FAIL…1111', createdAt: '2026-08-23T10:00:00.000Z' },
    { id: managedOnlineBackupIds.c, displayKey: 'invalid', createdAt: '2026-08-24T10:00:00.000Z' }
  ] },
  { ok: false, entries: [], code: 'KEYRING_DECRYPT_FAILED', error: 'Gespeicherter Online-Sicherungsschlüssel konnte nicht entschlüsselt werden' },
  { ok: false, entries: [], code: 'KEYRING_DECRYPT_FAILED', error: 'Gespeicherter Online-Sicherungsschlüssel konnte nicht entschlüsselt werden' },
  { ok: true, entries: [
    { id: managedOnlineBackupIds.c, displayKey: 'MHU2-QWER…4321', createdAt: '2026-08-23T12:00:00.000Z' },
    { id: managedOnlineBackupIds.a, displayKey: 'MHU2-ABCD…1234', createdAt: '2026-08-20T08:00:00.000Z' }
  ] },
  null,
  { ok: false, entries: [], code: 'KEYRING_ID_MISMATCH', error: 'Gespeicherte Online-Sicherungskennung stimmt nicht mit dem Schlüssel überein' }
];
let managedOnlineBackupListIndex = 0;
let managedOnlineBackupCreateIndex = 0;
const pendingManagedOnlineBackupLists = new Map();
let pendingManagedOnlineBackupCopy = null;
let pendingManagedOnlineBackupDelete = null;
contextBridge.exposeInMainWorld('api', {
  onUpdateAvailable() {},
  onUpdateProgress() {},
  onPrepareClose() {},
  getConfig() { return new Promise(() => {}); },
  remoteStatus() { return Promise.resolve({ running: false, port: 0, clientCount: 0 }); },
  diagnosticsStatus() { return Promise.resolve({ running: false }); },
  diagnosticsGetSettings() { return Promise.resolve({}); },
  listManagedOnlineBackups() {
    managedOnlineBackupListIndex++;
    managedOnlineBackupProbeCalls.push(['list', managedOnlineBackupListIndex]);
    if (managedOnlineBackupListIndex === 5) {
      return new Promise(resolve => { pendingManagedOnlineBackupLists.set(managedOnlineBackupListIndex, resolve); });
    }
    return Promise.resolve(managedOnlineBackupListResponses[managedOnlineBackupListIndex - 1]);
  },
  releaseManagedOnlineBackupList(index) {
    const resolve = pendingManagedOnlineBackupLists.get(index);
    pendingManagedOnlineBackupLists.delete(index);
    resolve({ ok: true, entries: [
      { id: managedOnlineBackupIds.e, displayKey: 'MHU2-AUTH…9999', createdAt: '2026-08-26T10:00:00.000Z' },
      { id: managedOnlineBackupIds.d, displayKey: 'MHU2-DFGH…2468', createdAt: '2026-08-25T10:00:00.000Z' },
      { id: managedOnlineBackupIds.a, displayKey: 'MHU2-ABCD…1234', createdAt: '2026-08-20T08:00:00.000Z' }
    ] });
  },
  createManagedOnlineBackup() {
    managedOnlineBackupCreateIndex++;
    managedOnlineBackupProbeCalls.push(['create', managedOnlineBackupCreateIndex]);
    const entry = managedOnlineBackupCreateIndex === 1
      ? { id: managedOnlineBackupIds.c, displayKey: 'MHU2-QWER…4321', createdAt: '2026-08-23T12:00:00.000Z' }
      : { id: managedOnlineBackupIds.d, displayKey: 'MHU2-DFGH…2468', createdAt: '2026-08-25T10:00:00.000Z' };
    return Promise.resolve({ ok: true, entry });
  },
  copyManagedOnlineBackup(id) {
    managedOnlineBackupProbeCalls.push(['copy', id]);
    return new Promise(resolve => { pendingManagedOnlineBackupCopy = resolve; });
  },
  releaseManagedOnlineBackupCopy() {
    const resolve = pendingManagedOnlineBackupCopy;
    pendingManagedOnlineBackupCopy = null;
    resolve({ ok: true });
  },
  deleteManagedOnlineBackup(id) {
    managedOnlineBackupProbeCalls.push(['delete', id]);
    return new Promise(resolve => { pendingManagedOnlineBackupDelete = { id, resolve }; });
  },
  releaseManagedOnlineBackupDelete() {
    const pending = pendingManagedOnlineBackupDelete;
    pendingManagedOnlineBackupDelete = null;
    pending.resolve({ ok: true, removedId: pending.id, notFound: false });
  },
  getManagedOnlineBackupProbeCalls() { return managedOnlineBackupProbeCalls; },
  configureAutomationProbe(value = {}) {
    automationProbe = {
      history: Array.isArray(value.history) ? value.history : [],
      uploadLog: Array.isArray(value.uploadLog) ? value.uploadLog : [],
      paused: value.paused === true,
      automationStatusSequence: Array.isArray(value.automationStatusSequence) ? value.automationStatusSequence.map(entry => ({ ...entry })) : [],
      historyError: String(value.historyError || ''),
      addResult: value.addResult || null,
      addMode: String(value.addMode || ''),
      addError: String(value.addError || ''),
      startResult: value.startResult || null,
      startError: String(value.startError || ''),
      saveSettingsError: String(value.saveSettingsError || ''),
      dryScan: value.dryScan || { files: [], reachable: true, trigger: 'test' },
      readCalls: { history: 0, uploadLog: 0, inspect: 0, status: 0, testScan: 0, reconcile: 0 },
      mutationCalls: [],
      logs: [],
      savedSettings: []
    };
  },
  getAutomationProbeState() {
    return {
      readCalls: { ...automationProbe.readCalls },
      mutationCalls: automationProbe.mutationCalls.map(value => [...value]),
      logs: [...automationProbe.logs],
      savedSettings: automationProbe.savedSettings.map(value => JSON.parse(JSON.stringify(value)))
    };
  },
  inspectImportFiles(entries, existingPaths) {
    automationProbe.readCalls.inspect++;
    const candidates = Array.isArray(entries) ? entries : [];
    const normalize = value => String(value || '').replace(/\\\\/g, '/').toLowerCase();
    const seen = new Set((Array.isArray(existingPaths) ? existingPaths : []).map(normalize));
    const duplicates = [];
    const unique = [];
    for (const entry of candidates) {
      const key = normalize(entry?.path);
      if (seen.has(key)) duplicates.push({ ...entry });
      else {
        seen.add(key);
        unique.push(entry);
      }
    }
    const unavailable = unique.filter(entry => entry?.unavailable).map(entry => ({ ...entry, reason: 'unreadable' }));
    const accepted = unique.filter(entry => !entry?.unavailable).map(entry => ({ ...entry }));
    return Promise.resolve({
      candidateCount: candidates.length,
      duplicateCount: duplicates.length,
      unavailableCount: unavailable.length,
      acceptedCount: accepted.length,
      accepted,
      duplicates,
      unavailable
    });
  },
  getHistory() {
    automationProbe.readCalls.history++;
    if (automationProbe.historyError) return Promise.reject(new Error(automationProbe.historyError));
    return Promise.resolve(automationProbe.history);
  },
  readOwnUploadLog() {
    automationProbe.readCalls.uploadLog++;
    return Promise.resolve(automationProbe.uploadLog);
  },
  automationGetStatus() {
    automationProbe.readCalls.status++;
    if (automationProbe.automationStatusSequence.length > 0) return Promise.resolve(automationProbe.automationStatusSequence.shift());
    return Promise.resolve({ paused: automationProbe.paused });
  },
  folderMonitorTestScan() {
    automationProbe.readCalls.testScan++;
    return Promise.resolve(automationProbe.dryScan);
  },
  folderMonitorReconcile() {
    automationProbe.readCalls.reconcile++;
    return Promise.resolve(automationProbe.dryScan);
  },
  debugLog(value) { automationProbe.logs.push(String(value)); },
  saveGlobalSettings(value) {
    automationProbe.savedSettings.push(value);
    automationProbe.mutationCalls.push(['settings']);
    if (automationProbe.saveSettingsError) return Promise.reject(new Error(automationProbe.saveSettingsError));
    return Promise.resolve(true);
  },
  savePendingQueue(payload) {
    folderMonitorProbeCalls.push(['save', payload?.queueJobs?.length || 0]);
    automationProbe.mutationCalls.push(['save', payload?.queueJobs?.length || 0]);
    return Promise.resolve(true);
  },
  addJobsToBatch(payload) {
    folderMonitorProbeCalls.push(['inject', payload?.jobs?.length || 0]);
    automationProbe.mutationCalls.push(['inject', payload?.jobs?.length || 0]);
    if (automationProbe.addError) return Promise.reject(new Error(automationProbe.addError));
    if (automationProbe.addMode === 'partial-consistent' && payload?.jobs?.length >= 4) {
      return Promise.resolve({
        added: payload.jobs.length - 2,
        alreadyInBatchJobIds: [payload.jobs[1].id],
        skippedJobs: [{ jobId: payload.jobs[2].id, reason: 'Kein gültiger Account' }]
      });
    }
    return Promise.resolve(automationProbe.addResult || { added: payload?.jobs?.length || 0 });
  },
  startUpload(payload) {
    automationProbe.mutationCalls.push(['start', payload?.jobs?.length || 0]);
    if (automationProbe.startError) return Promise.reject(new Error(automationProbe.startError));
    return Promise.resolve(automationProbe.startResult || { started: true });
  },
  getFolderMonitorProbeCalls() { return folderMonitorProbeCalls; }
});
`, 'utf8');
  const appDialogBehaviorScript = `(async () => {
    setupListeners();
    const settle = promise => Promise.race([
      promise,
      new Promise(resolve => setTimeout(() => resolve('pending'), 30))
    ]);
    const safePromise = showAppConfirm({ title: 'Safe', message: 'Safe default', confirmText: 'Continue', danger: true });
    const safeFocus = document.activeElement?.id;
    document.getElementById('appAlertCancelBtn').click();
    const safeResult = await safePromise;
    const removalPromise = showAppConfirm({ title: 'Remove', message: 'Remove now', confirmText: 'Remove', danger: true, defaultAction: 'confirm' });
    const removalFocus = document.activeElement?.id;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    const removalEnterResult = await settle(removalPromise);
    if (removalEnterResult === 'pending') document.getElementById('appAlertCancelBtn').click();
    const cancelPromise = showAppConfirm({ title: 'Remove', message: 'Cancel intentionally', confirmText: 'Remove', danger: true, defaultAction: 'confirm' });
    document.getElementById('appAlertCancelBtn').focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    const cancelFocusedEnter = await settle(cancelPromise);
    document.getElementById('appAlertCancelBtn').click();
    const cancelResult = await cancelPromise;
    const realShowAppConfirm = showAppConfirm;
    const removalCalls = [];
    showAppConfirm = options => {
      removalCalls.push({ title: options.title, defaultAction: options.defaultAction });
      return Promise.resolve(false);
    };
    selectedRecentIds.clear();
    selectedRecentIds.add(1);
    sessionFilesData = [{ order: 1, link: 'https://example.invalid/a', filename: 'a.mp4', host: 'byse.sx' }];
    await deleteSelectedRecentFiles();
    await clearAllRecentFiles();
    queueJobs = [{ id: 'dialog-remove', file: 'C:/dialog-remove.mp4', fileName: 'dialog-remove.mp4', hoster: 'byse.sx', status: 'queued' }];
    selectedJobIds.clear();
    selectedJobIds.add('dialog-remove');
    rebuildJobIndex();
    await handleContextAction('delete-selected');
    await handleContextAction('delete-all');
    showAppConfirm = realShowAppConfirm;
    queueJobs = [];
    selectedJobIds.clear();
    selectedRecentIds.clear();
    sessionFilesData = [];
    rebuildJobIndex();
    return { safeFocus, safeResult, removalFocus, removalEnterResult, cancelFocusedEnter, cancelResult, removalCalls };
  })()`;
  const settingsSearchBehaviorScript = `(async () => {
    setUiLanguage('de');
    document.querySelector('[data-view="settings"]')?.click();
    renderSettings();
    await new Promise(resolve => setTimeout(resolve, 0));
    const search = document.getElementById('settingsSearchInput');
    search.value = 'erfolgreich löschen';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    const resultButtons = [...document.querySelectorAll('.settings-search-result')];
    const targetResult = resultButtons.find(button => button.textContent.includes('Nach erfolgreichem Upload löschen'));
    const germanState = {
      navigationHidden: document.querySelector('.settings-navigation')?.hidden,
      resultsHidden: document.getElementById('settingsSearchResults')?.hidden,
      count: resultButtons.length,
      path: targetResult?.querySelector('.settings-search-result-path')?.textContent.trim(),
      marks: [...(targetResult?.querySelectorAll('mark') || [])].map(mark => mark.textContent.toLowerCase()),
      liveStatus: document.getElementById('settingsSearchStatus')?.textContent.trim()
    };
    const inspectPaths = value => {
      search.value = value;
      search.dispatchEvent(new Event('input', { bubbles: true }));
      return [...document.querySelectorAll('.settings-search-result-path')].map(element => element.textContent.trim());
    };
    const updatePaths = inspectPaths('update');
    const exceptionalPaths = [
      'schlüssel importieren',
      'neuen schlüssel erzeugen',
      'online-backups verwalten',
      'datei exportieren',
      'datei importieren'
    ].map(value => inspectPaths(value));
    const stableSectionPath = inspectPaths('ordnerpfad')[0];
    const umlautAliasPath = inspectPaths('loeschen').find(path => path.includes('Nach erfolgreichem Upload löschen'));
    search.value = 'online-backups verwalten';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('.settings-search-result')?.click();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const managedBackupNavigation = {
      page: document.querySelector('.settings-subpage.active')?.dataset.subpage,
      focus: document.activeElement?.id,
      highlighted: document.querySelector('.online-backup-managed')?.classList.contains('settings-search-target-highlight')
    };
    search.value = 'erfolgreich löschen';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('.settings-search-result')?.click();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const navigationState = {
      page: document.querySelector('.settings-subpage.active')?.dataset.subpage,
      focus: document.activeElement?.id,
      highlighted: document.querySelector('.source-delete-option')?.classList.contains('settings-search-target-highlight'),
      searchValue: search.value,
      navigationHidden: document.querySelector('.settings-navigation')?.hidden,
      resultsHidden: document.getElementById('settingsSearchResults')?.hidden
    };
    setUiLanguage('en');
    search.value = 'delete source';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    const englishPath = [...document.querySelectorAll('.settings-search-result-path')]
      .map(element => element.textContent.trim())
      .find(text => text.includes('Delete after successful upload'));
    search.value = '';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    const clearedState = {
      page: document.querySelector('.settings-subpage.active')?.dataset.subpage,
      navigationHidden: document.querySelector('.settings-navigation')?.hidden,
      resultsHidden: document.getElementById('settingsSearchResults')?.hidden,
      emptyHidden: document.getElementById('settingsSearchEmpty')?.hidden
    };
    return { germanState, updatePaths, exceptionalPaths, stableSectionPath, umlautAliasPath, managedBackupNavigation, navigationState, englishPath, clearedState };
  })()`;
  const folderMonitorBehaviorScript = `(async () => {
    setUiLanguage('de');
    renderSettings();
    await new Promise(resolve => setTimeout(resolve, 0));
    const keys = ['enabled', 'recursive', 'existing', 'duplicates', 'auto-start', 'hosters'];
    const readTooltips = () => Object.fromEntries(keys.map(key => {
      const element = document.querySelector('[data-folder-monitor-help="' + key + '"]');
      return [key, { tooltip: element?.dataset.tooltip, label: element?.getAttribute('aria-label') }];
    }));
    const germanTooltips = readTooltips();
    const gridScope = {
      ordinary: document.getElementById('alwaysOnTopInput').closest('.checkbox-row').classList.contains('folder-monitor-help-row'),
      folderMonitor: document.getElementById('fmEnabledInput').closest('.checkbox-row').classList.contains('folder-monitor-help-row')
    };
    setUiLanguage('en');
    await new Promise(resolve => setTimeout(resolve, 0));
    const englishTooltips = readTooltips();
    const actions = {
      disabledWhileIdle: resolveFolderMonitorQueueAction({ autoStart: false, uploading: false, healthCheckRunning: false }),
      disabledWhileUploading: resolveFolderMonitorQueueAction({ autoStart: false, uploading: true, healthCheckRunning: false }),
      enabledWhileIdle: resolveFolderMonitorQueueAction({ autoStart: true, uploading: false, healthCheckRunning: false }),
      enabledWhileUploading: resolveFolderMonitorQueueAction({ autoStart: true, uploading: true, healthCheckRunning: false }),
      enabledDuringHealthCheck: resolveFolderMonitorQueueAction({ autoStart: true, uploading: false, healthCheckRunning: true })
    };
    const resetQueue = autoStart => {
      config = {
        hosters: Object.fromEntries(HOSTERS.map(hoster => [hoster, []])),
        globalSettings: { folderMonitor: { hosters: ['doodstream.com'], autoStart } }
      };
      hosterSettings = {};
      selectedUploadHosters = [];
      selectedFiles = [];
      queueJobs = [];
      uploading = true;
      healthCheckRunning = false;
      rebuildJobIndex();
    };
    resetQueue(false);
    await handleFolderMonitorFiles(['C:\\\\folder-monitor-queue-only.mkv']);
    await new Promise(resolve => setTimeout(resolve, 0));
    const queueOnly = {
      statuses: queueJobs.map(job => job.status),
      injectCalls: window.api.getFolderMonitorProbeCalls().filter(call => call[0] === 'inject').length
    };
    resetQueue(true);
    await handleFolderMonitorFiles(['C:\\\\folder-monitor-inject.mkv']);
    await new Promise(resolve => setTimeout(resolve, 0));
    const autoStart = {
      statuses: queueJobs.map(job => job.status),
      injectCalls: window.api.getFolderMonitorProbeCalls().filter(call => call[0] === 'inject').length
    };
    const originalStartUpload = startUpload;
    let startCalls = 0;
    startUpload = () => { startCalls++; return Promise.resolve(); };
    const prepareManualSelection = (filePath, autoStartValue, isUploading) => {
      const file = { path: filePath, name: filePath.split('\\\\').pop(), size: 1 };
      resetQueue(autoStartValue);
      uploading = isUploading;
      _pendingFiles = [file];
      _pendingImportInspection = { candidateCount: 1, duplicateCount: 0, unavailableCount: 0, accepted: [file] };
      _pendingImportInspections = 0;
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.dataset.hosterModal = 'doodstream.com';
      input.checked = true;
      document.getElementById('hosterModalList').replaceChildren(input);
      markPendingFolderMonitorFiles([file], autoStartValue);
      return file;
    };
    const injectBeforeManualQueue = window.api.getFolderMonitorProbeCalls().filter(call => call[0] === 'inject').length;
    prepareManualSelection('C:\\\\folder-monitor-manual-queue.mkv', false, true);
    applyHosterSelection();
    await new Promise(resolve => setTimeout(resolve, 0));
    const manualQueueOnly = {
      statuses: queueJobs.map(job => job.status),
      injectCalls: window.api.getFolderMonitorProbeCalls().filter(call => call[0] === 'inject').length - injectBeforeManualQueue
    };
    const injectBeforeManualAuto = window.api.getFolderMonitorProbeCalls().filter(call => call[0] === 'inject').length;
    prepareManualSelection('C:\\\\folder-monitor-manual-inject.mkv', true, true);
    applyHosterSelection();
    await new Promise(resolve => setTimeout(resolve, 0));
    const manualAutoStartRunning = {
      statuses: queueJobs.map(job => job.status),
      injectCalls: window.api.getFolderMonitorProbeCalls().filter(call => call[0] === 'inject').length - injectBeforeManualAuto
    };
    prepareManualSelection('C:\\\\folder-monitor-manual-start.mkv', true, false);
    applyHosterSelection();
    await new Promise(resolve => setTimeout(resolve, 0));
    const manualAutoStartIdle = { startCalls };
    startUpload = originalStartUpload;
    queueJobs = [
      { id: 'active-same-name', file: 'C:\\\\active\\\\same-name.mkv', fileName: 'same-name.mkv', hoster: 'doodstream.com', status: 'queued', bytesTotal: 1 },
      { id: 'waiting-same-name', file: 'D:\\\\watched\\\\same-name.mkv', fileName: 'same-name.mkv', hoster: 'doodstream.com', status: 'preview', bytesTotal: 1 }
    ];
    rebuildJobIndex();
    applySummaryResults({ files: [{ name: 'same-name.mkv', size: 1, results: [{ hoster: 'doodstream.com', status: 'done', file_code: 'active-code' }] }] });
    const sameBasenameResult = Object.fromEntries(queueJobs.map(job => [job.id, { status: job.status, code: job.result?.file_code || null }]));
    return { germanTooltips, englishTooltips, gridScope, actions, queueOnly, autoStart, manualQueueOnly, manualAutoStartRunning, manualAutoStartIdle, sameBasenameResult };
  })()`;
  const automationPipelineScript = `(async () => {
    const clone = value => JSON.parse(JSON.stringify(value));
    const captureMutationFingerprint = async () => {
      const api = await window.api.getAutomationProbeState();
      return {
        queueJobs: clone(queueJobs),
        selectedFiles: clone(selectedFiles),
        counters: { sessionDone: _sessionDoneCount, sessionError: _sessionErrorCount },
        pendingFiles: clone(_pendingFiles),
        pendingInspection: clone(_pendingImportInspection),
        pendingInspections: _pendingImportInspections,
        pendingAutoStart: clone([..._pendingFolderMonitorAutoStart]),
        config: clone(config),
        monitorSettings: clone(config.globalSettings?.folderMonitor || {}),
        api: { mutationCalls: api.mutationCalls, logs: api.logs, savedSettings: api.savedSettings }
      };
    };
    const hosters = ['doodstream.com', 'voe.sx', 'vidmoly.me', 'byse.sx'];
    const candidates = Array.from({ length: 500 }, (_, index) => ({
      path: 'C:\\\\watch\\\\candidate-' + String(index).padStart(3, '0') + '.mkv',
      name: 'candidate-' + String(index).padStart(3, '0') + '.mkv',
      size: index >= 55 && index < 75 ? 2 * 1024 * 1024 : 512 * 1024,
      mtimeMs: index,
      filterMatched: index < 430,
      unavailable: index >= 50 && index < 55
    }));
    const history = [{
      id: 'history',
      files: candidates.slice(0, 25).map(file => ({ path: file.path, name: file.name, results: [{ hoster: hosters[0], status: 'done' }] }))
    }];
    const uploadLog = candidates.slice(25, 50).map(file => ({ fileName: file.name, hoster: hosters[0] }));
    config = {
      hosters: Object.fromEntries(HOSTERS.map(hoster => [hoster, []])),
      hosterSettings: {},
      globalSettings: {
        folderMonitor: {
          enabled: true,
          folderPath: 'C:\\\\watch',
          hosters,
          autoStart: false,
          queueLimitJobs: 1500,
          paused: false,
          telemetry: { dateKey: '2026-08-26', detected: 7, queued: 3, skipped: 2, deferred: 1 }
        }
      }
    };
    hosterSettings = { 'doodstream.com': { maxSizeMb: 1 } };
    selectedUploadHosters = [];
    selectedFiles = [{ path: 'C:\\\\manual\\\\selected.mkv', name: 'selected.mkv', size: 1 }];
    queueJobs = Array.from({ length: 300 }, (_, index) => ({
      id: 'existing-' + index,
      file: 'C:\\\\queue\\\\existing-' + index + '.mkv',
      fileName: 'existing-' + index + '.mkv',
      hoster: hosters[index % hosters.length],
      status: 'queued',
      bytesTotal: 1
    }));
    _sessionDoneCount = 4;
    _sessionErrorCount = 5;
    _pendingFiles = [{ path: 'C:\\\\pending\\\\pending.mkv', name: 'pending.mkv', size: 1 }];
    _pendingImportInspection = { candidateCount: 1, accepted: clone(_pendingFiles) };
    _pendingImportInspections = 1;
    _pendingFolderMonitorAutoStart.clear();
    _pendingFolderMonitorAutoStart.set('C:\\\\pending\\\\pending.mkv', true);
    rebuildJobIndex();
    window.api.configureAutomationProbe({ history, uploadLog, paused: false });
    const before = await captureMutationFingerprint();
    const preview = await evaluateAutomationCandidates(candidates, { dryRun: true, trigger: 'test' });
    const after = await captureMutationFingerprint();
    const dryReads = (await window.api.getAutomationProbeState()).readCalls;
    const dry = {
      fingerprintEqual: JSON.stringify(after) === JSON.stringify(before),
      summary: preview.summary,
      frozen: Object.isFrozen(preview) && Object.isFrozen(preview.summary) && Object.isFrozen(preview.admittedFiles) && Object.isFrozen(preview.deferredFiles),
      reads: dryReads
    };
    window.api.configureAutomationProbe({
      dryScan: { files: [candidates[55]], reachable: true, trigger: 'test' },
      paused: false
    });
    const manualTestBefore = await captureMutationFingerprint();
    const manualTestPreview = await runFolderMonitorTestScan();
    const manualTestAfter = await captureMutationFingerprint();
    const manualTestProbe = await window.api.getAutomationProbeState();
    const manualTest = {
      fingerprintEqual: JSON.stringify(manualTestAfter) === JSON.stringify(manualTestBefore),
      summary: manualTestPreview.summary,
      reads: manualTestProbe.readCalls
    };
    const historyCandidates = [
      { path: 'C:\\\\history\\\\success.mkv', name: 'success.mkv', size: 1 },
      { path: 'C:\\\\history\\\\link-success.mkv', name: 'link-success.mkv', size: 1 },
      { path: 'C:\\\\history\\\\error.mkv', name: 'error.mkv', size: 1 },
      { path: 'C:\\\\history\\\\aborted.mkv', name: 'aborted.mkv', size: 1 },
      { path: 'C:\\\\history\\\\skipped.mkv', name: 'skipped.mkv', size: 1 },
      { path: 'C:\\\\history\\\\all-failed.mkv', name: 'all-failed.mkv', size: 1 },
      { path: 'C:\\\\history-a\\\\same-name.mkv', name: 'same-name.mkv', size: 1 },
      { path: 'D:\\\\history-b\\\\same-name.mkv', name: 'same-name.mkv', size: 1 }
    ];
    config.globalSettings.folderMonitor = {
      enabled: true,
      folderPath: 'C:\\\\history',
      hosters: ['doodstream.com'],
      autoStart: false,
      queueLimitJobs: 15000,
      paused: false
    };
    hosterSettings = {};
    selectedFiles = [];
    queueJobs = [];
    rebuildJobIndex();
    window.api.configureAutomationProbe({
      paused: false,
      history: [{
        id: 'evidence',
        files: [
          { path: historyCandidates[0].path, name: historyCandidates[0].name, results: [{ hoster: 'doodstream.com', status: 'done' }] },
          { path: historyCandidates[1].path, name: historyCandidates[1].name, results: [{ hoster: 'doodstream.com', status: 'error', download_url: 'https://example.test/link' }] },
          { path: historyCandidates[2].path, name: historyCandidates[2].name, results: [{ hoster: 'doodstream.com', status: 'error' }] },
          { path: historyCandidates[3].path, name: historyCandidates[3].name, results: [{ hoster: 'doodstream.com', status: 'aborted' }] },
          { path: historyCandidates[4].path, name: historyCandidates[4].name, results: [{ hoster: 'doodstream.com', status: 'skipped' }] },
          { path: historyCandidates[5].path, name: historyCandidates[5].name, results: [{ hoster: 'doodstream.com', status: 'error' }, { hoster: 'voe.sx', status: 'aborted' }] },
          { name: 'same-name.mkv', results: [{ hoster: 'doodstream.com', status: 'done' }] }
        ]
      }]
    });
    const historyEvaluation = await evaluateAutomationCandidates(historyCandidates, { dryRun: true, trigger: 'test' });
    const historyEvidence = {
      alreadyProcessed: historyEvaluation.summary.alreadyProcessed,
      acceptedNames: historyEvaluation.candidates.map(file => file.name).sort(),
      resultingJobs: historyEvaluation.summary.resultingJobs
    };
    config.globalSettings.folderMonitor = {
      enabled: true,
      folderPath: 'C:\\\\pending',
      hosters: [],
      autoStart: false,
      queueLimitJobs: 15000,
      paused: false
    };
    selectedFiles = [];
    queueJobs = [];
    _pendingFiles = [{ path: 'C:\\\\pending\\\\existing.mkv', name: 'existing.mkv', size: 1 }];
    _pendingImportInspection = { candidateCount: 1, duplicateCount: 0, unavailableCount: 0, accepted: _pendingFiles.slice() };
    _pendingFolderMonitorAutoStart.clear();
    rebuildJobIndex();
    window.api.configureAutomationProbe({ paused: false });
    const pendingEvaluation = await evaluateAutomationCandidates([
      { path: 'c:\\\\PENDING\\\\existing.mkv', name: 'existing.mkv', size: 1 },
      { path: 'C:\\\\pending\\\\new.mkv', name: 'new.mkv', size: 1 },
      { path: 'c:\\\\PENDING\\\\new.mkv', name: 'new.mkv', size: 1 }
    ], { dryRun: true, trigger: 'test' });
    _pendingFiles = [];
    _pendingImportInspection = null;
    _pendingFolderMonitorAutoStart.clear();
    const overlapping = { path: 'C:\\\\pending\\\\overlap.mkv', name: 'overlap.mkv', size: 1 };
    await Promise.all([
      handleFolderMonitorFiles([overlapping, { ...overlapping, path: 'c:\\\\PENDING\\\\overlap.mkv' }]),
      handleFolderMonitorFiles([{ ...overlapping }])
    ]);
    const pendingDedup = {
      evaluatedNames: pendingEvaluation.candidates.map(file => file.name),
      pendingPaths: _pendingFiles.map(file => normalizeAutomationPath(file.path)),
      pendingAccepted: _pendingImportInspection?.accepted?.length || 0,
      markerPaths: [..._pendingFolderMonitorAutoStart.keys()].map(normalizeAutomationPath)
    };
    const prepareManualHostFailure = ({ full, historyError }) => {
      const file = { path: 'C:\\\\manual-host\\\\pending.mkv', name: 'pending.mkv', size: 1, mtimeMs: 1 };
      config.globalSettings.folderMonitor = {
        enabled: true,
        folderPath: 'C:\\\\manual-host',
        hosters: [],
        autoStart: false,
        queueLimitJobs: full ? 1 : 15000,
        paused: false
      };
      hosterSettings = {};
      selectedFiles = [];
      selectedUploadHosters = [];
      queueJobs = full ? [{ id: 'full', file: 'C:\\\\queue\\\\full.mkv', fileName: 'full.mkv', hoster: 'doodstream.com', status: 'queued', bytesTotal: 1 }] : [];
      _pendingFiles = [file];
      _pendingImportInspection = { candidateCount: 1, duplicateCount: 0, unavailableCount: 0, accepted: [file] };
      _pendingImportInspections = 0;
      _pendingFolderMonitorAutoStart.clear();
      _pendingFolderMonitorAutoStart.set(file.path, false);
      rebuildJobIndex();
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.dataset.hosterModal = 'doodstream.com';
      input.checked = true;
      document.getElementById('hosterModalList').replaceChildren(input);
      document.getElementById('hosterModal').style.display = 'flex';
      window.api.configureAutomationProbe({ paused: false, historyError });
    };
    const captureManualHostFailure = (result, thrown) => ({
      result,
      thrown,
      pendingNames: _pendingFiles.map(file => file.name),
      markerNames: [..._pendingFolderMonitorAutoStart.keys()].map(path => path.split('\\\\').pop()),
      inspectionAccepted: _pendingImportInspection?.accepted?.length || 0,
      modalOpen: document.getElementById('hosterModal').style.display === 'flex'
    });
    prepareManualHostFailure({ full: false, historyError: 'token=secret-value' });
    let readFailureResult = null;
    let readFailureThrown = null;
    try {
      readFailureResult = await applyHosterSelection();
    } catch (error) {
      readFailureThrown = error.message || String(error);
    }
    const readFailure = captureManualHostFailure(readFailureResult, readFailureThrown);
    prepareManualHostFailure({ full: true, historyError: '' });
    let applyFailureResult = null;
    let applyFailureThrown = null;
    try {
      applyFailureResult = await applyHosterSelection();
    } catch (error) {
      applyFailureThrown = error.message || String(error);
    }
    const applyFailure = captureManualHostFailure(applyFailureResult, applyFailureThrown);
    const manualHostTransactional = {
      readFailure,
      applyFailure,
      secretExposed: JSON.stringify({ readFailure, applyFailure }).includes('secret-value')
    };

    const configureAtomicState = currentCount => {
      config.globalSettings.folderMonitor = {
        enabled: true,
        folderPath: 'C:\\\\watch',
        hosters,
        autoStart: false,
        queueLimitJobs: 15000,
        paused: false,
        telemetry: { dateKey: new Date().toLocaleDateString('en-CA'), detected: 0, queued: 0, skipped: 0, deferred: 0 }
      };
      hosterSettings = {
        'doodstream.com': { maxSizeMb: 2 },
        'voe.sx': { maxSizeMb: 2 }
      };
      selectedUploadHosters = ['clouddrop.cc'];
      selectedFiles = [];
      queueJobs = Array.from({ length: currentCount }, (_, index) => ({
        id: 'capacity-' + index,
        file: 'C:\\\\capacity\\\\existing-' + index + '.mkv',
        fileName: 'existing-' + index + '.mkv',
        hoster: hosters[index % hosters.length],
        status: 'queued',
        bytesTotal: 1
      }));
      _pendingFiles = [];
      _pendingImportInspection = null;
      _pendingImportInspections = 0;
      _pendingFolderMonitorAutoStart.clear();
      uploading = false;
      rebuildJobIndex();
      window.api.configureAutomationProbe({ paused: false });
    };
    const atomicCandidates = [
      { path: 'C:\\\\watch\\\\a.mkv', name: 'a.mkv', size: 1024 * 1024, mtimeMs: 1, filterMatched: true },
      { path: 'C:\\\\watch\\\\b.mkv', name: 'b.mkv', size: 3 * 1024 * 1024, mtimeMs: 2, filterMatched: true }
    ];
    configureAtomicState(14998);
    selectedFiles = [{ path: 'C:\\\\manual\\\\unplanned.mkv', name: 'unplanned.mkv', size: 1 }];
    selectedUploadHosters = ['clouddrop.cc'];
    const atomicEvaluation = await evaluateAutomationCandidates(atomicCandidates, { dryRun: false, trigger: 'watcher' });
    const atomicResult = await applyAutomationEvaluation(atomicEvaluation);
    const selectedHostersAfterApply = selectedUploadHosters.slice();
    const manualSelectionFilesAfterApply = selectedFiles.map(file => file.name);
    const plannedHostsBeforeRebuild = queueJobs.filter(job => job.file === atomicCandidates[1].path).map(job => job.hoster).sort();
    selectedUploadHosters = ['clouddrop.cc'];
    updateUploadView();
    const atomic = {
      newQueueFiles: [...new Set(queueJobs.filter(job => job.file === atomicCandidates[0].path || job.file === atomicCandidates[1].path).map(job => job.fileName))],
      admittedFiles: atomicResult.admittedFiles.map(file => file.name),
      deferred: config.globalSettings.folderMonitor.telemetry.deferred,
      queued: config.globalSettings.folderMonitor.telemetry.queued,
      currentJobCount: window.AutomationControl.countAutomaticQueueJobs(queueJobs),
      unplannedJobs: queueJobs.filter(job => job.fileName === 'unplanned.mkv').length,
      selectedHostersAfterApply,
      manualSelectionFilesAfterApply,
      plannedHostsBeforeRebuild,
      hostsAfterRebuild: queueJobs.filter(job => job.file === atomicCandidates[1].path).map(job => job.hoster).sort()
    };
    const statusSnapshot = createAutomationStatusSnapshot();
    const status = {
      state: statusSnapshot.state,
      currentJobCount: statusSnapshot.currentJobCount,
      availableSlots: statusSnapshot.availableSlots,
      queueLimited: statusSnapshot.queueLimited,
      frozen: Object.isFrozen(statusSnapshot) && Object.isFrozen(statusSnapshot.telemetry)
    };

    configureAtomicState(0);
    selectedFiles = [];
    selectedUploadHosters = ['clouddrop.cc'];
    config.globalSettings.folderMonitor.hosters = ['doodstream.com', 'voe.sx'];
    hosterSettings = {};
    const persistedFile = { path: 'C:\\\\persisted\\\\automation.mkv', name: 'automation.mkv', size: 1, mtimeMs: 1 };
    const persistedEvaluation = await evaluateAutomationCandidates([persistedFile], { dryRun: false, trigger: 'watcher' });
    await applyAutomationEvaluation(persistedEvaluation);
    const pendingSnapshot = buildPersistedQueueState();
    config.globalSettings.pendingQueue = pendingSnapshot;
    selectedFiles = [];
    selectedUploadHosters = [];
    queueJobs = [];
    rebuildJobIndex();
    restoreQueueStateFromConfig();
    syncSelectedFilesFromQueue();
    selectedUploadHosters = ['clouddrop.cc'];
    updateUploadView();
    const persistedQueueExactness = {
      restoredSelectedFiles: selectedFiles.map(file => file.name),
      automationMarkers: queueJobs.filter(job => job.file === persistedFile.path && job.automationAdmission === true).length,
      hostsAfterRebuild: queueJobs.filter(job => job.file === persistedFile.path).map(job => job.hoster).sort()
    };

    configureAtomicState(14994);
    const staleEvaluation = await evaluateAutomationCandidates(atomicCandidates, { dryRun: false, trigger: 'watcher' });
    queueJobs.push(...Array.from({ length: 4 }, (_, index) => ({
      id: 'stale-' + index,
      file: 'C:\\\\capacity\\\\stale-' + index + '.mkv',
      fileName: 'stale-' + index + '.mkv',
      hoster: hosters[index],
      status: 'queued',
      bytesTotal: 1
    })));
    rebuildJobIndex();
    const staleResult = await applyAutomationEvaluation(staleEvaluation);
    const stale = {
      plannedBeforeApply: staleEvaluation.admittedFiles.map(file => file.name),
      admittedAfterApply: staleResult.admittedFiles.map(file => file.name),
      newQueueFiles: [...new Set(queueJobs.filter(job => job.file === atomicCandidates[0].path || job.file === atomicCandidates[1].path).map(job => job.fileName))]
    };

    configureAtomicState(0);
    selectedUploadHosters = ['clouddrop.cc'];
    selectedFiles = [];
    config.globalSettings.folderMonitor.hosters = ['doodstream.com', 'voe.sx'];
    hosterSettings = {};
    const changingFile = { path: 'C:\\\\watch\\\\changing.mkv', name: 'changing.mkv', size: 3 * 1024 * 1024, mtimeMs: 1 };
    const changingEvaluation = await evaluateAutomationCandidates([changingFile], { dryRun: false, trigger: 'watcher' });
    config.globalSettings.folderMonitor.hosters = ['byse.sx', 'vidmoly.me'];
    hosterSettings = { 'byse.sx': { maxSizeMb: 2 } };
    const changingResult = await applyAutomationEvaluation(changingEvaluation);
    const watcherHosts = queueJobs.filter(job => job.file === changingFile.path).map(job => job.hoster).sort();
    const immutableEvaluatedHosts = changingEvaluation.candidates[0].eligibleHosters.slice().sort();
    configureAtomicState(0);
    selectedFiles = [];
    config.globalSettings.folderMonitor.hosters = [];
    hosterSettings = {};
    const manualChangingEvaluation = await evaluateAutomationCandidates([changingFile], {
      dryRun: false,
      trigger: 'manual-host',
      selectedHosters: ['doodstream.com', 'voe.sx']
    });
    hosterSettings = {
      'doodstream.com': { maxSizeMb: 2 },
      'voe.sx': { maxSizeMb: 2 }
    };
    const manualChangingResult = await applyAutomationEvaluation(manualChangingEvaluation);
    const replannedEligibility = {
      watcherAdmitted: changingResult.admittedFiles.map(file => file.name),
      watcherHosts,
      immutableEvaluatedHosts,
      manualAdmitted: manualChangingResult.admittedFiles.map(file => file.name),
      manualJobs: queueJobs.filter(job => job.file === changingFile.path).length
    };

    const makePauseRaceJob = name => ({
      id: 'pause-race-' + name,
      file: 'C:\\\\pause-race\\\\' + name,
      fileName: name,
      hoster: 'doodstream.com',
      status: 'preview',
      bytesUploaded: 0,
      bytesTotal: 1,
      speedKbs: 0,
      elapsed: 0,
      remaining: 0,
      error: null,
      result: null,
      progress: 0,
      uploadId: null
    });
    configureAtomicState(0);
    selectedFiles = [];
    selectedUploadHosters = ['doodstream.com'];
    const startRaceJob = makePauseRaceJob('start-paused.mkv');
    queueJobs = [startRaceJob];
    rebuildJobIndex();
    window.api.configureAutomationProbe({ paused: false, startResult: { error: 'Automatik ist pausiert' } });
    const originalShowAppAlertForPause = showAppAlert;
    showAppAlert = async () => {};
    const startRaceResult = await startUpload();
    showAppAlert = originalShowAppAlertForPause;
    const startRace = { result: startRaceResult, status: startRaceJob.status, uploading };
    const addRaceJob = makePauseRaceJob('add-paused.mkv');
    queueJobs = [addRaceJob];
    uploading = true;
    rebuildJobIndex();
    window.api.configureAutomationProbe({ paused: false, addResult: { error: 'Automatik ist pausiert', added: 0 } });
    const addRaceResult = await startSelectedUpload([addRaceJob]);
    const addRace = { result: addRaceResult, status: addRaceJob.status, uploading };
    uploading = false;
    const selectedStartRaceJob = makePauseRaceJob('selected-start-paused.mkv');
    queueJobs = [selectedStartRaceJob];
    uploading = false;
    rebuildJobIndex();
    window.api.configureAutomationProbe({ paused: false, startResult: { error: 'Automatik ist pausiert' } });
    showAppAlert = async () => {};
    const selectedStartRaceResult = await startSelectedUpload([selectedStartRaceJob]);
    showAppAlert = originalShowAppAlertForPause;
    const selectedStartRace = { result: selectedStartRaceResult, status: selectedStartRaceJob.status, uploading };
    const manualRaceFile = { path: 'C:\\\\manual-race\\\\manual-paused.mkv', name: 'manual-paused.mkv', size: 1 };
    queueJobs = [];
    selectedFiles = [];
    uploading = true;
    _pendingFiles = [manualRaceFile];
    _pendingImportInspection = { candidateCount: 1, duplicateCount: 0, unavailableCount: 0, accepted: [manualRaceFile] };
    _pendingImportInspections = 0;
    _pendingFolderMonitorAutoStart.clear();
    rebuildJobIndex();
    const manualRaceInput = document.createElement('input');
    manualRaceInput.type = 'checkbox';
    manualRaceInput.dataset.hosterModal = 'doodstream.com';
    manualRaceInput.checked = true;
    document.getElementById('hosterModalList').replaceChildren(manualRaceInput);
    document.getElementById('hosterModal').style.display = 'flex';
    window.api.configureAutomationProbe({ paused: false, addResult: { error: 'Automatik ist pausiert', added: 0 } });
    const manualRaceResult = await applyHosterSelection();
    const manualRace = {
      result: manualRaceResult,
      status: queueJobs.find(job => job.file === manualRaceFile.path)?.status || null,
      uploading
    };
    uploading = false;
    const mainPauseResponses = { startRace, addRace, selectedStartRace, manualRace };

    const cleanupState = job => ({
      token: job.sourceCleanupToken,
      required: clone(job.sourceCleanupRequiredHosters),
      completed: clone(job.sourceCleanupCompletedHosters),
      fingerprint: clone(job.sourceCleanupFingerprint)
    });
    const runCleanupRollbackCase = async (name, probe) => {
      configureAtomicState(0);
      config.globalSettings.deleteSourceAfterSuccessfulUpload = true;
      const filePath = 'C:\\\\cleanup\\\\' + name + '.mkv';
      const target = {
        ...makePauseRaceJob(name + '.mkv'),
        id: 'cleanup-target-' + name,
        file: filePath,
        sourceCleanupToken: 'preview-token-' + name,
        sourceCleanupRequiredHosters: ['doodstream.com'],
        sourceCleanupCompletedHosters: [],
        sourceCleanupFingerprint: { size: 11, mtimeMs: 22 }
      };
      const sibling = {
        ...makePauseRaceJob(name + '-done.mkv'),
        id: 'cleanup-sibling-' + name,
        file: filePath,
        fileName: name + '.mkv',
        hoster: 'voe.sx',
        status: 'done',
        sourceCleanupToken: 'done-token-' + name,
        sourceCleanupRequiredHosters: ['voe.sx'],
        sourceCleanupCompletedHosters: ['voe.sx'],
        sourceCleanupFingerprint: { size: 33, mtimeMs: 44 }
      };
      queueJobs = [target, sibling];
      uploading = true;
      rebuildJobIndex();
      window.api.configureAutomationProbe({ paused: false, ...probe });
      const before = JSON.stringify([cleanupState(target), cleanupState(sibling)]);
      const result = await startSelectedUpload([target]);
      const after = JSON.stringify([cleanupState(target), cleanupState(sibling)]);
      uploading = false;
      return {
        cleanupByteIdentical: after === before,
        targetStatus: target.status,
        siblingStatus: sibling.status,
        result
      };
    };
    const cleanupRollback = {
      paused: await runCleanupRollbackCase('paused', { addResult: { error: 'Automatik ist pausiert', added: 0 } }),
      error: await runCleanupRollbackCase('error', { addResult: { error: 'token=secret-value', added: 0 } }),
      exception: await runCleanupRollbackCase('exception', { addError: 'token=secret-value' }),
      unconfirmed: await runCleanupRollbackCase('unconfirmed', { addResult: { added: 0 } })
    };
    const cleanupPresenceState = job => Object.fromEntries([
      'sourceCleanupToken',
      'sourceCleanupRequiredHosters',
      'sourceCleanupCompletedHosters',
      'sourceCleanupFingerprint'
    ].map(field => [field, {
      present: Object.prototype.hasOwnProperty.call(job, field),
      value: Object.prototype.hasOwnProperty.call(job, field) ? clone(job[field]) : null
    }]));
    const setupCrossPathCleanup = name => {
      configureAtomicState(0);
      config.globalSettings.deleteSourceAfterSuccessfulUpload = true;
      selectedUploadHosters = ['doodstream.com'];
      const token = 'cross-token-' + name;
      const target = {
        ...makePauseRaceJob(name + '.mkv'),
        id: 'cross-target-' + name,
        file: 'C:\\\\cleanup-target\\\\' + name + '.mkv',
        sourceCleanupToken: token,
        sourceCleanupRequiredHosters: ['doodstream.com']
      };
      const sibling = {
        ...makePauseRaceJob(name + '-done.mkv'),
        id: 'cross-sibling-' + name,
        file: 'D:\\\\cleanup-sibling\\\\' + name + '.mkv',
        hoster: 'voe.sx',
        status: 'done',
        sourceCleanupToken: token
      };
      const unrelated = {
        ...makePauseRaceJob(name + '-unrelated.mkv'),
        id: 'cross-unrelated-' + name,
        file: 'E:\\\\cleanup-unrelated\\\\' + name + '.mkv',
        hoster: 'vidmoly.me',
        status: 'done'
      };
      queueJobs = [target, sibling, unrelated];
      rebuildJobIndex();
      return { target, sibling, unrelated, token };
    };
    const crossPathResult = (fixture, before, result) => ({
      byteIdentical: JSON.stringify(fixture.map(cleanupPresenceState)) === before,
      statuses: fixture.map(job => job.status),
      result
    });
    const originalAlertForCrossPath = showAppAlert;
    showAppAlert = async () => {};
    let fixture = setupCrossPathCleanup('start-upload');
    let fixtureJobs = [fixture.target, fixture.sibling, fixture.unrelated];
    let fixtureBefore = JSON.stringify(fixtureJobs.map(cleanupPresenceState));
    window.api.configureAutomationProbe({ paused: false, startResult: { error: 'Automatik ist pausiert' } });
    const startUploadCleanup = crossPathResult(fixtureJobs, fixtureBefore, await startUpload());
    fixture = setupCrossPathCleanup('inactive-selected');
    fixtureJobs = [fixture.target, fixture.sibling, fixture.unrelated];
    fixtureBefore = JSON.stringify(fixtureJobs.map(cleanupPresenceState));
    uploading = false;
    window.api.configureAutomationProbe({ paused: false, startResult: { started: false } });
    const inactiveSelectedCleanup = crossPathResult(fixtureJobs, fixtureBefore, await startSelectedUpload([fixture.target]));
    fixture = setupCrossPathCleanup('active-selected');
    fixtureJobs = [fixture.target, fixture.sibling, fixture.unrelated];
    fixtureBefore = JSON.stringify(fixtureJobs.map(cleanupPresenceState));
    uploading = true;
    window.api.configureAutomationProbe({ paused: false, addResult: { error: 'Automatik ist pausiert', added: 0 } });
    const activeSelectedCleanup = crossPathResult(fixtureJobs, fixtureBefore, await startSelectedUpload([fixture.target]));
    fixture = setupCrossPathCleanup('manual-modal');
    fixture.target.automationAdmission = true;
    fixtureJobs = [fixture.target, fixture.sibling, fixture.unrelated];
    fixtureBefore = JSON.stringify(fixtureJobs.map(cleanupPresenceState));
    uploading = true;
    _pendingFiles = [{ path: fixture.target.file, name: fixture.target.fileName, size: 1 }];
    _pendingImportInspection = { candidateCount: 1, duplicateCount: 0, unavailableCount: 0, accepted: _pendingFiles.slice() };
    _pendingImportInspections = 0;
    _pendingFolderMonitorAutoStart.clear();
    const crossManualInput = document.createElement('input');
    crossManualInput.type = 'checkbox';
    crossManualInput.dataset.hosterModal = 'doodstream.com';
    crossManualInput.checked = true;
    document.getElementById('hosterModalList').replaceChildren(crossManualInput);
    window.api.configureAutomationProbe({ paused: false, addResult: { error: 'Automatik ist pausiert', added: 0 } });
    const manualModalCleanup = crossPathResult(fixtureJobs, fixtureBefore, await applyHosterSelection());
    fixture = setupCrossPathCleanup('automation');
    queueJobs = [fixture.sibling, fixture.unrelated];
    rebuildJobIndex();
    config.globalSettings.folderMonitor.hosters = ['doodstream.com'];
    config.globalSettings.folderMonitor.autoStart = true;
    uploading = true;
    const originalCreateAutomationPreviewJob = createAutomationPreviewJob;
    createAutomationPreviewJob = (file, hoster) => ({
      ...originalCreateAutomationPreviewJob(file, hoster),
      sourceCleanupToken: fixture.token
    });
    const automationFile = { path: fixture.target.file, name: fixture.target.fileName, size: 1, mtimeMs: 1 };
    window.api.configureAutomationProbe({ paused: false, addResult: { error: 'Automatik ist pausiert', added: 0 } });
    const automationEvaluation = await evaluateAutomationCandidates([automationFile], { dryRun: false, trigger: 'watcher' });
    const automationBeforeJobs = [fixture.sibling, fixture.unrelated];
    const automationBefore = JSON.stringify(automationBeforeJobs.map(cleanupPresenceState));
    const automationResult = await applyAutomationEvaluation(automationEvaluation);
    const automationTarget = queueJobs.find(job => job.file === automationFile.path);
    createAutomationPreviewJob = originalCreateAutomationPreviewJob;
    showAppAlert = originalAlertForCrossPath;
    uploading = false;
    const crossPathCleanupRollback = {
      startUpload: startUploadCleanup,
      inactiveSelected: inactiveSelectedCleanup,
      activeSelected: activeSelectedCleanup,
      manualModal: manualModalCleanup,
      automation: {
        byteIdentical: JSON.stringify(automationBeforeJobs.map(cleanupPresenceState)) === automationBefore,
        targetCleanup: cleanupPresenceState(automationTarget),
        statuses: [automationTarget.status, fixture.sibling.status, fixture.unrelated.status],
        result: { ok: automationResult.ok, error: automationResult.error }
      }
    };
    const createPartialJobs = prefix => hosters.map((hoster, index) => ({
      ...makePauseRaceJob(prefix + '-' + index + '.mkv'),
      id: prefix + '-' + index,
      file: 'C:\\\\partial\\\\' + prefix + '-' + index + '.mkv',
      hoster
    }));
    const runPartialSelected = async consistent => {
      configureAtomicState(0);
      config.globalSettings.deleteSourceAfterSuccessfulUpload = true;
      const jobs = createPartialJobs(consistent ? 'consistent' : 'inconsistent');
      queueJobs = jobs;
      uploading = true;
      rebuildJobIndex();
      const before = jobs.map(job => JSON.stringify(cleanupPresenceState(job)));
      window.api.configureAutomationProbe({
        paused: false,
        addResult: {
          added: consistent ? 2 : 1,
          alreadyInBatchJobIds: [jobs[1].id],
          skippedJobs: [{ jobId: jobs[2].id, reason: 'Kein gültiger Account' }]
        }
      });
      const result = await startSelectedUpload(jobs);
      const after = jobs.map(job => JSON.stringify(cleanupPresenceState(job)));
      uploading = false;
      return {
        result,
        statuses: jobs.map(job => job.status),
        unconfirmedRestored: [0, 3].map(index => after[index] === before[index]),
        confirmedPrepared: [1, 2].map(index => after[index] !== before[index])
      };
    };
    const partialSelectedConsistent = await runPartialSelected(true);
    const partialSelectedInconsistent = await runPartialSelected(false);
    configureAtomicState(0);
    config.globalSettings.deleteSourceAfterSuccessfulUpload = true;
    config.globalSettings.folderMonitor.hosters = hosters.slice();
    config.globalSettings.folderMonitor.autoStart = true;
    selectedFiles = [];
    uploading = true;
    window.api.configureAutomationProbe({ paused: false, addMode: 'partial-consistent' });
    const partialAutomationFile = { path: 'C:\\\\partial\\\\automation.mkv', name: 'automation.mkv', size: 1, mtimeMs: 1 };
    const partialAutomationEvaluation = await evaluateAutomationCandidates([partialAutomationFile], { dryRun: false, trigger: 'watcher' });
    const partialAutomationResult = await applyAutomationEvaluation(partialAutomationEvaluation);
    const partialAutomationStatuses = Object.fromEntries(queueJobs
      .filter(job => job.file === partialAutomationFile.path)
      .map(job => [job.hoster, job.status]));
    uploading = false;
    configureAtomicState(0);
    config.globalSettings.deleteSourceAfterSuccessfulUpload = true;
    selectedFiles = [];
    uploading = true;
    const partialManualFile = { path: 'C:\\\\partial\\\\manual.mkv', name: 'manual.mkv', size: 1 };
    _pendingFiles = [partialManualFile];
    _pendingImportInspection = { candidateCount: 1, duplicateCount: 0, unavailableCount: 0, accepted: [partialManualFile] };
    _pendingImportInspections = 0;
    _pendingFolderMonitorAutoStart.clear();
    const partialManualInputs = hosters.map(hoster => {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.dataset.hosterModal = hoster;
      input.checked = true;
      return input;
    });
    document.getElementById('hosterModalList').replaceChildren(...partialManualInputs);
    window.api.configureAutomationProbe({ paused: false, addMode: 'partial-consistent' });
    const partialManualResult = await applyHosterSelection();
    const partialManualStatuses = Object.fromEntries(queueJobs
      .filter(job => job.file === partialManualFile.path)
      .map(job => [job.hoster, job.status]));
    uploading = false;
    const partialAddOutcomes = {
      selectedConsistent: partialSelectedConsistent,
      selectedInconsistent: partialSelectedInconsistent,
      automation: {
        result: {
          ok: partialAutomationResult.ok,
          error: partialAutomationResult.error || null,
          admitted: partialAutomationResult.admittedFiles.map(file => file.name)
        },
        statuses: partialAutomationStatuses
      },
      manual: {
        result: partialManualResult,
        statuses: partialManualStatuses
      }
    };

    configureAtomicState(0);
    selectedFiles = [];
    config.globalSettings.folderMonitor.autoStart = true;
    config.globalSettings.folderMonitor.hosters = ['doodstream.com'];
    config.globalSettings.folderMonitor.telemetry = { dateKey: new Date().toLocaleDateString('en-CA'), detected: 0, queued: 0, skipped: 0, deferred: 0 };
    hosterSettings = {};
    uploading = false;
    window.api.configureAutomationProbe({
      paused: false,
      automationStatusSequence: [{ paused: false }, { paused: true }]
    });
    const betweenFile = { path: 'C:\\\\between\\\\paused.mkv', name: 'paused.mkv', size: 1, mtimeMs: 1 };
    const betweenEvaluation = await evaluateAutomationCandidates([betweenFile], { dryRun: false, trigger: 'watcher' });
    const betweenResult = await applyAutomationEvaluation(betweenEvaluation);
    const betweenProbe = await window.api.getAutomationProbeState();
    const pauseBetweenApplyAndStart = {
      result: {
        ok: betweenResult.ok,
        error: betweenResult.error || null,
        warning: betweenResult.warning || null,
        admitted: betweenResult.admittedFiles.map(file => file.name)
      },
      status: queueJobs.find(job => job.file === betweenFile.path)?.status || null,
      queuedTelemetry: config.globalSettings.folderMonitor.telemetry.queued,
      startCalls: betweenProbe.mutationCalls.filter(call => call[0] === 'start').length
    };
    const runStartAcceptanceCase = async (name, probe) => {
      configureAtomicState(0);
      selectedFiles = [];
      selectedUploadHosters = ['doodstream.com'];
      const job = makePauseRaceJob(name + '.mkv');
      queueJobs = [job];
      uploading = false;
      rebuildJobIndex();
      window.api.configureAutomationProbe({ paused: false, ...probe });
      const originalAlert = showAppAlert;
      showAppAlert = async () => {};
      const result = await startUpload();
      showAppAlert = originalAlert;
      return { result, status: job.status, uploading };
    };
    const startAcceptance = {
      accepted: await runStartAcceptanceCase('accepted', { startResult: { started: true } }),
      unconfirmed: await runStartAcceptanceCase('unconfirmed', { startResult: { started: false } }),
      exception: await runStartAcceptanceCase('exception', { startError: 'token=secret-value' })
    };

    const originalShowCopyToastForAutomation = showCopyToast;
    const feedbackMessages = [];
    showCopyToast = message => { feedbackMessages.push(String(message)); };
    configureAtomicState(0);
    selectedFiles = [];
    config.globalSettings.folderMonitor.hosters = ['doodstream.com'];
    config.globalSettings.folderMonitor.autoStart = false;
    hosterSettings = {};
    window.api.configureAutomationProbe({ paused: false, saveSettingsError: 'token=telemetry-secret' });
    const watcherWarningResult = await handleFolderMonitorFiles([
      { path: 'C:\\\\feedback\\\\watcher-warning.mkv', name: 'watcher-warning.mkv', size: 1, mtimeMs: 1 }
    ]);
    const watcherWarningFeedback = feedbackMessages.splice(0);
    failedConfigWriteOperations.length = 0;
    configureAtomicState(0);
    selectedFiles = [];
    config.globalSettings.folderMonitor.hosters = ['doodstream.com'];
    config.globalSettings.folderMonitor.autoStart = true;
    hosterSettings = {};
    uploading = true;
    window.api.configureAutomationProbe({ paused: false, addResult: { error: 'token=secret-value', added: 0 } });
    const watcherErrorResult = await handleFolderMonitorFiles([
      { path: 'C:\\\\feedback\\\\watcher-error.mkv', name: 'watcher-error.mkv', size: 1, mtimeMs: 1 }
    ]);
    const watcherErrorFeedback = feedbackMessages.splice(0);
    uploading = false;
    configureAtomicState(0);
    selectedFiles = [];
    config.globalSettings.folderMonitor.hosters = [];
    config.globalSettings.folderMonitor.autoStart = false;
    hosterSettings = {};
    const modalWarningFile = { path: 'C:\\\\feedback\\\\modal-warning.mkv', name: 'modal-warning.mkv', size: 1, mtimeMs: 1 };
    _pendingFiles = [modalWarningFile];
    _pendingImportInspection = { candidateCount: 1, duplicateCount: 0, unavailableCount: 0, accepted: [modalWarningFile] };
    _pendingImportInspections = 0;
    _pendingFolderMonitorAutoStart.clear();
    _pendingFolderMonitorAutoStart.set(modalWarningFile.path, false);
    const modalWarningInput = document.createElement('input');
    modalWarningInput.type = 'checkbox';
    modalWarningInput.dataset.hosterModal = 'doodstream.com';
    modalWarningInput.checked = true;
    document.getElementById('hosterModalList').replaceChildren(modalWarningInput);
    document.getElementById('hosterModal').style.display = 'flex';
    window.api.configureAutomationProbe({ paused: false, saveSettingsError: 'token=telemetry-secret' });
    const modalWarningResult = await applyHosterSelection();
    const modalWarningFeedback = feedbackMessages.splice(0);
    failedConfigWriteOperations.length = 0;
    showCopyToast = originalShowCopyToastForAutomation;
    const fulfilledFeedback = {
      watcherWarning: {
        result: { ok: watcherWarningResult.ok, warning: watcherWarningResult.warning || null, error: watcherWarningResult.error || null },
        feedback: watcherWarningFeedback
      },
      watcherError: {
        result: { ok: watcherErrorResult.ok, warning: watcherErrorResult.warning || null, error: watcherErrorResult.error || null },
        feedback: watcherErrorFeedback
      },
      modalWarning: {
        result: modalWarningResult,
        feedback: modalWarningFeedback,
        pending: _pendingFiles.length,
        markers: _pendingFolderMonitorAutoStart.size,
        modalOpen: document.getElementById('hosterModal').style.display === 'flex',
        queueStatus: queueJobs.find(job => job.file === modalWarningFile.path)?.status || null
      },
      secretExposed: JSON.stringify({ watcherWarningFeedback, watcherErrorFeedback, modalWarningFeedback, modalWarningResult }).includes('secret')
    };

    const runInjectionCase = async (name, probe) => {
      configureAtomicState(0);
      selectedFiles = [];
      config.globalSettings.folderMonitor.autoStart = true;
      config.globalSettings.folderMonitor.hosters = ['doodstream.com'];
      config.globalSettings.folderMonitor.telemetry = { dateKey: new Date().toLocaleDateString('en-CA'), detected: 0, queued: 0, skipped: 0, deferred: 0 };
      hosterSettings = {};
      uploading = true;
      window.api.configureAutomationProbe({ paused: false, ...probe });
      const file = { path: 'C:\\\\injection\\\\' + name, name, size: 1, mtimeMs: 1 };
      const evaluation = await evaluateAutomationCandidates([file], { dryRun: false, trigger: 'watcher' });
      const result = await applyAutomationEvaluation(evaluation);
      const state = await window.api.getAutomationProbeState();
      const response = {
        ok: result.ok,
        error: result.error || null,
        warning: result.warning || null,
        admitted: result.admittedFiles.map(entry => entry.name),
        status: queueJobs.find(job => job.file === file.path)?.status || null,
        queuedTelemetry: config.globalSettings.folderMonitor.telemetry.queued,
        telemetrySaveAttempted: state.mutationCalls.some(call => call[0] === 'settings')
      };
      uploading = false;
      return response;
    };
    const pausedInjection = await runInjectionCase('paused.mkv', { addResult: { error: 'Automatik ist pausiert', added: 0 } });
    const unconfirmedInjection = await runInjectionCase('unconfirmed.mkv', { addResult: { added: 0 } });
    const exceptionInjection = await runInjectionCase('exception.mkv', { addError: 'token=secret-value' });
    const telemetryFailure = await runInjectionCase('telemetry.mkv', { saveSettingsError: 'token=telemetry-secret' });
    const injectionOutcomes = {
      pausedInjection,
      unconfirmedInjection,
      exceptionInjection,
      telemetryFailure,
      secretExposed: JSON.stringify({ pausedInjection, unconfirmedInjection, exceptionInjection, telemetryFailure }).includes('secret')
    };

    configureAtomicState(0);
    config.globalSettings.folderMonitor.paused = true;
    window.api.configureAutomationProbe({ paused: true });
    const pausedJob = {
      id: 'paused-preview',
      file: 'C:\\\\manual\\\\paused-preview.mkv',
      fileName: 'paused-preview.mkv',
      hoster: hosters[0],
      status: 'preview',
      bytesTotal: 1
    };
    queueJobs = [pausedJob];
    selectedFiles = [{ path: pausedJob.file, name: pausedJob.fileName, size: 1 }];
    selectedUploadHosters = [hosters[0]];
    rebuildJobIndex();
    await startUpload();
    uploading = true;
    await startSelectedUpload([pausedJob]);
    uploading = false;
    const pausedAutomaticEvaluation = await evaluateAutomationCandidates([
      { path: 'C:\\\\watch\\\\paused-auto.mkv', name: 'paused-auto.mkv', size: 1, mtimeMs: 1, filterMatched: true }
    ], { dryRun: false, trigger: 'watcher' });
    const pausedAutomaticResult = await applyAutomationEvaluation(pausedAutomaticEvaluation);
    await coordinateImportEntries([
      { path: 'C:\\\\manual\\\\allowed-preview.mkv', name: 'allowed-preview.mkv', size: 1 }
    ]);
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.hosterModal = hosters[0];
    input.checked = true;
    document.getElementById('hosterModalList').replaceChildren(input);
    await applyHosterSelection();
    const pausedProbe = await window.api.getAutomationProbeState();
    const paused = {
      uploading,
      statuses: Object.fromEntries(queueJobs.map(job => [job.fileName, job.status])),
      automaticApplied: pausedAutomaticResult.admittedFiles.length,
      startCalls: pausedProbe.mutationCalls.filter(call => call[0] === 'start').length,
      injectCalls: pausedProbe.mutationCalls.filter(call => call[0] === 'inject').length
    };
    return { dry, manualTest, historyEvidence, pendingDedup, manualHostTransactional, atomic, status, persistedQueueExactness, stale, replannedEligibility, mainPauseResponses, cleanupRollback, crossPathCleanupRollback, partialAddOutcomes, pauseBetweenApplyAndStart, startAcceptance, fulfilledFeedback, injectionOutcomes, paused };
  })()`;
  const onlineBackupBehaviorScript = `(async () => {
    const ids = {
      a: 'AAAAAAAAAAAAAAAAAAAAAA',
      b: 'AQEBAQEBAQEBAQEBAQEBAQ',
      c: 'AgICAgICAgICAgICAgICAg',
      d: 'AwMDAwMDAwMDAwMDAwMDAw',
      e: 'BAQEBAQEBAQEBAQEBAQEBA'
    };
    const fixture = document.createElement('section');
    fixture.innerHTML = '<div id="managedOnlineBackupList"></div><div id="managedOnlineBackupRefreshStatus" hidden><span id="managedOnlineBackupRefreshMessage"></span><button id="reloadManagedOnlineBackupsBtn" type="button">Erneut laden</button></div><div id="onlineBackupStatus"></div><button id="createOnlineBackupBtn"></button><input id="onlineBackupKeyInput"><button id="restoreOnlineBackupBtn"></button>';
    document.body.append(fixture);
    document.documentElement.lang = 'en';
    const waitFor = async predicate => {
      for (let attempt = 0; attempt < 120; attempt++) {
        if (await predicate()) return true;
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      return false;
    };
    const calls = async type => (await window.api.getManagedOnlineBackupProbeCalls()).filter(call => call[0] === type);
    let confirmation = null;
    let resolveConfirmation = null;
    showAppConfirm = options => {
      confirmation = options;
      return new Promise(resolve => { resolveConfirmation = resolve; });
    };
    flushPendingSettingsSaves = async () => {};
    openOnlineBackupView = () => {};
    const toastMessages = [];
    showCopyToast = message => toastMessages.push(localizeUiText(message));
    await loadManagedOnlineBackups();
    await new Promise(resolve => setTimeout(resolve, 0));
    const initialKeys = [...document.querySelectorAll('.online-backup-managed-key')].map(element => element.textContent);
    const initialWarning = {
      hidden: document.getElementById('managedOnlineBackupRefreshStatus')?.hidden,
      text: document.getElementById('managedOnlineBackupRefreshMessage')?.textContent
    };
    const exactSanitizedState = managedOnlineBackups.every(entry => /^[A-Za-z0-9_-]{22}$/.test(entry.id) && /^MHU2-[A-Za-z0-9_-]{4}…[A-Za-z0-9_-]{4}$/.test(entry.displayKey));
    const ariaDescriptions = [...document.querySelectorAll('.online-backup-managed-row')].every(row => {
      const keyId = row.querySelector('.online-backup-managed-key')?.id;
      return Boolean(keyId) && [...row.querySelectorAll('button')].every(button => button.getAttribute('aria-describedby') === keyId);
    });
    const deleteButton = document.querySelector('.online-backup-delete-btn');
    deleteButton.focus();
    deleteButton.click();
    await waitFor(() => typeof resolveConfirmation === 'function');
    resolveConfirmation(true);
    await waitFor(async () => (await calls('delete')).length === 1);
    window.api.releaseManagedOnlineBackupDelete();
    await waitFor(async () => (await calls('list')).length === 2);
    await waitFor(() => document.getElementById('onlineBackupStatus').textContent === 'Key deleted');
    const afterDelete = {
      keys: [...document.querySelectorAll('.online-backup-managed-key')].map(element => element.textContent),
      status: document.getElementById('onlineBackupStatus').textContent,
      statusState: document.getElementById('onlineBackupStatus').dataset.state,
      warning: document.getElementById('managedOnlineBackupRefreshMessage')?.textContent,
      retryVisible: document.getElementById('reloadManagedOnlineBackupsBtn')?.offsetParent !== null,
      focusAction: document.activeElement?.dataset.managedOnlineBackupAction,
      focusId: document.activeElement?.dataset.managedOnlineBackupId
    };
    const beforeCreateToasts = toastMessages.length;
    await doOnlineBackupCreate();
    await new Promise(resolve => setTimeout(resolve, 0));
    const refreshFailure = {
      keys: [...document.querySelectorAll('.online-backup-managed-key')].map(element => element.textContent),
      status: document.getElementById('onlineBackupStatus').textContent,
      statusState: document.getElementById('onlineBackupStatus').dataset.state,
      warning: document.getElementById('managedOnlineBackupRefreshMessage')?.textContent,
      retryVisible: document.getElementById('reloadManagedOnlineBackupsBtn')?.offsetParent !== null
    };
    const createSuccessToasts = toastMessages.slice(beforeCreateToasts);
    const beforeRetryCalls = (await calls('list')).length;
    document.getElementById('reloadManagedOnlineBackupsBtn')?.click();
    const retryTriggeredLoad = await waitFor(async () => (await calls('list')).length === beforeRetryCalls + 1);
    if (!retryTriggeredLoad) await loadManagedOnlineBackups();
    await new Promise(resolve => setTimeout(resolve, 0));
    const afterRetry = {
      keys: [...document.querySelectorAll('.online-backup-managed-key')].map(element => element.textContent),
      warningHidden: document.getElementById('managedOnlineBackupRefreshStatus')?.hidden
    };
    const racingCreate = doOnlineBackupCreate();
    await waitFor(async () => (await calls('list')).length === 5);
    const copyButton = [...document.querySelectorAll('.online-backup-copy-btn')].find(button => button.dataset.managedOnlineBackupId === ids.a) || document.querySelector('.online-backup-copy-btn');
    copyButton.focus();
    copyButton.click();
    await waitFor(async () => (await calls('copy')).length === 1);
    window.api.releaseManagedOnlineBackupCopy();
    const copyFocusRestored = await waitFor(() => document.activeElement?.dataset.managedOnlineBackupAction === 'copy' && document.activeElement?.dataset.managedOnlineBackupId === ids.a);
    window.api.releaseManagedOnlineBackupList(5);
    await racingCreate;
    await new Promise(resolve => setTimeout(resolve, 0));
    const raceResult = {
      keys: [...document.querySelectorAll('.online-backup-managed-key')].map(element => element.textContent),
      status: document.getElementById('onlineBackupStatus').textContent,
      statusState: document.getElementById('onlineBackupStatus').dataset.state,
      warningHidden: document.getElementById('managedOnlineBackupRefreshStatus')?.hidden
    };
    managedOnlineBackups = [];
    managedOnlineBackupsAuthoritative = false;
    renderManagedOnlineBackups(null);
    await loadManagedOnlineBackups();
    await new Promise(resolve => setTimeout(resolve, 0));
    const hardCorruption = {
      emptyStateVisible: Boolean(document.querySelector('.online-backup-managed-empty')),
      rowCount: document.querySelectorAll('.online-backup-managed-row').length,
      warning: document.getElementById('managedOnlineBackupRefreshMessage')?.textContent,
      retryVisible: document.getElementById('reloadManagedOnlineBackupsBtn')?.offsetParent !== null
    };
    return {
      initialKeys,
      initialWarning,
      exactSanitizedState,
      ariaDescriptions,
      afterDelete,
      refreshFailure,
      createSuccessToasts,
      retryTriggeredLoad,
      afterRetry,
      copyFocusRestored,
      raceResult,
      hardCorruption,
      confirmation,
      calls: await window.api.getManagedOnlineBackupProbeCalls(),
      secretInBody: /MHU2-[A-Za-z0-9_-]{70}/.test(document.body.textContent)
    };
  })()`;
  const onlineBackupLayoutScript = `(() => {
    const measure = language => {
      const copy = language === 'de' ? 'Schlüssel kopieren' : 'Copy key';
      const remove = language === 'de' ? 'Online-Backup löschen' : 'Delete online backup';
      document.documentElement.lang = language;
      document.body.innerHTML = '<section class="online-backup-panel"><section class="online-backup-managed"><h4>Managed</h4><div class="online-backup-managed-list"><article class="online-backup-managed-row"><span class="online-backup-managed-key">ABCDEFGH…1234</span><span class="online-backup-managed-created">22.08.2026 12:00</span><div class="online-backup-managed-actions"><button class="btn btn-secondary">' + copy + '</button><button class="btn btn-danger">' + remove + '</button></div></article><article class="online-backup-managed-row"><span class="online-backup-managed-key">ZYXWVUTS…9876</span><span class="online-backup-managed-created">21.08.2026 11:00</span><div class="online-backup-managed-actions"><button class="btn btn-secondary">' + copy + '</button><button class="btn btn-danger">' + remove + '</button></div></article></div></section><footer class="online-backup-footer"><button class="btn btn-primary">Generate new key</button></footer></section>';
      const panel = document.querySelector('.online-backup-panel');
      const panelRect = panel.getBoundingClientRect();
      const panelStyle = getComputedStyle(panel);
      const rows = [...document.querySelectorAll('.online-backup-managed-row')].map(row => {
        const key = row.querySelector('.online-backup-managed-key').getBoundingClientRect();
        const created = row.querySelector('.online-backup-managed-created').getBoundingClientRect();
        const actions = row.querySelector('.online-backup-managed-actions').getBoundingClientRect();
        return { keyLeft: key.left, createdLeft: created.left, actionsRight: actions.right };
      });
      return {
        rows,
        contentRight: panelRect.right - parseFloat(panelStyle.paddingRight),
        createRight: document.querySelector('.online-backup-footer button').getBoundingClientRect().right
      };
    };
    return { german: measure('de'), english: measure('en') };
  })()`;
  const onlineBackupNarrowLayoutScript = `(() => {
    document.body.innerHTML = '<section class="online-backup-panel"><section class="online-backup-managed"><div class="online-backup-managed-list"><article class="online-backup-managed-row"><span class="online-backup-managed-key">ABCDEFGH…1234</span><span class="online-backup-managed-created">22/08/2026, 12:00</span><div class="online-backup-managed-actions"><button class="btn btn-secondary">Copy key</button><button class="btn btn-danger">Delete online backup</button></div></article></div></section><footer class="online-backup-footer"><button class="btn btn-primary">Generate new key</button></footer></section>';
    const row = document.querySelector('.online-backup-managed-row').getBoundingClientRect();
    const key = document.querySelector('.online-backup-managed-key').getBoundingClientRect();
    const created = document.querySelector('.online-backup-managed-created').getBoundingClientRect();
    const actions = document.querySelector('.online-backup-managed-actions').getBoundingClientRect();
    const rowStyle = getComputedStyle(document.querySelector('.online-backup-managed-row'));
    const rowContentWidth = row.width - parseFloat(rowStyle.paddingLeft) - parseFloat(rowStyle.paddingRight) - parseFloat(rowStyle.borderLeftWidth) - parseFloat(rowStyle.borderRightWidth);
    const footer = document.querySelector('.online-backup-footer').getBoundingClientRect();
    const create = document.querySelector('.online-backup-footer button').getBoundingClientRect();
    return {
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      rowOverflow: document.querySelector('.online-backup-managed-row').scrollWidth > document.querySelector('.online-backup-managed-row').clientWidth + 1,
      stacked: key.top < created.top && created.top < actions.top,
      actionsStretched: Math.abs(actions.width - rowContentWidth) <= 1,
      createStretched: Math.abs(create.width - footer.width) <= 1
    };
  })()`;
  const probeSource = `
const { app, BrowserWindow, screen } = require('electron');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const outputPath = process.env.MHU_RDP_COMPOSITOR_OUTPUT;
function pixelAt(bitmap, width, x, y) {
  const offset = (y * width + x) * 4;
  return [bitmap[offset + 2], bitmap[offset + 1], bitmap[offset], bitmap[offset + 3]];
}
app.whenReady().then(async () => {
  const display = screen.getPrimaryDisplay();
  const requestedContentWidth = Math.min(2544, display.workAreaSize.width);
  const requestedContentHeight = Math.min(1353, display.workAreaSize.height);
  const window = new BrowserWindow({
    show: false,
    width: requestedContentWidth,
    height: requestedContentHeight,
    useContentSize: true,
    backgroundColor: '#0f0f0f',
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: process.env.MHU_PRELOAD_PATH }
  });
  const readyToShow = new Promise(resolve => window.once('ready-to-show', resolve));
  const document = '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#102030}.left,.right{position:fixed;top:0;bottom:0;width:8px}.left{left:0;background:#00ff00}.right{right:0;background:#ff00ff}</style></head><body><div class="left"></div><div class="right"></div></body></html>';
  await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(document));
  await readyToShow;
  await app.getGPUInfo('complete');
  const image = await window.webContents.capturePage();
  const size = image.getSize();
  const bitmap = image.toBitmap();
  const dom = await window.webContents.executeJavaScript('({ innerWidth, innerHeight, devicePixelRatio })');
  const rendererPid = window.webContents.getOSProcessId();
  const rendererCommandLine = execFileSync('powershell.exe', ['-NoProfile', '-Command', '(Get-CimInstance Win32_Process -Filter "ProcessId = ' + rendererPid + '").CommandLine'], { encoding: 'utf8' }).trim();
  const middleY = Math.floor(size.height / 2);
  await window.loadFile(process.env.MHU_RENDERER_PATH, { query: { language: 'en', version: '2.1.31' } });
  const liveSpeedChart = await window.webContents.executeJavaScript('({ baselinePresent: Boolean(document.querySelector(".upload-speed-baseline")), canvasWidth: document.getElementById("uploadSpeedCanvas")?.getBoundingClientRect().width || 0 })');
  const appDialogBehavior = await window.webContents.executeJavaScript(${JSON.stringify(appDialogBehaviorScript)});
  const onlineBackupBehavior = await window.webContents.executeJavaScript(${JSON.stringify(onlineBackupBehaviorScript)});
  const settingsSearchBehavior = await window.webContents.executeJavaScript(${JSON.stringify(settingsSearchBehaviorScript)});
  const folderMonitorBehavior = await window.webContents.executeJavaScript(${JSON.stringify(folderMonitorBehaviorScript)});
  const automationPipeline = await window.webContents.executeJavaScript(${JSON.stringify(automationPipelineScript)});
  const onlineBackupLayout = await window.webContents.executeJavaScript(${JSON.stringify(onlineBackupLayoutScript)});
  window.setContentSize(760, Math.min(900, display.workAreaSize.height));
  await new Promise(resolve => setTimeout(resolve, 50));
  const onlineBackupNarrowLayout = await window.webContents.executeJavaScript(${JSON.stringify(onlineBackupNarrowLayoutScript)});
  fs.writeFileSync(outputPath, JSON.stringify({
    size,
    dom,
    requestedContentWidth,
    requestedContentHeight,
    displayScaleFactor: display.scaleFactor,
    gpuFeatureStatus: app.getGPUFeatureStatus(),
    rendererCommandLine,
    leftEdge: pixelAt(bitmap, size.width, 0, middleY),
    rightEdge: pixelAt(bitmap, size.width, size.width - 1, middleY),
    liveSpeedChart,
    appDialogBehavior,
    settingsSearchBehavior,
    folderMonitorBehavior,
    automationPipeline,
    onlineBackupBehavior,
    onlineBackupLayout,
    onlineBackupNarrowLayout
  }), 'utf8');
  window.destroy();
  app.exit(0);
}).catch(error => {
  fs.writeFileSync(outputPath, JSON.stringify({ error: error.stack || String(error) }), 'utf8');
  app.exit(1);
});
`;
  fs.writeFileSync(probePath, probeSource, 'utf8');
  try {
    const electronPath = path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
    try {
      execFileSync(electronPath, [probePath, `--user-data-dir=${userDataPath}`], {
        cwd: projectRoot,
        env: {
          ...process.env,
          SESSIONNAME: 'RDP-Tcp#12',
          MHU_RDP_COMPOSITOR_OUTPUT: outputPath,
          MHU_RENDERER_PATH: path.join(projectRoot, 'renderer', 'index.html'),
          MHU_PRELOAD_PATH: preloadPath
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30000,
        windowsHide: true
      });
    } catch (error) {
      if (fs.existsSync(outputPath)) {
        const failedResult = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
        assert.fail(failedResult.error || error.message);
      }
      throw error;
    }
    const result = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    assert.equal(result.error, undefined);
    assert.doesNotMatch(result.rendererCommandLine, /--disable-gpu-compositing/u);
    assert.equal(result.size.width, Math.round(result.dom.innerWidth * result.dom.devicePixelRatio));
    assert.equal(result.size.height, Math.round(result.dom.innerHeight * result.dom.devicePixelRatio));
    assert.ok(result.requestedContentWidth > 0);
    assert.ok(result.requestedContentHeight > 0);
    if (Math.round(result.requestedContentWidth * result.displayScaleFactor) > 2048) {
      assert.ok(result.size.width > 2048);
    }
    assert.ok(result.leftEdge[1] > result.leftEdge[0] && result.leftEdge[1] > result.leftEdge[2]);
    assert.ok(result.rightEdge[0] > result.rightEdge[1] && result.rightEdge[2] > result.rightEdge[1]);
    assert.ok(result.liveSpeedChart.canvasWidth > 0);
    assert.equal(result.liveSpeedChart.baselinePresent, false);
    assert.deepEqual(result.appDialogBehavior, {
      safeFocus: 'appAlertCancelBtn',
      safeResult: false,
      removalFocus: 'appAlertConfirmBtn',
      removalEnterResult: true,
      cancelFocusedEnter: 'pending',
      cancelResult: false,
      removalCalls: [
        { title: 'Ausgewählte Einträge entfernen?', defaultAction: 'confirm' },
        { title: 'Alle Links entfernen?', defaultAction: 'confirm' },
        { title: 'Uploads entfernen?', defaultAction: 'confirm' },
        { title: 'Alle Uploads entfernen?', defaultAction: 'confirm' }
      ]
    });
    assert.deepEqual(result.settingsSearchBehavior, {
      germanState: {
        navigationHidden: true,
        resultsHidden: false,
        count: 1,
        path: 'Uploads → Quelldateien → Nach erfolgreichem Upload löschen',
        marks: ['erfolgreich', 'löschen'],
        liveStatus: 'Suchergebnisse: 1'
      },
      updatePaths: ['Allgemein → Programmupdate → Nach Updates suchen'],
      exceptionalPaths: [
        ['Backup & Übertragen → Online-Backup → Schlüssel importieren'],
        ['Backup & Übertragen → Online-Backup → Neuen Schlüssel erzeugen'],
        ['Backup & Übertragen → Online-Backup → Online-Backups verwalten'],
        ['Backup & Übertragen → Lokales Datei-Backup → Datei exportieren'],
        ['Backup & Übertragen → Lokales Datei-Backup → Datei importieren']
      ],
      stableSectionPath: 'Automatik → Ordnerüberwachung → Ordnerpfad',
      umlautAliasPath: 'Uploads → Quelldateien → Nach erfolgreichem Upload löschen',
      managedBackupNavigation: {
        page: 'backup',
        focus: 'managedOnlineBackupHeading',
        highlighted: true
      },
      navigationState: {
        page: 'uploads',
        focus: 'deleteSourceAfterSuccessfulUploadInput',
        highlighted: true,
        searchValue: '',
        navigationHidden: false,
        resultsHidden: true
      },
      englishPath: 'Uploads → Source files → Delete after successful upload',
      clearedState: {
        page: 'uploads',
        navigationHidden: false,
        resultsHidden: true,
        emptyHidden: true
      }
    });
    assert.deepEqual(result.folderMonitorBehavior, {
      germanTooltips: {
        enabled: { tooltip: 'Startet die Überwachung nach dem Speichern, wenn ein Ordner ausgewählt ist.', label: 'Startet die Überwachung nach dem Speichern, wenn ein Ordner ausgewählt ist.' },
        recursive: { tooltip: 'Überwacht zusätzlich alle Unterordner des ausgewählten Ordners.', label: 'Überwacht zusätzlich alle Unterordner des ausgewählten Ordners.' },
        existing: { tooltip: 'Fügt beim nächsten Start der Überwachung alle bereits vorhandenen passenden Dateien hinzu. Die Option wird danach automatisch deaktiviert.', label: 'Fügt beim nächsten Start der Überwachung alle bereits vorhandenen passenden Dateien hinzu. Die Option wird danach automatisch deaktiviert.' },
        duplicates: { tooltip: 'Ignoriert wiederholte Erkennungen desselben Dateipfads während der aktuellen Überwachung.', label: 'Ignoriert wiederholte Erkennungen desselben Dateipfads während der aktuellen Überwachung.' },
        'auto-start': { tooltip: 'Startet neu erkannte Dateien automatisch. Ohne diese Option werden sie nur zur Warteschlange hinzugefügt.', label: 'Startet neu erkannte Dateien automatisch. Ohne diese Option werden sie nur zur Warteschlange hinzugefügt.' },
        hosters: { tooltip: 'Legt die Upload-Ziele für Dateien aus der Ordnerüberwachung fest. Ohne Auswahl ist eine manuelle Bestätigung erforderlich.', label: 'Legt die Upload-Ziele für Dateien aus der Ordnerüberwachung fest. Ohne Auswahl ist eine manuelle Bestätigung erforderlich.' }
      },
      englishTooltips: {
        enabled: { tooltip: 'Starts monitoring after saving when a folder is selected.', label: 'Starts monitoring after saving when a folder is selected.' },
        recursive: { tooltip: 'Also monitors every subfolder inside the selected folder.', label: 'Also monitors every subfolder inside the selected folder.' },
        existing: { tooltip: 'Adds all matching files already present when monitoring starts next. The option is then disabled automatically.', label: 'Adds all matching files already present when monitoring starts next. The option is then disabled automatically.' },
        duplicates: { tooltip: 'Ignores repeated detections of the same file path during the current monitoring session.', label: 'Ignores repeated detections of the same file path during the current monitoring session.' },
        'auto-start': { tooltip: 'Starts newly detected files automatically. Without this option, they are only added to the queue.', label: 'Starts newly detected files automatically. Without this option, they are only added to the queue.' },
        hosters: { tooltip: 'Sets the upload destinations for files from folder monitoring. Without a selection, manual confirmation is required.', label: 'Sets the upload destinations for files from folder monitoring. Without a selection, manual confirmation is required.' }
      },
      gridScope: { ordinary: false, folderMonitor: true },
      actions: {
        disabledWhileIdle: 'queue',
        disabledWhileUploading: 'queue',
        enabledWhileIdle: 'start',
        enabledWhileUploading: 'inject',
        enabledDuringHealthCheck: 'queue'
      },
      queueOnly: { statuses: ['preview'], injectCalls: 0 },
      autoStart: { statuses: ['queued'], injectCalls: 1 },
      manualQueueOnly: { statuses: ['preview'], injectCalls: 0 },
      manualAutoStartRunning: { statuses: ['queued'], injectCalls: 1 },
      manualAutoStartIdle: { startCalls: 1 },
      sameBasenameResult: {
        'active-same-name': { status: 'done', code: 'active-code' },
        'waiting-same-name': { status: 'preview', code: null }
      }
    });
    assert.deepEqual(result.automationPipeline.dry, {
      fingerprintEqual: true,
      summary: {
        found: 500,
        filterMatched: 430,
        alreadyProcessed: 50,
        unavailable: 5,
        sizeLimitedJobs: 20,
        acceptedFiles: 375,
        selectedTargets: 4,
        resultingJobs: 1480,
        availableSlots: 1200,
        deferredFiles: 70
      },
      frozen: true,
      reads: { history: 1, uploadLog: 1, inspect: 1, status: 0, testScan: 0, reconcile: 0 }
    });
    assert.deepEqual(result.automationPipeline.manualTest, {
      fingerprintEqual: true,
      summary: {
        found: 1,
        filterMatched: 1,
        alreadyProcessed: 0,
        unavailable: 0,
        sizeLimitedJobs: 1,
        acceptedFiles: 1,
        selectedTargets: 4,
        resultingJobs: 3,
        availableSlots: 1200,
        deferredFiles: 0
      },
      reads: { history: 1, uploadLog: 1, inspect: 1, status: 0, testScan: 1, reconcile: 0 }
    });
    assert.deepEqual(result.automationPipeline.historyEvidence, {
      alreadyProcessed: 2,
      acceptedNames: ['aborted.mkv', 'all-failed.mkv', 'error.mkv', 'same-name.mkv', 'same-name.mkv', 'skipped.mkv'],
      resultingJobs: 6
    });
    assert.deepEqual(result.automationPipeline.pendingDedup, {
      evaluatedNames: ['new.mkv'],
      pendingPaths: ['c:/pending/overlap.mkv'],
      pendingAccepted: 1,
      markerPaths: ['c:/pending/overlap.mkv']
    });
    assert.deepEqual(result.automationPipeline.manualHostTransactional, {
      readFailure: {
        result: { ok: false, error: 'Automatische Aufnahme konnte nicht abgeschlossen werden.' },
        thrown: null,
        pendingNames: ['pending.mkv'],
        markerNames: ['pending.mkv'],
        inspectionAccepted: 1,
        modalOpen: true
      },
      applyFailure: {
        result: { ok: false, error: 'Automatische Aufnahme konnte nicht abgeschlossen werden.' },
        thrown: null,
        pendingNames: ['pending.mkv'],
        markerNames: ['pending.mkv'],
        inspectionAccepted: 1,
        modalOpen: true
      },
      secretExposed: false
    });
    assert.deepEqual(result.automationPipeline.atomic, {
      newQueueFiles: ['b.mkv'],
      admittedFiles: ['b.mkv'],
      deferred: 1,
      queued: 1,
      currentJobCount: 15000,
      unplannedJobs: 0,
      selectedHostersAfterApply: ['clouddrop.cc'],
      manualSelectionFilesAfterApply: ['unplanned.mkv'],
      plannedHostsBeforeRebuild: ['byse.sx', 'vidmoly.me'],
      hostsAfterRebuild: ['byse.sx', 'vidmoly.me']
    });
    assert.deepEqual(result.automationPipeline.status, {
      state: 'queue-limited',
      currentJobCount: 15000,
      availableSlots: 0,
      queueLimited: true,
      frozen: true
    });
    assert.deepEqual(result.automationPipeline.persistedQueueExactness, {
      restoredSelectedFiles: [],
      automationMarkers: 2,
      hostsAfterRebuild: ['doodstream.com', 'voe.sx']
    });
    assert.deepEqual(result.automationPipeline.stale, {
      plannedBeforeApply: ['a.mkv', 'b.mkv'],
      admittedAfterApply: ['b.mkv'],
      newQueueFiles: ['b.mkv']
    });
    assert.deepEqual(result.automationPipeline.replannedEligibility, {
      watcherAdmitted: ['changing.mkv'],
      watcherHosts: ['vidmoly.me'],
      immutableEvaluatedHosts: ['doodstream.com', 'voe.sx'],
      manualAdmitted: [],
      manualJobs: 0
    });
    assert.deepEqual(result.automationPipeline.mainPauseResponses, {
      startRace: {
        result: { ok: false, error: 'Automatik ist pausiert' },
        status: 'preview',
        uploading: false
      },
      addRace: {
        result: { ok: false, error: 'Automatik ist pausiert' },
        status: 'preview',
        uploading: true
      },
      selectedStartRace: {
        result: { ok: false, error: 'Automatik ist pausiert' },
        status: 'preview',
        uploading: false
      },
      manualRace: {
        result: { ok: false, error: 'Automatik ist pausiert' },
        status: 'preview',
        uploading: true
      }
    });
    assert.deepEqual(result.automationPipeline.cleanupRollback, {
      paused: {
        cleanupByteIdentical: true,
        targetStatus: 'preview',
        siblingStatus: 'done',
        result: { ok: false, error: 'Automatik ist pausiert' }
      },
      error: {
        cleanupByteIdentical: true,
        targetStatus: 'preview',
        siblingStatus: 'done',
        result: { ok: false, error: 'Jobs konnten nicht hinzugefügt werden.' }
      },
      exception: {
        cleanupByteIdentical: true,
        targetStatus: 'preview',
        siblingStatus: 'done',
        result: { ok: false, error: 'Jobs konnten nicht hinzugefügt werden.' }
      },
      unconfirmed: {
        cleanupByteIdentical: true,
        targetStatus: 'preview',
        siblingStatus: 'done',
        result: { ok: false, error: 'Jobs konnten nicht eindeutig bestätigt werden.' }
      }
    });
    assert.deepEqual(result.automationPipeline.crossPathCleanupRollback, {
      startUpload: {
        byteIdentical: true,
        statuses: ['preview', 'done', 'done'],
        result: { ok: false, error: 'Automatik ist pausiert' }
      },
      inactiveSelected: {
        byteIdentical: true,
        statuses: ['preview', 'done', 'done'],
        result: { ok: false, error: 'Upload wurde nicht bestätigt.' }
      },
      activeSelected: {
        byteIdentical: true,
        statuses: ['preview', 'done', 'done'],
        result: { ok: false, error: 'Automatik ist pausiert' }
      },
      manualModal: {
        byteIdentical: true,
        statuses: ['preview', 'done', 'done'],
        result: { ok: false, error: 'Automatik ist pausiert' }
      },
      automation: {
        byteIdentical: true,
        targetCleanup: {
          sourceCleanupToken: { present: true, value: 'cross-token-automation' },
          sourceCleanupRequiredHosters: { present: false, value: null },
          sourceCleanupCompletedHosters: { present: false, value: null },
          sourceCleanupFingerprint: { present: false, value: null }
        },
        statuses: ['preview', 'done', 'done'],
        result: { ok: false, error: 'Automatik ist pausiert' }
      }
    });
    assert.deepEqual(result.automationPipeline.partialAddOutcomes, {
      selectedConsistent: {
        result: { ok: true, added: 2 },
        statuses: ['queued', 'queued', 'skipped', 'queued'],
        unconfirmedRestored: [false, false],
        confirmedPrepared: [true, true]
      },
      selectedInconsistent: {
        result: { ok: false, error: 'Jobs konnten nicht eindeutig bestätigt werden.' },
        statuses: ['preview', 'queued', 'skipped', 'preview'],
        unconfirmedRestored: [true, true],
        confirmedPrepared: [true, true]
      },
      automation: {
        result: { ok: true, error: null, admitted: ['automation.mkv'] },
        statuses: {
          'doodstream.com': 'queued',
          'voe.sx': 'queued',
          'vidmoly.me': 'skipped',
          'byse.sx': 'queued'
        }
      },
      manual: {
        result: true,
        statuses: {
          'doodstream.com': 'queued',
          'voe.sx': 'queued',
          'vidmoly.me': 'skipped',
          'byse.sx': 'queued'
        }
      }
    });
    assert.deepEqual(result.automationPipeline.pauseBetweenApplyAndStart, {
      result: {
        ok: false,
        error: 'Automatik ist pausiert',
        warning: null,
        admitted: []
      },
      status: 'preview',
      queuedTelemetry: 0,
      startCalls: 0
    });
    assert.deepEqual(result.automationPipeline.startAcceptance, {
      accepted: {
        result: { ok: true },
        status: 'queued',
        uploading: true
      },
      unconfirmed: {
        result: { ok: false, error: 'Upload wurde nicht bestätigt.' },
        status: 'preview',
        uploading: false
      },
      exception: {
        result: { ok: false, error: 'Upload konnte nicht gestartet werden.' },
        status: 'preview',
        uploading: false
      }
    });
    assert.deepEqual(result.automationPipeline.fulfilledFeedback, {
      watcherWarning: {
        result: { ok: false, warning: 'Telemetrie konnte nicht gespeichert werden.', error: null },
        feedback: ['Telemetrie konnte nicht gespeichert werden.']
      },
      watcherError: {
        result: { ok: false, warning: null, error: 'Jobs konnten nicht hinzugefügt werden.' },
        feedback: ['Jobs konnten nicht hinzugefügt werden.']
      },
      modalWarning: {
        result: { ok: false, warning: 'Telemetrie konnte nicht gespeichert werden.', error: null },
        feedback: ['Telemetrie konnte nicht gespeichert werden.'],
        pending: 0,
        markers: 0,
        modalOpen: false,
        queueStatus: 'preview'
      },
      secretExposed: false
    });
    assert.deepEqual(result.automationPipeline.injectionOutcomes, {
      pausedInjection: {
        ok: false,
        error: 'Automatik ist pausiert',
        warning: null,
        admitted: [],
        status: 'preview',
        queuedTelemetry: 0,
        telemetrySaveAttempted: false
      },
      unconfirmedInjection: {
        ok: false,
        error: 'Jobs konnten nicht eindeutig bestätigt werden.',
        warning: null,
        admitted: [],
        status: 'preview',
        queuedTelemetry: 0,
        telemetrySaveAttempted: false
      },
      exceptionInjection: {
        ok: false,
        error: 'Jobs konnten nicht hinzugefügt werden.',
        warning: null,
        admitted: [],
        status: 'preview',
        queuedTelemetry: 0,
        telemetrySaveAttempted: false
      },
      telemetryFailure: {
        ok: false,
        error: null,
        warning: 'Telemetrie konnte nicht gespeichert werden.',
        admitted: ['telemetry.mkv'],
        status: 'queued',
        queuedTelemetry: 1,
        telemetrySaveAttempted: true
      },
      secretExposed: false
    });
    assert.deepEqual(result.automationPipeline.paused, {
      uploading: false,
      statuses: {
        'paused-preview.mkv': 'preview',
        'allowed-preview.mkv': 'preview'
      },
      automaticApplied: 0,
      startCalls: 0,
      injectCalls: 0
    });
    assert.deepEqual(result.onlineBackupBehavior.initialKeys, ['MHU2-ZYXW…9876', 'MHU2-ABCD…1234']);
    assert.deepEqual(result.onlineBackupBehavior.initialWarning, {
      hidden: false,
      text: 'Stored online backup key could not be decrypted'
    });
    assert.equal(result.onlineBackupBehavior.exactSanitizedState, true);
    assert.equal(result.onlineBackupBehavior.ariaDescriptions, true);
    assert.deepEqual(result.onlineBackupBehavior.afterDelete, {
      keys: ['MHU2-ABCD…1234'],
      status: 'Key deleted',
      statusState: 'success',
      warning: 'Stored online backup key could not be decrypted',
      retryVisible: true,
      focusAction: 'delete',
      focusId: 'AAAAAAAAAAAAAAAAAAAAAA'
    });
    assert.deepEqual(result.onlineBackupBehavior.refreshFailure, {
      keys: ['MHU2-QWER…4321', 'MHU2-ABCD…1234'],
      status: 'New key created.',
      statusState: 'success',
      warning: 'Stored online backup key could not be decrypted',
      retryVisible: true
    });
    assert.deepEqual(result.onlineBackupBehavior.createSuccessToasts, []);
    assert.equal(result.onlineBackupBehavior.retryTriggeredLoad, true);
    assert.deepEqual(result.onlineBackupBehavior.afterRetry, {
      keys: ['MHU2-QWER…4321', 'MHU2-ABCD…1234'],
      warningHidden: true
    });
    assert.equal(result.onlineBackupBehavior.copyFocusRestored, true);
    assert.deepEqual(result.onlineBackupBehavior.raceResult, {
      keys: ['MHU2-AUTH…9999', 'MHU2-DFGH…2468', 'MHU2-ABCD…1234'],
      status: 'New key created.',
      statusState: 'success',
      warningHidden: true
    });
    assert.deepEqual(result.onlineBackupBehavior.hardCorruption, {
      emptyStateVisible: false,
      rowCount: 0,
      warning: 'Stored online backup ID does not match its key',
      retryVisible: true
    });
    assert.deepEqual(result.onlineBackupBehavior.confirmation, {
      title: 'Online-Backup löschen',
      message: 'Dieses verschlüsselte Online-Backup wird dauerhaft vom Server gelöscht.',
      confirmText: 'Löschen',
      danger: true
    });
    assert.deepEqual(result.onlineBackupBehavior.calls, [
      ['list', 1],
      ['delete', 'AQEBAQEBAQEBAQEBAQEBAQ'],
      ['list', 2],
      ['create', 1],
      ['list', 3],
      ['list', 4],
      ['create', 2],
      ['list', 5],
      ['copy', 'AAAAAAAAAAAAAAAAAAAAAA'],
      ['list', 6]
    ]);
    assert.equal(result.onlineBackupBehavior.secretInBody, false);
    assert.ok(Math.abs(result.onlineBackupLayout.german.createRight - result.onlineBackupLayout.german.contentRight) <= 1);
    assert.ok(Math.abs(result.onlineBackupLayout.english.createRight - result.onlineBackupLayout.english.contentRight) <= 1);
    for (const layout of [result.onlineBackupLayout.german, result.onlineBackupLayout.english]) {
      assert.equal(layout.rows.length, 2);
      assert.ok(Math.abs(layout.rows[0].keyLeft - layout.rows[1].keyLeft) <= 1);
      assert.ok(Math.abs(layout.rows[0].createdLeft - layout.rows[1].createdLeft) <= 1);
      assert.ok(Math.abs(layout.rows[0].actionsRight - layout.rows[1].actionsRight) <= 1);
    }
    assert.ok(Math.abs(result.onlineBackupLayout.german.rows[0].keyLeft - result.onlineBackupLayout.english.rows[0].keyLeft) <= 1);
    assert.ok(Math.abs(result.onlineBackupLayout.german.rows[0].createdLeft - result.onlineBackupLayout.english.rows[0].createdLeft) <= 1);
    assert.ok(Math.abs(result.onlineBackupLayout.german.rows[0].actionsRight - result.onlineBackupLayout.english.rows[0].actionsRight) <= 1);
    assert.equal(result.onlineBackupNarrowLayout.horizontalOverflow, false);
    assert.equal(result.onlineBackupNarrowLayout.rowOverflow, false);
    assert.equal(result.onlineBackupNarrowLayout.stacked, true);
    assert.equal(result.onlineBackupNarrowLayout.actionsStretched, true);
    assert.equal(result.onlineBackupNarrowLayout.createStretched, true);
  } finally {
    fs.rmSync(probeRoot, { recursive: true, force: true });
  }
});

test('Windows DPAPI key management composes through hidden real IPC and local transport', { skip: process.platform !== 'win32' }, () => {
  const projectRoot = path.join(__dirname, '..');
  const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mhu-dpapi-ipc-'));
  const probePath = path.join(probeRoot, 'probe.cjs');
  const preloadPath = path.join(probeRoot, 'preload.cjs');
  const rendererPath = path.join(probeRoot, 'renderer.html');
  const outputPath = path.join(probeRoot, 'result.json');
  const userDataPath = path.join(probeRoot, 'user-data');
  const serverDataPath = path.join(probeRoot, 'server-data');
  fs.writeFileSync(preloadPath, `
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('managedBackup', {
  list: () => ipcRenderer.invoke('online-backup:list-managed'),
  create: () => ipcRenderer.invoke('online-backup:create-managed'),
  copy: id => ipcRenderer.invoke('online-backup:copy-managed', id),
  delete: id => ipcRenderer.invoke('online-backup:delete-managed', id)
});
`, 'utf8');
  fs.writeFileSync(rendererPath, `<!doctype html><html><body><script>
(async () => {
  const created = await window.managedBackup.create();
  const listed = await window.managedBackup.list();
  const id = listed.entries[0].id;
  const copied = await window.managedBackup.copy(id);
  const deleted = await window.managedBackup.delete(id);
  const after = await window.managedBackup.list();
  window.__managedBackupResult = { created, listed, copied, deleted, after, id };
})().catch(error => { window.__managedBackupResult = { error: error.message || String(error) }; });
</script></body></html>`, 'utf8');
  const probeSource = `
const { app, BrowserWindow, clipboard, ipcMain, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createOnlineBackupKeyring } = require(${JSON.stringify(path.join(projectRoot, 'lib', 'online-backup-keyring.js'))});
const { createOnlineBackupManager } = require(${JSON.stringify(path.join(projectRoot, 'lib', 'online-backup-manager.js'))});
const { deleteOnlineBackup, parseOnlineBackupKey, uploadOnlineBackup } = require(${JSON.stringify(path.join(projectRoot, 'lib', 'online-backup.js'))});
const secretStore = require(${JSON.stringify(path.join(projectRoot, 'lib', 'secret-store.js'))});
const outputPath = process.env.MHU_DPAPI_OUTPUT;
const userDataPath = process.env.MHU_DPAPI_USER_DATA;
const serverDataPath = process.env.MHU_DPAPI_SERVER_DATA;
const rendererPath = process.env.MHU_DPAPI_RENDERER;
const preloadPath = process.env.MHU_DPAPI_PRELOAD;
const serverModulePath = process.env.MHU_DPAPI_SERVER_MODULE;
app.setPath('userData', userDataPath);
let server = null;
let window = null;
let interceptedClipboard = '';
let interceptedClipboardWrites = 0;
const originalClipboardWriteText = clipboard.writeText;
clipboard.writeText = value => {
  interceptedClipboard = value;
  interceptedClipboardWrites++;
};
const logs = [];
const originalConsole = { log: console.log, warn: console.warn, error: console.error };
for (const method of Object.keys(originalConsole)) console[method] = (...values) => { logs.push(values.map(String).join(' ')); };
function canonicalId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(value)) return false;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.length === 16 && decoded.toString('base64url') === value;
}
function trusted(event) {
  return Boolean(window && !window.isDestroyed() && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame);
}
function requireId(value) {
  if (!canonicalId(value)) throw new Error('invalid id');
  return value;
}
async function closeServer() {
  if (!server) return;
  await new Promise(resolve => server.close(resolve));
  server = null;
}
app.whenReady().then(async () => {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('safeStorage unavailable');
  const { createBackupServer } = await import(pathToFileURL(serverModulePath).href);
  fs.mkdirSync(serverDataPath, { recursive: true });
  server = createBackupServer({
    rootDir: serverDataPath,
    allowedOrigins: [],
    rateLimit: { max: 100, windowMs: 60000 },
    uploadRateLimit: { max: 100, windowMs: 60000 },
    requestRateLimit: { max: 100, windowMs: 60000 }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  const keyringPath = path.join(userDataPath, 'online-backup-keys.json');
  const keyring = createOnlineBackupKeyring({ filePath: keyringPath });
  const transport = [];
  let fullKey = '';
  let diskBeforeDelete = '';
  let clipboardMatched = false;
  let serverRecordBeforeDelete = false;
  const manager = createOnlineBackupManager({
    keyring,
    loadSettings: async () => ({ globalSettings: { language: 'de' }, hosters: {}, hosterSettings: {} }),
    appVersion: () => '2.1.31',
    uploadBackup: async record => {
      transport.push({ operation: 'upload', id: record.id });
      return uploadOnlineBackup(record, baseUrl);
    },
    deleteBackup: async value => {
      const parsed = parseOnlineBackupKey(value);
      transport.push({ operation: 'delete', id: parsed.id });
      return deleteOnlineBackup(value, baseUrl);
    },
    copyText: value => clipboard.writeText(value)
  });
  ipcMain.handle('online-backup:list-managed', event => trusted(event) ? manager.listManaged() : { ok: false, error: 'rejected' });
  ipcMain.handle('online-backup:create-managed', async event => {
    if (!trusted(event)) return { ok: false, error: 'rejected' };
    const result = await manager.createManaged();
    if (result.ok) {
      fullKey = await keyring.getKey(result.entry.id);
      diskBeforeDelete = fs.readFileSync(keyringPath, 'utf8');
      serverRecordBeforeDelete = fs.existsSync(path.join(serverDataPath, result.entry.id + '.json'));
    }
    return result;
  });
  ipcMain.handle('online-backup:copy-managed', async (event, id) => {
    if (!trusted(event)) return { ok: false, error: 'rejected' };
    const result = await manager.copyManaged(requireId(id));
    clipboardMatched = interceptedClipboard === fullKey && interceptedClipboardWrites === 1;
    return result;
  });
  ipcMain.handle('online-backup:delete-managed', (event, id) => trusted(event) ? manager.deleteManaged(requireId(id)) : { ok: false, error: 'rejected' });
  window = new BrowserWindow({
    show: false,
    width: 640,
    height: 480,
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: preloadPath }
  });
  await window.loadFile(rendererPath);
  let rendererResult = null;
  for (let attempt = 0; attempt < 200; attempt++) {
    rendererResult = await window.webContents.executeJavaScript('window.__managedBackupResult || null');
    if (rendererResult) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  if (!rendererResult || rendererResult.error) throw new Error(rendererResult?.error || 'renderer timed out');
  const stored = JSON.parse(diskBeforeDelete);
  const encryptedKey = stored.keys[0].encryptedKey;
  const ipcJson = JSON.stringify(rendererResult);
  const afterDocument = JSON.parse(fs.readFileSync(keyringPath, 'utf8'));
  const remainingServerRecords = fs.readdirSync(serverDataPath).filter(name => name.endsWith('.json'));
  const result = {
    platform: process.platform,
    safeStorageAvailable: safeStorage.isEncryptionAvailable(),
    hidden: window.isVisible() === false,
    canonicalId: canonicalId(rendererResult.id),
    createOk: rendererResult.created.ok === true,
    copyOk: rendererResult.copied.ok === true,
    deleteOk: rendererResult.deleted.ok === true,
    afterEmpty: rendererResult.after.ok === true && rendererResult.after.entries.length === 0,
    diskUsesKeysSchema: Array.isArray(stored.keys) && !Object.hasOwn(stored, 'entries'),
    diskHadCiphertext: secretStore.isEncrypted(encryptedKey) && encryptedKey !== fullKey && !diskBeforeDelete.includes(fullKey),
    dpapiRoundTrip: safeStorage.decryptString(Buffer.from(encryptedKey.slice('enc:v1:'.length), 'base64')) === fullKey,
    rendererSecretAbsent: !ipcJson.includes(fullKey) && !/MHU2-[A-Za-z0-9_-]{70}/.test(ipcJson),
    logSecretAbsent: logs.every(line => !line.includes(fullKey)) && !logs.join(' ').match(/MHU2-[A-Za-z0-9_-]{70}/),
    clipboardMatched,
    interceptedClipboardWrites,
    serverRecordBeforeDelete,
    serverEmptyAfterDelete: remainingServerRecords.length === 0,
    keyringEmptyAfterDelete: afterDocument.keys.length === 0,
    transport
  };
  fs.writeFileSync(outputPath, JSON.stringify(result), 'utf8');
}).catch(error => {
  fs.writeFileSync(outputPath, JSON.stringify({ error: error.stack || String(error) }), 'utf8');
  process.exitCode = 1;
}).finally(async () => {
  clipboard.writeText = originalClipboardWriteText;
  for (const channel of ['online-backup:list-managed', 'online-backup:create-managed', 'online-backup:copy-managed', 'online-backup:delete-managed']) ipcMain.removeHandler(channel);
  if (window && !window.isDestroyed()) window.destroy();
  await closeServer();
  for (const [method, value] of Object.entries(originalConsole)) console[method] = value;
  app.exit(process.exitCode || 0);
});
`;
  fs.writeFileSync(probePath, probeSource, 'utf8');
  try {
    const electronPath = path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
    const probeEnvironment = {
      ...process.env,
      MHU_DPAPI_OUTPUT: outputPath,
      MHU_DPAPI_USER_DATA: userDataPath,
      MHU_DPAPI_SERVER_DATA: serverDataPath,
      MHU_DPAPI_RENDERER: rendererPath,
      MHU_DPAPI_PRELOAD: preloadPath,
      MHU_DPAPI_SERVER_MODULE: path.join(projectRoot, 'services', 'backup-api', 'src', 'server.mjs')
    };
    delete probeEnvironment.RUN_UI_SMOKE;
    const execution = spawnSync(electronPath, [probePath, `--user-data-dir=${userDataPath}`], {
      cwd: projectRoot,
      env: probeEnvironment,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000
    });
    assert.equal(execution.status, 0, `${execution.stdout}\n${execution.stderr}`);
    const result = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    assert.equal(result.error, undefined);
    assert.deepEqual(result, {
      platform: 'win32',
      safeStorageAvailable: true,
      hidden: true,
      canonicalId: true,
      createOk: true,
      copyOk: true,
      deleteOk: true,
      afterEmpty: true,
      diskUsesKeysSchema: true,
      diskHadCiphertext: true,
      dpapiRoundTrip: true,
      rendererSecretAbsent: true,
      logSecretAbsent: true,
      clipboardMatched: true,
      interceptedClipboardWrites: 1,
      serverRecordBeforeDelete: true,
      serverEmptyAfterDelete: true,
      keyringEmptyAfterDelete: true,
      transport: [
        { operation: 'upload', id: result.transport[0].id },
        { operation: 'delete', id: result.transport[0].id }
      ]
    });
    assert.match(result.transport[0].id, /^[A-Za-z0-9_-]{22}$/u);
    assert.doesNotMatch(`${execution.stdout}\n${execution.stderr}\n${fs.readFileSync(outputPath, 'utf8')}`, /MHU2-[A-Za-z0-9_-]{70}/u);
  } finally {
    fs.rmSync(probeRoot, { recursive: true, force: true });
    assert.equal(fs.existsSync(probeRoot), false);
  }
});

test('persisted automation pause rejects batch starts through hidden real IPC', { skip: process.platform !== 'win32' }, () => {
  const projectRoot = path.join(__dirname, '..');
  const mainSource = fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8');
  const startUploadStart = mainSource.indexOf("ipcMain.handle('start-upload'");
  const startUploadEnd = mainSource.indexOf('\n// Logged at batch boundaries', startUploadStart);
  const addJobsStart = mainSource.indexOf("ipcMain.handle('add-jobs-to-batch'");
  const addJobsEnd = mainSource.indexOf("\nipcMain.handle('finish-after-active'", addJobsStart);
  assert.notEqual(startUploadStart, -1);
  assert.notEqual(startUploadEnd, -1);
  assert.notEqual(addJobsStart, -1);
  assert.notEqual(addJobsEnd, -1);
  const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mhu-automation-pause-ipc-'));
  const probePath = path.join(probeRoot, 'probe.cjs');
  const preloadPath = path.join(probeRoot, 'preload.cjs');
  const rendererPath = path.join(probeRoot, 'renderer.html');
  const outputPath = path.join(probeRoot, 'result.json');
  const userDataPath = path.join(probeRoot, 'user-data');
  fs.writeFileSync(preloadPath, `
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('automationProbe', {
  start: () => ipcRenderer.invoke('start-upload', { files: [], hosters: [], jobs: [] }),
  extend: () => ipcRenderer.invoke('add-jobs-to-batch', { jobs: [], sourceCleanupGroups: [] })
});
`, 'utf8');
  fs.writeFileSync(rendererPath, `<!doctype html><html><body><script>
(async () => {
  const start = await window.automationProbe.start();
  const extend = await window.automationProbe.extend();
  window.__automationPauseResult = { start, extend };
})().catch(error => { window.__automationPauseResult = { error: error.message || String(error) }; });
</script></body></html>`, 'utf8');
  const productionHandlers = `${mainSource.slice(startUploadStart, startUploadEnd)}\n${mainSource.slice(addJobsStart, addJobsEnd)}`;
  const probeSource = `
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const ConfigStore = require(${JSON.stringify(path.join(projectRoot, 'lib', 'config-store.js'))});
const outputPath = process.env.MHU_AUTOMATION_OUTPUT;
const rendererPath = process.env.MHU_AUTOMATION_RENDERER;
const preloadPath = process.env.MHU_AUTOMATION_PRELOAD;
app.setPath('userData', process.env.MHU_AUTOMATION_USER_DATA);
const configStore = new ConfigStore(app);
let closeFlushRequested = false;
const settingsImportGate = { canStartUpload: () => true };
let uploadManager = { running: false };
${productionHandlers}
app.whenReady().then(async () => {
  const current = configStore.load();
  await configStore.save({
    globalSettings: {
      ...current.globalSettings,
      folderMonitor: { ...current.globalSettings.folderMonitor, paused: true, pausedAt: Date.now() }
    }
  });
  const window = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: preloadPath }
  });
  await window.loadFile(rendererPath);
  let result = null;
  for (let attempt = 0; attempt < 200; attempt++) {
    result = await window.webContents.executeJavaScript('window.__automationPauseResult || null');
    if (result) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  fs.writeFileSync(outputPath, JSON.stringify({ hidden: window.isVisible() === false, result }), 'utf8');
  window.destroy();
  app.exit(0);
}).catch(error => {
  fs.writeFileSync(outputPath, JSON.stringify({ error: error.stack || String(error) }), 'utf8');
  app.exit(1);
});
`;
  fs.writeFileSync(probePath, probeSource, 'utf8');
  try {
    const electronPath = path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
    const execution = spawnSync(electronPath, [probePath, `--user-data-dir=${userDataPath}`], {
      cwd: projectRoot,
      env: {
        ...process.env,
        MHU_AUTOMATION_OUTPUT: outputPath,
        MHU_AUTOMATION_RENDERER: rendererPath,
        MHU_AUTOMATION_PRELOAD: preloadPath,
        MHU_AUTOMATION_USER_DATA: userDataPath
      },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000
    });
    assert.equal(execution.status, 0, `${execution.stdout}\n${execution.stderr}`);
    const outcome = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    assert.equal(outcome.error, undefined);
    assert.deepEqual(outcome, {
      hidden: true,
      result: {
        start: { error: 'Automatik ist pausiert' },
        extend: { error: 'Automatik ist pausiert' }
      }
    });
  } finally {
    fs.rmSync(probeRoot, { recursive: true, force: true });
  }
});

test('resolveStartupLanguage accepts only the supported persisted language', () => {
  assert.equal(resolveStartupLanguage({ globalSettings: { language: 'de' } }), 'de');
  assert.equal(resolveStartupLanguage({ globalSettings: { language: 'en' } }), 'en');
  assert.equal(resolveStartupLanguage({ globalSettings: { language: 'fr' } }), 'en');
  assert.equal(resolveStartupLanguage(null), 'en');
});

test('startup query carries language and installed version into the first renderer frame', () => {
  assert.deepEqual(createStartupQuery({ globalSettings: { language: 'de' } }, '2.1.25'), {
    language: 'de',
    version: '2.1.25'
  });
  assert.deepEqual(createStartupQuery(null, 'invalid'), { language: 'en', version: '' });
});

test('createStartupWindow forces the main window to start hidden', () => {
  const startup = createStartupWindow(TestBrowserWindow, { width: 1100, show: true });

  assert.equal(startup.window.options.width, 1100);
  assert.equal(startup.window.options.show, false);
});

test('main window uses the branded application icon', () => {
  const projectRoot = path.join(__dirname, '..');
  const mainSource = fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8');
  const createWindowStart = mainSource.indexOf('function createWindow()');
  const createWindowEnd = mainSource.indexOf('\nfunction createTray()', createWindowStart);
  const createWindowSource = mainSource.slice(createWindowStart, createWindowEnd);

  assert.equal(fs.existsSync(path.join(projectRoot, 'assets', 'app_icon.ico')), true);
  assert.match(createWindowSource, /icon:\s*path\.join\(__dirname, ['"]assets['"], ['"]app_icon\.ico['"]\)/u);
});

test('startup load registers visibility before navigation and shows only once', async () => {
  const startup = createStartupWindow(TestBrowserWindow, {});
  startup.window.loadError = null;
  const loading = startup.load('renderer/index.html', () => {});

  assert.deepEqual(startup.window.startupEvents, [
    'listen:ready-to-show',
    'load:renderer/index.html'
  ]);

  startup.window.emit('ready-to-show');
  assert.equal(startup.window.showCalls, 0);
  startup.window.webContents.emit('did-finish-load');
  startup.window.emit('ready-to-show');
  startup.window.webContents.emit('did-finish-load');
  await loading;

  assert.equal(startup.window.showCalls, 1);
});

test('startup waits for native paint readiness when renderer loading finishes first', () => {
  const startup = createStartupWindow(TestBrowserWindow, {});

  startup.window.webContents.emit('did-finish-load');
  assert.equal(startup.window.showCalls, 0);
  startup.window.emit('ready-to-show');
  assert.equal(startup.window.showCalls, 1);
});

test('startup load forwards a rejected navigation to the error handler', async () => {
  const startup = createStartupWindow(TestBrowserWindow, {});
  let handledError;

  await startup.load('renderer/index.html', (err) => {
    handledError = err;
  });

  assert.equal(handledError, startup.window.loadError);
});

test('startup load forwards navigation options before the renderer becomes visible', async () => {
  const startup = createStartupWindow(TestBrowserWindow, {});
  const options = { query: { language: 'de' } };

  await startup.load('renderer/index.html', () => {}, options);

  assert.deepEqual(startup.window.loadOptions, options);
});

test('desktop drag and drop is accepted before asynchronous renderer initialization', () => {
  const projectRoot = path.join(__dirname, '..');
  const appSource = fs.readFileSync(path.join(projectRoot, 'renderer', 'app.js'), 'utf8');
  const earlyBinding = appSource.lastIndexOf('\nsetupDragDrop();');
  const initialization = appSource.lastIndexOf('\ninit().then(');

  assert.notEqual(earlyBinding, -1);
  assert.notEqual(initialization, -1);
  assert.ok(earlyBinding < initialization);
  assert.match(appSource, /dataTransfer\.dropEffect\s*=\s*['"]copy['"]/u);
});

test('upload sidebar renders and updates the remaining upload size', () => {
  const projectRoot = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(projectRoot, 'renderer', 'index.html'), 'utf8');
  const appSource = fs.readFileSync(path.join(projectRoot, 'renderer', 'app.js'), 'utf8');

  assert.match(html, /Verbleibende Größe[\s\S]*id="uploadTelemetryRemainingSize"[^>]*>0 B</u);
  assert.match(appSource, /_setUploadTelemetryText\(['"]uploadTelemetryRemainingSize['"],\s*formatBytes\(stats\.bytesRemaining\)\)/u);
});

test('header occupies its final geometry before asynchronous initialization', () => {
  const projectRoot = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(projectRoot, 'renderer', 'index.html'), 'utf8');
  const appSource = fs.readFileSync(path.join(projectRoot, 'renderer', 'app.js'), 'utf8');
  const mainSource = fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8');
  const css = fs.readFileSync(path.join(projectRoot, 'renderer', 'styles.css'), 'utf8');
  const updateButton = html.match(/<button class="header-update-button"[^>]*id="headerUpdateBtn"[^>]*>/u)?.[0] || '';
  const updateSlotIndex = html.indexOf('class="header-update-slot"');
  const speedWidgetIndex = html.indexOf('id="uploadSpeedSparkline"');
  const firstFrameInitialization = appSource.lastIndexOf('\ninitializeStaticHeader();');
  const asynchronousInitialization = appSource.lastIndexOf('\ninit().then(');

  assert.doesNotMatch(updateButton, /\shidden(?:\s|>)/u);
  assert.doesNotMatch(updateButton, /\stitle=/u);
  assert.ok(updateSlotIndex >= 0 && updateSlotIndex < speedWidgetIndex);
  assert.match(css, /\.header-update-slot\s*\{[^}]*width:\s*0;[^}]*flex:\s*0 0 0;[^}]*overflow:\s*hidden;/su);
  assert.match(css, /\.header-update-slot\.is-visible\s*\{[^}]*width:\s*146px;[^}]*flex-basis:\s*146px;/su);
  assert.match(css, /\.header-update-slot\.is-visible\s+\.header-update-button\s*\{[^}]*opacity:\s*1;[^}]*transform:\s*translateX\(0\);/su);
  assert.match(css, /\.version-badge\s*\{[^}]*min-width:\s*48px;/su);
  assert.notEqual(firstFrameInitialization, -1);
  assert.ok(firstFrameInitialization < asynchronousInitialization);
  assert.match(mainSource, /createStartupQuery\([^,]+,\s*app\.getVersion\(\)\)/u);
  assert.doesNotMatch(mainSource, /runAutomaticUpdateCheck\(true\);\s*\},\s*3000\)/u);
  assert.match(html, /class="upload-speed-baseline"/u);
  assert.match(css, /\.upload-speed-baseline\s*\{[^}]*background:\s*var\(--success\);/su);
  assert.match(css, /\.header-update-button\.update-available\s*\{[^}]*background:\s*var\(--success\);[^}]*color:\s*#000;/su);
  assert.match(css, /\.header-update-button\.update-available:hover\s*\{[^}]*background:\s*var\(--success-end\);[^}]*color:\s*#000;/su);
  assert.match(css, /\.update-dialog\s*\{[^}]*width:\s*min\(576px,\s*100%\);/su);
  assert.match(css, /\.update-release-notes\s*\{[^}]*height:\s*min\(264px,\s*48vh\);/su);
  assert.match(html, /class="update-progress-footer"[\s\S]*id="updateProgressDetails"[\s\S]*id="updateProgressSize"[\s\S]*id="updateProgressSpeed"[\s\S]*id="updateProgressEta"[\s\S]*id="updateProgressText"/u);
  assert.match(html, /id="queueFilterResetBtn"[^>]*disabled[^>]*>Filter zurücksetzen</u);
  assert.match(html, /class="queue-filter-summary"[\s\S]*id="queueActiveFilterCount"[^>]*>0</u);
  assert.match(html, /data-action="copy-failure-details"[^>]*style="display:none"[^>]*>Fehlerdetails kopieren</u);
  assert.doesNotMatch(html, /<\/div>\s*<div class="queue-filter-bar"/u);
  assert.match(css, /\.queue-filter-bar\s*\{[^}]*display:\s*flex;[^}]*margin-left:\s*auto;[^}]*border:\s*1px solid var\(--border\);[^}]*border-radius:\s*7px;/su);
  assert.match(css, /#updateProgressDetails\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*19ch 2ch 11ch 2ch 10ch;[^}]*column-gap:\s*0;[^}]*font-variant-numeric:\s*tabular-nums;/su);
  assert.match(css, /\.update-progress-separator\s*\{[^}]*display:\s*grid;[^}]*place-items:\s*center;/su);
  assert.match(css, /#updateProgressSpeed\s*\{[^}]*text-align:\s*right;/su);
  assert.match(css, /#updateProgressEta\s*\{[^}]*text-align:\s*left;/su);
  assert.match(css, /\.update-release-heading\s*\{[^}]*color:\s*var\(--success\);[^}]*font-size:\s*14px;[^}]*font-weight:\s*750;/su);
  assert.match(css, /\.update-release-category\s*\{[^}]*font-size:\s*13px;[^}]*font-weight:\s*700;/su);
  assert.match(css, /#updateProgressDetails\[hidden\]\s*\{[^}]*display:\s*none;/su);
});
