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

test('Windows compositor paints the full hidden surface with an RDP session environment', { skip: process.platform !== 'win32' }, (t) => {
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
const automationStatusListeners = [];
let pendingAutomationTestScan = null;
let automationProbe = {
  history: [],
  uploadLog: [],
  paused: false,
  runtimeStatus: {},
  automationStatusSequence: [],
  historyError: '',
  addResult: null,
  addMode: '',
  addError: '',
  startResult: null,
  startError: '',
  saveSettingsError: '',
  testScanError: '',
  deferTestScan: false,
  deferInspect: false,
  activeInspections: 0,
  maxConcurrentInspections: 0,
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
    pendingAutomationTestScan = null;
    automationProbe = {
      history: Array.isArray(value.history) ? value.history : [],
      uploadLog: Array.isArray(value.uploadLog) ? value.uploadLog : [],
      paused: value.paused === true,
      runtimeStatus: value.runtimeStatus && typeof value.runtimeStatus === 'object' ? { ...value.runtimeStatus } : {},
      automationStatusSequence: Array.isArray(value.automationStatusSequence) ? value.automationStatusSequence.map(entry => ({ ...entry })) : [],
      historyError: String(value.historyError || ''),
      addResult: value.addResult || null,
      addMode: String(value.addMode || ''),
      addError: String(value.addError || ''),
      startResult: value.startResult || null,
      startError: String(value.startError || ''),
      saveSettingsError: String(value.saveSettingsError || ''),
      testScanError: String(value.testScanError || ''),
      deferTestScan: value.deferTestScan === true,
      deferInspect: value.deferInspect === true,
      activeInspections: 0,
      maxConcurrentInspections: 0,
      dryScan: value.dryScan || { files: [], reachable: true, trigger: 'test' },
      readCalls: { history: 0, uploadLog: 0, inspect: 0, status: 0, testScan: 0, reconcile: 0 },
      mutationCalls: [],
      logs: [],
      savedSettings: []
    };
  },
  setAutomationEvidence(value = {}) {
    if (Array.isArray(value.history)) automationProbe.history = value.history;
    if (Array.isArray(value.uploadLog)) automationProbe.uploadLog = value.uploadLog;
  },
  getAutomationProbeState() {
    return {
      readCalls: { ...automationProbe.readCalls },
      activeInspections: automationProbe.activeInspections,
      maxConcurrentInspections: automationProbe.maxConcurrentInspections,
      mutationCalls: automationProbe.mutationCalls.map(value => [...value]),
      logs: [...automationProbe.logs],
      savedSettings: automationProbe.savedSettings.map(value => JSON.parse(JSON.stringify(value)))
    };
  },
  async inspectImportFiles(entries, existingPaths) {
    automationProbe.readCalls.inspect++;
    automationProbe.activeInspections++;
    automationProbe.maxConcurrentInspections = Math.max(automationProbe.maxConcurrentInspections, automationProbe.activeInspections);
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
    if (automationProbe.deferInspect) await new Promise(resolve => setTimeout(resolve, 5));
    automationProbe.activeInspections--;
    return {
      candidateCount: candidates.length,
      duplicateCount: duplicates.length,
      unavailableCount: unavailable.length,
      acceptedCount: accepted.length,
      accepted,
      duplicates,
      unavailable
    };
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
    return Promise.resolve({ ...automationProbe.runtimeStatus, paused: automationProbe.paused });
  },
  automationPauseAfterActive() {
    automationProbe.mutationCalls.push(['pause']);
    automationProbe.paused = true;
    return Promise.resolve({ ...automationProbe.runtimeStatus, paused: true, pausedAt: 1787712000000 });
  },
  automationResume() {
    automationProbe.mutationCalls.push(['resume']);
    automationProbe.paused = false;
    return Promise.resolve({ ...automationProbe.runtimeStatus, paused: false, pausedAt: null });
  },
  onAutomationStatus(listener) {
    automationStatusListeners.push(listener);
    return () => {
      const index = automationStatusListeners.indexOf(listener);
      if (index >= 0) automationStatusListeners.splice(index, 1);
    };
  },
  emitAutomationStatus(status) {
    automationStatusListeners.forEach(listener => listener({ ...status }));
  },
  folderMonitorTestScan() {
    automationProbe.readCalls.testScan++;
    if (automationProbe.testScanError) return Promise.reject(new Error(automationProbe.testScanError));
    if (automationProbe.deferTestScan) {
      return new Promise(resolve => { pendingAutomationTestScan = resolve; });
    }
    return Promise.resolve(automationProbe.dryScan);
  },
  releaseAutomationTestScan() {
    const resolve = pendingAutomationTestScan;
    pendingAutomationTestScan = null;
    if (resolve) resolve(automationProbe.dryScan);
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
    automationProbe.mutationCalls.push([
      'inject',
      payload?.jobs?.length || 0,
      (payload?.jobs || []).map(job => job.id),
      (payload?.jobs || []).map(job => ({
        id: job.id,
        requiredHosters: [...(job.sourceCleanupRequiredHosters || [])]
      })),
      (payload?.sourceCleanupGroups || []).map(group => ({
        requiredHosters: [...(group.requiredHosters || [])],
        jobIds: (group.jobs || []).map(job => job.jobId)
      }))
    ]);
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
    automationProbe.mutationCalls.push(['start', payload?.jobs?.length || 0, (payload?.jobs || []).map(job => job.id)]);
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
    _completedUploadKeys.clear();
    const completedFile = { path: 'C:\\history\\completed-in-session.mkv', name: 'completed-in-session.mkv', size: 1 };
    config.globalSettings.removeFromQueueOnDone = true;
    config.globalSettings.folderMonitor = {
      enabled: true,
      folderPath: 'C:\\history',
      hosters: ['doodstream.com'],
      autoStart: false,
      queueLimitJobs: 15000,
      paused: false
    };
    const completedJob = {
      id: 'completed-in-session',
      file: completedFile.path,
      fileName: completedFile.name,
      hoster: 'doodstream.com',
      status: 'queued',
      bytesTotal: 1,
      automationAdmission: true
    };
    queueJobs = [completedJob];
    selectedFiles = [];
    uploading = false;
    rebuildJobIndex();
    window.api.configureAutomationProbe({ paused: false, history: [], uploadLog: [] });
    handleProgress({
      jobId: completedJob.id,
      fileName: completedJob.fileName,
      hoster: completedJob.hoster,
      status: 'done',
      bytesUploaded: 1,
      bytesTotal: 1,
      progress: 1,
      result: { download_url: 'https://doodstream.com/d/completed-in-session' }
    });
    _doneRemovalCoalescer?.drainSync();
    automationEvidenceSnapshotGeneration++;
    automationEvidenceSnapshotCache = null;
    const removedAfterDone = !queueJobs.some(job => job.id === completedJob.id);
    const completedKeyPresent = _completedUploadKeys.has(completedFile.path + '|doodstream.com');
    const completedResult = await handleFolderMonitorFiles([completedFile]);
    const completedProbe = await window.api.getAutomationProbeState();
    const completedEvidence = {
      removedAfterDone,
      completedKeyPresent,
      admittedFiles: completedResult.admittedFiles.length,
      matchingQueueJobs: queueJobs.filter(job => normalizeAutomationPath(job.file) === normalizeAutomationPath(completedFile.path)).length,
      startOrInjectCalls: completedProbe.mutationCalls.filter(call => call[0] === 'start' || call[0] === 'inject').length
    };
    _completedUploadKeys.clear();
    config.globalSettings.removeFromQueueOnDone = false;
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
    configureAtomicState(0);
    config.globalSettings.folderMonitor.hosters = ['doodstream.com'];
    hosterSettings = {};
    const parallelFile = { path: 'C:\\\\watch\\\\parallel.mkv', name: 'parallel.mkv', size: 1, mtimeMs: 1 };
    const parallelResults = await Promise.all([
      handleFolderMonitorFiles([parallelFile, { ...parallelFile, path: 'c:\\\\WATCH\\\\parallel.mkv' }]),
      handleFolderMonitorFiles([{ ...parallelFile }]),
      handleFolderMonitorFiles([{ ...parallelFile, path: 'C:\\\\watch\\\\PARALLEL.mkv' }])
    ]);
    const parallelAdmission = {
      admittedFiles: [...new Set(parallelResults.flatMap(result => result.admittedFiles.map(file => file.name)))],
      matchingJobs: queueJobs.filter(job => normalizeAutomationPath(job.file) === normalizeAutomationPath(parallelFile.path)).length,
      matchingPaths: [...new Set(queueJobs
        .filter(job => normalizeAutomationPath(job.file) === normalizeAutomationPath(parallelFile.path))
        .map(job => normalizeAutomationPath(job.file)))],
      queuedTelemetry: config.globalSettings.folderMonitor.telemetry.queued
    };
    configureAtomicState(0);
    config.globalSettings.folderMonitor.hosters = ['doodstream.com'];
    hosterSettings = {};
    handleBatchDone({ files: [] });
    const evidenceSnapshotFiles = Array.from({ length: 66 }, (_, index) => ({
      path: 'C:\\\\evidence-snapshot\\\\file-' + String(index).padStart(2, '0') + '.mkv',
      name: 'file-' + String(index).padStart(2, '0') + '.mkv',
      size: 1,
      mtimeMs: index
    }));
    await handleFolderMonitorFiles(evidenceSnapshotFiles);
    const evidenceSnapshotProbe = await window.api.getAutomationProbeState();
    const evidenceSnapshotDrain = {
      historyCalls: evidenceSnapshotProbe.readCalls.history,
      uploadLogCalls: evidenceSnapshotProbe.readCalls.uploadLog,
      inspectCalls: evidenceSnapshotProbe.readCalls.inspect,
      batchSizes: evidenceSnapshotProbe.logs
        .filter(message => message.startsWith('folder-monitor: received '))
        .map(message => Number(message.split(' ')[2] || 0)),
      queuedFiles: new Set(queueJobs.filter(job => job.file.startsWith('C:\\\\evidence-snapshot\\\\')).map(job => job.file)).size
    };
    configureAtomicState(0);
    config.globalSettings.folderMonitor.hosters = ['doodstream.com'];
    hosterSettings = {};
    handleBatchDone({ files: [] });
    const separatedEventFiles = Array.from({ length: 66 }, (_, index) => ({
      path: 'C:\\\\separated-events\\\\file-' + String(index).padStart(2, '0') + '.mkv',
      name: 'file-' + String(index).padStart(2, '0') + '.mkv',
      size: 1,
      mtimeMs: index
    }));
    for (const file of separatedEventFiles) {
      await handleFolderMonitorFiles([file]);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    const separatedBurstProbe = await window.api.getAutomationProbeState();
    const invalidatedEvidenceFile = { path: 'C:\\\\separated-events\\\\invalidated.mkv', name: 'invalidated.mkv', size: 1, mtimeMs: 100 };
    window.api.setAutomationEvidence({
      history: [{ files: [{ ...invalidatedEvidenceFile, results: [{ hoster: 'doodstream.com', status: 'done' }] }] }]
    });
    handleBatchDone({ files: [] });
    await handleFolderMonitorFiles([invalidatedEvidenceFile]);
    const invalidatedProbe = await window.api.getAutomationProbeState();
    const expiredEvidenceFile = { path: 'C:\\\\separated-events\\\\expired.mkv', name: 'expired.mkv', size: 1, mtimeMs: 101 };
    window.api.setAutomationEvidence({
      history: [{ files: [{ ...expiredEvidenceFile, results: [{ hoster: 'doodstream.com', status: 'done' }] }] }]
    });
    automationEvidenceSnapshotCache.expiresAt = 0;
    await handleFolderMonitorFiles([expiredEvidenceFile]);
    const expiredProbe = await window.api.getAutomationProbeState();
    const separatedEventEvidence = {
      afterBurst: {
        historyCalls: separatedBurstProbe.readCalls.history,
        uploadLogCalls: separatedBurstProbe.readCalls.uploadLog,
        queuedFiles: new Set(queueJobs.filter(job => job.file.startsWith('C:\\\\separated-events\\\\file-')).map(job => job.file)).size
      },
      afterInvalidation: {
        historyCalls: invalidatedProbe.readCalls.history,
        uploadLogCalls: invalidatedProbe.readCalls.uploadLog,
        queued: queueJobs.some(job => normalizeAutomationPath(job.file) === normalizeAutomationPath(invalidatedEvidenceFile.path))
      },
      afterExpiry: {
        historyCalls: expiredProbe.readCalls.history,
        uploadLogCalls: expiredProbe.readCalls.uploadLog,
        queued: queueJobs.some(job => normalizeAutomationPath(job.file) === normalizeAutomationPath(expiredEvidenceFile.path))
      }
    };
    configureAtomicState(18);
    config.globalSettings.folderMonitor.queueLimitJobs = 20;
    config.globalSettings.folderMonitor.hosters = ['doodstream.com'];
    config.globalSettings.folderMonitor.autoStart = false;
    hosterSettings = {};
    const distinctFiles = Array.from({ length: 20 }, (_, index) => ({
      path: 'C:\\\\distinct\\\\distinct-' + String(index).padStart(3, '0') + '.mkv',
      name: 'distinct-' + String(index).padStart(3, '0') + '.mkv',
      size: 1,
      mtimeMs: index
    }));
    window.api.configureAutomationProbe({ paused: false, deferInspect: true });
    await Promise.all(distinctFiles.map(file => handleFolderMonitorFiles([file])));
    const distinctProbe = await window.api.getAutomationProbeState();
    const distinctTelemetry = config.globalSettings.folderMonitor.telemetry;
    const distinctParallel = {
      inspectCalls: distinctProbe.readCalls.inspect,
      maxConcurrentInspections: distinctProbe.maxConcurrentInspections,
      capacityJobs: window.AutomationControl.countAutomaticQueueJobs(queueJobs),
      distinctJobs: queueJobs.filter(job => job.file.startsWith('C:\\\\distinct\\\\')).length,
      detected: distinctTelemetry.detected,
      queued: distinctTelemetry.queued,
      deferred: distinctTelemetry.deferred,
      lastDetectedName: distinctTelemetry.lastDetectedName
    };
    configureAtomicState(14999);
    config.globalSettings.folderMonitor.hosters = ['doodstream.com'];
    config.globalSettings.folderMonitor.autoStart = false;
    hosterSettings = { 'doodstream.com': { maxSizeMb: 2 } };
    const reasonCandidates = [
      { path: 'C:\\\\reasons\\\\admitted.mkv', name: 'admitted.mkv', size: 1, mtimeMs: 1, filterMatched: true },
      { path: 'C:\\\\reasons\\\\deferred.mkv', name: 'deferred.mkv', size: 1, mtimeMs: 2, filterMatched: true },
      { path: 'C:\\\\reasons\\\\filtered.txt', name: 'filtered.txt', size: 1, mtimeMs: 3, filterMatched: false },
      { path: 'C:\\\\reasons\\\\processed.mkv', name: 'processed.mkv', size: 1, mtimeMs: 4, filterMatched: true },
      { path: 'C:\\\\reasons\\\\inspection-duplicate.mkv', name: 'inspection-duplicate.mkv', size: 1, mtimeMs: 5, filterMatched: true },
      { path: 'C:\\\\reasons\\\\unavailable.mkv', name: 'unavailable.mkv', size: 1, mtimeMs: 6, filterMatched: true, unavailable: true },
      { path: 'C:\\\\reasons\\\\size-limited.mkv', name: 'size-limited.mkv', size: 3 * 1024 * 1024, mtimeMs: 7, filterMatched: true }
    ];
    _pendingFiles = [reasonCandidates[4]];
    window.api.configureAutomationProbe({
      paused: false,
      history: [{ files: [{ path: reasonCandidates[3].path, name: reasonCandidates[3].name, results: [{ hoster: 'doodstream.com', status: 'done' }] }] }]
    });
    const reasonEvaluation = await evaluateAutomationCandidates(reasonCandidates, { dryRun: false, trigger: 'watcher' });
    const reasonResult = await applyAutomationEvaluation(reasonEvaluation);
    const reasonCounts = {};
    for (const entry of reasonEvaluation.classifications || []) reasonCounts[entry.reason] = (reasonCounts[entry.reason] || 0) + 1;
    const disjointClassification = {
      summary: reasonEvaluation.summary,
      reasonCounts,
      classificationCount: reasonEvaluation.classifications?.length || 0,
      telemetryDelta: reasonEvaluation.telemetryDelta,
      applied: {
        admitted: reasonResult.admittedFiles.map(file => file.name),
        deferred: reasonResult.deferredFiles.map(file => file.name)
      },
      telemetry: {
        detected: config.globalSettings.folderMonitor.telemetry.detected,
        queued: config.globalSettings.folderMonitor.telemetry.queued,
        skipped: config.globalSettings.folderMonitor.telemetry.skipped,
        deferred: config.globalSettings.folderMonitor.telemetry.deferred
      }
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
      manualJobHosters: queueJobs.filter(job => job.fileName === 'unplanned.mkv').map(job => job.hoster),
      automationJobHosters: queueJobs.filter(job => job.file === atomicCandidates[1].path).map(job => job.hoster).sort(),
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
    configureAtomicState(14998);
    config.globalSettings.folderMonitor.autoStart = true;
    config.globalSettings.folderMonitor.telemetry = {
      dateKey: new Date().toLocaleDateString('en-CA'),
      detected: 0,
      queued: 0,
      skipped: 0,
      deferred: 0
    };
    window.api.configureAutomationProbe({ paused: false, runtimeStatus: { running: true, reachable: true, folderPath: 'C:\\watch' } });
    const zeroAdmissionFile = { path: 'C:\\watch\\four-targets.mkv', name: 'four-targets.mkv', size: 1024 * 1024, mtimeMs: 1 };
    const zeroAdmissionEvaluation = await evaluateAutomationCandidates([zeroAdmissionFile], { dryRun: false, trigger: 'watcher' });
    const zeroAdmissionResult = await applyAutomationEvaluation(zeroAdmissionEvaluation);
    const zeroAdmissionProbe = await window.api.getAutomationProbeState();
    const limitedSnapshot = createAutomationStatusSnapshot();
    config.globalSettings.folderMonitor.queueLimitJobs = 0;
    const unlimitedSnapshot = createAutomationStatusSnapshot();
    config.globalSettings.folderMonitor.queueLimitJobs = 15000;
    config.globalSettings.folderMonitor.enabled = false;
    const disabledSnapshot = createAutomationStatusSnapshot();
    config.globalSettings.folderMonitor.enabled = true;
    const zeroAdmission = {
      evaluatedAdmitted: zeroAdmissionEvaluation.admittedFiles.map(file => file.name),
      evaluatedDeferred: zeroAdmissionEvaluation.deferredFiles.map(file => file.name),
      appliedAdmitted: zeroAdmissionResult.admittedFiles.map(file => file.name),
      appliedDeferred: zeroAdmissionResult.deferredFiles.map(file => file.name),
      telemetry: {
        detected: config.globalSettings.folderMonitor.telemetry.detected,
        queued: config.globalSettings.folderMonitor.telemetry.queued,
        skipped: config.globalSettings.folderMonitor.telemetry.skipped,
        deferred: config.globalSettings.folderMonitor.telemetry.deferred
      },
      telemetrySaves: zeroAdmissionProbe.mutationCalls.filter(call => call[0] === 'settings').length,
      mainAdmissions: zeroAdmissionProbe.mutationCalls.filter(call => call[0] === 'start' || call[0] === 'inject').length,
      status: {
        state: limitedSnapshot.state,
        currentJobCount: limitedSnapshot.currentJobCount,
        availableSlots: limitedSnapshot.availableSlots,
        queueLimited: limitedSnapshot.queueLimited
      },
      unlimited: { availableSlots: unlimitedSnapshot.availableSlots, queueLimited: unlimitedSnapshot.queueLimited },
      disabled: { state: disabledSnapshot.state, queueLimited: disabledSnapshot.queueLimited }
    };
    const stressStartedAt = performance.now();
    const stressQueue = Array.from({ length: 14996 }, (_, index) => ({
      id: 'stress-queue-' + index,
      file: 'C:\\\\stress\\\\queued-' + index + '.mkv',
      status: 'queued'
    }));
    const stressCandidateCount = 15000;
    const stressCandidates = Array.from({ length: stressCandidateCount }, (_, index) => ({
      path: 'C:\\\\stress\\\\candidate-' + String(index).padStart(5, '0') + '.mkv',
      mtimeMs: index,
      eligibleJobCount: 4
    }));
    const stressCurrentJobCount = window.AutomationControl.countAutomaticQueueJobs(stressQueue);
    const stressPlan = window.AutomationControl.planAtomicAdmissions({
      candidates: stressCandidates,
      currentJobCount: stressCurrentJobCount,
      queueLimitJobs: Number.POSITIVE_INFINITY
    });
    const stressDomRowsBefore = document.querySelectorAll('#queueBody .queue-row').length;
    queueJobs = stressQueue;
    config.globalSettings.folderMonitor.queueLimitJobs = Number.POSITIVE_INFINITY;
    rebuildJobIndex();
    const stressSnapshot = createAutomationStatusSnapshot();
    const stressDomRowsAfter = document.querySelectorAll('#queueBody .queue-row').length;
    const stress = {
      candidateCount: stressCandidateCount,
      currentJobCount: stressPlan.currentJobCount,
      plannedJobs: stressPlan.plannedJobs,
      deferredPaths: stressPlan.deferredPaths.length,
      queueLimitJobs: stressSnapshot.queueLimitJobs,
      snapshotCurrentJobCount: stressSnapshot.currentJobCount,
      snapshotAvailableSlots: stressSnapshot.availableSlots,
      domRowsBefore: stressDomRowsBefore,
      domRowsAfter: stressDomRowsAfter,
      durationMs: performance.now() - stressStartedAt
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

    const resolverMissingJob = makePauseRaceJob('resolver-missing.mkv');
    delete resolverMissingJob.id;
    const collisionJobs = [
      { ...makePauseRaceJob('resolver-duplicate-a.mkv'), id: 'resolver-duplicate' },
      { ...makePauseRaceJob('resolver-duplicate-b.mkv'), id: 'resolver-duplicate' },
      resolverMissingJob,
      { ...makePauseRaceJob('resolver-unique.mkv'), id: 'resolver-unique' }
    ];
    const cleanCollisionOutcome = resolveAddJobsOutcome(collisionJobs, { added: 1 });
    const hostileCollisionOutcome = resolveAddJobsOutcome(collisionJobs, {
      added: 1,
      alreadyInBatchJobIds: ['resolver-duplicate'],
      skippedJobs: [{ reason: 'Ungültig' }]
    });
    const summarizeCollisionOutcome = outcome => ({
      consistent: outcome.consistent,
      added: outcome.addedJobs.map(job => job.fileName),
      already: outcome.alreadyJobs.map(job => job.fileName),
      skipped: outcome.skippedJobs.map(job => job.fileName),
      unconfirmed: outcome.unconfirmedJobs.map(job => job.fileName)
    });
    const collisionResolver = {
      clean: summarizeCollisionOutcome(cleanCollisionOutcome),
      hostile: summarizeCollisionOutcome(hostileCollisionOutcome)
    };

    const applyCollisionCleanupFixture = (job, index) => {
      job.sourceCleanupToken = 'collision-token-' + index;
      job.sourceCleanupRequiredHosters = ['required-' + index];
      job.sourceCleanupCompletedHosters = ['completed-' + index];
      job.sourceCleanupFingerprint = { index, nested: ['before-' + index] };
      return job;
    };
    const summarizeCollisionPath = async (jobs, invalidJobs, validJobs, result, before) => {
      const probe = await window.api.getAutomationProbeState();
      const inject = probe.mutationCalls.find(call => call[0] === 'inject');
      return {
        result,
        sentIds: inject?.[2] || [],
        sentJobs: inject?.[3] || [],
        sourceCleanupGroups: inject?.[4] || [],
        statuses: jobs.map(job => job.status),
        invalidRestored: invalidJobs.map((job, index) => JSON.stringify(job) === before[index]),
        validJobs: validJobs.map(job => ({
          id: job.id,
          status: job.status,
          requiredHosters: [...(job.sourceCleanupRequiredHosters || [])].sort(),
          fingerprint: clone(job.sourceCleanupFingerprint)
        }))
      };
    };

    configureAtomicState(0);
    config.globalSettings.deleteSourceAfterSuccessfulUpload = true;
    uploading = true;
    const activeCollisionFile = 'C:\\\\collision\\\\active.mkv';
    const activeMissingJob = makePauseRaceJob('active-missing.mkv');
    delete activeMissingJob.id;
    const activeCollisionJobs = [
      { ...makePauseRaceJob('active-duplicate-a.mkv'), id: 'active-duplicate' },
      { ...makePauseRaceJob('active-duplicate-b.mkv'), id: 'active-duplicate' },
      activeMissingJob,
      { ...makePauseRaceJob('active-shadowed.mkv'), id: 'active-shadowed' },
      { ...makePauseRaceJob('active-unique.mkv'), id: 'active-unique' },
      { ...makePauseRaceJob('active-already.mkv'), id: 'active-already' }
    ].map((job, index) => {
      job.file = activeCollisionFile;
      job.hoster = [hosters[0], hosters[1], hosters[2], hosters[0], hosters[3], hosters[1]][index];
      return applyCollisionCleanupFixture(job, index);
    });
    const activeShadowSibling = applyCollisionCleanupFixture({
      ...makePauseRaceJob('active-shadow-sibling.mkv'),
      id: 'active-shadowed',
      file: activeCollisionFile,
      hoster: hosters[1],
      status: 'done'
    }, 5);
    const activeMainFingerprint = { size: 11, mtimeMs: 22, headHash: 'active-main' };
    const activeValidToken = 'active-valid-token';
    activeCollisionJobs[0].sourceCleanupToken = activeValidToken;
    activeCollisionJobs[4].sourceCleanupToken = activeValidToken;
    activeCollisionJobs[4].sourceCleanupRequiredHosters = [];
    activeCollisionJobs[5].sourceCleanupToken = activeValidToken;
    activeCollisionJobs[5].sourceCleanupRequiredHosters = [];
    const activeValidSibling = applyCollisionCleanupFixture({
      ...makePauseRaceJob('active-running-sibling.mkv'),
      id: 'active-running-sibling',
      file: activeCollisionFile,
      hoster: 'clouddrop.cc',
      status: 'uploading'
    }, 6);
    activeValidSibling.sourceCleanupToken = activeValidToken;
    activeValidSibling.sourceCleanupRequiredHosters = ['removed.example'];
    queueJobs = [...activeCollisionJobs, activeShadowSibling, activeValidSibling];
    rebuildJobIndex();
    const activeInvalidJobs = [...activeCollisionJobs.slice(0, 4), activeShadowSibling];
    const activeCollisionBefore = activeInvalidJobs.map(job => JSON.stringify(job));
    window.api.configureAutomationProbe({
      paused: false,
      addResult: {
        added: 1,
        alreadyInBatchJobIds: ['active-already'],
        sourceCleanupFingerprints: { [activeValidToken]: activeMainFingerprint }
      }
    });
    const activeCollisionResult = await startSelectedUpload(activeCollisionJobs);
    const activeCollision = await summarizeCollisionPath(
      activeCollisionJobs,
      activeInvalidJobs,
      [activeCollisionJobs[4], activeCollisionJobs[5], activeValidSibling],
      activeCollisionResult,
      activeCollisionBefore
    );

    configureAtomicState(0);
    config.globalSettings.deleteSourceAfterSuccessfulUpload = true;
    selectedFiles = [];
    uploading = true;
    const manualCollisionFile = { path: 'C:\\collision\\manual.mkv', name: 'manual.mkv', size: 1 };
    _pendingFiles = [manualCollisionFile];
    _pendingImportInspection = { candidateCount: 1, duplicateCount: 0, unavailableCount: 0, accepted: [manualCollisionFile] };
    _pendingImportInspections = 0;
    _pendingFolderMonitorAutoStart.clear();
    const manualCollisionInputs = hosters.map(hoster => {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.dataset.hosterModal = hoster;
      input.checked = true;
      return input;
    });
    document.getElementById('hosterModalList').replaceChildren(...manualCollisionInputs);
    const originalBuildQueuePreviewForCollision = buildQueuePreview;
    let manualCollisionJobs = [];
    let manualInvalidJobs = [];
    let manualCollisionBefore = [];
    buildQueuePreview = () => {
      originalBuildQueuePreviewForCollision();
      manualCollisionJobs = queueJobs.filter(job => job.file === manualCollisionFile.path);
      manualCollisionJobs[0].id = 'manual-duplicate';
      manualCollisionJobs[1].id = 'manual-duplicate';
      manualCollisionJobs[2].id = 'manual-shadowed';
      manualCollisionJobs[3].id = 'manual-unique';
      manualCollisionJobs.forEach(applyCollisionCleanupFixture);
      const manualValidToken = 'manual-valid-token';
      manualCollisionJobs[0].sourceCleanupToken = manualValidToken;
      manualCollisionJobs[3].sourceCleanupToken = manualValidToken;
      manualCollisionJobs[3].sourceCleanupRequiredHosters = [];
      const manualAlready = applyCollisionCleanupFixture({
        ...makePauseRaceJob('manual-already.mkv'),
        id: 'manual-already',
        file: manualCollisionFile.path,
        hoster: 'clouddrop.cc',
        status: 'preview'
      }, 6);
      manualAlready.sourceCleanupToken = manualValidToken;
      manualAlready.sourceCleanupRequiredHosters = [];
      manualCollisionJobs.push(manualAlready);
      const manualShadowSibling = applyCollisionCleanupFixture({
        ...makePauseRaceJob('manual-shadow-sibling.mkv'),
        id: 'manual-shadowed',
        file: manualCollisionFile.path,
        hoster: hosters[0],
        status: 'done'
      }, 4);
      const manualMissingSibling = applyCollisionCleanupFixture({
        ...makePauseRaceJob('manual-missing-sibling.mkv'),
        file: manualCollisionFile.path,
        hoster: hosters[1],
        status: 'done'
      }, 5);
      delete manualMissingSibling.id;
      const manualValidSibling = applyCollisionCleanupFixture({
        ...makePauseRaceJob('manual-running-sibling.mkv'),
        id: 'manual-running-sibling',
        file: manualCollisionFile.path,
        hoster: 'voe.sx',
        status: 'uploading'
      }, 7);
      manualValidSibling.sourceCleanupToken = manualValidToken;
      manualValidSibling.sourceCleanupRequiredHosters = ['removed.example'];
      queueJobs.push(manualAlready, manualShadowSibling, manualMissingSibling, manualValidSibling);
      manualInvalidJobs = [...manualCollisionJobs.slice(0, 3), manualShadowSibling, manualMissingSibling];
      manualCollisionBefore = manualInvalidJobs.map(job => JSON.stringify(job));
      manualCollisionJobs.validJobs = [manualCollisionJobs[3], manualAlready, manualValidSibling];
      rebuildJobIndex();
    };
    const manualMainFingerprint = { size: 33, mtimeMs: 44, headHash: 'manual-main' };
    window.api.configureAutomationProbe({
      paused: false,
      addResult: {
        added: 1,
        alreadyInBatchJobIds: ['manual-already'],
        sourceCleanupFingerprints: { 'manual-valid-token': manualMainFingerprint }
      }
    });
    const manualCollisionResult = await applyHosterSelection();
    buildQueuePreview = originalBuildQueuePreviewForCollision;
    const manualCollision = await summarizeCollisionPath(
      manualCollisionJobs,
      manualInvalidJobs,
      manualCollisionJobs.validJobs || [],
      manualCollisionResult,
      manualCollisionBefore
    );

    configureAtomicState(0);
    config.globalSettings.deleteSourceAfterSuccessfulUpload = true;
    config.globalSettings.folderMonitor.hosters = HOSTERS.slice();
    config.globalSettings.folderMonitor.autoStart = true;
    selectedFiles = [];
    uploading = true;
    const automationCollisionFile = { path: 'C:\\collision\\automation.mkv', name: 'automation.mkv', size: 1, mtimeMs: 1 };
    const automationShadowSibling = applyCollisionCleanupFixture({
      ...makePauseRaceJob('automation-shadow-sibling.mkv'),
      id: 'automation-shadowed',
      file: 'C:\\collision\\automation-shadow-existing.mkv',
      hoster: hosters[0],
      status: 'done'
    }, 4);
    const automationMissingSibling = applyCollisionCleanupFixture({
      ...makePauseRaceJob('automation-missing-sibling.mkv'),
      file: 'C:\\collision\\automation-missing-existing.mkv',
      hoster: hosters[1],
      status: 'done'
    }, 5);
    delete automationMissingSibling.id;
    automationShadowSibling.sourceCleanupToken = 'automation-collision-token';
    automationMissingSibling.sourceCleanupToken = 'automation-collision-token';
    const automationValidSibling = applyCollisionCleanupFixture({
      ...makePauseRaceJob('automation-running-sibling.mkv'),
      id: 'automation-running-sibling',
      file: 'C:\\collision\\automation-running-existing.mkv',
      hoster: 'voe.sx',
      status: 'uploading'
    }, 6);
    automationValidSibling.sourceCleanupToken = 'automation-collision-token';
    automationValidSibling.sourceCleanupRequiredHosters = ['removed.example'];
    queueJobs.push(automationShadowSibling, automationMissingSibling, automationValidSibling);
    rebuildJobIndex();
    const automationExternalBefore = [automationShadowSibling, automationMissingSibling].map(job => JSON.stringify(job));
    const originalCreateAutomationPreviewJobForCollision = createAutomationPreviewJob;
    const automationCollisionJobs = [];
    const automationCollisionBefore = [];
    createAutomationPreviewJob = (file, hoster) => {
      const job = originalCreateAutomationPreviewJobForCollision(file, hoster);
      const index = automationCollisionJobs.length;
      if (index < 2) job.id = 'automation-duplicate';
      else if (index === 2) job.id = 'automation-shadowed';
      else if (index === 3) job.id = 'automation-unique';
      else job.id = 'automation-already';
      applyCollisionCleanupFixture(job, index);
      job.sourceCleanupToken = 'automation-collision-token';
      if (index >= 3) job.sourceCleanupRequiredHosters = [];
      automationCollisionJobs.push(job);
      if (index < 3) automationCollisionBefore.push(JSON.stringify(job));
      return job;
    };
    const automationMainFingerprint = { size: 55, mtimeMs: 66, headHash: 'automation-main' };
    window.api.configureAutomationProbe({
      paused: false,
      addResult: {
        added: 1,
        alreadyInBatchJobIds: ['automation-already'],
        sourceCleanupFingerprints: { 'automation-collision-token': automationMainFingerprint }
      }
    });
    const automationCollisionEvaluation = await evaluateAutomationCandidates([automationCollisionFile], { dryRun: false, trigger: 'watcher' });
    const automationCollisionResult = await applyAutomationEvaluation(automationCollisionEvaluation);
    createAutomationPreviewJob = originalCreateAutomationPreviewJobForCollision;
    const automationInvalidJobs = [...automationCollisionJobs.slice(0, 3), automationShadowSibling, automationMissingSibling];
    const automationCollision = await summarizeCollisionPath(
      automationCollisionJobs,
      automationInvalidJobs,
      [automationCollisionJobs[3], automationCollisionJobs[4], automationValidSibling],
      {
        ok: automationCollisionResult.ok,
        error: automationCollisionResult.error || null,
        admitted: automationCollisionResult.admittedFiles.map(file => file.name)
      },
      [...automationCollisionBefore, ...automationExternalBefore]
    );
    uploading = false;
    const collisionAdmission = { active: activeCollision, manual: manualCollision, automation: automationCollision };

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
    const pauseMarkerJob = makePauseRaceJob('pause-marker.mkv');
    pauseMarkerJob.status = 'queued';
    queueJobs = [pauseMarkerJob];
    uploading = true;
    rebuildJobIndex();
    window.api.configureAutomationProbe({ paused: false });
    applyAutomationRuntimeStatus({ paused: false });
    await toggleAutomationPauseResume();
    const pauseMarkerPersisted = buildPersistedQueueState()?.queueJobs.find(entry => entry.id === pauseMarkerJob.id);
    const pauseMarker = {
      marked: pauseMarkerJob.automationPaused === true,
      persisted: pauseMarkerPersisted?.automationPaused === true,
      persistedStatus: pauseMarkerPersisted?.status || null
    };

    const runResumeQueueCase = async ({ active, resumeError = '' }) => {
      configureAtomicState(0);
      const job = makePauseRaceJob(active ? 'resume-active.mkv' : 'resume-idle.mkv');
      job.id = active ? 'resume-active' : 'resume-idle';
      job.status = 'aborted';
      job.error = 'Warteschlange angehalten';
      job.automationPaused = true;
      queueJobs = [
        job,
        { ...makePauseRaceJob('manual-preview.mkv'), id: 'manual-preview', status: 'preview' },
        { ...makePauseRaceJob('manual-queued.mkv'), id: 'manual-queued', status: 'queued' },
        { ...makePauseRaceJob('manual-error.mkv'), id: 'manual-error', status: 'error' },
        { ...makePauseRaceJob('manual-skipped.mkv'), id: 'manual-skipped', status: 'skipped' }
      ];
      selectedFiles = [];
      selectedUploadHosters = ['doodstream.com'];
      config.globalSettings.folderMonitor.paused = true;
      uploading = active;
      rebuildJobIndex();
      window.api.configureAutomationProbe({
        paused: true,
        runtimeStatus: resumeError ? { error: resumeError } : {},
        addResult: { added: 1 },
        startResult: { started: true }
      });
      applyAutomationRuntimeStatus({ paused: true });
      await toggleAutomationPauseResume();
      const probe = await window.api.getAutomationProbeState();
      const acceptedStatus = job.status;
      const persistedJob = buildPersistedQueueState()?.queueJobs.find(entry => entry.id === job.id);
      if (!resumeError) {
        handleProgress({
          jobId: job.id,
          fileName: job.fileName,
          hoster: job.hoster,
          status: 'getting-server',
          bytesUploaded: 0,
          bytesTotal: job.bytesTotal
        });
      }
      return {
        status: acceptedStatus,
        uploading,
        markerPersisted: persistedJob?.automationPaused === true,
        markerAfterProgress: job.automationPaused === true,
        mutations: probe.mutationCalls.map(call => ({ kind: call[0], count: call[1] || 0, ids: call[2] || [] }))
      };
    };
    const resumeQueue = {
      active: await runResumeQueueCase({ active: true }),
      idle: await runResumeQueueCase({ active: false }),
      rollback: await runResumeQueueCase({ active: false, resumeError: 'Automatik konnte nicht fortgesetzt werden.' })
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
      manualPreviewJobs: queueJobs.filter(job => job.fileName === 'allowed-preview.mkv' && job.status === 'preview').length,
      automaticApplied: pausedAutomaticResult.admittedFiles.length,
      startCalls: pausedProbe.mutationCalls.filter(call => call[0] === 'start').length,
      injectCalls: pausedProbe.mutationCalls.filter(call => call[0] === 'inject').length
    };
    return { dry, manualTest, historyEvidence, completedEvidence, pendingDedup, parallelAdmission, evidenceSnapshotDrain, separatedEventEvidence, distinctParallel, disjointClassification, manualHostTransactional, atomic, status, zeroAdmission, stress, persistedQueueExactness, stale, replannedEligibility, mainPauseResponses, cleanupRollback, crossPathCleanupRollback, partialAddOutcomes, collisionResolver, collisionAdmission, pauseBetweenApplyAndStart, startAcceptance, fulfilledFeedback, injectionOutcomes, pauseMarker, resumeQueue, paused };
  })()`;
  const automationControlCenterScript = `(async () => {
    const waitFor = async predicate => {
      for (let attempt = 0; attempt < 80; attempt++) {
        if (await predicate()) return true;
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      return false;
    };
    const fixedNow = 1787712600000;
    const runtimeStatus = {
      running: true,
      reachable: true,
      scanning: false,
      folderPath: 'C:\\\\watch',
      lastScanAt: fixedNow - 60000,
      startedAt: fixedNow - 3600000,
      nextReconcileAt: fixedNow + 123456,
      error: ''
    };
    setUiLanguage('de');
    config = {
      hosters: Object.fromEntries(HOSTERS.map(hoster => [hoster, []])),
      hosterSettings: {},
      globalSettings: {
        language: 'de',
        folderMonitor: {
          enabled: true,
          folderPath: 'C:\\\\watch',
          hosters: ['doodstream.com'],
          autoStart: false,
          reconcileIntervalMinutes: 5,
          paused: false,
          pausedAt: null,
          telemetry: {
            dateKey: new Date().toLocaleDateString('en-CA'),
            detected: 23,
            queued: 17,
            skipped: 5,
            deferred: 2,
            lastDetectedName: 'episode-08.mkv',
            lastDetectedAt: fixedNow - 120000,
            lastError: '',
            lastErrorAt: null
          }
        }
      }
    };
    hosterSettings = {};
    selectedFiles = [];
    selectedUploadHosters = ['doodstream.com'];
    queueJobs = Array.from({ length: 8420 }, (_, index) => ({
      id: 'ui-capacity-' + index,
      file: 'C:\\\\queue\\\\' + index + '.mkv',
      fileName: index + '.mkv',
      hoster: 'doodstream.com',
      status: 'queued',
      bytesTotal: 1
    }));
    rebuildJobIndex();
    applyAutomationRuntimeStatus(runtimeStatus);
    renderSettings();
    document.querySelector('[data-settings-page="automatik"]')?.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    const automationPage = document.querySelector('[data-subpage="automatik"]');
    const pageHeader = automationPage?.querySelector('.settings-page-header');
    const queueLimitInput = document.getElementById('fmQueueLimitInput');
    const intervalInput = document.getElementById('fmReconcileIntervalInput');
    const initial = {
      cardImmediatelyAfterHeader: pageHeader?.nextElementSibling?.id === 'automationStatusCard',
      stateBadge: {
        text: document.getElementById('automationStateBadge')?.textContent.trim() || null,
        classes: [...(document.getElementById('automationStateBadge')?.classList || [])]
      },
      queueMeter: document.getElementById('automationQueueMeter')?.textContent.trim() || null,
      lastErrorHidden: document.getElementById('automationLastErrorRow')?.hidden ?? null,
      queueLimitDefault: queueLimitInput?.value || null,
      queueLimitMin: queueLimitInput?.min || null,
      intervalDefault: intervalInput?.value || null,
      intervalOptions: [...(intervalInput?.options || [])].map(option => option.value),
      snapshotFrozen: Object.isFrozen(createAutomationStatusSnapshot()) && Object.isFrozen(createAutomationStatusSnapshot().telemetry),
      startedAt: createAutomationStatusSnapshot().startedAt,
      nextReconcileAt: createAutomationStatusSnapshot().nextReconcileAt
    };
    applyAutomationRuntimeStatus({ ...runtimeStatus, startedAt: null, nextReconcileAt: null });
    const missingMainTimes = createAutomationStatusSnapshot();
    const noRendererTimeEstimate = {
      startedAt: missingMainTimes.startedAt,
      nextReconcileAt: missingMainTimes.nextReconcileAt
    };
    applyAutomationRuntimeStatus(runtimeStatus);
    if (queueLimitInput) {
      queueLimitInput.value = '0';
      queueLimitInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    initial.queueLimitAcceptsZero = queueLimitInput?.value === '0' && queueLimitInput.checkValidity();
    const stateDefinitions = [
      ['inactive', 'Inaktiv', 'state-inactive'],
      ['active', 'Aktiv', 'state-active'],
      ['paused', 'Pausiert', 'state-paused'],
      ['queue-limited', 'Queue-Limit erreicht', 'state-queue-limited'],
      ['disconnected', 'Ordner getrennt', 'state-disconnected'],
      ['error', 'Fehler', 'state-error']
    ];
    const states = [];
    if (typeof renderAutomationStatusSnapshot === 'function') {
      const baseSnapshot = createAutomationStatusSnapshot();
      for (const [state, label, className] of stateDefinitions) {
        renderAutomationStatusSnapshot(Object.freeze({ ...baseSnapshot, state, error: state === 'error' ? 'Fehler beim Scan' : '' }));
        const badge = document.getElementById('automationStateBadge');
        states.push({ state, expectedLabel: label, text: badge?.textContent.trim(), classApplied: badge?.classList.contains(className) });
      }
      renderAutomationStatusSnapshot(baseSnapshot);
    }
    const originalSnapshotFactory = createAutomationStatusSnapshot;
    const finiteQueueSnapshot = originalSnapshotFactory();
    renderAutomationStatusSnapshot(Object.freeze({ ...finiteQueueSnapshot, queueLimitJobs: 0, availableSlots: null }));
    const unlimitedQueueAria = {
      now: document.getElementById('automationQueueMeterTrack')?.getAttribute('aria-valuenow'),
      max: document.getElementById('automationQueueMeterTrack')?.getAttribute('aria-valuemax'),
      text: document.getElementById('automationQueueMeterTrack')?.getAttribute('aria-valuetext')
    };
    renderAutomationStatusSnapshot(finiteQueueSnapshot);
    const finiteQueueAria = {
      now: document.getElementById('automationQueueMeterTrack')?.getAttribute('aria-valuenow'),
      max: document.getElementById('automationQueueMeterTrack')?.getAttribute('aria-valuemax'),
      text: document.getElementById('automationQueueMeterTrack')?.getAttribute('aria-valuetext')
    };
    const finiteQueueJobs = queueJobs;
    queueJobs = Array.from({ length: 15001 }, (_, index) => ({
      id: 'manual-over-limit-' + index,
      file: 'C:\\\\manual\\\\' + index + '.mkv',
      fileName: index + '.mkv',
      hoster: 'doodstream.com',
      status: 'preview',
      bytesTotal: 1
    }));
    rebuildJobIndex();
    renderAutomationStatusSnapshot(originalSnapshotFactory());
    const overLimitQueueAria = {
      meter: document.getElementById('automationQueueMeter')?.textContent.trim() || null,
      now: document.getElementById('automationQueueMeterTrack')?.getAttribute('aria-valuenow'),
      max: document.getElementById('automationQueueMeterTrack')?.getAttribute('aria-valuemax'),
      text: document.getElementById('automationQueueMeterTrack')?.getAttribute('aria-valuetext')
    };
    queueJobs = finiteQueueJobs;
    rebuildJobIndex();
    renderAutomationStatusSnapshot(finiteQueueSnapshot);
    setUiLanguage('en');
    renderAutomationStatusSnapshot(Object.freeze({ ...finiteQueueSnapshot, state: 'error', error: 'Ordnerscan fehlgeschlagen' }));
    const localizedStatusError = document.getElementById('automationLastError')?.textContent.trim() || '';
    setUiLanguage('de');
    renderAutomationStatusSnapshot(finiteQueueSnapshot);
    let snapshotCalls = 0;
    const pausedSnapshot = Object.freeze({
      ...originalSnapshotFactory(),
      paused: true,
      state: 'paused',
      telemetry: Object.freeze({ ...originalSnapshotFactory().telemetry })
    });
    if (typeof refreshAutomationControlCenter === 'function') {
      createAutomationStatusSnapshot = () => {
        snapshotCalls++;
        return pausedSnapshot;
      };
      refreshAutomationControlCenter();
      createAutomationStatusSnapshot = originalSnapshotFactory;
    }
    queueJobs = [
      { id: 'ui-preview', file: 'C:\\\\ui-preview.mkv', fileName: 'ui-preview.mkv', hoster: 'doodstream.com', status: 'preview', bytesTotal: 1 },
      { id: 'ui-error', file: 'C:\\\\ui-error.mkv', fileName: 'ui-error.mkv', hoster: 'doodstream.com', status: 'error', bytesTotal: 1 }
    ];
    config.globalSettings.pendingQueue = buildPersistedQueueState();
    queueJobs = [];
    selectedFiles = [];
    selectedUploadHosters = [];
    rebuildJobIndex();
    restoreQueueStateFromConfig();
    const restoredPreviewBeforeResume = JSON.stringify(queueJobs.find(job => job.id === 'ui-preview'));
    uploadSidebarFilter = 'all';
    queueSearchQuery = '';
    queueHosterFilter = '';
    queueStatusFilter = '';
    _queueFilterCache = { filter: '', source: null, result: [] };
    selectedJobIds.clear();
    selectedJobIds.add('ui-preview');
    selectedJobIds.add('ui-error');
    rebuildJobIndex();
    updateUploadView({ rebuildPreview: false });
    config.globalSettings.folderMonitor.paused = true;
    applyAutomationRuntimeStatus({ ...runtimeStatus, paused: true, pausedAt: fixedNow });
    updateQueueActionButtons();
    document.querySelector('[data-view="upload"]')?.click();
    const pauseButton = document.getElementById('automationPauseResumeBtn');
    const pausedControls = {
      snapshotCalls,
      pauseButtonDisabled: pauseButton?.disabled ?? null,
      pauseButtonText: pauseButton?.textContent.trim() || null,
      pauseButtonLabel: pauseButton?.getAttribute('aria-label') || null,
      pauseButtonGreen: pauseButton?.classList.contains('automation-resume') ?? null,
      pauseButtonFits: pauseButton ? pauseButton.scrollWidth <= pauseButton.clientWidth + 1 && pauseButton.getBoundingClientRect().width > 34 : null,
      startDisabled: Object.fromEntries(['startUploadBtn', 'startSelectedBtn', 'reuploadSelectedBtn', 'retryFailedBtn'].map(id => [id, document.getElementById(id)?.disabled ?? null])),
      contextStartDisabled: document.querySelector('[data-action="start-selected"]')?.getAttribute('aria-disabled') || null,
      contextRetryDisabled: document.querySelector('[data-action="retry-selected"]')?.getAttribute('aria-disabled') || null
    };
    window.api.configureAutomationProbe({ paused: true, runtimeStatus });
    pauseButton?.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    const afterResumeProbe = await window.api.getAutomationProbeState();
    const restoredPreviewAfterResume = queueJobs.find(job => job.id === 'ui-preview');
    const resumedLabel = document.getElementById('automationPauseResumeBtn')?.textContent.trim() || null;
    selectedJobIds.clear();
    selectedJobIds.add('ui-preview');
    selectedJobIds.add('ui-error');
    updateQueueActionButtons();
    const startDisabledAfterResume = Object.fromEntries(['startUploadBtn', 'startSelectedBtn', 'reuploadSelectedBtn', 'retryFailedBtn'].map(id => [id, document.getElementById(id)?.disabled ?? null]));
    document.getElementById('automationPauseResumeBtn')?.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    const afterPauseProbe = await window.api.getAutomationProbeState();
    const pausedLabel = document.getElementById('automationPauseResumeBtn')?.textContent.trim() || null;
    setUiLanguage('en');
    await new Promise(resolve => setTimeout(resolve, 0));
    const pausedLabelEnglish = document.getElementById('automationPauseResumeBtn')?.textContent.trim() || null;
    setUiLanguage('de');
    const pauseResumeActions = {
      calls: afterPauseProbe.mutationCalls.filter(call => call[0] === 'resume' || call[0] === 'pause').map(call => call[0]),
      resumedLabel,
      startDisabledAfterResume,
      restoredPreviewPresent: Boolean(restoredPreviewAfterResume),
      restoredPreviewStatus: restoredPreviewAfterResume?.status || null,
      restoredPreviewByteIdentical: JSON.stringify(restoredPreviewAfterResume) === restoredPreviewBeforeResume,
      resumeStartCalls: afterResumeProbe.mutationCalls.filter(call => call[0] === 'start').length,
      resumeAddCalls: afterResumeProbe.mutationCalls.filter(call => call[0] === 'inject').length,
      pausedLabel,
      pausedLabelEnglish,
      configPaused: config.globalSettings.folderMonitor.paused
    };
    document.querySelector('[data-view="settings"]')?.click();
    document.querySelector('[data-settings-page="automatik"]')?.click();
    config.globalSettings.folderMonitor.paused = false;
    applyAutomationRuntimeStatus(runtimeStatus);
    queueJobs = Array.from({ length: 8420 }, (_, index) => ({
      id: 'ui-test-' + index,
      file: 'C:\\\\queue-test\\\\' + index + '.mkv',
      fileName: index + '.mkv',
      hoster: 'doodstream.com',
      status: 'queued',
      bytesTotal: 1
    }));
    rebuildJobIndex();
    if (typeof refreshAutomationControlCenter === 'function') refreshAutomationControlCenter();
    const dryFiles = [
      { path: 'C:\\\\watch\\\\accepted.mkv', name: 'accepted.mkv', size: 1, mtimeMs: 1, filterMatched: true },
      { path: 'C:\\\\watch\\\\filtered.txt', name: 'filtered.txt', size: 1, mtimeMs: 2, filterMatched: false },
      { path: 'C:\\\\watch\\\\unavailable.mkv', name: 'unavailable.mkv', size: 1, mtimeMs: 3, filterMatched: true, unavailable: true },
      { path: 'C:\\\\watch\\\\processed.mkv', name: 'processed.mkv', size: 1, mtimeMs: 4, filterMatched: true }
    ];
    window.api.configureAutomationProbe({
      paused: false,
      runtimeStatus,
      deferTestScan: true,
      dryScan: { files: dryFiles, reachable: true, trigger: 'test' },
      history: [{ id: 'ui-history', files: [{ path: dryFiles[3].path, name: dryFiles[3].name, results: [{ hoster: 'doodstream.com', status: 'done' }] }] }]
    });
    const beforeTestProbe = await window.api.getAutomationProbeState();
    const testButton = document.getElementById('automationTestBtn');
    testButton?.focus();
    testButton?.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    const overlay = document.getElementById('automationTestOverlay');
    const loading = {
      visible: overlay?.style.display === 'flex' && overlay?.getAttribute('aria-hidden') === 'false',
      busy: overlay?.getAttribute('aria-busy') || null,
      spinnerVisible: document.getElementById('automationTestSpinner')?.hidden === false,
      focusInside: Boolean(overlay?.contains(document.activeElement)),
      backgroundInert: Array.from(document.body.children).filter(element => element !== overlay && 'inert' in element).every(element => element.inert)
    };
    window.api.releaseAutomationTestScan();
    await waitFor(() => overlay?.getAttribute('aria-busy') === 'false');
    const metricValues = Object.fromEntries([...document.querySelectorAll('[data-automation-test-metric]')].map(row => [
      row.dataset.automationTestMetric,
      row.querySelector('.automation-test-value')?.textContent.trim() || ''
    ]));
    const germanMetricLabels = [...document.querySelectorAll('[data-automation-test-metric] .automation-test-label')].map(element => element.textContent.trim());
    const afterTestProbe = await window.api.getAutomationProbeState();
    const completed = {
      metricValues,
      metricCount: Object.keys(metricValues).length,
      germanMetricLabels,
      errorHidden: document.getElementById('automationTestError')?.hidden ?? null,
      actionIds: [...(overlay?.querySelectorAll('button') || [])].map(button => button.id),
      mutationFree: JSON.stringify(afterTestProbe.mutationCalls) === JSON.stringify(beforeTestProbe.mutationCalls)
    };
    setUiLanguage('en');
    await new Promise(resolve => setTimeout(resolve, 0));
    const english = {
      queueMeter: document.getElementById('automationQueueMeter')?.textContent.trim() || null,
      availableSlots: document.querySelector('[data-automation-test-metric="availableSlots"] .automation-test-value')?.textContent.trim() || null,
      metricLabels: [...document.querySelectorAll('[data-automation-test-metric] .automation-test-label')].map(element => element.textContent.trim())
    };
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    const closed = {
      hidden: overlay?.style.display === 'none' && overlay?.getAttribute('aria-hidden') === 'true',
      focusReturned: document.activeElement?.id === 'automationTestBtn',
      backgroundRestored: Array.from(document.body.children).filter(element => element !== overlay && 'inert' in element).every(element => !element.inert)
    };
    setUiLanguage('de');
    window.api.configureAutomationProbe({ paused: false, runtimeStatus, testScanError: 'token=secret-value' });
    document.getElementById('automationTestBtn')?.click();
    await waitFor(() => document.getElementById('automationTestOverlay')?.getAttribute('aria-busy') === 'false');
    const errorText = document.getElementById('automationTestError')?.textContent.trim() || '';
    const errorState = {
      visible: document.getElementById('automationTestError')?.hidden === false,
      text: errorText,
      secretExposed: /secret-value|token=/i.test(errorText)
    };
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    window.api.configureAutomationProbe({
      paused: false,
      runtimeStatus,
      deferTestScan: true,
      dryScan: { files: dryFiles, reachable: true, trigger: 'test' }
    });
    document.getElementById('automationTestBtn')?.click();
    await waitFor(() => document.getElementById('automationTestOverlay')?.getAttribute('aria-busy') === 'true');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    const enabledAfterCancel = document.getElementById('automationTestBtn')?.disabled === false;
    window.api.releaseAutomationTestScan();
    await new Promise(resolve => setTimeout(resolve, 0));
    const cancelLoading = {
      hidden: document.getElementById('automationTestOverlay')?.style.display === 'none',
      enabledAfterCancel,
      lateResultStayedClosed: document.getElementById('automationTestOverlay')?.style.display === 'none'
    };
    return { initial, noRendererTimeEstimate, states, unlimitedQueueAria, finiteQueueAria, overLimitQueueAria, localizedStatusError, pausedControls, pauseResumeActions, loading, completed, english, closed, errorState, cancelLoading };
  })()`;
  const automationControlCenterLayoutScript = `(() => {
    const card = document.getElementById('automationStatusCard');
    const metrics = document.querySelector('.automation-status-metrics');
    const metricValue = document.querySelector('.automation-status-value');
    return {
      viewportWidth: document.documentElement.clientWidth,
      documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      cardOverflow: card ? card.scrollWidth > card.clientWidth + 1 : null,
      metricsOverflow: metrics ? metrics.scrollWidth > metrics.clientWidth + 1 : null,
      gridTemplateColumns: metrics ? getComputedStyle(metrics).gridTemplateColumns : null,
      tabularNumbers: metricValue ? getComputedStyle(metricValue).fontVariantNumeric.includes('tabular-nums') : null
    };
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
      const fixture = document.createElement('div');
      fixture.innerHTML = '<section class="online-backup-panel"><section class="online-backup-managed"><h4>Managed</h4><div class="online-backup-managed-list"><article class="online-backup-managed-row"><span class="online-backup-managed-key">ABCDEFGH…1234</span><span class="online-backup-managed-created">22.08.2026 12:00</span><div class="online-backup-managed-actions"><button class="btn btn-secondary">' + copy + '</button><button class="btn btn-danger">' + remove + '</button></div></article><article class="online-backup-managed-row"><span class="online-backup-managed-key">ZYXWVUTS…9876</span><span class="online-backup-managed-created">21.08.2026 11:00</span><div class="online-backup-managed-actions"><button class="btn btn-secondary">' + copy + '</button><button class="btn btn-danger">' + remove + '</button></div></article></div></section><footer class="online-backup-footer"><button class="btn btn-primary">Generate new key</button></footer></section>';
      document.body.appendChild(fixture);
      const panel = fixture.querySelector('.online-backup-panel');
      const panelRect = panel.getBoundingClientRect();
      const panelStyle = getComputedStyle(panel);
      const rows = [...fixture.querySelectorAll('.online-backup-managed-row')].map(row => {
        const key = row.querySelector('.online-backup-managed-key').getBoundingClientRect();
        const created = row.querySelector('.online-backup-managed-created').getBoundingClientRect();
        const actions = row.querySelector('.online-backup-managed-actions').getBoundingClientRect();
        return { keyLeft: key.left, createdLeft: created.left, actionsRight: actions.right };
      });
      const result = {
        rows,
        contentRight: panelRect.right - parseFloat(panelStyle.paddingRight),
        createRight: fixture.querySelector('.online-backup-footer button').getBoundingClientRect().right
      };
      fixture.remove();
      return result;
    };
    return { german: measure('de'), english: measure('en') };
  })()`;
  const onlineBackupNarrowLayoutScript = `(() => {
    const fixture = document.createElement('div');
    fixture.innerHTML = '<section class="online-backup-panel"><section class="online-backup-managed"><div class="online-backup-managed-list"><article class="online-backup-managed-row"><span class="online-backup-managed-key">ABCDEFGH…1234</span><span class="online-backup-managed-created">22/08/2026, 12:00</span><div class="online-backup-managed-actions"><button class="btn btn-secondary">Copy key</button><button class="btn btn-danger">Delete online backup</button></div></article></div></section><footer class="online-backup-footer"><button class="btn btn-primary">Generate new key</button></footer></section>';
    document.body.appendChild(fixture);
    const rowElement = fixture.querySelector('.online-backup-managed-row');
    const row = rowElement.getBoundingClientRect();
    const key = fixture.querySelector('.online-backup-managed-key').getBoundingClientRect();
    const created = fixture.querySelector('.online-backup-managed-created').getBoundingClientRect();
    const actions = fixture.querySelector('.online-backup-managed-actions').getBoundingClientRect();
    const rowStyle = getComputedStyle(rowElement);
    const rowContentWidth = row.width - parseFloat(rowStyle.paddingLeft) - parseFloat(rowStyle.paddingRight) - parseFloat(rowStyle.borderLeftWidth) - parseFloat(rowStyle.borderRightWidth);
    const footer = fixture.querySelector('.online-backup-footer').getBoundingClientRect();
    const create = fixture.querySelector('.online-backup-footer button').getBoundingClientRect();
    const result = {
      innerWidth,
      narrowMedia: matchMedia('(max-width: 820px)').matches,
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      rowOverflow: rowElement.scrollWidth > rowElement.clientWidth + 1,
      stacked: key.top < created.top && created.top < actions.top,
      actionsStretched: Math.abs(actions.width - rowContentWidth) <= 1,
      createStretched: Math.abs(create.width - footer.width) <= 1
    };
    fixture.remove();
    return result;
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
async function waitForContentWidth(browserWindow, target) {
  let width = 0;
  for (let attempt = 0; attempt < 80; attempt++) {
    width = await browserWindow.webContents.executeJavaScript('innerWidth');
    if (Math.abs(width - target) <= 1) return width;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return width;
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
  const automationControlCenter = await window.webContents.executeJavaScript(${JSON.stringify(automationControlCenterScript)});
  const automationControlCenterWideLayout = await window.webContents.executeJavaScript(${JSON.stringify(automationControlCenterLayoutScript)});
  const onlineBackupLayout = await window.webContents.executeJavaScript(${JSON.stringify(onlineBackupLayoutScript)});
  window.setContentSize(760, Math.min(900, display.workAreaSize.height));
  await waitForContentWidth(window, 760);
  const automationControlCenterNarrowLayout = await window.webContents.executeJavaScript(${JSON.stringify(automationControlCenterLayoutScript)});
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
    automationControlCenter,
    automationControlCenterWideLayout,
    automationControlCenterNarrowLayout,
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
    assert.deepEqual(result.automationPipeline.completedEvidence, {
      removedAfterDone: true,
      completedKeyPresent: true,
      admittedFiles: 0,
      matchingQueueJobs: 0,
      startOrInjectCalls: 0
    });
    assert.deepEqual(result.automationPipeline.pendingDedup, {
      evaluatedNames: ['new.mkv'],
      pendingPaths: ['c:/pending/overlap.mkv'],
      pendingAccepted: 1,
      markerPaths: ['c:/pending/overlap.mkv']
    });
    assert.deepEqual(result.automationPipeline.parallelAdmission, {
      admittedFiles: ['parallel.mkv'],
      matchingJobs: 1,
      matchingPaths: ['c:/watch/parallel.mkv'],
      queuedTelemetry: 1
    });
    assert.deepEqual(result.automationPipeline.evidenceSnapshotDrain, {
      historyCalls: 1,
      uploadLogCalls: 1,
      inspectCalls: 9,
      batchSizes: [8, 8, 8, 8, 8, 8, 8, 8, 2],
      queuedFiles: 66
    });
    assert.deepEqual(result.automationPipeline.separatedEventEvidence, {
      afterBurst: { historyCalls: 1, uploadLogCalls: 1, queuedFiles: 66 },
      afterInvalidation: { historyCalls: 2, uploadLogCalls: 2, queued: false },
      afterExpiry: { historyCalls: 3, uploadLogCalls: 3, queued: false }
    });
    assert.deepEqual(result.automationPipeline.resumeQueue, {
      active: {
        status: 'queued',
        uploading: true,
        markerPersisted: true,
        markerAfterProgress: false,
        mutations: [
          { kind: 'resume', count: 0, ids: [] },
          { kind: 'inject', count: 1, ids: ['resume-active'] }
        ]
      },
      idle: {
        status: 'queued',
        uploading: true,
        markerPersisted: true,
        markerAfterProgress: false,
        mutations: [
          { kind: 'resume', count: 0, ids: [] },
          { kind: 'start', count: 1, ids: ['resume-idle'] }
        ]
      },
      rollback: {
        status: 'aborted',
        uploading: false,
        markerPersisted: true,
        markerAfterProgress: true,
        mutations: [{ kind: 'resume', count: 0, ids: [] }]
      }
    });
    assert.deepEqual(result.automationPipeline.pauseMarker, {
      marked: true,
      persisted: true,
      persistedStatus: 'queued'
    });
    assert.deepEqual(result.automationPipeline.distinctParallel, {
      inspectCalls: 3,
      maxConcurrentInspections: 1,
      capacityJobs: 20,
      distinctJobs: 2,
      detected: 20,
      queued: 2,
      deferred: 18,
      lastDetectedName: 'distinct-019.mkv'
    });
    assert.deepEqual(result.automationPipeline.disjointClassification, {
      summary: {
        found: 7,
        filterMatched: 6,
        alreadyProcessed: 2,
        unavailable: 1,
        sizeLimitedJobs: 1,
        acceptedFiles: 2,
        selectedTargets: 1,
        resultingJobs: 2,
        availableSlots: 1,
        deferredFiles: 1
      },
      reasonCounts: {
        admitted: 1,
        deferred: 1,
        'filter-rejected': 1,
        processed: 1,
        'inspection-duplicate': 1,
        unavailable: 1,
        'size-limited': 1
      },
      classificationCount: 7,
      telemetryDelta: {
        detected: 7,
        queued: 1,
        skipped: 5,
        deferred: 1,
        lastDetectedName: 'size-limited.mkv'
      },
      applied: { admitted: ['admitted.mkv'], deferred: ['deferred.mkv'] },
      telemetry: { detected: 7, queued: 1, skipped: 5, deferred: 1 }
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
      currentJobCount: 15001,
      unplannedJobs: 1,
      manualJobHosters: ['clouddrop.cc'],
      automationJobHosters: ['byse.sx', 'vidmoly.me'],
      selectedHostersAfterApply: ['clouddrop.cc'],
      manualSelectionFilesAfterApply: ['unplanned.mkv'],
      plannedHostsBeforeRebuild: ['byse.sx', 'vidmoly.me'],
      hostsAfterRebuild: ['byse.sx', 'vidmoly.me']
    });
    assert.deepEqual(result.automationPipeline.status, {
      state: 'queue-limited',
      currentJobCount: 15001,
      availableSlots: 0,
      queueLimited: true,
      frozen: true
    });
    assert.deepEqual(result.automationPipeline.zeroAdmission, {
      evaluatedAdmitted: [],
      evaluatedDeferred: ['four-targets.mkv'],
      appliedAdmitted: [],
      appliedDeferred: ['four-targets.mkv'],
      telemetry: { detected: 1, queued: 0, skipped: 0, deferred: 1 },
      telemetrySaves: 1,
      mainAdmissions: 0,
      status: { state: 'queue-limited', currentJobCount: 14998, availableSlots: 2, queueLimited: true },
      unlimited: { availableSlots: null, queueLimited: false },
      disabled: { state: 'inactive', queueLimited: false }
    });
    assert.equal(result.automationPipeline.stress.candidateCount, 15000);
    assert.equal(result.automationPipeline.stress.currentJobCount, 14996);
    assert.equal(result.automationPipeline.stress.plannedJobs, 4);
    assert.equal(result.automationPipeline.stress.deferredPaths, 14999);
    assert.equal(result.automationPipeline.stress.queueLimitJobs, 15000);
    assert.equal(result.automationPipeline.stress.snapshotCurrentJobCount, 14996);
    assert.equal(result.automationPipeline.stress.snapshotAvailableSlots, 4);
    assert.equal(result.automationPipeline.stress.domRowsAfter, result.automationPipeline.stress.domRowsBefore);
    assert.ok(result.automationPipeline.stress.domRowsAfter < 15000);
    assert.ok(result.automationPipeline.stress.durationMs < 1000, `15,000-job stress took ${result.automationPipeline.stress.durationMs}ms`);
    t.diagnostic(`automation-stress-duration-ms=${result.automationPipeline.stress.durationMs.toFixed(3)}`);
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
    assert.deepEqual(result.automationPipeline.collisionResolver, {
      clean: {
        consistent: true,
        added: ['resolver-unique.mkv'],
        already: [],
        skipped: [],
        unconfirmed: ['resolver-duplicate-a.mkv', 'resolver-duplicate-b.mkv', 'resolver-missing.mkv']
      },
      hostile: {
        consistent: false,
        added: [],
        already: [],
        skipped: [],
        unconfirmed: ['resolver-duplicate-a.mkv', 'resolver-duplicate-b.mkv', 'resolver-missing.mkv', 'resolver-unique.mkv']
      }
    });
    assert.deepEqual(result.automationPipeline.collisionAdmission, {
      active: {
        result: { ok: true, added: 1 },
        sentIds: ['active-unique', 'active-already'],
        sentJobs: [
          { id: 'active-unique', requiredHosters: ['removed.example', 'byse.sx', 'voe.sx', 'clouddrop.cc'] },
          { id: 'active-already', requiredHosters: ['removed.example', 'byse.sx', 'voe.sx', 'clouddrop.cc'] }
        ],
        sourceCleanupGroups: [{
          requiredHosters: ['removed.example', 'byse.sx', 'voe.sx', 'clouddrop.cc'],
          jobIds: ['active-unique', 'active-already', 'active-running-sibling']
        }],
        statuses: ['preview', 'preview', 'preview', 'preview', 'queued', 'queued'],
        invalidRestored: [true, true, true, true, true],
        validJobs: [
          { id: 'active-unique', status: 'queued', requiredHosters: ['byse.sx', 'clouddrop.cc', 'removed.example', 'voe.sx'], fingerprint: { size: 11, mtimeMs: 22, headHash: 'active-main' } },
          { id: 'active-already', status: 'queued', requiredHosters: ['byse.sx', 'clouddrop.cc', 'removed.example', 'voe.sx'], fingerprint: { size: 11, mtimeMs: 22, headHash: 'active-main' } },
          { id: 'active-running-sibling', status: 'uploading', requiredHosters: ['byse.sx', 'clouddrop.cc', 'removed.example', 'voe.sx'], fingerprint: { size: 11, mtimeMs: 22, headHash: 'active-main' } }
        ]
      },
      manual: {
        result: true,
        sentIds: ['manual-unique', 'manual-already'],
        sentJobs: [
          { id: 'manual-unique', requiredHosters: ['removed.example', 'byse.sx', 'clouddrop.cc', 'voe.sx'] },
          { id: 'manual-already', requiredHosters: ['removed.example', 'byse.sx', 'clouddrop.cc', 'voe.sx'] }
        ],
        sourceCleanupGroups: [{
          requiredHosters: ['removed.example', 'byse.sx', 'clouddrop.cc', 'voe.sx'],
          jobIds: ['manual-unique', 'manual-already', 'manual-running-sibling']
        }],
        statuses: ['preview', 'preview', 'preview', 'queued', 'queued'],
        invalidRestored: [true, true, true, true, true],
        validJobs: [
          { id: 'manual-unique', status: 'queued', requiredHosters: ['byse.sx', 'clouddrop.cc', 'removed.example', 'voe.sx'], fingerprint: { size: 33, mtimeMs: 44, headHash: 'manual-main' } },
          { id: 'manual-already', status: 'queued', requiredHosters: ['byse.sx', 'clouddrop.cc', 'removed.example', 'voe.sx'], fingerprint: { size: 33, mtimeMs: 44, headHash: 'manual-main' } },
          { id: 'manual-running-sibling', status: 'uploading', requiredHosters: ['byse.sx', 'clouddrop.cc', 'removed.example', 'voe.sx'], fingerprint: { size: 33, mtimeMs: 44, headHash: 'manual-main' } }
        ]
      },
      automation: {
        result: { ok: true, error: null, admitted: ['automation.mkv'] },
        sentIds: ['automation-unique', 'automation-already'],
        sentJobs: [
          { id: 'automation-unique', requiredHosters: ['removed.example', 'voe.sx', 'byse.sx', 'clouddrop.cc'] },
          { id: 'automation-already', requiredHosters: ['removed.example', 'voe.sx', 'byse.sx', 'clouddrop.cc'] }
        ],
        sourceCleanupGroups: [{
          requiredHosters: ['removed.example', 'voe.sx', 'byse.sx', 'clouddrop.cc'],
          jobIds: ['automation-running-sibling', 'automation-unique', 'automation-already']
        }],
        statuses: ['preview', 'preview', 'preview', 'queued', 'queued'],
        invalidRestored: [true, true, true, true, true],
        validJobs: [
          { id: 'automation-unique', status: 'queued', requiredHosters: ['byse.sx', 'clouddrop.cc', 'removed.example', 'voe.sx'], fingerprint: { size: 55, mtimeMs: 66, headHash: 'automation-main' } },
          { id: 'automation-already', status: 'queued', requiredHosters: ['byse.sx', 'clouddrop.cc', 'removed.example', 'voe.sx'], fingerprint: { size: 55, mtimeMs: 66, headHash: 'automation-main' } },
          { id: 'automation-running-sibling', status: 'uploading', requiredHosters: ['byse.sx', 'clouddrop.cc', 'removed.example', 'voe.sx'], fingerprint: { size: 55, mtimeMs: 66, headHash: 'automation-main' } }
        ]
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
        feedback: ['Telemetry could not be saved.']
      },
      watcherError: {
        result: { ok: false, warning: null, error: 'Jobs konnten nicht hinzugefügt werden.' },
        feedback: ['Jobs could not be added.']
      },
      modalWarning: {
        result: { ok: false, warning: 'Telemetrie konnte nicht gespeichert werden.', error: null },
        feedback: ['Telemetry could not be saved.'],
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
      manualPreviewJobs: 1,
      automaticApplied: 0,
      startCalls: 0,
      injectCalls: 0
    });
    assert.equal(result.automationControlCenter.initial.cardImmediatelyAfterHeader, true);
    assert.equal(result.automationControlCenter.initial.stateBadge.text, 'Aktiv');
    assert.equal(result.automationControlCenter.initial.stateBadge.classes.includes('state-active'), true);
    assert.equal(result.automationControlCenter.initial.queueMeter, '8.420 / 15.000');
    assert.equal(result.automationControlCenter.initial.lastErrorHidden, true);
    assert.equal(result.automationControlCenter.initial.queueLimitDefault, '15000');
    assert.equal(result.automationControlCenter.initial.queueLimitMin, '0');
    assert.equal(result.automationControlCenter.initial.queueLimitAcceptsZero, true);
    assert.equal(result.automationControlCenter.initial.intervalDefault, '5');
    assert.deepEqual(result.automationControlCenter.initial.intervalOptions, ['1', '5', '15', '30', '60']);
    assert.equal(result.automationControlCenter.initial.snapshotFrozen, true);
    assert.equal(result.automationControlCenter.initial.startedAt, 1787709000000);
    assert.equal(result.automationControlCenter.initial.nextReconcileAt, 1787712723456);
    assert.deepEqual(result.automationControlCenter.noRendererTimeEstimate, { startedAt: null, nextReconcileAt: null });
    assert.deepEqual(result.automationControlCenter.states, [
      { state: 'inactive', expectedLabel: 'Inaktiv', text: 'Inaktiv', classApplied: true },
      { state: 'active', expectedLabel: 'Aktiv', text: 'Aktiv', classApplied: true },
      { state: 'paused', expectedLabel: 'Pausiert', text: 'Pausiert', classApplied: true },
      { state: 'queue-limited', expectedLabel: 'Queue-Limit erreicht', text: 'Queue-Limit erreicht', classApplied: true },
      { state: 'disconnected', expectedLabel: 'Ordner getrennt', text: 'Ordner getrennt', classApplied: true },
      { state: 'error', expectedLabel: 'Fehler', text: 'Fehler', classApplied: true }
    ]);
    assert.deepEqual(result.automationControlCenter.unlimitedQueueAria, { now: null, max: null, text: '8.420 / Unbegrenzt' });
    assert.deepEqual(result.automationControlCenter.finiteQueueAria, { now: '8420', max: '15000', text: '8.420 / 15.000' });
    assert.deepEqual(result.automationControlCenter.overLimitQueueAria, { meter: '15.001 / 15.000', now: '15000', max: '15000', text: '15.001 / 15.000' });
    assert.equal(result.automationControlCenter.localizedStatusError, 'Folder scan failed');
    assert.deepEqual(result.automationControlCenter.pausedControls, {
      snapshotCalls: 1,
      pauseButtonDisabled: false,
      pauseButtonText: 'Fortsetzen',
      pauseButtonLabel: 'Fortsetzen',
      pauseButtonGreen: true,
      pauseButtonFits: true,
      startDisabled: {
        startUploadBtn: true,
        startSelectedBtn: true,
        reuploadSelectedBtn: true,
        retryFailedBtn: true
      },
      contextStartDisabled: 'true',
      contextRetryDisabled: 'true'
    });
    assert.deepEqual(result.automationControlCenter.pauseResumeActions, {
      calls: ['resume', 'pause'],
      resumedLabel: 'Abschließen und pausieren',
      startDisabledAfterResume: {
        startUploadBtn: false,
        startSelectedBtn: false,
        reuploadSelectedBtn: false,
        retryFailedBtn: false
      },
      restoredPreviewPresent: true,
      restoredPreviewStatus: 'preview',
      restoredPreviewByteIdentical: true,
      resumeStartCalls: 0,
      resumeAddCalls: 0,
      pausedLabel: 'Fortsetzen',
      pausedLabelEnglish: 'Resume',
      configPaused: true
    });
    assert.deepEqual(result.automationControlCenter.loading, {
      visible: true,
      busy: 'true',
      spinnerVisible: true,
      focusInside: true,
      backgroundInert: true
    });
    assert.deepEqual(result.automationControlCenter.completed, {
      metricValues: {
        found: '4',
        filterMatched: '3',
        alreadyProcessed: '1',
        unavailable: '1',
        sizeLimitedJobs: '0',
        acceptedFiles: '1',
        selectedTargets: '1',
        resultingJobs: '1',
        availableSlots: '6.580',
        deferredFiles: '0'
      },
      metricCount: 10,
      germanMetricLabels: [
        'Gefundene Dateien',
        'Passend zum Dateifilter',
        'Bereits verarbeitet',
        'Fehlend, leer oder nicht lesbar',
        'Durch Größenlimits ausgeschlossen',
        'Akzeptierte Dateien',
        'Ausgewählte Ziele',
        'Entstehende Upload-Jobs',
        'Verfügbare Jobs bis zum Queue-Limit',
        'Aktuell zurückzustellende Dateien'
      ],
      errorHidden: true,
      actionIds: ['automationTestCloseBtn'],
      mutationFree: true
    });
    assert.deepEqual(result.automationControlCenter.english, {
      queueMeter: '8,420 / 15,000',
      availableSlots: '6,580',
      metricLabels: [
        'Files found',
        'Matching file filter',
        'Already processed',
        'Missing, empty, or unreadable',
        'Excluded by size limits',
        'Accepted files',
        'Selected destinations',
        'Resulting upload jobs',
        'Available jobs before queue limit',
        'Files currently deferred'
      ]
    });
    assert.deepEqual(result.automationControlCenter.closed, {
      hidden: true,
      focusReturned: true,
      backgroundRestored: true
    });
    assert.deepEqual(result.automationControlCenter.errorState, {
      visible: true,
      text: 'Ordnerüberwachung konnte nicht getestet werden.',
      secretExposed: false
    });
    assert.deepEqual(result.automationControlCenter.cancelLoading, {
      hidden: true,
      enabledAfterCancel: true,
      lateResultStayedClosed: true
    });
    assert.equal(result.automationControlCenterWideLayout.documentOverflow, false);
    assert.equal(result.automationControlCenterWideLayout.cardOverflow, false);
    assert.equal(result.automationControlCenterWideLayout.metricsOverflow, false);
    assert.equal(result.automationControlCenterWideLayout.tabularNumbers, true);
    assert.ok(result.automationControlCenterWideLayout.gridTemplateColumns);
    assert.equal(result.automationControlCenterNarrowLayout.viewportWidth, 760);
    assert.equal(result.automationControlCenterNarrowLayout.documentOverflow, false);
    assert.equal(result.automationControlCenterNarrowLayout.cardOverflow, false);
    assert.equal(result.automationControlCenterNarrowLayout.metricsOverflow, false);
    assert.equal(result.automationControlCenterNarrowLayout.tabularNumbers, true);
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
    assert.equal(result.onlineBackupNarrowLayout.innerWidth, 760);
    assert.equal(result.onlineBackupNarrowLayout.narrowMedia, true);
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

test('persisted automation pause survives runtime restart and resumes one reconciliation without starting previews', { skip: process.platform !== 'win32' }, () => {
  const projectRoot = path.join(__dirname, '..');
  const mainSource = fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8').replace(/\r\n?/gu, '\n');
  const startUploadStart = mainSource.indexOf("ipcMain.handle('start-upload'");
  const startUploadEnd = mainSource.indexOf("\nipcMain.handle('cancel-upload'", startUploadStart);
  const addJobsStart = mainSource.indexOf("ipcMain.handle('add-jobs-to-batch'");
  const addJobsEnd = mainSource.indexOf("\nipcMain.handle('finish-after-active'", addJobsStart);
  const automationStart = mainSource.indexOf('const automationLifecycleQueue = []');
  const automationEnd = mainSource.indexOf("\nipcMain.handle('folder-monitor:select-folder'", automationStart);
  const startupStart = mainSource.indexOf('  try {\n    const launchConfig = configStore.load();');
  const startupEnd = mainSource.indexOf('\n  // Auto-start remote server', startupStart);
  assert.notEqual(startUploadStart, -1);
  assert.notEqual(startUploadEnd, -1);
  assert.notEqual(addJobsStart, -1);
  assert.notEqual(addJobsEnd, -1);
  assert.notEqual(automationStart, -1);
  assert.notEqual(automationEnd, -1);
  assert.notEqual(startupStart, -1);
  assert.notEqual(startupEnd, -1);
  const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mhu-automation-pause-ipc-'));
  const probePath = path.join(probeRoot, 'probe.cjs');
  const preloadPath = path.join(probeRoot, 'preload.cjs');
  const rendererPath = path.join(probeRoot, 'renderer.html');
  const outputPath = path.join(probeRoot, 'result.json');
  const userDataPath = path.join(probeRoot, 'user-data');
  const watchPath = path.join(probeRoot, 'watch');
  fs.mkdirSync(watchPath);
  fs.writeFileSync(path.join(watchPath, 'manual-preview.mkv'), Buffer.from('preview'));
  fs.writeFileSync(preloadPath, `
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('restartProbe', {
  status: () => ipcRenderer.invoke('automation:get-status'),
  testScan: () => ipcRenderer.invoke('folder-monitor:test-scan'),
  startMonitor: settings => ipcRenderer.invoke('folder-monitor:start', settings),
  reconcile: () => ipcRenderer.invoke('folder-monitor:reconcile'),
  start: job => ipcRenderer.invoke('start-upload', { files: [], hosters: [], jobs: [job] }),
  extend: job => ipcRenderer.invoke('add-jobs-to-batch', { jobs: [job], sourceCleanupGroups: [] }),
  resume: () => ipcRenderer.invoke('automation:resume'),
  pause: () => ipcRenderer.invoke('automation:pause-after-active'),
  counters: () => ipcRenderer.invoke('probe:counters'),
  waitCleanup: () => ipcRenderer.invoke('probe:wait-cleanup'),
  releaseCleanup: () => ipcRenderer.invoke('probe:release-cleanup')
});
`, 'utf8');
  fs.writeFileSync(rendererPath, `<!doctype html><html><body><script>
(async () => {
  const captureFailure = async operation => {
    try {
      return { ok: true, value: await operation() };
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    }
  };
  const preview = {
    id: 'manual-preview',
    file: 'C:\\\\manual\\\\preview.mkv',
    fileName: 'preview.mkv',
    hoster: 'doodstream.com',
    status: 'preview'
  };
  const initial = await window.restartProbe.status();
  const testScan = await window.restartProbe.testScan();
  const monitorStart = await window.restartProbe.startMonitor({ folderPath: 'C:\\\\blocked' });
  const reconcile = await captureFailure(() => window.restartProbe.reconcile());
  const start = await window.restartProbe.start(preview);
  const extend = await window.restartProbe.extend(preview);
  const beforeResume = await window.restartProbe.counters();
  const resume = await window.restartProbe.resume();
  const afterResume = await window.restartProbe.counters();
  const lateJob = {
    id: 'late-add',
    file: 'C:\\\\manual\\\\late-add.mkv',
    fileName: 'late-add.mkv',
    hoster: 'doodstream.com',
    status: 'preview'
  };
  const latePromise = window.restartProbe.extend(lateJob);
  await window.restartProbe.waitCleanup();
  const pause = await window.restartProbe.pause();
  await window.restartProbe.releaseCleanup();
  const late = await latePromise;
  const final = await window.restartProbe.counters();
  window.__automationRestartResult = {
    initial,
    testScan,
    monitorStart,
    reconcile,
    start,
    extend,
    previewStatus: preview.status,
    beforeResume,
    resume,
    afterResume,
    pause,
    late,
    final
  };
})().catch(error => { window.__automationRestartResult = { error: error.stack || error.message || String(error) }; });
</script></body></html>`, 'utf8');
  const productionHandlers = `${mainSource.slice(startUploadStart, startUploadEnd)}\n${mainSource.slice(addJobsStart, addJobsEnd)}`;
  const automationHandlers = mainSource.slice(automationStart, automationEnd);
  const startupAutomation = mainSource.slice(startupStart, startupEnd);
  const probeSource = `
const { app, BrowserWindow, ipcMain } = require('electron');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const ConfigStore = require(${JSON.stringify(path.join(projectRoot, 'lib', 'config-store.js'))});
const FolderMonitor = require(${JSON.stringify(path.join(projectRoot, 'lib', 'folder-monitor.js'))});
const { normalizeAutomationSettings } = require(${JSON.stringify(path.join(projectRoot, 'lib', 'automation-control.js'))});
const outputPath = process.env.MHU_AUTOMATION_OUTPUT;
const rendererPath = process.env.MHU_AUTOMATION_RENDERER;
const preloadPath = process.env.MHU_AUTOMATION_PRELOAD;
const watchPath = process.env.MHU_AUTOMATION_WATCH;
app.setPath('userData', process.env.MHU_AUTOMATION_USER_DATA);
let configStore;
let closeFlushRequested = false;
let folderMonitorLifecycleGeneration = 0;
let folderMonitorRendererGeneration = 1;
let folderMonitorRendererReadyGeneration = null;
let folderMonitorStartupReconcile = null;
let quitTeardownStarted = false;
const settingsImportGate = { canStartUpload: () => true };
const sentEvents = [];
const intervalCallbacks = new Set();
const timeoutCallbacks = new Set();
let watcherStarts = 0;
let watcherCloseCalls = 0;
let walkCalls = 0;
let addJobsCalls = 0;
let startBatchCalls = 0;
let finishCalls = 0;
let stoppingAfterActive = true;
let cleanupRelease;
let cleanupStartedResolve;
const cleanupStarted = new Promise(resolve => { cleanupStartedResolve = resolve; });
const folderMonitor = new FolderMonitor({
  watch: () => {
    watcherStarts++;
    const watcher = new EventEmitter();
    watcher.close = async () => { watcherCloseCalls++; };
    return watcher;
  },
  access: fs.promises.access,
  walkFolder: async folderPath => {
    walkCalls++;
    const filePath = path.join(folderPath, 'manual-preview.mkv');
    return [{ path: filePath, name: 'manual-preview.mkv', size: fs.statSync(filePath).size }];
  },
  stat: fs.promises.stat,
  setIntervalFn: callback => {
    intervalCallbacks.add(callback);
    return callback;
  },
  clearIntervalFn: callback => intervalCallbacks.delete(callback),
  setTimeoutFn: callback => {
    timeoutCallbacks.add(callback);
    return callback;
  },
  clearTimeoutFn: callback => timeoutCallbacks.delete(callback)
});
const safeSend = (channel, payload) => sentEvents.push({ channel, payload });
const debugLog = () => {};
const makeAccountPicker = () => ({});
const persistRotation = () => {};
const buildUploadTasksFromJobs = (_config, jobs) => jobs.map(job => ({
  jobId: job.id,
  file: job.file,
  hoster: job.hoster
}));
const appendUploadPlanAudit = async () => {};
const summarizeBatchPlan = ({ jobs = [] } = {}) => ({
  fileCount: jobs.length,
  destinationCount: jobs.length,
  plannedUploadCount: jobs.length
});
let uploadManager = {
  running: true,
  sourceFileCleanup: {
    registerGroups: async () => {
      cleanupStartedResolve();
      await new Promise(resolve => { cleanupRelease = resolve; });
      return {};
    },
    markSkipped: () => {}
  },
  addJobs: tasks => {
    addJobsCalls++;
    return { added: tasks.length, alreadyInBatchJobIds: [] };
  },
  isStoppingAfterActive: () => stoppingAfterActive,
  resumeAfterActive: () => { stoppingAfterActive = false; },
  startBatch: () => {
    startBatchCalls++;
    return Promise.resolve();
  },
  finishAfterActive: () => {
    finishCalls++;
    stoppingAfterActive = true;
  }
};
${productionHandlers}
${automationHandlers}
ipcMain.handle('probe:counters', () => ({
  watcherStarts,
  watcherCloseCalls,
  intervalCount: intervalCallbacks.size,
  timeoutCount: timeoutCallbacks.size,
  walkCalls,
  addJobsCalls,
  startBatchCalls,
  finishCalls,
  newFileEvents: sentEvents.filter(event => event.channel === 'folder-monitor:new-files').length,
  configPaused: configStore.load().globalSettings.folderMonitor.paused === true,
  monitor: folderMonitor.status()
}));
ipcMain.handle('probe:wait-cleanup', async () => {
  await cleanupStarted;
  return true;
});
ipcMain.handle('probe:release-cleanup', () => {
  if (cleanupRelease) cleanupRelease();
  return true;
});
app.whenReady().then(async () => {
  const initialStore = new ConfigStore(app);
  const current = initialStore.load();
  await initialStore.save({
    globalSettings: {
      ...current.globalSettings,
      folderMonitor: {
        ...current.globalSettings.folderMonitor,
        enabled: true,
        folderPath: watchPath,
        recursive: true,
        extensions: 'mkv',
        filterMode: 'include',
        hosters: ['doodstream.com'],
        paused: true,
        pausedAt: 1787712000000
      }
    }
  });
  configStore = new ConfigStore(app);
  const restartedSettings = configStore.load().globalSettings.folderMonitor;
${startupAutomation}
  const pausedStartup = {
    configPaused: restartedSettings.paused === true,
    pausedAt: restartedSettings.pausedAt,
    watcherStarts,
    intervalCount: intervalCallbacks.size,
    walkCalls
  };
  const window = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: preloadPath }
  });
  await window.loadFile(rendererPath);
  let result = null;
  for (let attempt = 0; attempt < 200; attempt++) {
    result = await window.webContents.executeJavaScript('window.__automationRestartResult || null');
    if (result) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  fs.writeFileSync(outputPath, JSON.stringify({ hidden: window.isVisible() === false, pausedStartup, result }), 'utf8');
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
    const probeEnvironment = {
      ...process.env,
      MHU_AUTOMATION_OUTPUT: outputPath,
      MHU_AUTOMATION_RENDERER: rendererPath,
      MHU_AUTOMATION_PRELOAD: preloadPath,
      MHU_AUTOMATION_USER_DATA: userDataPath,
      MHU_AUTOMATION_WATCH: watchPath
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
    const outcome = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    assert.equal(outcome.error, undefined);
    assert.equal(outcome.hidden, true);
    assert.deepEqual(outcome.pausedStartup, {
      configPaused: true,
      pausedAt: 1787712000000,
      watcherStarts: 0,
      intervalCount: 0,
      walkCalls: 0
    });
    assert.equal(outcome.result.error, undefined);
    assert.equal(outcome.result.initial.paused, true);
    assert.equal(outcome.result.testScan.reachable, true);
    assert.equal(outcome.result.testScan.trigger, 'test');
    assert.equal(outcome.result.testScan.files.length, 1);
    assert.equal(outcome.result.testScan.files[0].name, 'manual-preview.mkv');
    assert.deepEqual(outcome.result.monitorStart, { error: 'Automatik ist pausiert' });
    assert.equal(outcome.result.reconcile.ok, true);
    assert.deepEqual(outcome.result.reconcile.value, { error: 'Automatik ist pausiert' });
    assert.deepEqual(outcome.result.start, { error: 'Automatik ist pausiert' });
    assert.deepEqual(outcome.result.extend, { error: 'Automatik ist pausiert' });
    assert.equal(outcome.result.previewStatus, 'preview');
    assert.equal(outcome.result.beforeResume.watcherStarts, 0);
    assert.equal(outcome.result.beforeResume.intervalCount, 0);
    assert.equal(outcome.result.beforeResume.walkCalls, 1);
    assert.equal(outcome.result.resume.paused, false);
    assert.equal(outcome.result.afterResume.watcherStarts, 1);
    assert.equal(outcome.result.afterResume.intervalCount, 1);
    assert.equal(outcome.result.afterResume.walkCalls, 2);
    assert.equal(outcome.result.afterResume.newFileEvents, 1);
    assert.equal(outcome.result.afterResume.addJobsCalls, 0);
    assert.equal(outcome.result.afterResume.startBatchCalls, 0);
    assert.equal(outcome.result.afterResume.monitor.lastScanTrigger, 'resume');
    assert.deepEqual(outcome.result.late, { error: 'Automatik ist pausiert' });
    assert.equal(outcome.result.pause.paused, true);
    assert.equal(outcome.result.final.addJobsCalls, 0);
    assert.equal(outcome.result.final.startBatchCalls, 0);
    assert.equal(outcome.result.final.finishCalls, 1);
    assert.equal(outcome.result.final.watcherCloseCalls, 1);
    assert.equal(outcome.result.final.intervalCount, 0);
    assert.equal(outcome.result.final.walkCalls, 2);
    assert.equal(outcome.result.final.configPaused, true);
    assert.equal(outcome.result.final.monitor.paused, true);
    assert.equal(outcome.result.final.monitor.running, false);
  } finally {
    fs.rmSync(probeRoot, { recursive: true, force: true });
  }
});

function runStartupHandshakeScenario(scenario) {
  const projectRoot = path.join(__dirname, '..');
  const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), `mhu-startup-${scenario}-`));
  try {
    const appRoot = path.join(probeRoot, 'app');
    const userDataPath = path.join(probeRoot, 'user-data');
    const outputPath = path.join(probeRoot, 'result.json');
    const watchPath = path.join(probeRoot, 'watch');
    fs.mkdirSync(appRoot, { recursive: true });
    fs.mkdirSync(watchPath, { recursive: true });
    fs.writeFileSync(path.join(watchPath, 'scenario-ready.mkv'), Buffer.alloc(23, 6));
    for (const relativePath of ['main.js', 'preload.js', 'preload-drop-target.js', 'package.json']) {
      fs.copyFileSync(path.join(projectRoot, relativePath), path.join(appRoot, relativePath));
    }
    for (const relativePath of ['lib', 'renderer', 'assets']) {
      fs.cpSync(path.join(projectRoot, relativePath), path.join(appRoot, relativePath), { recursive: true });
    }
    if (scenario === 'init-recovery') {
      const rendererAppPath = path.join(appRoot, 'renderer', 'app.js');
      const rendererSource = fs.readFileSync(rendererAppPath, 'utf8');
      fs.writeFileSync(rendererAppPath, rendererSource.replace(
        'async function init() {',
        "async function init() {\n  if (sessionStorage.getItem('startup-init-failed') !== 'true') { sessionStorage.setItem('startup-init-failed', 'true'); throw new Error('forced renderer init failure'); }"
      ));
    }
    fs.symlinkSync(path.join(projectRoot, 'node_modules'), path.join(appRoot, 'node_modules'), 'junction');
    const probePath = path.join(appRoot, 'scenario-probe.cjs');
    const probeSource = `
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const ConfigStore = require('./lib/config-store');
const FolderMonitor = require('./lib/folder-monitor');
const scenario = process.env.MHU_STARTUP_SCENARIO;
const outputPath = process.env.MHU_STARTUP_SCENARIO_OUTPUT;
const userDataPath = process.env.MHU_STARTUP_SCENARIO_USER_DATA;
const watchPath = process.env.MHU_STARTUP_SCENARIO_WATCH;
app.setPath('userData', userDataPath);
BrowserWindow.prototype.show = function () {};
const rendererGenerations = [];
const originalLoadFile = BrowserWindow.prototype.loadFile;
BrowserWindow.prototype.loadFile = function (...args) {
  const originalSend = this.webContents.send.bind(this.webContents);
  this.webContents.send = (channel, ...payload) => {
    if (channel === 'folder-monitor:renderer-generation') rendererGenerations.push(payload[0]);
    return originalSend(channel, ...payload);
  };
  return originalLoadFile.apply(this, args);
};
let monitorStartedResolve;
const monitorStarted = new Promise(resolve => { monitorStartedResolve = resolve; });
let getConfigStartedResolve;
const getConfigStarted = new Promise(resolve => { getConfigStartedResolve = resolve; });
let releaseConfig;
const configRelease = new Promise(resolve => { releaseConfig = resolve; });
let startupScanCalls = 0;
let getConfigCalls = 0;
const originalStart = FolderMonitor.prototype.start;
FolderMonitor.prototype.start = function (...args) {
  const result = originalStart.apply(this, args);
  monitorStartedResolve();
  return result;
};
const originalScan = FolderMonitor.prototype.scan;
FolderMonitor.prototype.scan = function (options = {}) {
  if (options.trigger === 'startup' && options.emitFiles === true) startupScanCalls++;
  return originalScan.call(this, options);
};
const readySignals = { folder: 0, close: 0 };
let folderReadyHandler = null;
const originalOn = ipcMain.on.bind(ipcMain);
ipcMain.on = (channel, handler) => {
  if (channel === 'folder-monitor:renderer-ready') folderReadyHandler = handler;
  return originalOn(channel, function (event, ...args) {
    if (channel === 'folder-monitor:renderer-ready') readySignals.folder++;
    if (channel === 'app:close-handshake-ready') readySignals.close++;
    return handler.call(this, event, ...args);
  });
};
const originalHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => originalHandle(channel, async function (event, ...args) {
  if (channel === 'get-config') {
    getConfigCalls++;
    getConfigStartedResolve();
    if (scenario !== 'init-recovery') await configRelease;
  }
  return handler.call(this, event, ...args);
});

async function waitFor(read, timeoutMs = 20000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('startup scenario probe timed out');
}

(async () => {
  const store = new ConfigStore(app);
  const current = store.load();
  await store.save({
    globalSettings: {
      ...current.globalSettings,
      language: 'en',
      logVerbose: false,
      logFilePath: path.join(userDataPath, 'fileuploader.log'),
      folderMonitor: {
        ...current.globalSettings.folderMonitor,
        enabled: true,
        folderPath: watchPath,
        recursive: true,
        extensions: 'mkv',
        filterMode: 'include',
        skipDuplicates: true,
        includeExisting: false,
        autoStart: false,
        hosters: ['doodstream.com'],
        queueLimitJobs: 15000,
        reconcileIntervalMinutes: 60,
        paused: false,
        pausedAt: null
      }
    }
  });
  require('./main.js');
  await app.whenReady();
  const window = await waitFor(async () => BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed()) || null);
  await monitorStarted;
  if (scenario !== 'init-recovery') await getConfigStarted;
  let initFailureVisible = false;
  if (scenario === 'init-recovery') {
    initFailureVisible = await waitFor(async () => {
      try {
        return await window.webContents.executeJavaScript("sessionStorage.getItem('startup-init-failed') === 'true'");
      } catch {
        return false;
      }
    });
    window.webContents.reload();
    await waitFor(async () => readySignals.folder === 1 && readySignals.close === 1 && startupScanCalls === 1);
  } else {
    if (scenario === 'pending-close') window.emit('closed');
    if (scenario === 'pending-shutdown') app.emit('will-quit');
    folderReadyHandler({ sender: window.webContents }, rendererGenerations[0]);
    releaseConfig();
    await waitFor(async () => readySignals.close === 1);
  }
  let rendererState = null;
  if (scenario === 'init-recovery') {
    rendererState = await waitFor(async () => {
      try {
        const state = await window.webContents.executeJavaScript("(() => { if (typeof queueJobs === 'undefined' || typeof automationEventQueue === 'undefined') return null; return { candidateNames: queueJobs.filter(job => job.fileName === 'scenario-ready.mkv').map(job => job.fileName), draining: Boolean(automationEventDrainPromise), pendingCandidates: automationEventQueue.size }; })()");
        return state && !state.draining && state.pendingCandidates === 0 ? state : null;
      } catch {
        return null;
      }
    });
  }
  fs.writeFileSync(outputPath, JSON.stringify({
    hidden: window.isVisible() === false,
    scenario,
    initFailureVisible,
    readySignals,
    startupScanCalls,
    getConfigCalls,
    rendererGenerations,
    rendererState
  }), 'utf8');
  window.destroy();
  app.exit(0);
})().catch(error => {
  fs.writeFileSync(outputPath, JSON.stringify({ error: error.stack || String(error), scenario, readySignals, startupScanCalls, getConfigCalls, rendererGenerations }), 'utf8');
  app.exit(1);
});
`;
    fs.writeFileSync(probePath, probeSource, 'utf8');
    const electronPath = path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
    const probeEnvironment = {
      ...process.env,
      MHU_PERF: '0',
      MHU_STARTUP_SCENARIO: scenario,
      MHU_STARTUP_SCENARIO_OUTPUT: outputPath,
      MHU_STARTUP_SCENARIO_USER_DATA: userDataPath,
      MHU_STARTUP_SCENARIO_WATCH: watchPath
    };
    delete probeEnvironment.RUN_UI_SMOKE;
    const execution = spawnSync(electronPath, [probePath, `--user-data-dir=${userDataPath}`], {
      cwd: appRoot,
      env: probeEnvironment,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60000
    });
    const probeOutput = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '';
    assert.equal(execution.status, 0, `${execution.stdout}\n${execution.stderr}\n${probeOutput}`);
    return JSON.parse(probeOutput);
  } finally {
    fs.rmSync(probeRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    assert.equal(fs.existsSync(probeRoot), false);
  }
}

test('hidden renderer init failure leaves startup pending for one successful reload generation', { skip: process.platform !== 'win32' }, () => {
  const outcome = runStartupHandshakeScenario('init-recovery');
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.hidden, true);
  assert.equal(outcome.initFailureVisible, true);
  assert.deepEqual(outcome.readySignals, { folder: 1, close: 1 });
  assert.equal(outcome.startupScanCalls, 1);
  assert.equal(outcome.getConfigCalls, 1);
  assert.deepEqual(outcome.rendererGenerations, [1, 2]);
  assert.deepEqual(outcome.rendererState.candidateNames, ['scenario-ready.mkv']);
});

for (const scenario of ['pending-close', 'pending-shutdown']) {
  test(`hidden ${scenario} invalidates startup pending before renderer readiness`, { skip: process.platform !== 'win32' }, () => {
    const outcome = runStartupHandshakeScenario(scenario);
    assert.equal(outcome.error, undefined);
    assert.equal(outcome.hidden, true);
    assert.deepEqual(outcome.readySignals, { folder: 1, close: 1 });
    assert.equal(outcome.startupScanCalls, 0);
    assert.equal(outcome.getConfigCalls, 1);
    assert.deepEqual(outcome.rendererGenerations, [1]);
  });
}

test('real startup releases one productive reconcile only after the folder candidate listener is ready', { skip: process.platform !== 'win32' }, () => {
  const projectRoot = path.join(__dirname, '..');
  const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mhu-startup-ready-e2e-'));
  try {
    const appRoot = path.join(probeRoot, 'app');
    const userDataPath = path.join(probeRoot, 'user-data');
    const outputPath = path.join(probeRoot, 'result.json');
    const watchPath = path.join(probeRoot, 'watch');
    fs.mkdirSync(appRoot, { recursive: true });
    fs.mkdirSync(watchPath, { recursive: true });
    fs.writeFileSync(path.join(watchPath, 'startup-ready.mkv'), Buffer.alloc(19, 5));
    for (const relativePath of ['main.js', 'preload.js', 'preload-drop-target.js', 'package.json']) {
      fs.copyFileSync(path.join(projectRoot, relativePath), path.join(appRoot, relativePath));
    }
    for (const relativePath of ['lib', 'renderer', 'assets']) {
      fs.cpSync(path.join(projectRoot, relativePath), path.join(appRoot, relativePath), { recursive: true });
    }
    fs.symlinkSync(path.join(projectRoot, 'node_modules'), path.join(appRoot, 'node_modules'), 'junction');
    const probePath = path.join(appRoot, 'startup-ready-probe.cjs');
    const probeSource = `
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const ConfigStore = require('./lib/config-store');
const FolderMonitor = require('./lib/folder-monitor');
const outputPath = process.env.MHU_STARTUP_READY_OUTPUT;
const userDataPath = process.env.MHU_STARTUP_READY_USER_DATA;
const watchPath = process.env.MHU_STARTUP_READY_WATCH;
app.setPath('userData', userDataPath);
BrowserWindow.prototype.show = function () {};
const rendererGenerations = [];
const originalLoadFile = BrowserWindow.prototype.loadFile;
BrowserWindow.prototype.loadFile = function (...args) {
  const originalSend = this.webContents.send.bind(this.webContents);
  this.webContents.send = (channel, ...payload) => {
    if (channel === 'folder-monitor:renderer-generation') rendererGenerations.push(payload[0]);
    return originalSend(channel, ...payload);
  };
  return originalLoadFile.apply(this, args);
};
let monitorStartedResolve;
const monitorStarted = new Promise(resolve => { monitorStartedResolve = resolve; });
let getConfigStartedResolve;
const getConfigStarted = new Promise(resolve => { getConfigStartedResolve = resolve; });
let getConfigCalls = 0;
let releaseConfig;
const configRelease = new Promise(resolve => { releaseConfig = resolve; });
let startupScanSettledResolve;
const startupScanSettled = new Promise(resolve => { startupScanSettledResolve = resolve; });
let startupScanCalls = 0;
let startupScanSettledCalls = 0;
const originalStart = FolderMonitor.prototype.start;
FolderMonitor.prototype.start = function (...args) {
  const result = originalStart.apply(this, args);
  monitorStartedResolve();
  return result;
};
const originalScan = FolderMonitor.prototype.scan;
FolderMonitor.prototype.scan = function (options = {}) {
  const result = originalScan.call(this, options);
  if (options.trigger === 'startup' && options.emitFiles === true) {
    startupScanCalls++;
    Promise.resolve(result).finally(() => {
      startupScanSettledCalls++;
      startupScanSettledResolve();
    });
  }
  return result;
};
const readySignals = { folder: 0, close: 0 };
let folderReadyHandler = null;
const originalOn = ipcMain.on.bind(ipcMain);
ipcMain.on = (channel, handler) => {
  if (channel === 'folder-monitor:renderer-ready') folderReadyHandler = handler;
  return originalOn(channel, function (event, ...args) {
    if (channel === 'folder-monitor:renderer-ready') readySignals.folder++;
    if (channel === 'app:close-handshake-ready') readySignals.close++;
    return handler.call(this, event, ...args);
  });
};
const originalHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => originalHandle(channel, async function (event, ...args) {
  if (channel === 'get-config') {
    getConfigCalls++;
    getConfigStartedResolve();
    await configRelease;
  }
  return handler.call(this, event, ...args);
});

async function waitFor(read, timeoutMs = 20000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('startup ready probe timed out');
}

(async () => {
  const store = new ConfigStore(app);
  const current = store.load();
  await store.save({
    globalSettings: {
      ...current.globalSettings,
      language: 'en',
      logVerbose: false,
      logFilePath: path.join(userDataPath, 'fileuploader.log'),
      folderMonitor: {
        ...current.globalSettings.folderMonitor,
        enabled: true,
        folderPath: watchPath,
        recursive: true,
        extensions: 'mkv',
        filterMode: 'include',
        skipDuplicates: true,
        includeExisting: false,
        autoStart: false,
        hosters: ['doodstream.com'],
        queueLimitJobs: 15000,
        reconcileIntervalMinutes: 60,
        paused: false,
        pausedAt: null
      }
    }
  });
  require('./main.js');
  await app.whenReady();
  const window = await waitFor(async () => BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed()) || null);
  await Promise.all([monitorStarted, getConfigStarted]);
  const beforeReady = {
    startupScanCalls,
    startupScanSettledCalls,
    folderReadySignals: readySignals.folder
  };
  const foreign = new BrowserWindow({ show: false });
  await foreign.loadURL('data:text/html,<html></html>');
  folderReadyHandler({ sender: foreign.webContents }, rendererGenerations[0]);
  const afterForeignSignal = startupScanCalls;
  window.webContents.reload();
  await waitFor(async () => getConfigCalls === 2);
  const beforeStaleSignal = startupScanCalls;
  folderReadyHandler({ sender: window.webContents }, rendererGenerations[0]);
  const afterStaleSignal = startupScanCalls;
  releaseConfig();
  await waitFor(async () => readySignals.close === 1);
  await waitFor(async () => startupScanCalls === 1);
  await startupScanSettled;
  const rendererState = await waitFor(async () => {
    try {
      const state = await window.webContents.executeJavaScript("(async () => { if (typeof queueJobs === 'undefined' || typeof automationEventQueue === 'undefined') return null; const monitor = await window.api.folderMonitorStatus(); return { candidateJobs: queueJobs.filter(job => job.fileName === 'startup-ready.mkv'), draining: Boolean(automationEventDrainPromise), pendingCandidates: automationEventQueue.size, monitor }; })()");
      return state && !state.draining && state.pendingCandidates === 0 ? state : null;
    } catch {
      return null;
    }
  });
  window.webContents.reload();
  await waitFor(async () => readySignals.folder === 2 && readySignals.close === 2);
  fs.writeFileSync(outputPath, JSON.stringify({
    hidden: window.isVisible() === false,
    beforeReady,
    readySignals,
    startupScanCalls,
    startupScanSettledCalls,
    getConfigCalls,
    rendererGenerations,
    afterForeignSignal,
    beforeStaleSignal,
    afterStaleSignal,
    rendererState
  }), 'utf8');
  foreign.destroy();
  window.destroy();
  app.exit(0);
})().catch(error => {
  fs.writeFileSync(outputPath, JSON.stringify({ error: error.stack || String(error), readySignals, startupScanCalls, startupScanSettledCalls, getConfigCalls, rendererGenerations }), 'utf8');
  app.exit(1);
});
`;
    fs.writeFileSync(probePath, probeSource, 'utf8');
    const electronPath = path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
    const probeEnvironment = {
      ...process.env,
      MHU_PERF: '0',
      MHU_STARTUP_READY_OUTPUT: outputPath,
      MHU_STARTUP_READY_USER_DATA: userDataPath,
      MHU_STARTUP_READY_WATCH: watchPath
    };
    delete probeEnvironment.RUN_UI_SMOKE;
    const execution = spawnSync(electronPath, [probePath, `--user-data-dir=${userDataPath}`], {
      cwd: appRoot,
      env: probeEnvironment,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60000
    });
    const probeOutput = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '';
    assert.equal(execution.status, 0, `${execution.stdout}\n${execution.stderr}\n${probeOutput}`);
    const outcome = JSON.parse(probeOutput);
    assert.equal(outcome.error, undefined);
    assert.equal(outcome.hidden, true);
    assert.deepEqual({
      beforeReady: outcome.beforeReady,
      readySignals: outcome.readySignals,
      startupScanCalls: outcome.startupScanCalls,
      startupScanSettledCalls: outcome.startupScanSettledCalls,
      getConfigCalls: outcome.getConfigCalls,
      rendererGenerations: outcome.rendererGenerations,
      afterForeignSignal: outcome.afterForeignSignal,
      beforeStaleSignal: outcome.beforeStaleSignal,
      afterStaleSignal: outcome.afterStaleSignal,
      lastScanTrigger: outcome.rendererState.monitor.lastScanTrigger,
      candidateNames: outcome.rendererState.candidateJobs.map(job => job.fileName)
    }, {
      beforeReady: {
        startupScanCalls: 0,
        startupScanSettledCalls: 0,
        folderReadySignals: 0
      },
      readySignals: { folder: 2, close: 2 },
      startupScanCalls: 1,
      startupScanSettledCalls: 1,
      getConfigCalls: 3,
      rendererGenerations: [1, 2, 3],
      afterForeignSignal: 0,
      beforeStaleSignal: 0,
      afterStaleSignal: 0,
      lastScanTrigger: 'startup',
      candidateNames: ['startup-ready.mkv']
    });
  } finally {
    fs.rmSync(probeRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    assert.equal(fs.existsSync(probeRoot), false);
  }
});

test('real app resume keeps the ConfigStore-restored manual preview byte-identical without starting work', { skip: process.platform !== 'win32' }, () => {
  const projectRoot = path.join(__dirname, '..');
  const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mhu-real-resume-e2e-'));
  try {
  const appRoot = path.join(probeRoot, 'app');
  const userDataPath = path.join(probeRoot, 'user-data');
  const outputPath = path.join(probeRoot, 'result.json');
  const previewPath = path.join(probeRoot, 'manual-preview.mkv');
  fs.mkdirSync(appRoot, { recursive: true });
  fs.writeFileSync(previewPath, Buffer.alloc(17, 7));
  for (const relativePath of ['main.js', 'preload.js', 'preload-drop-target.js', 'package.json']) {
    fs.copyFileSync(path.join(projectRoot, relativePath), path.join(appRoot, relativePath));
  }
  for (const relativePath of ['lib', 'renderer', 'assets']) {
    fs.cpSync(path.join(projectRoot, relativePath), path.join(appRoot, relativePath), { recursive: true });
  }
  fs.symlinkSync(path.join(projectRoot, 'node_modules'), path.join(appRoot, 'node_modules'), 'junction');
  const probePath = path.join(appRoot, 'real-resume-probe.cjs');
  const probeSource = `
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const ConfigStore = require('./lib/config-store');
const outputPath = process.env.MHU_REAL_RESUME_OUTPUT;
const userDataPath = process.env.MHU_REAL_RESUME_USER_DATA;
const previewPath = process.env.MHU_REAL_RESUME_PREVIEW;
app.setPath('userData', userDataPath);
BrowserWindow.prototype.show = function () {};
const calls = { resume: 0, start: 0, add: 0 };
let resumeDiagnostic = null;
const originalHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => originalHandle(channel, function (event, ...args) {
  if (channel === 'automation:resume') calls.resume++;
  if (channel === 'start-upload') calls.start++;
  if (channel === 'add-jobs-to-batch') calls.add++;
  return handler.call(this, event, ...args);
});
let rendererReady = 0;
const originalOn = ipcMain.on.bind(ipcMain);
ipcMain.on = (channel, handler) => originalOn(channel, function (event, ...args) {
  if (channel === 'app:close-handshake-ready') rendererReady++;
  return handler.call(this, event, ...args);
});

async function waitFor(read, timeoutMs = 20000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('real resume probe timed out');
}

(async () => {
  const store = new ConfigStore(app);
  const current = store.load();
  await store.save({
    globalSettings: {
      ...current.globalSettings,
      language: 'en',
      resumeQueueOnLaunch: true,
      autoStartRestoredQueue: false,
      logVerbose: false,
      logFilePath: path.join(userDataPath, 'fileuploader.log'),
      pendingQueue: {
        savedAt: 1787712000000,
        selectedUploadHosters: ['doodstream.com'],
        selectedFiles: [],
        completedKeys: [],
        suppressedKeys: [],
        queueJobs: [{
          id: 'real-restored-preview',
          file: previewPath,
          fileName: 'manual-preview.mkv',
          hoster: 'doodstream.com',
          status: 'preview',
          bytesTotal: 17,
          error: null,
          failureDetails: null,
          result: null,
          sourceCleanupToken: 'real-preview-token',
          sourceCleanupRequiredHosters: ['doodstream.com'],
          sourceCleanupCompletedHosters: [],
          sourceCleanupFingerprint: { size: 17, mtimeMs: 1787712000000, headHash: 'real-preview-head' },
          automationAdmission: false,
          maxAttempts: 3
        }]
      },
      folderMonitor: {
        ...current.globalSettings.folderMonitor,
        enabled: false,
        folderPath: '',
        paused: true,
        pausedAt: 1787712000000
      }
    }
  });

  require('./main.js');
  await app.whenReady();
  const window = await waitFor(async () => BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed()) || null);
  await waitFor(async () => rendererReady === 1);
  const readRendererState = async () => {
    try {
      return await window.webContents.executeJavaScript("(() => { const queueReady = typeof queueJobs !== 'undefined'; const apiReady = typeof window.api?.automationResume === 'function'; const snapshotReady = typeof createAutomationStatusSnapshot === 'function'; const job = queueReady ? queueJobs.find(entry => entry.fileName === 'manual-preview.mkv' && entry.hoster === 'doodstream.com') : null; const button = document.getElementById('automationPauseResumeBtn'); const ready = Boolean(queueReady && apiReady && snapshotReady && job && button); return { ready, queueReady, apiReady, snapshotReady, jobPresent: Boolean(job), buttonPresent: Boolean(button), jobJson: job ? JSON.stringify(job) : null, status: job?.status || null, buttonText: button?.textContent.trim() || null, paused: snapshotReady ? createAutomationStatusSnapshot().paused : null, queueIds: queueReady ? queueJobs.map(entry => entry.id) : [], selectedPaths: typeof selectedFiles !== 'undefined' ? selectedFiles.map(entry => entry.path) : [], pendingIds: config?.globalSettings?.pendingQueue?.queueJobs?.map(entry => entry.id) || [], uploading: typeof uploading === 'boolean' ? uploading : null }; })()");
    } catch (error) {
      return { ready: false, executeError: error.message || String(error) };
    }
  };
  const before = await waitFor(async () => {
    const state = await readRendererState();
    return state.ready ? state : null;
  });
  const rendererUrl = window.webContents.getURL();
  await window.webContents.executeJavaScript("document.getElementById('automationPauseResumeBtn').click(); true");
  const after = await waitFor(async () => {
    const state = await readRendererState();
    const persisted = new ConfigStore(app).load().globalSettings.folderMonitor;
    resumeDiagnostic = { state, persistedPaused: persisted.paused, calls: { ...calls } };
    return calls.resume === 1 && state?.ready === true && state.paused === false && persisted.paused === false ? state : null;
  });
  fs.writeFileSync(outputPath, JSON.stringify({
    hidden: window.isVisible() === false,
    rendererUrl,
    before,
    after,
    calls,
    rendererReady,
    persistedPaused: new ConfigStore(app).load().globalSettings.folderMonitor.paused
  }), 'utf8');
  window.destroy();
  app.exit(0);
})().catch(error => {
  fs.writeFileSync(outputPath, JSON.stringify({ error: error.stack || String(error), calls, resumeDiagnostic }), 'utf8');
  app.exit(1);
});
`;
  fs.writeFileSync(probePath, probeSource, 'utf8');
    const electronPath = path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
    const probeEnvironment = {
      ...process.env,
      MHU_PERF: '0',
      MHU_REAL_RESUME_OUTPUT: outputPath,
      MHU_REAL_RESUME_USER_DATA: userDataPath,
      MHU_REAL_RESUME_PREVIEW: previewPath
    };
    delete probeEnvironment.RUN_UI_SMOKE;
    const execution = spawnSync(electronPath, [probePath, `--user-data-dir=${userDataPath}`], {
      cwd: appRoot,
      env: probeEnvironment,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60000
    });
    const probeOutput = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '';
    assert.equal(execution.status, 0, `${execution.stdout}\n${execution.stderr}\n${probeOutput}`);
    const outcome = JSON.parse(probeOutput);
    assert.equal(outcome.error, undefined);
    assert.equal(outcome.hidden, true);
    assert.equal(new URL(outcome.rendererUrl).pathname.replace(/^\/([A-Za-z]:)/u, '$1').split('/').join(path.sep), path.join(appRoot, 'renderer', 'index.html'));
    assert.equal(outcome.before.apiReady, true);
    assert.equal(outcome.before.status, 'preview');
    assert.equal(JSON.parse(outcome.before.jobJson).id, 'real-restored-preview');
    assert.equal(outcome.before.buttonText, 'Resume');
    assert.equal(outcome.before.paused, true);
    assert.equal(outcome.after.status, 'preview');
    assert.equal(outcome.after.buttonText, 'Finish and pause');
    assert.equal(outcome.after.paused, false);
    assert.equal(outcome.after.apiReady, true);
    assert.equal(outcome.after.jobJson, outcome.before.jobJson);
    assert.deepEqual(outcome.calls, { resume: 1, start: 0, add: 0 });
    assert.equal(outcome.rendererReady, 1);
    assert.equal(outcome.persistedPaused, false);
  } finally {
    fs.rmSync(probeRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    assert.equal(fs.existsSync(probeRoot), false);
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
