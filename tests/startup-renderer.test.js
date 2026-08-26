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
  debugLog() {},
  savePendingQueue(payload) {
    folderMonitorProbeCalls.push(['save', payload?.queueJobs?.length || 0]);
    return Promise.resolve(true);
  },
  addJobsToBatch(payload) {
    folderMonitorProbeCalls.push(['inject', payload?.jobs?.length || 0]);
    return Promise.resolve({});
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
    handleFolderMonitorFiles(['C:\\\\folder-monitor-queue-only.mkv']);
    await new Promise(resolve => setTimeout(resolve, 0));
    const queueOnly = {
      statuses: queueJobs.map(job => job.status),
      injectCalls: window.api.getFolderMonitorProbeCalls().filter(call => call[0] === 'inject').length
    };
    resetQueue(true);
    handleFolderMonitorFiles(['C:\\\\folder-monitor-inject.mkv']);
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
