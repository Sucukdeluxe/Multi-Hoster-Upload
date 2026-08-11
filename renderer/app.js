const HOSTERS = ['doodstream.com', 'voe.sx', 'vidmoly.me', 'byse.sx', 'clouddrop.cc'];
const uiLocalizer = window.I18n.createDomLocalizer(document);
uiLocalizer.start('en');

function setUiLanguage(value) {
  return uiLocalizer.setLanguage(window.I18n.normalizeLanguage(value));
}

function getUiLocale() {
  return uiLocalizer.getLanguage() === 'de' ? 'de-DE' : 'en-US';
}

// Dropdown options for "Add Account" modal: value -> label
const HOSTER_ADD_OPTIONS = [
  { value: 'doodstream.com', label: 'Doodstream (Web Login)', hoster: 'doodstream.com', authType: 'login' },
  { value: 'doodstream.com:api', label: 'Doodstream (API)', hoster: 'doodstream.com', authType: 'api' },
  { value: 'voe.sx', label: 'Voe (Web Login)', hoster: 'voe.sx', authType: 'login' },
  { value: 'voe.sx:api', label: 'Voe (API)', hoster: 'voe.sx', authType: 'api' },
  { value: 'vidmoly.me', label: 'Vidmoly (Web Login)', hoster: 'vidmoly.me', authType: 'login' },
  { value: 'byse.sx', label: 'Byse (API)', hoster: 'byse.sx', authType: 'api' },
  { value: 'clouddrop.cc', label: 'Clouddrop (API)', hoster: 'clouddrop.cc', authType: 'api' }
];

// --- State ---
let selectedFiles = []; // { path, name, size }
let selectedUploadHosters = [];
let config = { hosters: {}, hosterSettings: {}, globalSettings: {} };
let hosterSettings = {};
let uploading = false;
let healthCheckRunning = false;

let _rLongTasks = 0, _rLongTaskMax = 0, _rFrameLast = 0, _rFrameWorst = 0, _rFrameCount = 0, _rFrameJank = 0, _rPerfLastLog = 0, _rPerfWindowStart = 0;
function _rElLabel(el) {
  try {
    if (!el || !el.tagName) return '?';
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    else if (el.className && typeof el.className === 'string') { const c = el.className.trim().split(/\s+/)[0]; if (c) s += '.' + c; }
    const a = el.getAttribute && (el.getAttribute('data-action') || el.getAttribute('data-tab') || el.getAttribute('aria-label') || el.getAttribute('title'));
    if (a) s += `[${String(a).slice(0, 24)}]`;
    return s;
  } catch { return '?'; }
}
try {
  if (window.PerformanceObserver) {
    new window.PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        _rLongTasks++;
        if (e.duration > _rLongTaskMax) _rLongTaskMax = e.duration;
        if (e.duration >= 100 && window.api && window.api.debugLog) window.api.debugLog(`renderer-longtask dur=${Math.round(e.duration)}ms`);
      }
    }).observe({ entryTypes: ['longtask'] });
  }
} catch {}
try {
  if (window.PerformanceObserver) {
    new window.PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const proc = Math.round((e.processingEnd || 0) - (e.processingStart || 0));
        if (window.api && window.api.debugLog) window.api.debugLog(`renderer-interaction ${e.name} dur=${Math.round(e.duration)}ms proc=${proc}ms target=${_rElLabel(e.target)}`);
      }
    }).observe({ type: 'event', durationThreshold: 50, buffered: true });
  }
} catch {}
function _rFrameTick(ts) {
  if (_rFrameLast) { const d = ts - _rFrameLast; _rFrameCount++; if (d > _rFrameWorst) _rFrameWorst = d; if (d > 33) _rFrameJank++; }
  _rFrameLast = ts;
  requestAnimationFrame(_rFrameTick);
}
requestAnimationFrame(_rFrameTick);
function _resetRendererPerf() {
  _rPerfWindowStart = Date.now();
  _rFrameCount = 0; _rFrameJank = 0; _rFrameWorst = 0; _rLongTasks = 0; _rLongTaskMax = 0;
}
function _maybeLogRendererPerf(activeJobs) {
  const now = Date.now();
  if (!_rPerfWindowStart) _rPerfWindowStart = now;
  if (now - _rPerfLastLog < 5000) return;
  const winSec = (now - _rPerfWindowStart) / 1000;
  const fps = winSec > 0 ? Math.round(_rFrameCount / winSec) : 0;
  if (window.api && window.api.debugLog) {
    window.api.debugLog(`renderer-perf active=${activeJobs} fps=${fps} jankFrames=${_rFrameJank} worstFrame=${Math.round(_rFrameWorst)}ms longtasks=${_rLongTasks} maxTask=${Math.round(_rLongTaskMax)}ms`);
  }
  _rPerfLastLog = now;
  _resetRendererPerf();
}
let accountStatuses = {}; // { accountId: { status: 'ok'|'warn'|'error'|'checking'|'unchecked', message: '' } }
let editingAccountId = null; // null = adding, string = editing account by ID
let autoHealthCheckEnabled = true;
const queuePersistThrottle = (window.ThrottleTimer && window.ThrottleTimer.makeThrottleTimer)
  ? window.ThrottleTimer.makeThrottleTimer()
  : (function () {
      let h = null;
      let fn = null;
      let burstStart = null;
      function go() { h = null; burstStart = null; const g = fn; fn = null; if (g) g(); }
      return {
        request(f, d, maxWait) {
          if (typeof f === 'function') fn = f;
          const t = Date.now();
          if (burstStart === null) burstStart = t;
          let wait = typeof d === 'number' && d >= 0 ? d : 0;
          if (typeof maxWait === 'number' && maxWait >= 0) {
            const remaining = maxWait - (t - burstStart);
            wait = Math.min(wait, remaining < 0 ? 0 : remaining);
          }
          clearTimeout(h);
          h = setTimeout(go, wait);
        },
        flushSync() { clearTimeout(h); h = null; burstStart = null; const g = fn; fn = null; if (g) g(); },
        cancel() { clearTimeout(h); h = null; burstStart = null; fn = null; },
        isPending() { return h !== null; }
      };
    })();
let configWriteQueue = Promise.resolve();
const failedConfigWriteOperations = [];
let configFlushPromise = null;
let configWriteEpoch = 0;
let configImportInProgress = false;
let closePreparationState = 'open';
let closeWriteAccessDepth = 0;

function createSupersededConfigWriteError() {
  const error = new Error('Einstellungen wurden durch einen Import ersetzt');
  error.code = 'CONFIG_WRITE_SUPERSEDED';
  return error;
}

function createClosedConfigWriteError() {
  const error = new Error('Die Anwendung wird gerade beendet');
  error.code = 'CONFIG_WRITE_CLOSED';
  return error;
}

function beginConfigImport() {
  if (configImportInProgress) throw new Error('Ein Einstellungsimport läuft bereits');
  configImportInProgress = true;
  configWriteEpoch++;
}

function endConfigImport() {
  configImportInProgress = false;
}

function isConfigWriteImportGateError(error) {
  return String(error && error.message ? error.message : error).includes('Einstellungen werden gerade importiert');
}

function retainFailedConfigWrite(operation, epoch, preserveAcrossImport) {
  if (!failedConfigWriteOperations.some(entry => entry.operation === operation)) {
    failedConfigWriteOperations.push({ operation, epoch, preserveAcrossImport });
  }
}

async function retryFailedConfigWrites() {
  while (failedConfigWriteOperations.length > 0) {
    const entry = failedConfigWriteOperations[0];
    if (entry.epoch !== configWriteEpoch && !entry.preserveAcrossImport) {
      failedConfigWriteOperations.shift();
      continue;
    }
    try {
      await entry.operation();
      failedConfigWriteOperations.shift();
    } catch (error) {
      if (isConfigWriteImportGateError(error)) {
        failedConfigWriteOperations.shift();
        continue;
      }
      throw error;
    }
  }
}

function enqueueConfigWriteOperation(operation) {
  const promise = configWriteQueue.then(operation, operation);
  const tail = promise.then(() => undefined, () => undefined);
  configWriteQueue = tail;
  return { promise, tail };
}

function runConfigWrite(operation, options = {}) {
  const epoch = configWriteEpoch;
  const preserveAcrossImport = options.preserveAcrossImport === true;
  const allowedDuringClose = options.allowDuringClose === true || closeWriteAccessDepth > 0;
  const blockedByImport = configImportInProgress && !preserveAcrossImport;
  const blockedByClose = closePreparationState !== 'open' && !allowedDuringClose;
  return enqueueConfigWriteOperation(async () => {
    if (blockedByClose || (closePreparationState === 'sealed' && !allowedDuringClose)) throw createClosedConfigWriteError();
    if (!preserveAcrossImport && (blockedByImport || configImportInProgress || epoch !== configWriteEpoch)) throw createSupersededConfigWriteError();
    try {
      await retryFailedConfigWrites();
    } catch (error) {
      retainFailedConfigWrite(operation, epoch, preserveAcrossImport);
      throw error;
    }
    try {
      return await operation();
    } catch (error) {
      if (!isConfigWriteImportGateError(error)) retainFailedConfigWrite(operation, epoch, preserveAcrossImport);
      throw error;
    }
  }).promise;
}

async function withCloseWriteAccess(operation) {
  closeWriteAccessDepth++;
  try {
    return await operation();
  } finally {
    closeWriteAccessDepth--;
  }
}

function snapshotConfigWritePayload(payload) {
  return structuredClone(payload);
}

function saveConfigTracked(configPatch) {
  const payload = snapshotConfigWritePayload(configPatch);
  return runConfigWrite(() => window.api.saveConfig(payload));
}

function saveHosterSettingsTracked(settings) {
  const payload = snapshotConfigWritePayload(settings);
  return runConfigWrite(() => window.api.saveHosterSettings(payload));
}

function saveGlobalSettingsTracked(settings) {
  const payload = snapshotConfigWritePayload(settings);
  return runConfigWrite(() => window.api.saveGlobalSettings(payload));
}

function savePendingQueueTracked(pendingQueue) {
  const payload = snapshotConfigWritePayload(pendingQueue);
  return runConfigWrite(() => window.api.savePendingQueue(payload), { preserveAcrossImport: true });
}

function setAlwaysOnTopTracked(value) {
  const enabled = !!value;
  return runConfigWrite(() => window.api.setAlwaysOnTop(enabled));
}

function saveDiagnosticsSettingsTracked(settings) {
  const payload = snapshotConfigWritePayload(settings);
  return runConfigWrite(() => window.api.diagnosticsSaveSettings(payload));
}

function saveRemoteSettingsTracked(settings) {
  const payload = snapshotConfigWritePayload(settings);
  return runConfigWrite(() => window.api.remoteSaveSettings(payload));
}

function flushConfigWrites() {
  if (configFlushPromise) return configFlushPromise;
  configFlushPromise = (async () => {
    while (true) {
      const { promise, tail } = enqueueConfigWriteOperation(retryFailedConfigWrites);
      await promise;
      if (configWriteQueue === tail && failedConfigWriteOperations.length === 0) return;
    }
  })();
  configFlushPromise.then(
    () => { configFlushPromise = null; },
    () => { configFlushPromise = null; }
  );
  return configFlushPromise;
}

let _restoredSnapshotSavedAt = null;
let settingsSaveTimer = null;
const settingsSaveCoordinator = window.SerializedRunner.createSerializedRunner(performSaveSettings);
let settingsBaseline = '';
let settingsDirty = false;
let settingsSaving = false;
let lastUploadStats = { state: 'idle', globalSpeedKbs: 0, totalBytes: 0, elapsed: 0, activeJobs: 0 };
const uploadSpeedState = { display: 0, history: [] };
let uploadSpeedTimer = null;
const AUTO_CHECK_PREF_KEY = 'autoHealthCheckBeforeUpload';
const QUEUE_COL_WIDTHS_KEY = 'queueColumnWidthsPx';
const STARTABLE_QUEUE_STATUSES = new Set(['preview', 'queued', 'error', 'aborted', 'skipped']);

function isStartableQueueStatus(status) {
  return STARTABLE_QUEUE_STATUSES.has(status);
}

function isStartableQueueJob(job) {
  return !!job && isStartableQueueStatus(job.status);
}

// Queue state
let queueJobs = []; // { id, file, fileName, hoster, status, bytesUploaded, bytesTotal, speedKbs, elapsed, remaining, error, result, attempt, maxAttempts, link }
const _jobIndexById = new Map(); // id -> job (O(1) lookup)
const _jobIndexByUploadId = new Map(); // uploadId -> job
const selectedJobIds = new Set();
let _sessionTotalBytes = 0; // Total bytes ever added to queue this session
let _sessionUploadedBytes = 0; // Bytes fully uploaded this session (done jobs)
const _sessionTrackedJobs = new Set(); // Job IDs already counted for totalBytes
const _sessionDoneJobs = new Set(); // Job IDs already counted for uploadedBytes
const _completedUploadKeys = new Set(); // 'filepath|hoster' keys for done uploads (survives removeFromQueueOnDone)
const _suppressedPreviewKeys = new Set();
const _deletedJobIds = new Set(); // IDs of jobs explicitly deleted by user (prevents re-creation from stale progress callbacks)
// Coalesce removeFromQueueOnDone removals into one filter pass per microtask
// to avoid O(N²) behaviour when a burst of jobs finish at once. Logic now
// lives in lib/coalesced-set.js so it can be unit-tested with a manual
// scheduler. Optional-chained so the renderer still works if the script
// failed to load — falls back to immediate per-event filter (legacy slow
// path), better than crashing.
const _doneRemovalCoalescer = window.CoalescedSet
  ? window.CoalescedSet.makeCoalescedSet({
      apply: (drop) => { queueJobs = queueJobs.filter(j => !drop.has(j.id)); }
    })
  : null;
const queueSortState = { key: 'filename', direction: 'asc' };
let uploadSidebarFilter = 'all';
let _queueFilterCache = { filter: '', source: null, result: [] };

// History state
let historyRowsData = [];
let historySortState = { key: 'date', direction: 'desc' };
let _historySortClicked = false;
let historySidebarCounts = { total: 0, success: 0, error: 0 };
let accountSidebarFilter = 'all';
let historySidebarFilter = 'all';
let _knownUpdateInfo = null;
let _updateCheckBusy = false;
let _updateInstallBusy = false;
let _updateDialogReturnFocus = null;
let _updateDialogInertState = [];

// Session-specific files for the "Files" panel (resets each session)
let sessionFilesData = [];
let _recentSeqCounter = 0;
let _recentDataVersion = 0;
const recentSortState = { key: 'date', direction: 'desc' };
const selectedRecentIds = new Set();
// Maintained incrementally — avoids O(n) filter() scans every 250ms in the status bar.
let _sessionDoneCount = 0;
let _sessionErrorCount = 0;
// O(1) dedup for maybeAddSessionFile (was O(n) sessionFilesData.some).
// Huge with thousands of rows × thousands of incoming results.
const _sessionFileKeys = new Set();

window.addEventListener('error', (e) => {
  try {
    const msg = `RENDERER ERROR: ${e.message} at ${e.filename}:${e.lineno}:${e.colno}${e.error && e.error.stack ? '\n' + e.error.stack : ''}`;
    if (window.api && window.api.debugLog) window.api.debugLog(msg);
  } catch {}
});
window.addEventListener('unhandledrejection', (e) => {
  try {
    const reason = e.reason && e.reason.stack ? e.reason.stack : (e.reason && e.reason.message) || String(e.reason);
    if (window.api && window.api.debugLog) window.api.debugLog(`RENDERER UNHANDLED REJECTION: ${reason}`);
  } catch {}
});

// --- Init ---
async function init() {
  config = await window.api.getConfig();
  setUiLanguage(config.globalSettings?.language);
  hosterSettings = config.hosterSettings || {};
  autoHealthCheckEnabled = loadAutoCheckPreference();
  ensureAccountStatusEntries();
  syncSelectedUploadHosters();
  restoreQueueStateFromConfig();
  await _autoDeduplicateFromLog();
  _hydrateMissingJobSizes();
  renderHosterSummary();
  renderHosterModal();
  renderSettings();
  renderAccounts();
  setupListeners();
  setupDragDrop();
  initUploadSpeedSparkline();
  restoreQueueColumnWidths();
  loadHistory();
  _refreshSessionFailedSnapshot();
  renderRecentUploadsPanel();
  updateUploadView();
  updateStatusBar();

  // Version display
  try {
    const version = await window.api.getVersion();
    const versionLabel = document.getElementById('versionLabel');
    if (versionLabel) versionLabel.textContent = `v${version}`;
  } catch {}

  window.api.onUploadProgress((data) => {
    handleProgress(data);
  });
  if (window.api.onUploadProgressBatch) {
    window.api.onUploadProgressBatch((batch) => {
      if (!Array.isArray(batch)) return;
      for (let i = 0; i < batch.length; i++) handleProgress(batch[i]);
    });
  }
  window.api.onUploadBatchDone((data) => {
    handleBatchDone(data);
  });
  window.api.onUploadStats((data) => {
    handleStats(data);
  });
  window.api.onShutdownCountdown(handleShutdownCountdown);
  window.api.onUploadLogFallback((data) => {
    const path = data && data.fallbackPath ? data.fallbackPath : '(Fallback)';
    showCopyToast(`Log-Pfad nicht beschreibbar — schreibe nach: ${path}`, 8000);
  });
  window.api.onLogPathAutoUpdated((data) => {
    if (!data || !data.logFilePath) return;
    // Keep the in-memory config and the visible Settings input in sync so
    // the user sees the path that's actually being written to, and the
    // next save from the UI doesn't revert it.
    if (config && config.globalSettings) config.globalSettings.logFilePath = data.logFilePath;
    const input = document.getElementById('logFilePathInput');
    if (input) input.value = data.logFilePath;
    showCopyToast(`Log-Pfad automatisch auf funktionierenden Ordner gesetzt`, 5000);
  });
  window.api.onAccountRotationLog((entry) => {
    // Surface only the user-visible rotation events as toasts; full detail
    // goes to account-rotation.log. Keep it quiet otherwise.
    if (!entry || !entry.event) return;
    const hosterLabel = entry.hoster ? getHosterLabel(entry.hoster) : '';
    if (entry.event === 'rotate') {
      showCopyToast(`${hosterLabel}: Account-Wechsel → Fallback`);
    } else if (entry.event === 'rotation-end') {
      showCopyToast(`${hosterLabel}: Keine weiteren Fallback-Accounts verfügbar`);
    } else if (entry.event === 'final-error') {
      showCopyToast(`${hosterLabel}: Alle Accounts ausgeschöpft`);
    }
  });

  // Folder monitor: auto-queue new files
  window.api.onFolderMonitorNewFiles((files) => {
    window.api.debugLog('folder-monitor: received ' + files.length + ' file(s)');
    const fm = config.globalSettings && config.globalSettings.folderMonitor;
    const fmHosters = fm && Array.isArray(fm.hosters) && fm.hosters.length > 0 ? fm.hosters : [];

    if (fmHosters.length > 0) {
      // Pre-selected hosters: set them as active selection and add directly to queue
      selectedUploadHosters = fmHosters.slice();
      const existing = new Set();
      for (const f of selectedFiles) existing.add(f.path);
      for (const f of _pendingFiles) existing.add(f.path);
      const newFiles = [];
      for (const p of files) {
        if (existing.has(p)) continue;
        existing.add(p);
        const name = p.split('\\').pop().split('/').pop();
        newFiles.push({ path: p, name, size: null });
      }
      if (newFiles.length > 0) {
        const newPaths = new Set(newFiles.map(f => f.path));
        clearDedupKeysForPaths(newPaths);
        selectedFiles.push(...newFiles);
        buildQueuePreview();
        updateUploadView();
        if (fm.autoStart && !uploading && !healthCheckRunning) {
          startUpload();
        } else if (uploading) {
          // Inject new preview jobs into the running batch
          const newJobs = queueJobs.filter(j => j.status === 'preview' && newPaths.has(j.file));
          if (newJobs.length > 0) {
            newJobs.forEach(j => { j.status = 'queued'; });
            renderQueueTable();
            window.api.addJobsToBatch({
              jobs: newJobs.map(j => ({ id: j.id, file: j.file, fileName: j.fileName, hoster: j.hoster }))
            }).then(result => { _markSkippedJobs(result); }).catch(() => {});
            persistQueueStateSoon(true);
          }
        }
      }
    } else {
      // No pre-selected hosters: open modal
      addPathsToQueue(files);
    }
  });

  // Account switched notification
  window.api.onAccountSwitched((data) => {
    window.api.debugLog(`account-switched: ${data.hoster} ${data.fromAccountId} -> ${data.toAccountId}`);
  });

  // Drop target window: files dropped on the small floating window
  window.api.onDropTargetFiles((paths) => {
    addPathsToQueue(paths);
  });

  // Remote client count updates (registered once, not per renderSettings call)
  window.api.onRemoteClientCount(() => {
    const el = document.getElementById('remoteConnectionStatus');
    if (el && el.style.color === 'rgb(16, 185, 129)') {
      window.api.remoteStatus().then(status => {
        if (status.running) {
          el.textContent = `Aktiv auf Port ${status.port} — ${status.clientCount} Client(s) verbunden`;
        }
      }).catch(() => {});
    }
  });

  window.api.debugLog('init complete, all listeners registered');

  // Restore always-on-top state
  try {
    const onTop = await window.api.getAlwaysOnTop();
    alwaysOnTopState = !!onTop;
  } catch {}

  scheduleStartupAccountCheck();
}

// --- Tab switching ---
let _historyDirty = false;
let _historyEverLoaded = false;
function _isHistoryTabActive() {
  const tab = document.querySelector('.tab.active');
  return !!(tab && tab.dataset.view === 'history');
}
// Cache the tab/view collections once and use event delegation on the parent
// so tab switches don't trigger three querySelectorAll walks per click.
(() => {
  const tabs = Array.from(document.querySelectorAll('.tab'));
  const views = Array.from(document.querySelectorAll('.view'));
  const tabsByView = {};
  const viewsById = {};
  for (const t of tabs) tabsByView[t.dataset.view] = t;
  for (const v of views) viewsById[v.id] = v;
  let activeTab = tabs.find(t => t.classList.contains('active')) || tabs[0];

  const handle = (target) => {
    const tab = target.closest('.tab');
    if (!tab || tab === activeTab) return;
    if (activeTab) {
      activeTab.classList.remove('active');
      activeTab.setAttribute('aria-selected', 'false');
      activeTab.tabIndex = -1;
      const prevView = viewsById[`${activeTab.dataset.view}-view`];
      if (prevView) prevView.classList.remove('active');
    }
    tab.classList.add('active');
    tab.setAttribute('aria-selected', 'true');
    tab.tabIndex = 0;
    const nextView = viewsById[`${tab.dataset.view}-view`];
    if (nextView) nextView.classList.add('active');
    activeTab = tab;
    syncTabIndicator(tab);
    syncUploadSpeedSparklineVisibility(tab.dataset.view);
    const activeSidebarButton = nextView?.querySelector('.view-sidebar-navigation > .view-sidebar-item.active, .settings-navigation > .settings-nav-button.active');
    _syncSidebarIndicator(activeSidebarButton, true);
    if (tab.dataset.view === 'history' && (_historyDirty || !_historyEverLoaded)) {
      loadHistory();
    }
  };

  const tabBar = tabs[0] && tabs[0].parentElement;
  const tabIndicator = tabBar?.querySelector('.tab-indicator');
  function syncTabIndicator(tab) {
    if (!tabIndicator || !tab) return;
    tabIndicator.style.width = `${tab.offsetWidth}px`;
    tabIndicator.style.transform = `translateX(${tab.offsetLeft}px)`;
  }
  if (tabBar) {
    if (tabIndicator) {
      tabIndicator.style.transition = 'none';
      syncTabIndicator(activeTab);
      requestAnimationFrame(() => { tabIndicator.style.transition = ''; });
      window.addEventListener('resize', () => syncTabIndicator(activeTab));
    }
    tabBar.addEventListener('click', (e) => handle(e.target));
    tabBar.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      const current = Math.max(0, tabs.indexOf(activeTab));
      const next = e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? tabs.length - 1
          : (current + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      tabs[next].focus();
      handle(tabs[next]);
    });
  } else {
    // Fallback: bind per-tab if somehow no common parent
    tabs.forEach(t => t.addEventListener('click', () => handle(t)));
  }
})();

// --- Top menu bar (Datei / Einstellungen / Hilfe) ---
function initMenuBar() {
  const menuBar = document.getElementById('menuBar');
  if (!menuBar) return;
  let openMenu = null;

  const dropdowns = {};
  menuBar.querySelectorAll('[data-menu-dropdown]').forEach(d => { dropdowns[d.dataset.menuDropdown] = d; });
  const triggers = {};
  menuBar.querySelectorAll('[data-menu-trigger]').forEach(t => { triggers[t.dataset.menuTrigger] = t; });
  const panelTokens = new WeakMap();

  function openPanel(panel) {
    if (!panel) return;
    panelTokens.set(panel, (panelTokens.get(panel) || 0) + 1);
    panel.classList.remove('menu-closing', 'menu-opening');
    panel.style.display = '';
    void panel.offsetHeight;
    panel.classList.add('menu-opening');
  }

  function closePanel(panel) {
    if (!panel || window.getComputedStyle(panel).display === 'none') return;
    const token = (panelTokens.get(panel) || 0) + 1;
    panelTokens.set(panel, token);
    panel.classList.remove('menu-opening', 'menu-closing');
    void panel.offsetHeight;
    panel.classList.add('menu-closing');
    const finish = () => {
      if (panelTokens.get(panel) !== token) return;
      panel.style.display = 'none';
      panel.classList.remove('menu-closing');
    };
    panel.addEventListener('animationend', finish, { once: true });
    setTimeout(finish, 220);
  }

  function closeMenus() {
    openMenu = null;
    for (const k in dropdowns) closePanel(dropdowns[k]);
    for (const k in triggers) triggers[k].classList.remove('open');
    menuBar.querySelectorAll('.menu-submenu-dropdown').forEach(closePanel);
  }

  function openMenuNamed(name) {
    if (openMenu === name) return;
    closeMenus();
    openMenu = name;
    openPanel(dropdowns[name]);
    if (triggers[name]) triggers[name].classList.add('open');
    if (name === 'einstellungen') _syncMenuSettings();
  }

  menuBar.querySelectorAll('[data-menu-trigger]').forEach(trigger => {
    const name = trigger.dataset.menuTrigger;
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      if (openMenu === name) closeMenus(); else openMenuNamed(name);
    });
    trigger.addEventListener('mouseenter', () => { if (openMenu && openMenu !== name) openMenuNamed(name); });
  });

  menuBar.querySelectorAll('.menu-submenu').forEach(sm => {
    const sub = sm.querySelector('.menu-submenu-dropdown');
    sm.addEventListener('mouseenter', () => openPanel(sub));
    sm.addEventListener('mouseleave', () => closePanel(sub));
  });

  menuBar.querySelectorAll('[data-menu-action]').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = item.dataset.menuAction;
      closeMenus();
      _handleMenuAction(action);
    });
  });

  document.addEventListener('mousedown', (e) => { if (openMenu && !e.target.closest('.menu-bar')) closeMenus(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openMenu) closeMenus(); });

  _initMenuSettingsControls();
}

async function _handleMenuAction(action) {
  switch (action) {
    case 'add-files': document.getElementById('addFilesBtn')?.click(); break;
    case 'add-folder': document.getElementById('addFolderBtn')?.click(); break;
    case 'backup-export': doBackupExport(); break;
    case 'backup-import': doBackupImport(); break;
    case 'online-backup-create': doOnlineBackupCreate(); break;
    case 'online-backup-restore': openOnlineBackupRestore(); break;
    case 'restart': if (confirm('Anwendung neu starten?')) window.api.restartApp(); break;
    case 'quit': window.api.quitApp(); break;
    case 'open-settings': document.querySelector('.tab[data-view="settings"]')?.click(); break;
    case 'open-log-folder': window.api.openLogFolder(); break;
    case 'support-bundle': {
      showCopyToast('Diagnose-Paket wird erstellt…');
      try {
        const res = await window.api.createSupportBundle();
        if (res && res.ok) showCopyToast(`Diagnose-Paket gespeichert (${(res.bytes / 1024).toFixed(1)} KB)`);
        else if (res && res.canceled) showCopyToast('Abgebrochen');
        else showCopyToast(`Fehler: ${(res && res.error) || 'unbekannt'}`);
      } catch (err) { showCopyToast(`Fehler: ${err.message || err}`); }
      break;
    }
    case 'check-updates': {
      await requestUpdateCheck();
      break;
    }
  }
}

function _setHeaderUpdateLabel(text) {
  const button = document.getElementById('headerUpdateBtn');
  if (!button) return;
  const label = button.querySelector('[data-update-label], .header-update-label');
  if (label) label.textContent = text;
  else button.textContent = text;
}

function _syncHeaderUpdateState() {
  const button = document.getElementById('headerUpdateBtn');
  const available = !!(_knownUpdateInfo && _knownUpdateInfo.available);
  const version = available ? String(_knownUpdateInfo.remoteVersion || '').replace(/^v/i, '') : '';
  const hint = _updateCheckBusy
    ? 'Suche nach Aktualisierungen…'
    : available
      ? `Update v${version || 'unbekannt'} verfügbar. Klicken zum Installieren.`
      : 'Nach Aktualisierungen suchen';
  if (button) {
    button.hidden = !available;
    button.classList.toggle('update-available', available);
    button.classList.toggle('is-checking', _updateCheckBusy);
    button.disabled = _updateCheckBusy;
    button.setAttribute('aria-busy', _updateCheckBusy ? 'true' : 'false');
    button.setAttribute('aria-label', hint);
    button.title = hint;
    button.dataset.tooltip = hint;
    _setHeaderUpdateLabel(_updateCheckBusy ? 'Prüfen…' : (available ? 'Update verfügbar' : 'Update'));
  }
  const manualButton = document.getElementById('manualUpdateCheckBtn');
  if (manualButton) {
    manualButton.disabled = _updateCheckBusy;
    manualButton.setAttribute('aria-busy', _updateCheckBusy ? 'true' : 'false');
    manualButton.textContent = _updateCheckBusy ? 'Prüfe…' : (available ? 'Update verfügbar' : 'Nach Updates suchen');
  }
}

async function requestUpdateCheck() {
  if (_knownUpdateInfo && _knownUpdateInfo.available) {
    showUpdateBanner(_knownUpdateInfo);
    return _knownUpdateInfo;
  }
  if (_updateCheckBusy) return null;
  _updateCheckBusy = true;
  _syncHeaderUpdateState();
  showCopyToast('Suche nach Updates…');
  try {
    const result = await window.api.checkForUpdate();
    if (result && result.available) {
      showUpdateBanner(result);
      showCopyToast('Update gefunden!');
    } else if (result && result.error) {
      showCopyToast('Updateprüfung fehlgeschlagen');
    } else {
      showCopyToast('Kein Update verfügbar');
    }
    return result;
  } catch {
    showCopyToast('Updateprüfung fehlgeschlagen');
    return null;
  } finally {
    _updateCheckBusy = false;
    _syncHeaderUpdateState();
  }
}

function _syncMenuSettings() {
  const gs = config.globalSettings || {};
  const pInput = document.getElementById('menuParallelInput');
  if (pInput) pInput.value = String(gs.parallelUploadCount ?? 0);
  const speedKbs = gs.globalMaxSpeedKbs || 0;
  const enabled = speedKbs > 0;
  const sCheck = document.getElementById('menuSpeedLimitCheck');
  const sInput = document.getElementById('menuSpeedInput');
  const sSpinner = document.getElementById('menuSpeedSpinner');
  if (sCheck) sCheck.checked = enabled;
  if (sInput) sInput.value = enabled ? String(+(speedKbs / 1024).toFixed(2)) : '0';
  if (sSpinner) sSpinner.classList.toggle('disabled', !enabled);
}

function _menuSaveParallel(v) {
  const n = Math.max(0, Math.min(100, parseInt(v, 10) || 0));
  const gs = { ...(config.globalSettings || {}), parallelUploadCount: n };
  config.globalSettings = gs;
  saveGlobalSettingsTracked(gs).catch(() => {});
  const mirror = document.getElementById('parallelUploadCountInput');
  if (mirror) mirror.value = String(n);
  return n;
}

function _menuSaveSpeedMbs(mbs, enabled) {
  const kbs = enabled ? Math.max(0, Math.round((parseFloat(mbs) || 0) * 1024)) : 0;
  const gs = { ...(config.globalSettings || {}), globalMaxSpeedKbs: kbs };
  config.globalSettings = gs;
  saveGlobalSettingsTracked(gs).catch(() => {});
  const mirror = document.getElementById('globalMaxSpeedMbsInput');
  if (mirror) mirror.value = kbs > 0 ? String(+(kbs / 1024).toFixed(2)) : '0';
}

function _initMenuSettingsControls() {
  const grid = document.getElementById('menuSettingsGrid');
  if (grid) grid.addEventListener('click', (e) => e.stopPropagation());

  const pInput = document.getElementById('menuParallelInput');
  if (pInput) {
    const save = () => { pInput.value = String(_menuSaveParallel(pInput.value)); };
    pInput.addEventListener('change', save);
    pInput.addEventListener('blur', save);
  }

  const sInput = document.getElementById('menuSpeedInput');
  const sCheck = document.getElementById('menuSpeedLimitCheck');
  const sSpinner = document.getElementById('menuSpeedSpinner');
  if (sCheck) sCheck.addEventListener('change', () => {
    if (sSpinner) sSpinner.classList.toggle('disabled', !sCheck.checked);
    _menuSaveSpeedMbs(sInput ? sInput.value : 0, sCheck.checked);
  });
  if (sInput) {
    const save = () => _menuSaveSpeedMbs(sInput.value, sCheck ? sCheck.checked : true);
    sInput.addEventListener('change', save);
    sInput.addEventListener('blur', save);
  }

  document.querySelectorAll('#menuSettingsGrid [data-spin]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const kind = btn.dataset.spin;
      if (kind === 'parallel-up' || kind === 'parallel-down') {
        const cur = parseInt(pInput.value, 10) || 0;
        pInput.value = String(_menuSaveParallel(cur + (kind === 'parallel-up' ? 1 : -1)));
      } else if (kind === 'speed-up' || kind === 'speed-down') {
        const cur = parseFloat(sInput.value) || 0;
        const next = Math.max(0, cur + (kind === 'speed-up' ? 1 : -1));
        sInput.value = String(next);
        _menuSaveSpeedMbs(next, sCheck ? sCheck.checked : true);
      }
    });
  });
}

// --- Hoster selection ---
function accountHasCreds(name, account) {
  if (!account) return false;
  if (account.authType === 'api') return !!account.apiKey;
  if (account.authType === 'login') return !!(account.username && account.password);
  // Fallback
  if (name === 'vidmoly.me') return !!(account.username && account.password);
  if (name === 'voe.sx' || name === 'doodstream.com') return !!(account.username && account.password) || !!account.apiKey;
  return !!account.apiKey;
}

// Returns hosters that have at least one enabled account with credentials
function getAvailableHosters() {
  const result = [];
  for (const name of HOSTERS) {
    const accounts = config.hosters[name];
    if (!Array.isArray(accounts)) continue;
    const hasEnabledAccount = accounts.some(a => a.enabled !== false && accountHasCreds(name, a));
    if (hasEnabledAccount) result.push({ name });
  }
  return result;
}

function syncSelectedUploadHosters() {
  const available = new Set(getAvailableHosters().map(item => item.name));
  selectedUploadHosters = selectedUploadHosters.filter(name => available.has(name));
  if (selectedUploadHosters.length === 0) {
    selectedUploadHosters = HOSTERS.filter(name => {
      const accounts = config.hosters[name];
      return Array.isArray(accounts) && accounts.some(a => a.enabled !== false && accountHasCreds(name, a));
    });
  }
}

function getSelectedHosters() {
  return selectedUploadHosters.slice();
}

function getHosterLabel(name) {
  const labels = {
    'doodstream.com': 'Doodstream',
    'voe.sx': 'VOE',
    'vidmoly.me': 'Vidmoly',
    'byse.sx': 'Byse',
    'clouddrop.cc': 'Clouddrop'
  };
  return labels[name] || name;
}

function getAccountAuthLabel(account) {
  if (!account) return '';
  if (account.authType === 'api') return 'API';
  if (account.authType === 'login') return 'Web Login';
  return '';
}

function getAccountDisplayName(name, account) {
  const authLabel = getAccountAuthLabel(account);
  return authLabel
    ? `${getHosterLabel(name)} (${authLabel})`
    : getHosterLabel(name);
}

function maskCredential(value, keep = 4) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.length <= keep) return text;
  return `${text.slice(0, keep)}…${text.slice(-2)}`;
}

function ensureAccountStatusEntries() {
  const nextStatuses = {};
  for (const { account } of getAllAccountsFlat()) {
    if (account.id) {
      nextStatuses[account.id] = accountStatuses[account.id] || { status: 'unchecked', message: '' };
    }
  }
  accountStatuses = nextStatuses;
}

// Returns flat array of all accounts: [{ name, account, index }]
function getAllAccountsFlat() {
  const result = [];
  for (const name of HOSTERS) {
    const accounts = config.hosters[name];
    if (!Array.isArray(accounts)) continue;
    accounts.forEach((account, index) => result.push({ name, account, index }));
  }
  return result;
}

// Returns flat array of accounts with credentials
function getAccountsWithCredsFlat() {
  return getAllAccountsFlat().filter(({ name, account }) => accountHasCreds(name, account));
}

// Find account by ID across all hosters
function findAccountById(accountId) {
  for (const name of HOSTERS) {
    const accounts = config.hosters[name];
    if (!Array.isArray(accounts)) continue;
    const account = accounts.find(a => a.id === accountId);
    if (account) return { name, account };
  }
  return null;
}

function scheduleStartupAccountCheck() {
  const accounts = getAccountsWithCredsFlat();
  if (!accounts.length) return;
  setTimeout(() => {
    runHealthCheck('startup').catch(() => {});
  }, 500);
}

function renderHosterSummary() {
  const summary = document.getElementById('hosterSummary');
  if (!summary) return;
  const hosters = getSelectedHosters();
  if (hosters.length === 0) {
    summary.textContent = 'Keine Upload-Ziele ausgewählt';
  } else if (hosters.length === 1) {
    summary.textContent = `Aktives Ziel: ${getHosterLabel(hosters[0])}`;
  } else {
    summary.textContent = `${hosters.length} Ziele aktiv: ${hosters.map((name) => getHosterLabel(name)).join(', ')}`;
  }
}

function renderHosterModal() {
  const list = document.getElementById('hosterModalList');
  const hint = document.getElementById('hosterModalHint');
  if (!list || !hint) return;

  const available = getAvailableHosters();
  if (available.length === 0) {
    list.innerHTML = '';
    hint.textContent = 'Keine Hoster mit Zugangsdaten vorhanden. Bitte zuerst in den Accounts einen Login oder API-Key hinterlegen.';
    return;
  }

  list.innerHTML = available.map(item => {
    const checked = selectedUploadHosters.includes(item.name);
    // Get first enabled account's status for subtitle
    const accounts = config.hosters[item.name] || [];
    const enabledAccounts = accounts.filter(a => a.enabled !== false && accountHasCreds(item.name, a));
    const accountCount = enabledAccounts.length;
    let subtitle = `${accountCount} Account${accountCount !== 1 ? 's' : ''}`;
    // Check if any account has ok status
    const hasOk = enabledAccounts.some(a => accountStatuses[a.id] && accountStatuses[a.id].status === 'ok');
    const hasError = enabledAccounts.some(a => accountStatuses[a.id] && accountStatuses[a.id].status === 'error');
    if (hasOk) subtitle += ' • Bereit';
    else if (hasError) subtitle += ' • Fehler';
    return `
      <label class="hoster-option${checked ? ' selected' : ''}" data-hoster-option="${item.name}">
        <input type="checkbox" data-hoster-modal="${item.name}" ${checked ? 'checked' : ''}>
        <div class="hoster-option-main">
          <div class="hoster-option-title">${escapeHtml(getHosterLabel(item.name))}</div>
          <div class="hoster-option-subtitle">${subtitle}</div>
        </div>
      </label>
    `;
  }).join('');

  hint.textContent = 'Die Auswahl wird für neue Queue-Einträge verwendet.';

  list.querySelectorAll('input[data-hoster-modal]').forEach(input => {
    input.addEventListener('change', () => {
      input.closest('.hoster-option')?.classList.toggle('selected', input.checked);
    });
  });
}

function openHosterModal() {
  syncSelectedUploadHosters();
  renderHosterModal();
  document.getElementById('hosterModal').style.display = 'flex';
}

function closeHosterModal() {
  const modal = document.getElementById('hosterModal');
  if (modal) modal.style.display = 'none';
}

function applyHosterSelection() {
  selectedUploadHosters = Array.from(document.querySelectorAll('input[data-hoster-modal]:checked'))
    .map(input => input.dataset.hosterModal);
  // Move pending files to selectedFiles on confirm
  const pendingPaths = new Set(_pendingFiles.map(f => f.path));
  if (_pendingFiles.length > 0) {
    selectedFiles.push(..._pendingFiles);
    _pendingFiles = [];
  }
  clearDedupKeysForPaths(pendingPaths);
  renderHosterSummary();

  // During an active upload, build preview jobs for the new files and inject
  // them into the running batch immediately (otherwise they'd be lost on
  // handleBatchDone via syncSelectedFilesFromQueue)
  if (uploading && pendingPaths.size > 0) {
    buildQueuePreview(); // creates 'preview' jobs for new files
    const newJobs = queueJobs.filter(j => j.status === 'preview' && pendingPaths.has(j.file));
    if (newJobs.length > 0) {
      newJobs.forEach(j => { j.status = 'queued'; });
      renderQueueTable();
      window.api.addJobsToBatch({
        jobs: newJobs.map(j => ({ id: j.id, file: j.file, fileName: j.fileName, hoster: j.hoster }))
      }).then(result => { _markSkippedJobs(result); }).catch(() => {});
      persistQueueStateSoon(true);
    }
  }

  updateUploadView();
  persistQueueStateSoon(true); // immediate persist after adding files
  document.getElementById('hosterModal').style.display = 'none';
}

function cancelHosterModal() {
  _pendingFiles = [];
  closeHosterModal();
}

function normalizeRestoredJobStatus(status) {
  if (status === 'done' || status === 'error' || status === 'skipped' || status === 'preview' || status === 'aborted') return status;
  return 'queued';
}

function restoreQueueStateFromConfig() {
  if (config?.globalSettings?.resumeQueueOnLaunch === false) return;
  const pending = config?.globalSettings?.pendingQueue;
  if (!pending || typeof pending !== 'object') return;

  _restoredSnapshotSavedAt = (typeof pending.savedAt === 'number' && isFinite(pending.savedAt))
    ? pending.savedAt
    : null;

  if (Array.isArray(pending.completedKeys)) {
    for (const k of pending.completedKeys) {
      if (typeof k === 'string' && k) _completedUploadKeys.add(k);
    }
  }

  if (Array.isArray(pending.suppressedKeys)) {
    for (const k of pending.suppressedKeys) {
      if (typeof k === 'string' && k) _suppressedPreviewKeys.add(k);
    }
  }

  selectedUploadHosters = Array.isArray(pending.selectedUploadHosters)
    ? pending.selectedUploadHosters.filter(Boolean)
    : selectedUploadHosters;

  selectedFiles = Array.isArray(pending.selectedFiles)
    ? pending.selectedFiles
      .filter(file => file && file.path)
      .map(file => ({ path: file.path, name: file.name || file.path.split(/[\\/]/).pop(), size: file.size || 0 }))
    : [];

  const rawJobs = Array.isArray(pending.queueJobs)
    ? pending.queueJobs
      .filter(job => job && job.fileName && job.hoster)
      .map(job => ({
        id: job.id || `restored-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        uploadId: null,
        file: job.file || '',
        fileName: job.fileName,
        hoster: job.hoster,
        status: normalizeRestoredJobStatus(job.status),
        bytesUploaded: job.status === 'done' ? (job.bytesTotal || 0) : 0,
        bytesTotal: job.bytesTotal || 0,
        speedKbs: 0,
        elapsed: 0,
        remaining: 0,
        error: job.error || null,
        result: job.result || null,
        attempt: 0,
        maxAttempts: job.maxAttempts || 0,
        link: '',
        progress: job.status === 'done' ? 1 : 0
      }))
    : [];

  // Deduplicate: keep the job with the best status for each file+hoster pair
  const seen = new Map();
  const statusPriority = { done: 0, uploading: 1, queued: 2, preview: 3, error: 4, aborted: 5, skipped: 6 };
  for (const job of rawJobs) {
    const key = `${job.file}|${job.hoster}`;
    const existing = seen.get(key);
    if (!existing || (statusPriority[job.status] ?? 9) < (statusPriority[existing.status] ?? 9)) {
      seen.set(key, job);
    }
  }
  queueJobs = Array.from(seen.values());
  rebuildJobIndex();
}

function buildPersistedQueueState() {
  const persistableJobs = queueJobs.filter(job => !['done', 'skipped'].includes(job.status));
  const selectedFileMap = new Map(selectedFiles.map(file => [file.path, file]));

  for (const job of persistableJobs) {
    if (job.file && !selectedFileMap.has(job.file)) {
      selectedFileMap.set(job.file, {
        path: job.file,
        name: job.fileName,
        size: job.bytesTotal || 0
      });
    }
  }

  if (selectedFileMap.size === 0 && queueJobs.every(job => ['done', 'skipped'].includes(job.status))) {
    return null;
  }

  // After a restart no upload manager is running, so any in-flight state
  // (queued / getting-server / uploading / retrying / aborted) is
  // meaningless. Collapse them all to 'preview' so the queue shows a
  // consistent "Bereit" for everything that didn't actually terminate.
  // Only true terminal states (done / error / skipped) survive as-is.
  const TERMINAL = new Set(['done', 'error', 'skipped']);
  const completedKeys = [];
  for (const k of _completedUploadKeys) {
    const sep = k.lastIndexOf('|');
    if (sep > 0 && selectedFileMap.has(k.slice(0, sep))) completedKeys.push(k);
  }
  const suppressedKeys = [];
  for (const k of _suppressedPreviewKeys) {
    const sep = k.lastIndexOf('|');
    if (sep > 0 && selectedFileMap.has(k.slice(0, sep))) suppressedKeys.push(k);
  }
  return {
    savedAt: Date.now(),
    selectedUploadHosters: getSelectedHosters(),
    selectedFiles: Array.from(selectedFileMap.values()),
    completedKeys,
    suppressedKeys,
    queueJobs: queueJobs.map(job => {
      const isTerminal = TERMINAL.has(job.status);
      return {
        id: job.id,
        file: job.file,
        fileName: job.fileName,
        hoster: job.hoster,
        status: isTerminal ? job.status : 'preview',
        bytesTotal: job.bytesTotal || 0,
        error: isTerminal ? (job.error || null) : null,
        result: isTerminal ? (job.result || null) : null,
        maxAttempts: job.maxAttempts || 0
      };
    })
  };
}

async function persistQueueStateNow() {
  const pendingQueue = buildPersistedQueueState();
  const globalSettings = {
    ...(config.globalSettings || {}),
    pendingQueue
  };
  config.globalSettings = globalSettings;
  await savePendingQueueTracked(pendingQueue);
  return pendingQueue;
}

function persistQueueStateSoon(immediate) {
  if (closePreparationState !== 'open') return;
  if (immediate) {
    queuePersistThrottle.cancel();
    persistQueueStateNow().catch(() => {});
    return;
  }
  const maxWait = uploading ? 20000 : undefined;
  queuePersistThrottle.request(() => {
    persistQueueStateNow().catch(() => {});
  }, 500, maxWait);
}

function clearPersistedQueueStateSoon() {
  if (closePreparationState !== 'open') return;
  queuePersistThrottle.request(() => {
    config.globalSettings = { ...(config.globalSettings || {}), pendingQueue: null };
    savePendingQueueTracked(null).catch(() => {});
  }, 0);
}

// --- File selection ---
function setupDragDrop() {
  const dropZone = document.getElementById('dropZone');
  // Allow drop on the entire upload view
  const uploadView = document.getElementById('upload-view');
  let _dragCounter = 0;
  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); });
  dropZone.addEventListener('dragenter', (e) => { e.preventDefault(); _dragCounter++; dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', (e) => { e.preventDefault(); _dragCounter--; if (_dragCounter <= 0) { _dragCounter = 0; dropZone.classList.remove('drag-over'); } });
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault(); e.stopPropagation(); _dragCounter = 0; dropZone.classList.remove('drag-over');
    addDroppedFiles(e.dataTransfer.files).catch(console.error);
  });
  dropZone.addEventListener('click', () => pickFiles());

  // Also handle drops on queue container
  uploadView.addEventListener('dragover', (e) => { e.preventDefault(); });
  uploadView.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.target.closest('.drop-zone')) return; // handled above
    addDroppedFiles(e.dataTransfer.files).catch(console.error);
  });
}

let _pendingFiles = []; // Files waiting for hoster modal confirmation

let _addingDropped = false;

async function addDroppedFiles(fileList) {
  if (_addingDropped) return;
  _addingDropped = true;
  try {
    const files = Array.from(fileList);
    const existingPaths = new Set([
      ...selectedFiles.map(f => f.path),
      ..._pendingFiles.map(f => f.path)
    ]);
    const newFiles = [];

    for (const file of files) {
      let filePath = '';
      try { filePath = window.api.getPathForFile(file); } catch { filePath = file.path || ''; }
      if (!filePath) continue;

      // Detect folders: directories report size 0 and empty type in Electron drag-and-drop
      if (file.type === '' && file.size === 0) {
        try {
          const folderFiles = await window.api.resolveFolderFiles(filePath);
          if (folderFiles && folderFiles.length > 0) {
            for (const fp of folderFiles) {
              const p = typeof fp === 'string' ? fp : (fp && fp.path);
              if (!p || existingPaths.has(p)) continue;
              const name = typeof fp === 'string' ? p.split('\\').pop().split('/').pop() : (fp.name || p.split('\\').pop().split('/').pop());
              const size = typeof fp === 'string' ? null : (fp.size || 0);
              newFiles.push({ path: p, name, size });
              existingPaths.add(p);
            }
            continue;
          }
        } catch {}
      }

      // Regular file
      const fileName = file.name || '';
      if (!existingPaths.has(filePath)) {
        newFiles.push({ path: filePath, name: fileName, size: file.size });
        existingPaths.add(filePath);
      }
    }

    if (newFiles.length > 0) {
      _pendingFiles.push(...newFiles);
      openHosterModal();
    }
  } finally {
    _addingDropped = false;
  }
}

async function pickFiles() {
  const paths = await window.api.selectFiles();
  if (!paths) return;
  addPathsToQueue(paths);
}

async function pickFolder() {
  const richFiles = window.api.selectFolderWithSizes ? await window.api.selectFolderWithSizes() : null;
  if (richFiles && Array.isArray(richFiles)) { addPathsToQueue(richFiles); return; }
  const paths = await window.api.selectFolder();
  if (!paths) return;
  addPathsToQueue(paths);
}

function addPathsToQueue(paths) {
  const existing = new Set();
  for (const f of selectedFiles) existing.add(f.path);
  for (const f of _pendingFiles) existing.add(f.path);

  const newFiles = [];
  const pendingSizeFetch = [];
  for (const entry of paths) {
    const p = typeof entry === 'string' ? entry : (entry && entry.path);
    if (!p || existing.has(p)) continue;
    existing.add(p);
    const name = typeof entry === 'string' ? p.split('\\').pop().split('/').pop() : (entry.name || p.split('\\').pop().split('/').pop());
    const size = typeof entry === 'string' ? null : (entry.size || 0);
    newFiles.push({ path: p, name, size });
    if (size === null || size === undefined || size === 0) pendingSizeFetch.push(p);
  }
  if (newFiles.length > 0) {
    _pendingFiles.push(...newFiles);
    openHosterModal();
    if (pendingSizeFetch.length > 0 && window.api.getFileSizes) {
      window.api.getFileSizes(pendingSizeFetch).then((sizeMap) => {
        if (!sizeMap || typeof sizeMap !== 'object') return;
        let changed = false;
        for (const f of _pendingFiles) {
          if (sizeMap[f.path] && (!f.size || f.size === 0)) { f.size = sizeMap[f.path]; changed = true; }
        }
        for (const f of selectedFiles) {
          if (sizeMap[f.path] && (!f.size || f.size === 0)) { f.size = sizeMap[f.path]; changed = true; }
        }
        for (const j of queueJobs) {
          if (sizeMap[j.file] && (!j.bytesTotal || j.bytesTotal === 0)) { j.bytesTotal = sizeMap[j.file]; changed = true; }
        }
        if (changed) {
          _queueStatsCache = null;
          if (typeof renderQueueTable === 'function') renderQueueTable();
          if (typeof updateStatusBar === 'function') updateStatusBar();
        }
      }).catch(() => {});
    }
  }
}

function updateUploadView() {
  const dropZone = document.getElementById('dropZone');
  const queueShell = document.getElementById('queueShell');
  const queueActions = document.getElementById('queueActions');

  if (selectedFiles.length === 0 && queueJobs.length === 0) {
    dropZone.style.display = 'flex';
    queueShell.style.display = 'none';
    queueActions.style.display = 'none';
  } else {
    dropZone.style.display = 'none';
    queueShell.style.display = 'flex';
    queueActions.style.display = 'flex';
    if (!uploading && selectedFiles.length > 0) {
      buildQueuePreview();
    }
  }
  updateQueueActionButtons();
}

function updateStartButton() {
  const btn = document.getElementById('startUploadBtn');
  const hosters = getSelectedHosters();
  const hasQueuedJobs = queueJobs.some(isStartableQueueJob);
  const canBuildQueueFromSelection = selectedFiles.length > 0 && hosters.length > 0;
  btn.disabled = uploading || !(hasQueuedJobs || canBuildQueueFromSelection);
}

const _UPLOAD_SELECTION_STATUSES = new Set(['done', 'error', 'aborted', 'skipped']);
const _ABORT_SELECTION_STATUSES = new Set(['preview', 'queued', 'getting-server', 'uploading', 'retrying']);

function updateQueueActionButtons() {
  updateStartButton();
  _normalizeQueueSelectionToVisible();

  const hasSelection = selectedJobIds.size > 0;
  // Single pass over the (usually small) selection set instead of three O(n)
  // scans over the entire queue. For 1000 jobs × 3 scans this drops the
  // selection-change cost from ~3000 checks to |selection|.
  let hasUploadSelection = false, hasAbortSelection = false, hasStartableSelection = false;
  for (const id of selectedJobIds) {
    const job = _jobIndexById.get(id);
    if (!job) continue;
    const s = job.status;
    if (!hasUploadSelection && _UPLOAD_SELECTION_STATUSES.has(s)) hasUploadSelection = true;
    if (!hasAbortSelection && _ABORT_SELECTION_STATUSES.has(s)) hasAbortSelection = true;
    if (!hasStartableSelection && isStartableQueueStatus(s)) hasStartableSelection = true;
    if (hasUploadSelection && hasAbortSelection && hasStartableSelection) break;
  }
  const hasMovableSelection = hasSelection && !uploading;

  const startSelectedBtn = document.getElementById('startSelectedBtn');
  const reuploadBtn = document.getElementById('reuploadSelectedBtn');
  const abortSelectedBtn = document.getElementById('abortSelectedBtn');
  const finishStopBtn = document.getElementById('finishStopBtn');
  const abortAllBtn = document.getElementById('abortAllBtn');
  const moveTopBtn = document.getElementById('moveTopBtn');
  const moveUpBtn = document.getElementById('moveUpBtn');
  const moveDownBtn = document.getElementById('moveDownBtn');
  const moveBottomBtn = document.getElementById('moveBottomBtn');

  if (startSelectedBtn) startSelectedBtn.disabled = uploading || !hasStartableSelection;
  if (reuploadBtn) reuploadBtn.disabled = !hasUploadSelection;
  if (abortSelectedBtn) abortSelectedBtn.disabled = !hasAbortSelection;
  if (finishStopBtn) finishStopBtn.disabled = !uploading;
  if (abortAllBtn) abortAllBtn.disabled = !uploading;
  if (moveTopBtn) moveTopBtn.disabled = !hasMovableSelection;
  if (moveUpBtn) moveUpBtn.disabled = !hasMovableSelection;
  if (moveDownBtn) moveDownBtn.disabled = !hasMovableSelection;
  if (moveBottomBtn) moveBottomBtn.disabled = !hasMovableSelection;
}

function clearDedupKeysForPaths(pathSet) {
  if (!pathSet || pathSet.size === 0) return;
  for (const set of [_completedUploadKeys, _suppressedPreviewKeys]) {
    for (const key of [...set]) {
      const sep = key.lastIndexOf('|');
      if (sep > 0 && pathSet.has(key.slice(0, sep))) set.delete(key);
    }
  }
}

function suppressPreviewKeysStillSelected(keys) {
  if (!keys || keys.length === 0) return;
  const stillSelected = new Set(selectedFiles.map(f => f.path));
  for (const key of keys) {
    const sep = key.lastIndexOf('|');
    if (sep > 0 && stillSelected.has(key.slice(0, sep))) _suppressedPreviewKeys.add(key);
  }
}

// Build preview jobs from selected files x selected hosters (before upload starts)
function buildQueuePreview() {
  const hosters = getSelectedHosters();
  if (hosters.length === 0) {
    queueJobs = queueJobs.filter(j => j.status !== 'preview');
    rebuildJobIndex();
    renderQueueTable();
    persistQueueStateSoon();
    return;
  }
  // Remove old preview jobs
  queueJobs = queueJobs.filter(j => j.status !== 'preview');

  // Build a Set for fast existence checks
  const existingKeys = new Set();
  for (const j of queueJobs) {
    existingKeys.add(`${j.file}|${j.hoster}`);
  }

  for (const file of selectedFiles) {
    for (const hoster of hosters) {
      const key = `${file.path}|${hoster}`;
      if (!existingKeys.has(key) && !_completedUploadKeys.has(key) && !_suppressedPreviewKeys.has(key)) {
        const job = {
          id: `preview-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          file: file.path, fileName: file.name, hoster,
          status: 'preview', bytesUploaded: 0, bytesTotal: file.size || 0,
          speedKbs: 0, elapsed: 0, remaining: 0,
          error: null, result: null, attempt: 0, maxAttempts: 0, link: ''
        };
        queueJobs.push(job);
        existingKeys.add(key);
      }
    }
  }
  rebuildJobIndex();
  renderQueueTable();
  persistQueueStateSoon();
}

// --- Job Index Management ---
function rebuildJobIndex() {
  _jobIndexById.clear();
  _jobIndexByUploadId.clear();
  for (const job of queueJobs) {
    _jobIndexById.set(job.id, job);
    if (job.uploadId) _jobIndexByUploadId.set(job.uploadId, job);
  }
}

function indexJob(job) {
  _jobIndexById.set(job.id, job);
  if (job.uploadId) _jobIndexByUploadId.set(job.uploadId, job);
}

function removeJobFromIndex(job, keepCompletedKey) {
  _jobIndexById.delete(job.id);
  if (job.uploadId) _jobIndexByUploadId.delete(job.uploadId);
  // Track deletion so handleProgress() won't re-create this job from stale callbacks
  _deletedJobIds.add(job.id);
  if (job.uploadId) _deletedJobIds.add(job.uploadId);
  // Allow re-uploading same file+hoster after deletion
  if (!keepCompletedKey && job.file && job.hoster) _completedUploadKeys.delete(`${job.file}|${job.hoster}`);
}

// --- Queue Table Rendering (debounced with virtual scrolling) ---
let _renderQueued = false;
let _sortedJobsCache = [];
const VIRTUAL_ROW_HEIGHT = 28;
const VIRTUAL_OVERSCAN = 10;
let _lastVisibleRange = { start: -1, end: -1 };
let _queueListenersBound = false;

// Throttled UI update scheduling – max one render per 200ms during uploads
let _uiUpdateTimer = null;
const UI_UPDATE_INTERVAL = 200; // ms

function scheduleQueueRender() {
  if (_renderQueued) return;
  _renderQueued = true;
  requestAnimationFrame(() => { _renderQueued = false; renderQueueTable(); });
}

let _recentRenderQueued = false;
function scheduleRecentRender() {
  if (_recentRenderQueued) return;
  _recentRenderQueued = true;
  requestAnimationFrame(() => { _recentRenderQueued = false; renderRecentUploadsPanel(true); });
}

// Toggle the .selected class on existing rows without rebuilding the table.
// Used on click/selection changes — O(rendered rows) instead of O(total rows × sort).
// Uses getElementsByClassName for the live HTMLCollection (DOM-cached after the
// first call, auto-tracks insertions/removals on tbody) instead of running a
// fresh querySelectorAll on every click. At 200 visible rows that's the
// difference between paying for a tree walk per click vs reading a memoized
// list that the engine already maintains.
function applyQueueSelectionClasses() {
  const tbody = document.getElementById('queueBody');
  if (!tbody) return;
  const rows = tbody.getElementsByClassName('queue-row');
  for (let i = 0; i < rows.length; i++) {
    const tr = rows[i];
    tr.classList.toggle('selected', selectedJobIds.has(tr.dataset.jobId));
  }
}

function applyRecentSelectionClasses() {
  const tbody = document.getElementById('recentFilesBody');
  if (!tbody) return;
  const rows = tbody.getElementsByClassName('recent-file-row');
  for (let i = 0; i < rows.length; i++) {
    const tr = rows[i];
    const order = parseInt(tr.dataset.order, 10);
    tr.classList.toggle('selected', selectedRecentIds.has(order));
  }
}

function scheduleThrottledUIUpdate() {
  if (_uiUpdateTimer) return;
  _uiUpdateTimer = setTimeout(() => {
    _uiUpdateTimer = null;
    scheduleQueueRender();
    updateQueueActionButtons();
    updateStatusBar();
    updateStatsPanel();
  }, UI_UPDATE_INTERVAL);
}

// Coalesces status-change updates (done/error/retrying/queued/…) into one
// frame. Without this, a batch of 500 jobs flipping queued→getting-server
// →uploading synchronously fires 1500+ updateStatusBar/Buttons/Stats calls
// and janks the renderer. rAF caps it to ~60 Hz.
let _statusChangeUpdateQueued = false;
function scheduleStatusChangeUpdate() {
  if (_statusChangeUpdateQueued) return;
  _statusChangeUpdateQueued = true;
  requestAnimationFrame(() => {
    _statusChangeUpdateQueued = false;
    renderQueueTable();
    updateQueueActionButtons();
    updateStatusBar();
    updateStatsPanel();
  });
}

function _hydrateMissingJobSizes(jobsLike) {
  if (!window.api || !window.api.getFileSizes) return;
  const paths = [];
  const seen = new Set();
  const source = Array.isArray(jobsLike) ? jobsLike : queueJobs;
  for (const j of source) {
    if (!j || !j.file) continue;
    if (j.bytesTotal && j.bytesTotal > 0) continue;
    if (seen.has(j.file)) continue;
    seen.add(j.file);
    paths.push(j.file);
  }
  if (paths.length === 0) return;
  window.api.getFileSizes(paths).then((sizeMap) => {
    if (!sizeMap || typeof sizeMap !== 'object') return;
    let changed = false;
    for (const j of queueJobs) {
      if (sizeMap[j.file] && (!j.bytesTotal || j.bytesTotal === 0)) {
        j.bytesTotal = sizeMap[j.file];
        changed = true;
      }
    }
    for (const f of selectedFiles) {
      if (sizeMap[f.path] && (!f.size || f.size === 0)) f.size = sizeMap[f.path];
    }
    if (changed) {
      _queueStatsCache = null;
      if (typeof renderQueueTable === 'function') renderQueueTable();
      if (typeof updateStatusBar === 'function') updateStatusBar();
    }
  }).catch(() => {});
}

function _formatUploadedSize(job) {
  const bt = job.bytesTotal || 0;
  const bu = job.bytesUploaded || 0;
  const s = job.status;
  if (s === 'preview') return bt > 0 ? formatSize(bt) : '...';
  if (s === 'queued' || s === 'getting-server' || s === 'retrying') {
    return bt > 0 ? `${formatSize(bu)} / ${formatSize(bt)}` : '...';
  }
  return `${formatSize(bu)} / ${formatSize(bt)}`;
}

function buildRowHtml(job) {
  const statusClass = `status-${job.status}`;
  const rowClass = `queue-row ${statusClass}${selectedJobIds.has(job.id) ? ' selected' : ''}`;
  const uploadedSize = _formatUploadedSize(job);
  const statusText = getStatusText(job);
  const elapsed = formatTime(job.elapsed);
  const remaining = formatTime(job.remaining);
  const speed = job.speedKbs > 0 ? `${formatSpeed(job.speedKbs)}` : '';
  const pct = Math.min(100, Math.round((job.progress || 0) * 100));
  const link = job.result ? (job.result.download_url || job.result.embed_url || '') : '';

  return `<tr class="${rowClass}" data-job-id="${job.id}" data-link="${escapeAttr(link)}" style="height:${VIRTUAL_ROW_HEIGHT}px">
    <td class="col-filename" title="${escapeAttr(job.fileName)}">${escapeHtml(job.fileName)}</td>
    <td class="col-size">${uploadedSize}</td>
    <td class="col-host">${escapeHtml(job.hoster)}</td>
    <td class="col-status"><span class="status-badge ${statusClass}">${escapeHtml(statusText)}</span></td>
    <td class="col-elapsed">${elapsed}</td>
    <td class="col-remaining">${remaining}</td>
    <td class="col-speed">${speed}</td>
    <td class="col-progress">
      <div class="progress-cell">
        <div class="progress-bar-bg">
          <div class="progress-bar-fill ${statusClass}" style="width:${pct}%"></div>
        </div>
        <span class="progress-pct">${job.status === 'preview' ? '' : pct + '%'}</span>
      </div>
    </td>
  </tr>`;
}

// In-place update of a single row's cells (avoids full innerHTML rebuild)
function _updateRowInPlace(tr, job) {
  const statusClass = `status-${job.status}`;
  const uploadedSize = _formatUploadedSize(job);
  const statusText = getStatusText(job);
  const elapsed = formatTime(job.elapsed);
  const remaining = formatTime(job.remaining);
  const speed = job.speedKbs > 0 ? `${formatSpeed(job.speedKbs)}` : '';
  const pct = Math.min(100, Math.round((job.progress || 0) * 100));
  const link = job.result ? (job.result.download_url || job.result.embed_url || '') : '';

  // Write DOM only when the target value actually changes — a no-op progress
  // tick (same pct, same speed) then performs zero DOM work. Massive saver
  // when most of the visible jobs are idle/queued/done and only a few are
  // actively uploading.
  const newClass = `queue-row ${statusClass}${selectedJobIds.has(job.id) ? ' selected' : ''}`;
  if (tr.className !== newClass) tr.className = newClass;
  if (tr.dataset.link !== link) tr.dataset.link = link;

  const cells = tr.children;
  if (cells.length < 8) return false; // structure mismatch, needs full rebuild

  if (cells[1].textContent !== uploadedSize) cells[1].textContent = uploadedSize;
  // cells[0] (filename) and cells[2] (hoster) don't change during upload
  const badge = cells[3].querySelector('.status-badge');
  if (badge) {
    const badgeClass = `status-badge ${statusClass}`;
    if (badge.className !== badgeClass) badge.className = badgeClass;
    if (badge.textContent !== statusText) badge.textContent = statusText;
  }
  if (cells[4].textContent !== elapsed) cells[4].textContent = elapsed;
  if (cells[5].textContent !== remaining) cells[5].textContent = remaining;
  if (cells[6].textContent !== speed) cells[6].textContent = speed;

  const fill = cells[7].querySelector('.progress-bar-fill');
  if (fill) {
    const pctStr = pct + '%';
    if (fill.style.width !== pctStr) fill.style.width = pctStr;
    const fillClass = `progress-bar-fill ${statusClass}`;
    if (fill.className !== fillClass) fill.className = fillClass;
  }
  const pctSpan = cells[7].querySelector('.progress-pct');
  if (pctSpan) {
    const pctText = job.status === 'preview' ? '' : pct + '%';
    if (pctSpan.textContent !== pctText) pctSpan.textContent = pctText;
  }

  return true;
}

function _matchesUploadSidebarFilter(job, filter = uploadSidebarFilter) {
  if (filter === 'active') return job.status === 'uploading' || job.status === 'getting-server' || job.status === 'retrying';
  if (filter === 'waiting') return job.status === 'preview' || job.status === 'queued';
  if (filter === 'done') return job.status === 'done';
  if (filter === 'error') return job.status === 'error';
  return true;
}

function _getVisibleQueueJobs() {
  if (uploadSidebarFilter === 'all') return queueJobs;
  const filtered = queueJobs.filter(job => _matchesUploadSidebarFilter(job));
  if (_queueFilterCache.filter === uploadSidebarFilter && _queueFilterCache.source === queueJobs && _queueFilterCache.result.length === filtered.length) {
    let unchanged = true;
    for (let index = 0; index < filtered.length; index++) {
      if (_queueFilterCache.result[index] !== filtered[index]) {
        unchanged = false;
        break;
      }
    }
    if (unchanged) return _queueFilterCache.result;
  }
  _queueFilterCache = { filter: uploadSidebarFilter, source: queueJobs, result: filtered };
  return filtered;
}

function _normalizeQueueSelectionToVisible(visibleJobs = _getVisibleQueueJobs()) {
  if (selectedJobIds.size === 0) return false;
  const visibleIds = new Set(visibleJobs.map(job => job.id));
  let changed = false;
  for (const id of selectedJobIds) {
    if (!visibleIds.has(id)) {
      selectedJobIds.delete(id);
      changed = true;
    }
  }
  return changed;
}

function _getVisibleSelectedQueueJobs(predicate) {
  const visibleJobs = _getVisibleQueueJobs();
  _normalizeQueueSelectionToVisible(visibleJobs);
  return visibleJobs.filter(job => selectedJobIds.has(job.id) && (!predicate || predicate(job)));
}

function renderQueueTable() {
  const tbody = document.getElementById('queueBody');
  if (!tbody) return;

  const visibleJobs = _getVisibleQueueJobs();
  const selectionChanged = _normalizeQueueSelectionToVisible(visibleJobs);
  _sortedJobsCache = sortQueueJobs(visibleJobs);
  if (selectionChanged) updateQueueActionButtons();
  const totalRows = _sortedJobsCache.length;

  if (totalRows < 200) {
    // Try in-place update if row count matches (fast path)
    const existingRows = tbody.querySelectorAll('.queue-row');
    if (existingRows.length === totalRows && totalRows > 0) {
      // In-place update – no DOM destruction
      for (let i = 0; i < totalRows; i++) {
        const tr = existingRows[i];
        const job = _sortedJobsCache[i];
        // If row identity changed (different job), fall back to full rebuild
        if (tr.dataset.jobId !== job.id) {
          tbody.innerHTML = _sortedJobsCache.map(buildRowHtml).join('');
          _lastVisibleRange = { start: -1, end: -1 };
          break;
        }
        _updateRowInPlace(tr, job);
      }
    } else {
      // Full rebuild needed (row count changed)
      tbody.innerHTML = _sortedJobsCache.map(buildRowHtml).join('');
      _lastVisibleRange = { start: -1, end: -1 };
    }
  } else {
    // Virtual scrolling for large queues — in-place update when range unchanged
    _renderVirtualRows(tbody);
  }

  // Bind event delegation once
  if (!_queueListenersBound) {
    _queueListenersBound = true;
    tbody.addEventListener('click', (e) => {
      const row = e.target.closest('.queue-row');
      if (row) handleRowClick(e, row);
    });
    tbody.addEventListener('contextmenu', (e) => {
      const row = e.target.closest('.queue-row');
      if (row) handleRowContextMenu(e, row);
    });
  }

  // Update retry button visibility
  const hasFailedJobs = queueJobs.some(j => j.status === 'error');
  document.getElementById('retryFailedBtn').style.display = hasFailedJobs ? 'inline-block' : 'none';
  updateQueueActionButtons();
}

function _renderVirtualRows(tbody) {
  const scrollContainer = document.getElementById('queueContainer');
  if (!scrollContainer) return;

  const totalRows = _sortedJobsCache.length;
  const scrollTop = scrollContainer.scrollTop;
  // Use a minimum viewport height to avoid rendering nothing when container is being laid out
  const viewportHeight = Math.max(scrollContainer.clientHeight, 200);

  const startIdx = Math.max(0, Math.floor(scrollTop / VIRTUAL_ROW_HEIGHT) - VIRTUAL_OVERSCAN);
  const endIdx = Math.min(totalRows, Math.ceil((scrollTop + viewportHeight) / VIRTUAL_ROW_HEIGHT) + VIRTUAL_OVERSCAN);

  // Same range — try in-place update to avoid hover flicker
  if (startIdx === _lastVisibleRange.start && endIdx === _lastVisibleRange.end) {
    const rows = tbody.querySelectorAll('.queue-row');
    if (rows.length === endIdx - startIdx) {
      let allMatch = true;
      for (let i = 0; i < rows.length; i++) {
        const job = _sortedJobsCache[startIdx + i];
        if (rows[i].dataset.jobId !== job.id) { allMatch = false; break; }
        _updateRowInPlace(rows[i], job);
      }
      if (allMatch) return; // all rows updated in-place, no rebuild needed
    }
  }
  _lastVisibleRange = { start: startIdx, end: endIdx };

  const topPad = startIdx * VIRTUAL_ROW_HEIGHT;
  const bottomPad = Math.max(0, (totalRows - endIdx) * VIRTUAL_ROW_HEIGHT);

  let html = '';
  if (topPad > 0) html += `<tr class="virtual-spacer" style="height:${topPad}px"><td colspan="8"></td></tr>`;
  for (let i = startIdx; i < endIdx; i++) {
    html += buildRowHtml(_sortedJobsCache[i]);
  }
  if (bottomPad > 0) html += `<tr class="virtual-spacer" style="height:${bottomPad}px"><td colspan="8"></td></tr>`;

  tbody.innerHTML = html;
}

// Coalesce rapid scroll events (a fast trackpad fling fires dozens) into one
// render per frame. rAF keeps the scroll thread cheap.
let _queueScrollQueued = false;
function _onQueueScroll() {
  if (_queueScrollQueued) return;
  if (_sortedJobsCache.length < 200) return;
  _queueScrollQueued = true;
  requestAnimationFrame(() => {
    _queueScrollQueued = false;
    const tbody = document.getElementById('queueBody');
    if (tbody) _renderVirtualRows(tbody);
  });
}

const _collatorDE = new Intl.Collator('de', { sensitivity: 'base', numeric: true });
const _collatorSimple = new Intl.Collator('de');

// Queue sort memoization. Keys that don't change after a job enters the queue
// (filename, host) reuse the cached result across progress-driven re-renders.
// Dynamic keys (status/speed/progress) AND size (which goes 0 → actual when
// previews resolve / upload starts) are recomputed each call — otherwise a
// queue sorted by size during previews would be stuck in all-zeros order.
//
// CRITICAL: the cache also tracks jobsRef (identity of the queueJobs array) so
// that a full replacement (e.g. backup import, queue restore) invalidates the
// cache. Length alone can match across a replace and would otherwise pin the
// renderer to stale job references — the UI freezes showing old statuses even
// though queueJobs itself has fresh objects. Observed as "upload runs in
// status bar but all rows stay 'Bereit'" after importing a backup.
let _queueSortCache = { sig: '', result: [], jobsRef: null };
const _STATIC_SORT_KEYS = new Set(['filename', 'host']);

// Dynamic-key sort throttle: status/speed/progress/size change on every
// progress tick, so a strict per-call sort is O(N log N) per render. Within
// one UI_UPDATE_INTERVAL window (200ms), reuse the previous sort even if it's
// slightly out of order — the user can't perceive sub-200ms reorder lag, and
// at 5000 queued jobs this is the difference between smooth and stuttering.
// Uses lib/throttled-cache.js (see tests/throttled-cache.test.js).
const DYNAMIC_SORT_REFRESH_MS = 200;
const _dynamicSortCache = window.ThrottledCache
  ? window.ThrottledCache.makeThrottledCache(DYNAMIC_SORT_REFRESH_MS)
  : { get: () => undefined, set: (s, i, v) => v, clear: () => {} };

function sortQueueJobs(jobs) {
  const { key, direction } = queueSortState;
  const factor = direction === 'asc' ? 1 : -1;
  const canCache = _STATIC_SORT_KEYS.has(key);
  const sig = canCache ? `${key}|${direction}|${jobs.length}` : '';
  if (sig && _queueSortCache.sig === sig && _queueSortCache.jobsRef === jobs) {
    return _queueSortCache.result;
  }
  // Dynamic-key throttle: same key+direction+array, sorted within the last
  // 200ms → reuse. The cache is keyed by `key|direction` and uses the jobs
  // array identity as the input ref, so a fresh queueJobs (e.g. after
  // backup import) misses correctly.
  if (!canCache) {
    const dynSig = `${key}|${direction}`;
    const cached = _dynamicSortCache.get(dynSig, jobs);
    if (cached) return cached;
  }

  const sorted = jobs.slice().sort((a, b) => {
    let cmp = 0;
    if (key === 'filename') cmp = _collatorDE.compare(a.fileName, b.fileName);
    else if (key === 'size') cmp = (a.bytesTotal || 0) - (b.bytesTotal || 0);
    else if (key === 'host') cmp = _collatorSimple.compare(a.hoster, b.hoster);
    else if (key === 'status') cmp = getStatusOrder(a.status) - getStatusOrder(b.status);
    else if (key === 'speed') cmp = (a.speedKbs || 0) - (b.speedKbs || 0);
    else if (key === 'progress') cmp = (a.progress || 0) - (b.progress || 0);
    return cmp * factor;
  });
  if (sig) _queueSortCache = { sig, result: sorted, jobsRef: jobs };
  else _dynamicSortCache.set(`${key}|${direction}`, jobs, sorted);
  return sorted;
}

function getStatusOrder(status) {
  const order = { uploading: 0, 'getting-server': 1, retrying: 2, queued: 3, preview: 4, done: 5, aborted: 6, error: 7, skipped: 8 };
  return order[status] ?? 4;
}

// "Primär" / "Fallback #1" / "Fallback #2"… derived from the job's current
// accountId position in the configured hoster account list. Returns '' if we
// can't resolve it (e.g. account was removed mid-session).
function getAccountLabel(job) {
  if (!job || !job.accountId || !job.hoster) return '';
  const accounts = config && config.hosters && config.hosters[job.hoster];
  if (!Array.isArray(accounts)) return '';
  const idx = accounts.findIndex(a => a && a.id === job.accountId);
  if (idx < 0) return '';
  return idx === 0 ? 'Primär' : `Fallback #${idx}`;
}

function getStatusText(job) {
  const shortErr = job.error ? String(job.error).replace(/\s+/g, ' ').slice(0, 100) : '';
  const acc = getAccountLabel(job);
  const accSuffix = acc ? ` · ${acc}` : '';
  switch (job.status) {
    case 'preview': return 'Bereit';
    case 'queued': return 'Wartet';
    case 'getting-server': return `Server...${accSuffix}`;
    case 'uploading': return `Upload${accSuffix}`;
    case 'retrying': {
      const base = `Retry ${job.attempt}/${job.maxAttempts}${accSuffix}`;
      return shortErr ? `${base}: ${shortErr}` : base;
    }
    case 'done': return 'Fertig';
    case 'aborted': return 'Abgebrochen';
    case 'error': return shortErr ? `Fehlgeschlagen: ${shortErr}` : 'Fehlgeschlagen';
    case 'skipped': return shortErr ? `Übersprungen: ${shortErr}` : 'Übersprungen';
    default: return job.status;
  }
}

// --- Queue interactions ---
function handleRowClick(e, row) {
  const jobId = row.dataset.jobId;
  // Clear recent panel selection when clicking in queue — class-toggle only.
  if (selectedRecentIds.size > 0) { selectedRecentIds.clear(); applyRecentSelectionClasses(); }

  if (e.ctrlKey || e.metaKey) {
    if (selectedJobIds.has(jobId)) selectedJobIds.delete(jobId);
    else selectedJobIds.add(jobId);
  } else if (e.shiftKey && selectedJobIds.size > 0) {
    // Use sorted jobs cache for correct shift-click with virtual scrolling
    const sortedIds = _sortedJobsCache.map(j => j.id);
    const lastIdx = sortedIds.findIndex(id => selectedJobIds.has(id));
    const curIdx = sortedIds.indexOf(jobId);
    if (lastIdx >= 0 && curIdx >= 0) {
      const from = Math.min(lastIdx, curIdx);
      const to = Math.max(lastIdx, curIdx);
      for (let i = from; i <= to; i++) selectedJobIds.add(sortedIds[i]);
    }
  } else {
    selectedJobIds.clear();
    selectedJobIds.add(jobId);
    // Single click on done job -> copy link
    const job = _jobIndexById.get(jobId);
    if (job && job.status === 'done' && job.result) {
      const link = job.result.download_url || job.result.embed_url || '';
      if (link) {
        window.api.copyToClipboard(link);
        showCopyToast('Link kopiert');
      }
    }
  }
  // Selection changes don't change sort order / row content — just toggle classes.
  applyQueueSelectionClasses();
  updateQueueActionButtons();
}

// --- Context menu ---
let alwaysOnTopState = false;

// Cache hoster-counts for the context menu. Invalidated on structural changes
// to queueJobs (the length-based signature is good enough — a job's hoster
// never changes after it's created).
let _hosterCountsCache = { sig: '', result: new Map() };
function _getHosterCounts() {
  const sig = `${queueJobs.length}`;
  if (_hosterCountsCache.sig === sig) return _hosterCountsCache.result;
  const m = new Map();
  for (let i = 0; i < queueJobs.length; i++) {
    const h = queueJobs[i].hoster;
    m.set(h, (m.get(h) || 0) + 1);
  }
  _hosterCountsCache = { sig, result: m };
  return m;
}

function handleRowContextMenu(e, row) {
  e.preventDefault();
  const jobId = row.dataset.jobId;
  if (!selectedJobIds.has(jobId)) {
    selectedJobIds.clear();
    selectedJobIds.add(jobId);
    applyQueueSelectionClasses();
    updateQueueActionButtons();
  }
  showContextMenu(e.clientX, e.clientY);
}

function showContextMenu(x, y) {
  const menu = document.getElementById('contextMenu');
  // Update "Always on top" text
  const aotItem = menu.querySelector('[data-action="always-on-top"]');
  if (aotItem) aotItem.textContent = alwaysOnTopState ? 'Immer im Vordergrund ✓' : 'Immer im Vordergrund';
  // Update labels with selection count
  const n = selectedJobIds.size;
  const delItem = menu.querySelector('[data-action="delete-selected"]');
  if (delItem) delItem.textContent = n > 1 ? `Entfernen (${n})` : 'Entfernen';
  const copyItem = menu.querySelector('[data-action="copy-links"]');
  if (copyItem) copyItem.textContent = n > 1 ? `Links kopieren (${n})` : 'Link kopieren';
  menu.querySelectorAll('[data-action="retry-selected"]').forEach(el => {
    el.textContent = n > 1 ? `Erneut versuchen (${n})` : 'Erneut versuchen';
  });
  const startItem = menu.querySelector('[data-action="start-selected"]');
  if (startItem) startItem.textContent = n > 1 ? `Ausgewählte starten (${n})` : 'Ausgewählte starten';

  // Dynamic "delete by hoster" submenu — cached count keyed by queue length
  // so a right-click on a 5000-job queue doesn't rescan everything.
  const deleteHosterSubmenu = menu.querySelector('.ctx-hoster-delete-submenu');
  const deleteHosterContainer = menu.querySelector('.ctx-hoster-delete-items');
  const hosterCounts = _getHosterCounts();
  deleteHosterContainer.innerHTML = '';
  if (hosterCounts.size > 0) {
    deleteHosterSubmenu.style.display = '';
    hosterCounts.forEach((count, hoster) => {
      const item = document.createElement('div');
      item.className = 'ctx-item ctx-item-danger';
      item.dataset.action = `delete-hoster:${hoster}`;
      item.textContent = `${getHosterLabel(hoster)} (${count})`;
      deleteHosterContainer.appendChild(item);
    });
  } else {
    deleteHosterSubmenu.style.display = 'none';
  }

  menu.style.display = 'block';
  const menuX = Math.min(x, window.innerWidth - menu.offsetWidth - 5);
  menu.style.left = menuX + 'px';
  menu.style.top = Math.min(y, window.innerHeight - menu.offsetHeight - 5) + 'px';

  // Flip submenus if they would overflow the viewport right edge
  menu.querySelectorAll('.ctx-submenu-items').forEach(sub => {
    // Temporarily show to measure actual width (display:none → offsetWidth=0)
    sub.style.visibility = 'hidden';
    sub.style.display = 'block';
    sub.classList.toggle('flip-left', menuX + menu.offsetWidth + sub.offsetWidth > window.innerWidth);
    sub.style.display = '';
    sub.style.visibility = '';
  });
}

function hideContextMenu() {
  document.getElementById('contextMenu').style.display = 'none';
  document.getElementById('recentContextMenu').style.display = 'none';
}

function deleteSelectedRecentFiles() {
  if (selectedRecentIds.size === 0) return;
  let removedDone = 0, removedErr = 0;
  sessionFilesData = sessionFilesData.filter(r => {
    if (!selectedRecentIds.has(r.order)) return true;
    if (r.isError) removedErr++; else removedDone++;
    _sessionFileKeys.delete(`${r.link}\u0001${r.filename}\u0001${r.host}`);
    return false;
  });
  _sessionDoneCount = Math.max(0, _sessionDoneCount - removedDone);
  _sessionErrorCount = Math.max(0, _sessionErrorCount - removedErr);
  _recentDataVersion++;
  selectedRecentIds.clear();
  renderRecentUploadsPanel();
}

function clearAllRecentFiles() {
  if (sessionFilesData.length === 0) return;
  if (!confirm(`Wirklich alle ${sessionFilesData.length} Links aus diesem Panel entfernen?`)) return;
  sessionFilesData = [];
  _sessionFileKeys.clear();
  _sessionDoneCount = 0;
  _sessionErrorCount = 0;
  _recentDataVersion++;
  selectedRecentIds.clear();
  renderRecentUploadsPanel();
}

async function exportAllRecentFiles() {
  if (sessionFilesData.length === 0) {
    alert('Keine Einträge zum Exportieren.');
    return;
  }
  const rows = sortRecentFiles(sessionFilesData);
  const header = 'timestamp|hoster|link|filename|status';
  const lines = rows.map(r => {
    const ts = r.timestamp || r.time || '';
    const host = r.host || r.hoster || '';
    const link = r.link || '';
    const name = r.filename || '';
    const status = r.isError ? 'error' : 'ok';
    return [ts, host, link, name, status].map(v => String(v).replace(/[\r\n|]/g, ' ')).join('|');
  });
  const content = [header, ...lines].join('\n') + '\n';
  const defaultName = `uploads-${new Date().toISOString().slice(0, 10)}.log`;
  try {
    const result = await window.api.saveTextFile(defaultName, content, [
      { name: 'Log-Datei', extensions: ['log', 'txt', 'csv'] }
    ]);
    if (result && result.ok) showCopyToast(`${rows.length} Einträge exportiert`);
  } catch (err) {
    alert('Export fehlgeschlagen: ' + (err.message || err));
  }
}

function copySelectedRecentLinks() {
  const links = sessionFilesData
    .filter(r => selectedRecentIds.has(r.order) && !r.isError)
    .map(r => r.link)
    .filter(Boolean);
  if (links.length) { window.api.copyToClipboard(links.join('\n')); showCopyToast(`${links.length} Links kopiert`); }
}

// --- Backup export / import ---
async function doBackupExport() {
  try {
    await flushPendingSettingsSaves();
    const result = await window.api.exportBackup();
    if (result && result.ok) showCopyToast('Backup exportiert');
  } catch (err) {
    alert('Export fehlgeschlagen: ' + (err.message || err));
  }
}

function applyImportedConfig(importedConfig, message) {
  const pendingQueue = buildPersistedQueueState();
  config = {
    ...importedConfig,
    globalSettings: {
      ...(importedConfig.globalSettings || {}),
      pendingQueue
    }
  };
  hosterSettings = config.hosterSettings || {};
  ensureAccountStatusEntries();
  syncSelectedUploadHosters();
  alwaysOnTopState = !!(config.globalSettings && config.globalSettings.alwaysOnTop);
  renderSettings();
  renderAccounts();
  renderHosterSummary();
  renderHosterModal();
  loadHistory();
  showCopyToast(message);
}

async function persistImportedQueueState() {
  let persistenceError = null;
  try {
    await persistQueueStateNow();
  } catch (error) {
    persistenceError = error;
  }
  try {
    await flushConfigWrites();
  } catch (error) {
    if (!persistenceError) persistenceError = error;
  }
  return persistenceError;
}

function showImportQueuePersistenceError(error) {
  showCopyToast(`Import übernommen. Warteschlange konnte nicht vollständig gespeichert werden: ${error.message || error}`, 8000);
}

function setOnlineBackupStatus(message, state = '') {
  const status = document.getElementById('onlineBackupStatus');
  if (!status) return;
  status.textContent = message;
  status.dataset.state = state;
}

function setOnlineBackupBusy(busy) {
  const createButton = document.getElementById('createOnlineBackupBtn');
  const restoreButton = document.getElementById('restoreOnlineBackupBtn');
  if (createButton) createButton.disabled = busy;
  if (restoreButton) restoreButton.disabled = busy || !/^MHU2-[A-Za-z0-9_-]{70}$/.test(document.getElementById('onlineBackupKeyInput')?.value.trim() || '');
}

async function doOnlineBackupCreate() {
  if (doOnlineBackupCreate.busy) return;
  doOnlineBackupCreate.busy = true;
  try {
    await flushPendingSettingsSaves();
    openOnlineBackupView();
  } catch (error) {
    openOnlineBackupView();
    setOnlineBackupStatus(error.message || String(error), 'error');
    doOnlineBackupCreate.busy = false;
    return;
  }
  setOnlineBackupBusy(true);
  setOnlineBackupStatus('Verschlüssele und speichere Einstellungen…', 'busy');
  try {
    const result = await window.api.createOnlineBackup();
    if (!result || !result.ok) throw new Error(result?.error || 'Online-Sicherung konnte nicht erstellt werden');
    const output = document.getElementById('onlineBackupKeyOutput');
    const copyButton = document.getElementById('copyOnlineBackupKeyBtn');
    if (output) output.value = result.key;
    if (copyButton) copyButton.disabled = false;
    setOnlineBackupStatus('Neuer Schlüssel erstellt. Ältere Schlüssel bleiben gültig.', 'success');
    showCopyToast('Online-Schlüssel erstellt');
  } catch (error) {
    setOnlineBackupStatus(error.message || String(error), 'error');
  } finally {
    setOnlineBackupBusy(false);
    doOnlineBackupCreate.busy = false;
  }
}

function openOnlineBackupView(focusRestore = false) {
  document.querySelector('.tab[data-view="settings"]')?.click();
  const searchInput = document.getElementById('settingsSearchInput');
  if (searchInput && searchInput.value) {
    searchInput.value = '';
    searchInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  }
  document.querySelector('[data-settings-page="backup"]')?.click();
  if (focusRestore) document.getElementById('onlineBackupKeyInput')?.focus();
}

function openOnlineBackupRestore() {
  openOnlineBackupView(true);
}

async function doOnlineBackupRestore() {
  const input = document.getElementById('onlineBackupKeyInput');
  const key = input?.value.trim() || '';
  if (!/^MHU2-[A-Za-z0-9_-]{70}$/.test(key)) {
    setOnlineBackupStatus('Der Schlüssel muss mit MHU2- beginnen und exakt 75 Zeichen lang sein.', 'error');
    input?.focus();
    return;
  }
  setOnlineBackupBusy(true);
  setOnlineBackupStatus('Speichere aktuelle Einstellungen…', 'busy');
  try {
    await flushPendingSettingsSaves();
    setOnlineBackupStatus('Lade und entschlüssele Einstellungen…', 'busy');
    beginConfigImport();
    let result;
    let queuePersistenceError = null;
    try {
      result = await window.api.restoreOnlineBackup(key);
      if (result && result.ok) applyImportedConfig(result.config, 'Online-Backup importiert');
    } finally {
      queuePersistenceError = await persistImportedQueueState();
      endConfigImport();
    }
    if (!result || !result.ok) throw new Error(result?.error || 'Online-Sicherung konnte nicht importiert werden');
    const warnings = Array.isArray(result.warnings) ? result.warnings : [];
    if (warnings.length) setOnlineBackupStatus(`Einstellungen übernommen. Bitte prüfen: ${warnings.join(', ')}.`, 'warning');
    else setOnlineBackupStatus('Alle Accounts und Einstellungen wurden übernommen.', 'success');
    if (queuePersistenceError) showImportQueuePersistenceError(queuePersistenceError);
  } catch (error) {
    setOnlineBackupStatus(error.message || String(error), 'error');
  } finally {
    setOnlineBackupBusy(false);
  }
}

function askLegacyBackupPassword(hint) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.display = 'flex';

    const card = document.createElement('div');
    card.className = 'modal-card';
    card.style.width = 'min(380px,100%)';

    const header = document.createElement('div');
    header.className = 'modal-header';
    const h3 = document.createElement('h3');
    h3.textContent = 'Backup nicht entschlüsselbar';
    header.appendChild(h3);

    const body = document.createElement('div');
    body.className = 'modal-body';
    const p = document.createElement('p');
    p.style.margin = '0 0 10px';
    p.style.fontSize = '13px';
    p.textContent = 'Wenn das Backup mit der alten Passwort-Option (vor v3.0) erstellt wurde, hier eingeben.';
    if (hint) {
      const p2 = document.createElement('p');
      p2.style.margin = '0 0 10px';
      p2.style.fontSize = '12px';
      p2.style.color = 'var(--text-dim)';
      p2.textContent = hint;
      body.appendChild(p2);
    }
    const input = document.createElement('input');
    input.type = 'password';
    input.className = 'key-input';
    input.placeholder = 'Passwort';
    input.autocomplete = 'off';
    input.style.width = '100%';
    body.appendChild(p);
    body.appendChild(input);

    const footer = document.createElement('div');
    footer.className = 'modal-footer';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-secondary';
    cancelBtn.textContent = 'Abbrechen';
    const okBtn = document.createElement('button');
    okBtn.className = 'btn btn-primary';
    okBtn.textContent = 'Importieren';
    footer.appendChild(cancelBtn);
    footer.appendChild(okBtn);

    card.appendChild(header);
    card.appendChild(body);
    card.appendChild(footer);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    const done = (val) => { overlay.remove(); resolve(val); };
    okBtn.onclick = () => done(input.value || null);
    cancelBtn.onclick = () => done(null);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') done(input.value || null);
      if (e.key === 'Escape') done(null);
    });
    input.focus();
  });
}

async function doBackupImport(legacyPassword) {
  const pw = typeof legacyPassword === 'string' ? legacyPassword : undefined;
  try {
    await flushPendingSettingsSaves();
    beginConfigImport();
    let result;
    let queuePersistenceError = null;
    try {
      result = await window.api.importBackup(pw);
      if (result && result.ok) applyImportedConfig(result.config, 'Backup importiert');
    } finally {
      queuePersistenceError = await persistImportedQueueState();
      endConfigImport();
    }
    if (!result || result.canceled) return;
    if (result.needsPassword) {
      const entered = await askLegacyBackupPassword(result.hint);
      if (entered) doBackupImport(entered);
      return;
    }
    if (result.ok) {
      if (Array.isArray(result.warnings) && result.warnings.length) {
        alert(`Backup importiert. Bitte prüfen: ${result.warnings.join(', ')}.`);
      }
      if (queuePersistenceError) showImportQueuePersistenceError(queuePersistenceError);
    } else if (result.error) {
      alert('Import fehlgeschlagen: ' + result.error);
    }
  } catch (err) {
    alert('Import fehlgeschlagen: ' + (err.message || err));
  }
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.context-menu')) hideContextMenu();
});
document.addEventListener('keydown', (e) => {
  if (_isUpdateDialogVisible()) return;
  const accountModal = document.getElementById('accountModal');
  if (e.key === 'Tab' && accountModal && accountModal.style.display !== 'none') {
    const focusable = Array.from(accountModal.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'));
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (first && last && ((!e.shiftKey && document.activeElement === last) || (e.shiftKey && document.activeElement === first))) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    }
  }
  if (e.key === 'Escape') {
    hideContextMenu();
    cancelHosterModal();
    if (accountModal && accountModal.style.display !== 'none') closeAccountModal();
  }
  if (e.target.closest('input, textarea, select')) return;
  const activeView = document.querySelector('.view.active');
  // Ctrl+A
  if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
    if (activeView && activeView.id === 'upload-view') {
      e.preventDefault();
      // Select recent files only if user's last interaction was in the recent panel
      if (selectedRecentIds.size > 0 && selectedJobIds.size === 0) {
        sessionFilesData.forEach(r => selectedRecentIds.add(r.order));
        renderRecentUploadsPanel();
      } else {
        const visibleJobs = _getVisibleQueueJobs();
        selectedJobIds.clear();
        visibleJobs.forEach(j => selectedJobIds.add(j.id));
        renderQueueTable();
      }
    }
  }
  // Delete
  if (e.key === 'Delete') {
    if (activeView && activeView.id === 'upload-view') {
      e.preventDefault();
      _normalizeQueueSelectionToVisible();
      if (selectedRecentIds.size > 0) {
        deleteSelectedRecentFiles();
      } else if (selectedJobIds.size > 0) {
        const deletedIds = [...selectedJobIds];
        // Cancel active uploads for deleted jobs
        const activeIds = deletedIds.filter(id => {
          const j = _jobIndexById.get(id);
          return j && (j.status === 'uploading' || j.status === 'queued' || j.status === 'retrying' || j.status === 'getting-server');
        });
        if (activeIds.length > 0) window.api.cancelSelectedJobs(activeIds);
        const _deletedKeys = [];
        queueJobs = queueJobs.filter(j => {
          if (selectedJobIds.has(j.id)) {
            if (j.file && j.hoster && j.status !== 'done') _deletedKeys.push(`${j.file}|${j.hoster}`);
            removeJobFromIndex(j);
            return false;
          }
          return true;
        });
        selectedJobIds.clear();
        syncSelectedFilesFromQueue();
        suppressPreviewKeysStillSelected(_deletedKeys);
        renderQueueTable();
        if (queueJobs.length === 0) { selectedFiles = []; updateUploadView(); }
        updateStatusBar();
        persistQueueStateSoon(true);
      }
    }
  }
});

document.getElementById('contextMenu').addEventListener('click', (e) => {
  const item = e.target.closest('.ctx-item');
  if (!item) return;
  const action = item.dataset.action;
  if (!action) return;
  hideContextMenu();
  handleContextAction(action);
});

async function handleContextAction(action) {
  _normalizeQueueSelectionToVisible();
  if (action === 'start-selected') {
    startSelectedUpload();
  } else if (action === 'copy-links') {
    const links = getSelectedJobLinks();
    if (links.length) { window.api.copyToClipboard(links.join('\n')); showCopyToast(`${links.length} Links kopiert`); }
  } else if (action === 'retry-selected') {
    retrySelectedJobs();
  } else if (action === 'show-log') {
    showJobLogModal();
  } else if (action === 'delete-selected') {
    // Cancel active uploads for deleted jobs
    const activeIds = [...selectedJobIds].filter(id => {
      const j = _jobIndexById.get(id);
      return j && (j.status === 'uploading' || j.status === 'queued' || j.status === 'retrying' || j.status === 'getting-server');
    });
    if (activeIds.length > 0) window.api.cancelSelectedJobs(activeIds);
    const _deletedKeys = [];
    queueJobs = queueJobs.filter(j => {
      if (selectedJobIds.has(j.id)) {
        if (j.file && j.hoster && j.status !== 'done') _deletedKeys.push(`${j.file}|${j.hoster}`);
        removeJobFromIndex(j);
        return false;
      }
      return true;
    });
    selectedJobIds.clear();
    syncSelectedFilesFromQueue();
    suppressPreviewKeysStillSelected(_deletedKeys);
    renderQueueTable();
    if (queueJobs.length === 0) { selectedFiles = []; updateUploadView(); }
    updateStatusBar();
    persistQueueStateSoon(true);
  } else if (action === 'copy-all-links') {
    copyAllLinks();
  } else if (action === 'delete-all') {
    // Cancel all active uploads
    const activeIds = queueJobs
      .filter(j => j.status === 'uploading' || j.status === 'queued' || j.status === 'retrying' || j.status === 'getting-server')
      .map(j => j.id);
    if (activeIds.length > 0) window.api.cancelSelectedJobs(activeIds);
    queueJobs.forEach(j => removeJobFromIndex(j));
    queueJobs = [];
    selectedJobIds.clear();
    selectedFiles = [];
    syncSelectedFilesFromQueue();
    renderQueueTable();
    updateUploadView();
    updateStatusBar();
    persistQueueStateSoon(true);
  } else if (action === 'always-on-top') {
    alwaysOnTopState = !alwaysOnTopState;
    await setAlwaysOnTopTracked(alwaysOnTopState);
    config.globalSettings = { ...(config.globalSettings || {}), alwaysOnTop: alwaysOnTopState };
  } else if (action.startsWith('delete-hoster:')) {
    const hoster = action.replace('delete-hoster:', '');
    // Cancel active uploads for this hoster
    const activeIds = queueJobs
      .filter(j => j.hoster === hoster && (j.status === 'uploading' || j.status === 'queued' || j.status === 'retrying' || j.status === 'getting-server' || j.status === 'preview'))
      .map(j => j.id);
    if (activeIds.length > 0) await window.api.cancelSelectedJobs(activeIds);
    // Remove ALL jobs for this hoster
    queueJobs = queueJobs.filter(j => {
      if (j.hoster === hoster) { removeJobFromIndex(j); return false; }
      return true;
    });
    selectedJobIds.clear();
    syncSelectedFilesFromQueue();
    renderQueueTable();
    if (queueJobs.length === 0) { selectedFiles = []; updateUploadView(); }
    updateStatusBar();
    updateQueueActionButtons();
    persistQueueStateSoon(true);
  } else if (action.startsWith('shutdown-')) {
    const mode = action.replace('shutdown-', '');
    await window.api.setShutdownAfterFinish(mode);
  }
}

function getSelectedJobLinks() {
  return _getVisibleSelectedQueueJobs(j => j.status === 'done' && j.result)
    .map(j => j.result.download_url || j.result.embed_url || '')
    .filter(Boolean);
}

// --- Upload ---
async function startUpload(opts) {
  if (uploading) return;
  if (!(opts && opts._autoRetry)) _cancelAutoRetry(true);
  else _cancelAutoRetry(false);
  uploading = true; // set immediately to prevent double-click race
  updateQueueActionButtons();
  _hydrateMissingJobSizes();

  const hosters = getSelectedHosters();
  if (queueJobs.length === 0 && selectedFiles.length > 0) {
    if (hosters.length === 0) {
      alert('Bitte mindestens einen Hoster auswählen.');
      uploading = false;
      updateQueueActionButtons();
      return;
    }
    buildQueuePreview();
  }

  const jobsToStart = queueJobs.filter((job) => isStartableQueueStatus(job.status));
  if (jobsToStart.length === 0) { uploading = false; updateQueueActionButtons(); return; }

  try {
    jobsToStart.forEach(j => {
      j.status = 'queued';
      j.error = null;
      j.result = null;
      j.bytesUploaded = 0;
      j.speedKbs = 0;
      j.elapsed = 0;
      j.remaining = 0;
      j.progress = 0;
      j.uploadId = null;
    });
    updateQueueActionButtons();
    renderQueueTable();
    updateStatusBar();

    const uploadPayload = {
      hosters,
      isAutoRetry: !!(opts && opts._autoRetry),
      jobs: jobsToStart.map((job) => ({
        id: job.id,
        file: job.file,
        fileName: job.fileName,
        hoster: job.hoster
      }))
    };
    const result = await window.api.startUpload(uploadPayload);
    _markSkippedJobs(result);
    persistQueueStateSoon();

    if (result && result.error) {
      alert(result.error);
      uploading = false;
      updateQueueActionButtons();
      updateStatusBar();
    }
  } catch (err) {
    uploading = false;
    updateQueueActionButtons();
    updateStatusBar();
    alert(`Upload-Start fehlgeschlagen: ${err.message}`);
  }
}

function _markSkippedJobs(result) {
  if (!result || !Array.isArray(result.skippedJobs) || result.skippedJobs.length === 0) return;
  for (const skipped of result.skippedJobs) {
    const job = _jobIndexById.get(skipped.jobId);
    if (job) {
      job.status = 'error';
      job.error = skipped.reason || 'Kein gültiger Account';
    }
  }
  renderQueueTable();
}

async function startSelectedUpload(explicitJobs) {
  const scopedJobs = Array.isArray(explicitJobs) ? explicitJobs : _getVisibleSelectedQueueJobs();
  if (uploading) {
    _hydrateMissingJobSizes();
    const addable = scopedJobs.filter(j => isStartableQueueStatus(j.status));
    if (addable.length === 0) {
      if (selectedJobIds.size > 0) showCopyToast('Keine startbaren Jobs ausgewählt (alle laufen schon oder sind fertig).');
      return;
    }
    {
      addable.forEach(j => {
        j.status = 'queued'; j.error = null; j.result = null;
        j.bytesUploaded = 0; j.speedKbs = 0; j.progress = 0; j.uploadId = null;
      });
      renderQueueTable();
      let result = null;
      try {
        result = await window.api.addJobsToBatch({
          jobs: addable.map(j => ({ id: j.id, file: j.file, fileName: j.fileName, hoster: j.hoster }))
        });
      } catch (err) {
        showCopyToast(`Jobs konnten nicht hinzugefuegt werden: ${err.message}`);
        return;
      }

      // If the batch ended between UI-state and IPC call, start a fresh batch immediately
      if (result && result.error === 'Kein Upload aktiv') {
        uploading = false;
        updateQueueActionButtons();
        updateStatusBar();
        await startSelectedUpload(addable);
        return;
      }
      _markSkippedJobs(result);
      persistQueueStateSoon();
      const added = Number(result && result.added) || 0;
      // Use ASCII-only toast text here to avoid encoding artifacts on some systems.
      const skipped = Array.isArray(result && result.skippedJobs) ? result.skippedJobs.length : 0;
      const alreadyInBatch = Array.isArray(result && result.alreadyInBatchJobIds)
        ? result.alreadyInBatchJobIds.length
        : Math.max(0, addable.length - added - skipped);
      const toastParts = [];
      if (added > 0) toastParts.push(`${added} hinzugefuegt`);
      if (alreadyInBatch > 0) toastParts.push(`${alreadyInBatch} bereits im Batch`);
      if (skipped > 0) toastParts.push(`${skipped} ohne gueltigen Account`);
      if (result && result.error) {
        showCopyToast(`Jobs konnten nicht hinzugefuegt werden: ${result.error}`);
      } else if (toastParts.length > 0) {
        showCopyToast(`Jobs: ${toastParts.join(', ')}`);
      } else {
        showCopyToast('Keine Jobs hinzugefuegt');
      }
      return;
    }
  }
  uploading = true; // set immediately to prevent double-click race
  updateQueueActionButtons();

  const hosters = getSelectedHosters();
  const jobsToStart = scopedJobs.filter(job => isStartableQueueStatus(job.status));
  if (jobsToStart.length === 0) { uploading = false; updateQueueActionButtons(); return; }

  try {
    jobsToStart.forEach(j => {
      j.status = 'queued';
      j.error = null;
      j.result = null;
      j.bytesUploaded = 0;
      j.speedKbs = 0;
      j.progress = 0;
      j.uploadId = null;
    });
    updateQueueActionButtons();
    renderQueueTable();
    updateStatusBar();

    const uploadPayload = {
      hosters,
      jobs: jobsToStart.map((job) => ({
      id: job.id,
      file: job.file,
      fileName: job.fileName,
      hoster: job.hoster
    }))
  };
    const result = await window.api.startUpload(uploadPayload);
    _markSkippedJobs(result);
    persistQueueStateSoon();

    if (result && result.error) {
      alert(result.error);
      uploading = false;
      updateQueueActionButtons();
      updateStatusBar();
    }
  } catch (err) {
    uploading = false;
    updateQueueActionButtons();
    updateStatusBar();
    alert(`Upload-Start fehlgeschlagen: ${err.message}`);
  }
}

async function cancelUpload() {
  _cancelAutoRetry(true);
  await window.api.cancelUpload();
  uploading = false;
  // Reset all non-finished jobs back to queued state
  for (const job of queueJobs) {
    if (!['done', 'error', 'skipped'].includes(job.status)) {
      job.status = 'queued';
      job.progress = 0;
      job.bytesUploaded = 0;
      job.speedKbs = 0;
      job.elapsed = 0;
      job.remaining = 0;
      job.error = null;
    }
  }
  renderQueueTable();
  updateQueueActionButtons();
  updateStatusBar();
  persistQueueStateSoon();
}

// --- Progress handling ---
function handleProgress(data) {
  try {
    if (!data || typeof data !== 'object') return;
    _handleProgressImpl(data);
  } catch (err) {
    if (window.api && window.api.debugLog) window.api.debugLog(`handleProgress error: ${err && err.stack ? err.stack : err}`);
  }
}
function _handleProgressImpl(data) {
  let job = data.jobId ? _jobIndexById.get(data.jobId) : null;
  if (!job && data.uploadId) job = _jobIndexByUploadId.get(data.uploadId);
  if (!job) {
    job = queueJobs.find(j =>
      j.fileName === data.fileName && j.hoster === data.hoster && j.status === 'queued'
    ) || queueJobs.find(j =>
      j.fileName === data.fileName && j.hoster === data.hoster && j.status === 'preview'
    );
    if (job && data.uploadId) {
      job.uploadId = data.uploadId;
      _jobIndexByUploadId.set(data.uploadId, job);
    }
  }
  if (!job) {
    // Don't re-create jobs that were explicitly deleted by the user
    if ((data.jobId && _deletedJobIds.has(data.jobId)) || (data.uploadId && _deletedJobIds.has(data.uploadId))) {
      return;
    }
    job = {
      id: data.jobId || data.uploadId || `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      uploadId: data.uploadId,
      file: '', fileName: data.fileName, hoster: data.hoster,
      status: data.status, bytesUploaded: 0, bytesTotal: data.bytesTotal || 0,
      speedKbs: 0, elapsed: 0, remaining: 0,
      error: null, result: null, attempt: 0, maxAttempts: 0, link: ''
    };
    queueJobs.push(job);
    indexJob(job);
  }

  // Don't regress from terminal states (stale callbacks can arrive after completion)
  if (job.status === 'done' || job.status === 'skipped') return;

  // Update job state
  job.status = data.status;
  job.bytesUploaded = data.bytesUploaded || 0;
  job.bytesTotal = data.bytesTotal || job.bytesTotal;
  // Track session total bytes (survives removeFromQueueOnDone)
  if (job.bytesTotal > 0 && !_sessionTrackedJobs.has(job.id)) {
    _sessionTotalBytes += job.bytesTotal;
    _sessionTrackedJobs.add(job.id);
  }
  job.speedKbs = data.speedKbs || 0;
  job.elapsed = data.elapsed || 0;
  job.remaining = data.remaining || 0;
  job.error = data.error || null;
  job.result = data.result || job.result;
  job.attempt = data.attempt || 0;
  job.maxAttempts = data.maxAttempts || 0;
  job.progress = data.progress || 0;
  // Track which account the backend is currently using so the status cell
  // can display "Primär" vs "Fallback #N" during rotation.
  if (data.accountId) job.accountId = data.accountId;
  if (data.uploadId) {
    job.uploadId = data.uploadId;
    _jobIndexByUploadId.set(data.uploadId, job);
  }

  maybeAddSessionFile(job);

  // Track session uploaded bytes (survives removeFromQueueOnDone)
  if (job.status === 'done' && !_sessionDoneJobs.has(job.id)) {
    _sessionUploadedBytes += job.bytesTotal || 0;
    _sessionDoneJobs.add(job.id);
  }

  // Track completed uploads so they don't get re-queued after removal
  if (job.status === 'done') {
    _completedUploadKeys.add(`${job.file}|${job.hoster}`);
  }

  // Remove finished jobs from queue if setting is enabled. Coalesce the
  // actual array filter into one microtask: a burst of 500 done events
  // would otherwise fire 500 individual O(N) filters = O(N²) work, visible
  // as a brief UI freeze when a big batch finishes. Index/selection are
  // updated synchronously so subsequent lookups see the right state — only
  // the array rewrite is deferred.
  if (job.status === 'done' && config.globalSettings && config.globalSettings.removeFromQueueOnDone) {
    removeJobFromIndex(job, true);
    selectedJobIds.delete(job.id);
    if (_doneRemovalCoalescer) {
      _doneRemovalCoalescer.add(job.id);
    } else {
      // Legacy slow path: immediate filter when the lib script didn't load.
      queueJobs = queueJobs.filter(j => j !== job);
    }
  }

  // Status changes (done/error/etc) get one coalesced update per frame so a
  // burst of 500 parallel jobs flipping state doesn't fire 2000 sync DOM
  // updates. Ongoing uploading progress is throttled at 200ms.
  if (data.status === 'uploading') {
    scheduleThrottledUIUpdate();
  } else {
    scheduleStatusChangeUpdate();
  }
  persistQueueStateSoon();
}

function handleBatchDone(summary) {
  uploading = false;
  applySummaryResults(summary);
  _deletedJobIds.clear(); // Free memory — stale IDs no longer needed after batch completes
  // Prune session-stats sets to current queue contents. Without this, IDs
  // of jobs that were removed from queueJobs (via removeFromQueueOnDone
  // or the cap-prune below) live forever in these sets — small leak per
  // entry, real over weeks of use. _completedUploadKeys is intentionally
  // kept (it's the dedup against re-queueing the same file).
  if (_sessionTrackedJobs.size > 0 || _sessionDoneJobs.size > 0) {
    const aliveIds = new Set();
    for (const j of queueJobs) aliveIds.add(j.id);
    for (const id of _sessionTrackedJobs) if (!aliveIds.has(id)) _sessionTrackedJobs.delete(id);
    for (const id of _sessionDoneJobs) if (!aliveIds.has(id)) _sessionDoneJobs.delete(id);
  }

  // Reset aborted jobs back to queued so they can be restarted
  for (const job of queueJobs) {
    if (job.status === 'aborted') {
      job.status = 'queued';
      job.progress = 0;
      job.bytesUploaded = 0;
      job.speedKbs = 0;
      job.elapsed = 0;
      job.remaining = 0;
      job.error = null;
    }
  }

  syncSelectedFilesFromQueue();
  updateQueueActionButtons();
  renderQueueTable();
  renderRecentUploadsPanel();
  // History is only visible on the Verlauf tab. Mark it dirty and refresh when
  // the user actually switches to it — skips an IPC + full table rebuild per
  // batch-done when the user is watching the upload view.
  _historyDirty = true;
  if (_isHistoryTabActive()) loadHistory();

  const removeOnDone = config.globalSettings && config.globalSettings.removeFromQueueOnDone;
  if (removeOnDone) {
    // Single pass: build the keep-list and clean up the index for removed jobs.
    const nextJobs = [];
    for (const job of queueJobs) {
      if (job.status === 'done') {
        removeJobFromIndex(job, true);
        selectedJobIds.delete(job.id);
      } else {
        nextJobs.push(job);
      }
    }
    queueJobs = nextJobs;
    renderQueueTable();
  } else {
    // Auto-prune for the default (removeOnDone=false) too: cap terminal
    // jobs (done/skipped/error/aborted) at the most recent N so the queue
    // can't grow unbounded across long sessions. The algorithm lives in
    // lib/queue-prune.js (same impl Node-tested, see tests/queue-prune.test.js)
    // and the result tells us which jobs to drop so we can clean up the
    // index + selection in one pass.
    const TERMINAL_KEEP_LIMIT = 500;
    // Optional-chain so the renderer still works if the prune script fails
    // to load (e.g. file:// path issues during dev) — falls back to no-prune
    // rather than crashing on every batch-done.
    const result = window.QueuePrune?.pruneOldestTerminalJobs(queueJobs, TERMINAL_KEEP_LIMIT);
    if (result) {
      for (const j of result.dropped) {
        removeJobFromIndex(j, true);
        selectedJobIds.delete(j.id);
      }
      queueJobs = result.kept;
      renderQueueTable();
    }
  }

  if (queueJobs.some((job) => !['done', 'skipped'].includes(job.status))) persistQueueStateSoon(true);
  else clearPersistedQueueStateSoon();

  lastUploadStats = { state: 'idle', globalSpeedKbs: 0, totalBytes: lastUploadStats.totalBytes, elapsed: lastUploadStats.elapsed, activeJobs: 0 };
  updateStatusBar();
  _refreshSessionFailedSnapshot();
  _scheduleAutoRetryIfNeeded();
}

let _sessionFailedKeys = new Set();

const _autoRetryState = { round: 0, timer: null };
function _cancelAutoRetry(resetRound) {
  if (_autoRetryState.timer) { clearTimeout(_autoRetryState.timer); _autoRetryState.timer = null; }
  if (resetRound) _autoRetryState.round = 0;
}
function _collectAutoRetryableJobs() {
  if (!window.Stats) return [];
  return queueJobs.filter(j => j.status === 'error'
    && window.Stats.isRetryableCategory(window.Stats.classifyErrorCategory(j.error)));
}
function _scheduleAutoRetryIfNeeded() {
  const rounds = Math.max(0, Math.min(5, Number(config.globalSettings?.autoRetryRounds) || 0));
  if (rounds <= 0) return;
  if (_autoRetryState.round >= rounds) { _autoRetryState.round = 0; return; }
  const retryable = _collectAutoRetryableJobs();
  if (retryable.length === 0) { _autoRetryState.round = 0; return; }
  const delayMin = Math.max(1, Math.min(120, Number(config.globalSettings?.autoRetryDelayMin) || 5));
  const nextRound = _autoRetryState.round + 1;
  const waitMin = delayMin * nextRound;
  _autoRetryState.round = nextRound;
  showCopyToast(`Auto-Retry Runde ${nextRound}/${rounds}: ${retryable.length} transiente Fehler werden in ${waitMin} min neu versucht.`, 10000);
  _autoRetryState.timer = setTimeout(() => {
    _autoRetryState.timer = null;
    const jobs = _collectAutoRetryableJobs();
    if (jobs.length === 0) { _autoRetryState.round = 0; return; }
    for (const j of jobs) {
      j.status = 'queued'; j.error = null; j.result = null;
      j.bytesUploaded = 0; j.speedKbs = 0; j.progress = 0; j.uploadId = null;
    }
    renderQueueTable();
    startUpload({ _autoRetry: true });
  }, waitMin * 60_000);
}
async function _refreshSessionFailedSnapshot() {
  if (!window.api || !window.api.getSessionFailedAccounts) return;
  try {
    const keys = await window.api.getSessionFailedAccounts();
    _sessionFailedKeys = new Set(Array.isArray(keys) ? keys : []);
    renderAccounts();
  } catch { /* ignore */ }
}

function _maybeShowBatchSummary(summary) {
  if (!window.Stats || !summary) return;
  const buckets = window.Stats.summarizeBatchErrors(summary);
  const total = Object.values(buckets).reduce((n, arr) => n + arr.length, 0);
  if (total === 0) return;

  const modal = document.getElementById('batchSummaryModal');
  if (!modal) return;
  const list = modal.querySelector('#batchSummaryList');
  const retryAllBtn = modal.querySelector('#batchSummaryRetryAll');
  const retryTransientBtn = modal.querySelector('#batchSummaryRetryTransient');
  const closeBtn = modal.querySelector('#batchSummaryClose');

  const order = ['hoster-transient', 'network', 'unknown', 'file-rejected', 'account-error', 'aborted'];
  list.innerHTML = order
    .filter(cat => buckets[cat].length > 0)
    .map(cat => {
      const items = buckets[cat];
      const sample = items.slice(0, 3).map(i => `<li>${escapeHtml(i.fileName)} → ${escapeHtml(i.hoster)}: <em>${escapeHtml(i.error)}</em></li>`).join('');
      const more = items.length > 3 ? `<li><em>… +${items.length - 3} weitere</em></li>` : '';
      const retryable = window.Stats.isRetryableCategory(cat);
      const tag = retryable ? '<span class="batch-cat-tag retryable">erneut versuchbar</span>' : '<span class="batch-cat-tag">manuell</span>';
      return `<div class="batch-cat" data-category="${escapeAttr(cat)}">
        <div class="batch-cat-head"><strong>${escapeHtml(window.Stats.CATEGORY_LABELS[cat] || cat)}</strong> <span class="batch-cat-count">${items.length}</span> ${tag}</div>
        <ul class="batch-cat-list">${sample}${more}</ul>
      </div>`;
    }).join('');

  const transientCount = ['hoster-transient', 'network', 'unknown'].reduce((n, c) => n + buckets[c].length, 0);
  retryTransientBtn.textContent = transientCount > 0 ? `Transiente erneut hochladen (${transientCount})` : 'Keine transienten Fehler';
  retryTransientBtn.disabled = transientCount === 0;
  const allRetryable = total - buckets['aborted'].length;
  retryAllBtn.textContent = `Alle Fehler erneut versuchen (${allRetryable})`;
  retryAllBtn.disabled = allRetryable === 0;

  const close = () => { modal.style.display = 'none'; };
  closeBtn.onclick = close;
  retryAllBtn.onclick = () => { _retryFailedFromBuckets(buckets, false); close(); };
  retryTransientBtn.onclick = () => { _retryFailedFromBuckets(buckets, true); close(); };
  modal.style.display = 'flex';
}

function _retryFailedFromBuckets(buckets, transientOnly) {
  const cats = transientOnly ? ['hoster-transient', 'network', 'unknown'] : ['hoster-transient', 'network', 'unknown', 'file-rejected', 'account-error'];
  const toRetry = [];
  for (const cat of cats) {
    for (const item of (buckets[cat] || [])) toRetry.push(item);
  }
  if (toRetry.length === 0) return;
  const jobsToRetry = [];
  for (const item of toRetry) {
    const job = queueJobs.find(j => (j.fileName === item.fileName) && (j.hoster === item.hoster) && (j.status === 'error' || j.status === 'skipped'));
    if (job) {
      job.status = 'queued';
      job.progress = 0;
      job.bytesUploaded = 0;
      job.error = null;
      job.result = null;
      jobsToRetry.push(job);
    }
  }
  if (jobsToRetry.length === 0) { showCopyToast('Keine passenden Jobs für Retry gefunden.'); return; }
  renderQueueTable();
  showCopyToast(`${jobsToRetry.length} Job(s) zum erneuten Upload zurückgesetzt`);
  if (typeof startUpload === 'function') startUpload();
}

function handleStats(data) {
  try {
    if (!data || typeof data !== 'object') return;
    _handleStatsImpl(data);
  } catch (err) {
    if (window.api && window.api.debugLog) window.api.debugLog(`handleStats error: ${err && err.stack ? err.stack : err}`);
  }
}
function _handleStatsImpl(data) {
  lastUploadStats = {
    state: data.state || 'idle',
    globalSpeedKbs: data.globalSpeedKbs || 0,
    totalBytes: data.totalBytes || 0,
    elapsed: data.elapsed || 0,
    activeJobs: data.activeJobs || 0
  };
  updateStatusBar();
  updateStatsPanel();

  if (data.state === 'uploading' && (data.activeJobs || 0) > 0) {
    _maybeLogRendererPerf(data.activeJobs);
  } else {
    _resetRendererPerf();
  }

  // Track run time
  if (data.state === 'uploading' || data.state === 'stopping') {
    if (!statsStartTime) {
      statsStartTime = Date.now();
      statsRunTimer = setInterval(() => {
        const el = document.getElementById('statRunTime');
        if (el) el.textContent = formatDuration(Math.round((Date.now() - statsStartTime) / 1000));
      }, 1000);
    }
  } else if (data.state === 'idle' && statsRunTimer) {
    clearInterval(statsRunTimer);
    statsRunTimer = null;
  }
}

// --- Per-job log modal ---
async function showJobLogModal() {
  const selectedJobs = _getVisibleSelectedQueueJobs();
  if (selectedJobs.length === 0) return;
  // Use the first selected job — log view is per-file, multi-select doesn't
  // make sense here.
  const job = selectedJobs[0];
  const jobId = job.id;
  const modal = document.getElementById('jobLogModal');
  const titleEl = document.getElementById('jobLogTitle');
  const bodyEl = document.getElementById('jobLogBody');
  if (!modal || !titleEl || !bodyEl) return;

  titleEl.textContent = job && job.fileName ? `Log · ${job.fileName}` : 'Upload-Log';
  bodyEl.textContent = 'Lade…';
  modal.style.display = 'flex';

  let entries = [];
  try { entries = await window.api.getJobLog(jobId); } catch {}

  if (!Array.isArray(entries) || entries.length === 0) {
    bodyEl.textContent = 'Keine Log-Einträge für diesen Job (entweder noch nichts passiert oder aus vorherigem Batch und schon geräumt).';
    return;
  }

  const fmt = (e) => {
    const t = new Date(e.ts || Date.now()).toLocaleTimeString(getUiLocale(), { hour12: false }) + '.' +
      String((e.ts || 0) % 1000).padStart(3, '0');
    if (e.kind === 'progress') {
      const attempt = e.attempt ? ` (${e.attempt}/${e.maxAttempts || '?'})` : '';
      const acc = e.accountId ? ` acc=${e.accountId.slice(0, 32)}` : '';
      const err = e.error ? `\n    → ${e.error}` : '';
      return `[${t}] status=${e.status}${attempt}${acc}${err}`;
    }
    // rot-log
    const rest = Object.entries(e)
      .filter(([k]) => !['ts', 'kind', 'event', 'jobId'].includes(k))
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join(' ');
    return `[${t}] [${e.event}] ${rest}`;
  };
  bodyEl.textContent = entries.map(fmt).join('\n');
}

function hideJobLogModal() {
  const m = document.getElementById('jobLogModal');
  if (m) m.style.display = 'none';
}

async function copyJobLogToClipboard() {
  const body = document.getElementById('jobLogBody');
  if (!body || !body.textContent) return;
  try { await window.api.copyToClipboard(body.textContent); showCopyToast('Log in Zwischenablage'); } catch {}
}

// --- Retry ---
async function retrySelectedJobs() {
  _normalizeQueueSelectionToVisible();
  const retryJobs = [];
  // Build a Set for O(1) selectedFiles dedup below.
  const existingFilePaths = new Set();
  for (const f of selectedFiles) existingFilePaths.add(f.path);

  queueJobs.forEach(j => {
    if (selectedJobIds.has(j.id) && ['error', 'done', 'aborted', 'skipped'].includes(j.status)) {
      // Invalidate the old uploadId: retire the index entry and mark it so
      // any late progress event from the previous (cancelled/completed)
      // upload can't overwrite the freshly-reset state.
      if (j.uploadId) {
        _jobIndexByUploadId.delete(j.uploadId);
        _deletedJobIds.add(j.uploadId);
      }
      j.status = uploading ? 'queued' : 'preview';
      j.error = null;
      j.result = null;
      j.bytesUploaded = 0;
      j.speedKbs = 0;
      j.elapsed = 0;
      j.remaining = 0;
      j.progress = 0;
      j.uploadId = null;
      retryJobs.push(j);
      if (!existingFilePaths.has(j.file)) {
        selectedFiles.push({ path: j.file, name: j.fileName, size: j.bytesTotal });
        existingFilePaths.add(j.file);
      }
    }
  });
  if (retryJobs.length === 0) return;
  for (const j of retryJobs) {
    if (j.file && j.hoster) {
      _completedUploadKeys.delete(`${j.file}|${j.hoster}`);
      _suppressedPreviewKeys.delete(`${j.file}|${j.hoster}`);
    }
  }

  // Select the retry jobs and start them immediately.
  // No renderQueueTable / updateQueueActionButtons / updateStatusBar here:
  // startSelectedUpload() runs the exact same trio right after, and at 500+
  // jobs the double render freezes the UI for multiple seconds.
  selectedJobIds.clear();
  retryJobs.forEach(j => selectedJobIds.add(j.id));
  persistQueueStateSoon();
  await startSelectedUpload(retryJobs);
}

async function abortSelectedJobs() {
  _normalizeQueueSelectionToVisible();
  const activeJobIds = [];

  queueJobs.forEach((job) => {
    if (!selectedJobIds.has(job.id)) return;

    if (['preview', 'queued'].includes(job.status)) {
      job.status = 'aborted';
      job.error = 'Abgebrochen';
      job.progress = 0;
      job.uploadId = null;
    } else if (['getting-server', 'uploading', 'retrying'].includes(job.status)) {
      activeJobIds.push(job.id);
    }
  });

  if (activeJobIds.length > 0) {
    await window.api.cancelSelectedJobs(activeJobIds);
  }

  selectedJobIds.clear();
  syncSelectedFilesFromQueue();
  renderQueueTable();
  updateQueueActionButtons();
  updateStatusBar();
  persistQueueStateSoon(true);
}

async function finishUploadsInProgress() {
  if (!uploading) return;
  await window.api.finishAfterActive();
  lastUploadStats.state = 'stopping';
  updateStatusBar();
}

async function abortAllUploads() {
  await cancelUpload();
}

function moveSelectedJobs(direction) {
  _normalizeQueueSelectionToVisible();
  if (uploading || selectedJobIds.size === 0) return;

  const jobs = queueJobs.slice();

  if (direction === 'top') {
    queueJobs = jobs.filter((job) => selectedJobIds.has(job.id)).concat(jobs.filter((job) => !selectedJobIds.has(job.id)));
  } else if (direction === 'bottom') {
    queueJobs = jobs.filter((job) => !selectedJobIds.has(job.id)).concat(jobs.filter((job) => selectedJobIds.has(job.id)));
  } else if (direction === 'up') {
    for (let i = 1; i < jobs.length; i++) {
      if (selectedJobIds.has(jobs[i].id) && !selectedJobIds.has(jobs[i - 1].id)) {
        [jobs[i - 1], jobs[i]] = [jobs[i], jobs[i - 1]];
      }
    }
    queueJobs = jobs;
  } else if (direction === 'down') {
    for (let i = jobs.length - 2; i >= 0; i--) {
      if (selectedJobIds.has(jobs[i].id) && !selectedJobIds.has(jobs[i + 1].id)) {
        [jobs[i], jobs[i + 1]] = [jobs[i + 1], jobs[i]];
      }
    }
    queueJobs = jobs;
  }

  rebuildJobIndex();
  renderQueueTable();
  updateStatusBar();
  persistQueueStateSoon(true);
}

function syncSelectedFilesFromQueue() {
  const fileMap = new Map();
  queueJobs
    .filter((job) => !['done', 'skipped', 'aborted'].includes(job.status))
    .forEach((job) => {
      if (!job.file || fileMap.has(job.file)) return;
      fileMap.set(job.file, {
        path: job.file,
        name: job.fileName,
        size: job.bytesTotal || 0
      });
    });
  selectedFiles = Array.from(fileMap.values());
}

// Cap recent-files panel growth so a multi-thousand-job session doesn't
// turn every renderRecentUploadsPanel call into a multi-MB innerHTML write.
const SESSION_FILES_CAP = 2000;

function maybeAddSessionFile(job) {
  if (!job) return;

  if (job.status === 'done' && job.result) {
    const link = job.result.download_url || job.result.embed_url || '';
    if (!link) return;
    const dedupKey = `${link}\u0001${job.fileName}\u0001${job.hoster}`;
    if (!_sessionFileKeys.has(dedupKey)) {
      _sessionFileKeys.add(dedupKey);
      const dt = formatDateTime(new Date());
      sessionFilesData.push({
        date: dt.text,
        dateTs: dt.ts,
        filename: job.fileName || '',
        host: job.hoster || '',
        link,
        isError: false,
        order: _recentSeqCounter++
      });
      _recentDataVersion++;
      _sessionDoneCount++;
      _recentPendingAppends++;
      // Drop oldest entries past the cap to keep render cost bounded.
      // Without this, sessionFilesData grows unbounded across the session
      // and every renderRecentUploadsPanel call becomes a megabyte-sized
      // innerHTML write — visible as scroll/click lag in the lower panel.
      if (sessionFilesData.length > SESSION_FILES_CAP) {
        const drop = sessionFilesData.length - SESSION_FILES_CAP;
        for (let i = 0; i < drop; i++) {
          const r = sessionFilesData[i];
          _sessionFileKeys.delete(`${r.link}${r.filename}${r.host}`);
        }
        sessionFilesData = sessionFilesData.slice(drop);
      }
      // Coalesce rapid successive adds into one render per frame.
      scheduleRecentRender();
    }
  }

}

function applySummaryResults(summary) {
  const files = Array.isArray(summary?.files) ? summary.files : [];
  // Build a (fileName + hoster) → job map once so the per-result lookup is O(1)
  // instead of O(|queueJobs|). Big batches (hundreds of files × multiple hosters)
  // otherwise become O(n²).
  const jobByKey = new Map();
  for (const j of queueJobs) {
    jobByKey.set(`${j.fileName}\u0001${j.hoster}`, j);
  }
  for (const file of files) {
    for (const result of file.results || []) {
      const job = jobByKey.get(`${file.name}\u0001${result.hoster}`);
      if (!job) continue;
      if (result.status === 'done') {
        job.status = 'done';
        job.result = {
          download_url: result.download_url || null,
          embed_url: result.embed_url || null,
          file_code: result.file_code || null
        };
        job.error = null;
        job.progress = 1;
        job.bytesUploaded = job.bytesTotal || file.size || 0;
      } else if (result.status === 'aborted') {
        job.status = 'aborted';
        job.error = result.error || 'Abgebrochen';
      } else if (result.status === 'error') {
        job.status = 'error';
        job.error = result.error || 'Fehlgeschlagen';
      }
      maybeAddSessionFile(job);
    }
  }
}

// Single-pass queue stats computation (shared by status bar + stats panel).
// Also tracks inProgressBytes so the status bar doesn't need a second scan.
//
// Memoized within a single tick: back-to-back calls (updateStatusBar +
// updateStatsPanel fire together 4×/sec during upload) share one scan. The
// cache is cleared on microtask so the next tick picks up fresh state.
let _queueStatsCache = null;
function _computeQueueStats() {
  if (_queueStatsCache) return _queueStatsCache;

  let remaining = 0, inProgress = 0, done = 0, errors = 0;
  let bytesRemaining = 0, totalSize = 0, remainingSize = 0, inProgressBytes = 0;
  const total = queueJobs.length;

  for (let i = 0; i < total; i++) {
    const job = queueJobs[i];
    const s = job.status;
    const bt = job.bytesTotal || 0;
    const bu = job.bytesUploaded || 0;
    totalSize += bt;

    if (s === 'uploading' || s === 'getting-server' || s === 'retrying') {
      inProgress++;
      remaining++;
      inProgressBytes += bu;
      bytesRemaining += Math.max(0, bt - bu);
      remainingSize += Math.max(0, bt - bu);
    } else if (s === 'preview' || s === 'queued') {
      remaining++;
      bytesRemaining += Math.max(0, bt - bu);
      remainingSize += Math.max(0, bt - bu);
    } else if (s === 'done') {
      done++;
    } else if (s === 'error') {
      errors++;
    } else if (s !== 'skipped') {
      remainingSize += Math.max(0, bt - bu);
    }
  }

  _queueStatsCache = { total, remaining, inProgress, done, errors, bytesRemaining, totalSize, remainingSize, inProgressBytes };
  (typeof queueMicrotask === 'function' ? queueMicrotask : (fn) => Promise.resolve().then(fn))(() => { _queueStatsCache = null; });
  return _queueStatsCache;
}

function _setSidebarCount(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = Number(value || 0).toLocaleString(getUiLocale());
}

function _syncSidebarIndicator(button, immediate = false) {
  const navigation = button?.closest('.view-sidebar-navigation, .settings-navigation');
  const indicator = navigation?.querySelector(':scope > .view-sidebar-indicator, :scope > .settings-nav-indicator');
  if (!indicator || !button) return;
  const navigationRect = navigation.getBoundingClientRect();
  const buttonRect = button.getBoundingClientRect();
  if (buttonRect.width === 0 || buttonRect.height === 0) return;
  const firstPosition = indicator.dataset.ready !== 'true';
  if (immediate || firstPosition) indicator.style.transition = 'none';
  indicator.style.width = `${buttonRect.width}px`;
  indicator.style.height = `${buttonRect.height}px`;
  indicator.style.transform = `translate(${buttonRect.left - navigationRect.left}px, ${buttonRect.top - navigationRect.top}px)`;
  if (immediate || firstPosition) {
    indicator.getBoundingClientRect();
    requestAnimationFrame(() => {
      indicator.style.transition = '';
      indicator.dataset.ready = 'true';
    });
  }
}

function _syncSidebarFilterButtons(selector, datasetKey, value) {
  let activeButton = null;
  let selectionChanged = false;
  document.querySelectorAll(selector).forEach(button => {
    const active = button.dataset[datasetKey] === value;
    if (active && !button.classList.contains('active')) selectionChanged = true;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
    if (active) activeButton = button;
  });
  _syncSidebarIndicator(activeButton, !selectionChanged);
}

function setUploadSidebarFilter(value) {
  if (!['all', 'active', 'waiting', 'done', 'error'].includes(value)) return;
  uploadSidebarFilter = value;
  _syncSidebarFilterButtons('[data-upload-sidebar-target]', 'uploadSidebarTarget', value);
  _queueFilterCache = { filter: '', source: null, result: [] };
  _normalizeQueueSelectionToVisible();
  _lastVisibleRange = { start: -1, end: -1 };
  const container = document.getElementById('queueContainer');
  if (container) container.scrollTop = 0;
  renderQueueTable();
}

function updateUploadSidebarSummary(stats = _computeQueueStats()) {
  let waiting = 0;
  let active = 0;
  for (const job of queueJobs) {
    if (job.status === 'preview' || job.status === 'queued') waiting++;
    else if (job.status === 'uploading' || job.status === 'getting-server' || job.status === 'retrying') active++;
  }
  const accountCount = getAccountsWithCredsFlat().filter(({ account }) => account.enabled !== false).length;
  _setSidebarCount('uploadSidebarAllCount', stats.total);
  _setSidebarCount('uploadSidebarActiveCount', active);
  _setSidebarCount('uploadSidebarWaitingCount', waiting);
  _setSidebarCount('uploadSidebarDoneCount', stats.done);
  _setSidebarCount('uploadSidebarErrorCount', stats.errors);
  _setSidebarCount('uploadSidebarAccountsCount', accountCount);
}

function updateAccountSidebarSummary(allAccounts = getAllAccountsFlat()) {
  let ready = 0;
  let warning = 0;
  let error = 0;
  let availableAccounts = 0;
  const hosterCounts = new Map();
  for (const { name, account } of allAccounts) {
    hosterCounts.set(name, (hosterCounts.get(name) || 0) + 1);
    if (account.enabled !== false && accountHasCreds(name, account)) availableAccounts++;
    const category = _getAccountSidebarCategory(name, account);
    if (category === 'ready') ready++;
    else if (category === 'error') error++;
    else warning++;
  }
  _setSidebarCount('accountsSidebarAllCount', allAccounts.length);
  _setSidebarCount('accountsSidebarReadyCount', ready);
  _setSidebarCount('accountsSidebarWarningCount', warning);
  _setSidebarCount('accountsSidebarErrorCount', error);
  _setSidebarCount('uploadSidebarAccountsCount', availableAccounts);
  const container = document.getElementById('accountsSidebarHosters');
  if (container) {
    container.replaceChildren(...HOSTERS.filter(name => hosterCounts.has(name)).map(name => {
      const row = document.createElement('div');
      row.className = 'view-sidebar-hoster';
      const dot = document.createElement('span');
      dot.className = 'view-sidebar-hoster-dot';
      const label = document.createElement('span');
      label.className = 'view-sidebar-copy';
      label.textContent = getHosterLabel(name);
      const count = document.createElement('span');
      count.className = 'view-sidebar-badge';
      count.textContent = hosterCounts.get(name).toLocaleString(getUiLocale());
      row.append(dot, label, count);
      return row;
    }));
  }
}

function _getAccountSidebarCategory(name, account) {
  if (account.enabled === false || !accountHasCreds(name, account)) return 'warning';
  const status = (accountStatuses[account.id] && accountStatuses[account.id].status) || 'unchecked';
  if (status === 'ok') return 'ready';
  if (status === 'error') return 'error';
  return 'warning';
}

function _applyAccountSidebarFilter() {
  const entries = new Map(getAllAccountsFlat().map(entry => [entry.account.id, entry]));
  document.querySelectorAll('#accountsList .account-hoster-group').forEach(group => {
    let matches = 0;
    group.querySelectorAll('.account-card').forEach(card => {
      const entry = entries.get(card.dataset.accountId);
      const visible = !!entry && (accountSidebarFilter === 'all' || _getAccountSidebarCategory(entry.name, entry.account) === accountSidebarFilter);
      card.hidden = !visible;
      if (visible) matches++;
    });
    group.hidden = matches === 0;
  });
}

function setAccountSidebarFilter(value) {
  if (!['all', 'ready', 'warning', 'error'].includes(value)) return;
  accountSidebarFilter = value;
  _syncSidebarFilterButtons('[data-accounts-sidebar-filter]', 'accountsSidebarFilter', value);
  _applyAccountSidebarFilter();
}

function setHistorySidebarFilter(value) {
  if (!['all', 'success', 'error'].includes(value)) return;
  historySidebarFilter = value;
  _syncSidebarFilterButtons('[data-history-filter]', 'historyFilter', value);
  const container = document.getElementById('historyContainer');
  if (container) {
    container.scrollTop = 0;
    renderHistoryTable(container);
  }
}

function updateHistorySidebarSummary() {
  _setSidebarCount('historySidebarAllCount', historySidebarCounts.total);
  _setSidebarCount('historySidebarSuccessCount', historySidebarCounts.success);
  _setSidebarCount('historySidebarErrorCount', historySidebarCounts.error);
  const retention = document.getElementById('historySidebarRetention');
  const select = document.getElementById('historyRetentionSelect');
  const labels = {
    all: 'Alles behalten',
    '7d': 'Letzte 7 Tage',
    '30d': 'Letzte 30 Tage',
    '90d': 'Letzte 90 Tage',
    '1000': 'Letzte 1000 Uploads',
    '100': 'Letzte 100 Uploads'
  };
  if (retention && select) retention.textContent = labels[select.value] || labels.all;
}

function _setUploadTelemetryText(id, value) {
  const element = document.getElementById(id);
  if (!element) return;
  const text = String(value);
  element.textContent = text;
  element.setAttribute('aria-label', text);
}

function _setRollingUploadMetric(id, value) {
  const element = document.getElementById(id);
  if (!element) return;
  const numericValue = Number(value) || 0;
  const nextText = numericValue.toLocaleString(getUiLocale());
  const previousValue = Number(element.dataset.numericValue) || 0;
  if (previousValue === numericValue) {
    element.setAttribute('aria-label', nextText);
    return;
  }

  const direction = numericValue > previousValue ? 'up' : 'down';
  const previousText = element.getAttribute('aria-label') || previousValue.toLocaleString(getUiLocale());
  const outgoing = document.createElement('span');
  const incoming = document.createElement('span');
  outgoing.textContent = previousText;
  incoming.textContent = nextText;
  outgoing.className = 'upload-rolling-outgoing';
  incoming.className = 'upload-rolling-incoming';
  element.querySelectorAll(':scope > span').forEach(span => span.getAnimations().forEach(animation => animation.cancel()));
  element.dataset.numericValue = String(numericValue);
  element.dataset.direction = direction;
  element.setAttribute('aria-label', nextText);
  element.replaceChildren(outgoing, incoming);

  const distance = direction === 'up' ? -1 : 1;
  const options = { duration: 320, easing: 'cubic-bezier(.2, .8, .2, 1)', fill: 'forwards' };
  const outgoingAnimation = outgoing.animate([
    { transform: 'translateY(0)', opacity: 1 },
    { transform: `translateY(${distance * 100}%)`, opacity: 0 }
  ], options);
  const incomingAnimation = incoming.animate([
    { transform: `translateY(${-distance * 100}%)`, opacity: 0 },
    { transform: 'translateY(0)', opacity: 1 }
  ], options);
  Promise.allSettled([outgoingAnimation.finished, incomingAnimation.finished]).then(() => {
    if (!incoming.isConnected || incoming.parentElement !== element) return;
    const settled = document.createElement('span');
    settled.textContent = nextText;
    element.replaceChildren(settled);
    element.dataset.direction = 'none';
  });
}

function getUploadSpeedText(kbs = lastUploadStats.globalSpeedKbs) {
  return !kbs || kbs <= 0 ? '0 B/s' : formatSpeed(kbs);
}

function updateUploadSpeedDisplays() {
  const text = getUploadSpeedText();
  _setUploadTelemetryText('uploadTelemetrySpeed', text);
  _setUploadTelemetryText('uploadSpeedValue', text);
}

function syncUploadSpeedSparklineVisibility(view) {
  const widget = document.getElementById('uploadSpeedSparkline');
  if (!widget) return;
  const activeView = view || document.querySelector('.tab.active')?.dataset.view;
  widget.classList.toggle('is-hidden', activeView !== 'upload');
}

function drawUploadSpeedSparkline() {
  const canvas = document.getElementById('uploadSpeedCanvas');
  if (!canvas) return;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (width <= 0 || height <= 0) return;
  const scale = Math.max(1, window.devicePixelRatio || 1);
  const pixelWidth = Math.round(width * scale);
  const pixelHeight = Math.round(height * scale);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const context = canvas.getContext('2d');
  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.clearRect(0, 0, width, height);
  const values = uploadSpeedState.history;
  if (values.length < 2) return;
  const maximum = Math.max(1, ...values);
  const step = width / Math.max(1, values.length - 1);
  const y = value => height - 2 - (value / maximum) * (height - 4);
  context.beginPath();
  values.forEach((value, index) => {
    const x = index * step;
    if (index === 0) context.moveTo(x, y(value));
    else context.lineTo(x, y(value));
  });
  context.lineTo(width, height);
  context.lineTo(0, height);
  context.closePath();
  const fill = context.createLinearGradient(0, 0, 0, height);
  fill.addColorStop(0, 'rgba(117, 211, 155, .22)');
  fill.addColorStop(1, 'rgba(117, 211, 155, 0)');
  context.fillStyle = fill;
  context.fill();
  context.beginPath();
  values.forEach((value, index) => {
    const x = index * step;
    if (index === 0) context.moveTo(x, y(value));
    else context.lineTo(x, y(value));
  });
  context.strokeStyle = window.getComputedStyle(document.documentElement).getPropertyValue('--success').trim() || '#75d39b';
  context.lineWidth = 1.5;
  context.lineJoin = 'round';
  context.lineCap = 'round';
  context.stroke();
}

function updateUploadSpeedSparkline() {
  const speedKbs = Math.max(0, Number(lastUploadStats.globalSpeedKbs) || 0);
  window.SpeedHistory.updateSpeedHistory(uploadSpeedState, speedKbs * 1024);
  updateUploadSpeedDisplays();
  drawUploadSpeedSparkline();
}

function initUploadSpeedSparkline() {
  if (uploadSpeedTimer !== null) return;
  syncUploadSpeedSparklineVisibility();
  updateUploadSpeedSparkline();
  uploadSpeedTimer = window.setInterval(updateUploadSpeedSparkline, 250);
  window.addEventListener('resize', drawUploadSpeedSparkline);
  window.addEventListener('beforeunload', () => window.clearInterval(uploadSpeedTimer), { once: true });
}

function updateStatusBar() {
  const stats = _computeQueueStats();

  const etaSeconds = lastUploadStats.globalSpeedKbs > 0
    ? Math.round(stats.bytesRemaining / (lastUploadStats.globalSpeedKbs * 1024))
    : 0;

  _setRollingUploadMetric('uploadTelemetryTotal', stats.total);
  _setRollingUploadMetric('uploadTelemetryConnections', lastUploadStats.activeJobs || 0);
  _setRollingUploadMetric('uploadTelemetryRemaining', stats.remaining);
  _setRollingUploadMetric('uploadTelemetryRunning', stats.inProgress);
  _setRollingUploadMetric('uploadTelemetryCompleted', _sessionDoneCount);
  _setRollingUploadMetric('uploadTelemetryFailed', _sessionErrorCount);
  updateUploadSpeedDisplays();
  _setUploadTelemetryText('uploadTelemetryEta', etaSeconds > 0 ? formatTime(etaSeconds) : '--:--');
  updateUploadSidebarSummary(stats);
}

// --- Health Check ---

function renderHealthCheckResults(_results) {
  const container = document.getElementById('healthCheckResults');
  if (container) container.innerHTML = '';
}

let _appAlertResolve = null;

function closeAppAlert() {
  const modal = document.getElementById('appAlertModal');
  if (!modal) return;
  modal.style.display = 'none';
  modal.setAttribute('aria-hidden', 'true');
  const resolve = _appAlertResolve;
  _appAlertResolve = null;
  if (resolve) resolve();
}

function showAppAlert(message, title = 'Hinweis') {
  const modal = document.getElementById('appAlertModal');
  const titleEl = document.getElementById('appAlertTitle');
  const messageEl = document.getElementById('appAlertMessage');
  const confirm = document.getElementById('appAlertConfirmBtn');
  if (!modal || !titleEl || !messageEl || !confirm) return Promise.resolve();
  if (_appAlertResolve) closeAppAlert();
  titleEl.textContent = title;
  messageEl.textContent = String(message || '');
  modal.style.display = 'flex';
  modal.setAttribute('aria-hidden', 'false');
  confirm.focus();
  return new Promise(resolve => { _appAlertResolve = resolve; });
}

async function executeHealthCheck(hosters, _mode) {
  renderHealthCheckResults([]);
  const result = await window.api.runHealthCheck({ hosters });
  const rows = result && Array.isArray(result.results) ? result.results : [];
  rows.forEach((row) => {
    if (!row) return;
    const key = row.accountId || row.hoster;
    if (key) {
      accountStatuses[key] = {
        status: row.status || 'unchecked',
        message: row.message || ''
      };
    }
  });
  renderHealthCheckResults(rows);
  renderAccounts();
  renderHosterModal();
  return rows;
}

async function runHealthCheck(mode = 'manual', requestedHosters = null) {
  if (healthCheckRunning) {
    if (mode === 'manual') showCopyToast('Account-Check läuft bereits.');
    return [];
  }
  let hosters;
  if (Array.isArray(requestedHosters) && requestedHosters.length > 0) {
    hosters = requestedHosters;
  } else {
    hosters = getAccountsWithCredsFlat()
      .filter(({ account }) => account.enabled !== false)
      .map(({ name, account }) => ({ hoster: name, accountId: account.id }));
  }
  if (hosters.length === 0) {
    if (mode === 'manual') await showAppAlert('Keine Hoster mit Zugangsdaten für einen Check.');
    return [];
  }
  healthCheckRunning = true;
  // Mark all accounts as checking
  for (const h of hosters) {
    const key = typeof h === 'string' ? h : (h.accountId || h.hoster);
    accountStatuses[key] = { status: 'checking', message: '' };
  }
  renderAccounts();
  try {
    return await executeHealthCheck(hosters, mode);
  } catch (err) {
    renderHealthCheckResults([{ hoster: 'System', status: 'error', message: err.message }]);
    return [];
  } finally {
    healthCheckRunning = false;
    renderAccounts();
  }
}

// --- Settings ---
async function _renderLogPathsList(el) {
  if (!el || !window.api || !window.api.getLogPaths) return;
  try {
    const paths = await window.api.getLogPaths();
    if (!paths || typeof paths !== 'object') { el.innerHTML = '<span class="hint">Pfade nicht verfügbar.</span>'; return; }
    const entries = [
      ['fileuploader', 'fileuploader.log'],
      ['debug', 'debug.log'],
      ['accountRotation', 'account-rotation.log'],
      ['doodstreamDebug', 'doodstream-debug.log']
    ];
    el.innerHTML = entries.map(([key, label]) => {
      const p = paths[key] || '';
      return `<div style="display:flex;gap:6px;align-items:center;font-size:11px">
        <span style="min-width:160px;color:var(--text-dim)">${escapeHtml(label)}</span>
        <code style="flex:1;font-size:10px;opacity:0.85;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeAttr(p)}">${escapeHtml(p) || '<nicht gesetzt>'}</code>
        <button class="btn btn-xs btn-secondary" data-reveal-log="${escapeAttr(key)}" title="Im Explorer zeigen">Zeigen</button>
      </div>`;
    }).join('');
    el.querySelectorAll('[data-reveal-log]').forEach(btn => {
      btn.addEventListener('click', () => {
        const target = btn.getAttribute('data-reveal-log');
        if (window.api && window.api.revealLogFile) window.api.revealLogFile(target).catch(() => {});
      });
    });
  } catch (err) {
    el.innerHTML = `<span class="hint">Fehler: ${escapeHtml(err.message || String(err))}</span>`;
  }
}

function renderSettings() {
  const container = document.getElementById('settingsHosters');
  container.innerHTML = '';

  const globalSettings = config.globalSettings || {};
  const configuredAccounts = getAvailableHosters();
  const fm = globalSettings.folderMonitor || {};
  const remoteSettings = globalSettings.remote || {};

  const pageDefinitions = [
    { id: 'allgemein', label: 'Allgemein', search: 'fenster vordergrund drop target oberfläche updates aktualisierung version' },
    { id: 'uploads', label: 'Uploads', search: 'upload queue warteschlange fertig abschluss entfernen parallel geschwindigkeit speed limit fortsetzen wiederherstellen hoster' },
    { id: 'automatik', label: 'Automatik', search: 'automatisch retry wiederholen ordner überwachen dateierweiterungen unterordner duplikate' },
    { id: 'benachrichtigungen', label: 'Benachrichtigungen', search: 'webhook discord meldung ping erwähnung batch fertig' },
    { id: 'logs', label: 'Logs & Support', search: 'log protokoll debug verbose diagnose support paket datei ordner' },
    { id: 'remote', label: 'Fernsteuerung', search: 'remote fernsteuerung server input port api token verbindung' },
    { id: 'diagnose', label: 'Diagnose-Zugriff', search: 'diagnose zugriff lesen allowlist netzwerk lokal verbindung code support' },
    { id: 'backup', label: 'Backup & Übertragen', search: 'backup sichern export import online schlüssel einstellungen accounts übertragen' }
  ];
  const pageHeader = (title, description) => `
    <header class="settings-page-header">
      <h3>${title}</h3>
      <p>${description}</p>
    </header>`;

  const layout = document.createElement('div');
  layout.className = 'settings-layout';
  layout.innerHTML = `
    <aside class="settings-sidebar">
      <div class="settings-search-wrap">
        <label for="settingsSearchInput">Schnell finden</label>
        <div class="settings-search-control">
          <span class="settings-search-icon" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><circle cx="10.8" cy="10.8" r="5.8"></circle><path d="m15.2 15.2 4.3 4.3"></path></svg></span>
          <input type="search" id="settingsSearchInput" placeholder="Einstellungen durchsuchen" autocomplete="off" spellcheck="false">
        </div>
      </div>
      <nav class="settings-navigation" aria-label="Einstellungskategorien">
        <span class="settings-nav-indicator" aria-hidden="true"></span>
        ${pageDefinitions.map((definition, index) => `<button class="settings-nav-button${index === 0 ? ' active' : ''}" data-settings-page="${definition.id}" data-search="${definition.label.toLowerCase()} ${definition.search}" aria-current="${index === 0 ? 'page' : 'false'}">${definition.label}</button>`).join('')}
      </nav>
      <p class="settings-search-empty" id="settingsSearchEmpty" hidden>Keine passende Einstellung gefunden.</p>
      <div class="settings-sidebar-status">
        <span class="view-sidebar-section-label">Speicherstatus</span>
        <div class="view-sidebar-summary view-sidebar-summary-block save-feedback" id="saveFeedback" role="status" aria-live="polite">Automatisch gespeichert</div>
      </div>
    </aside>
    <div class="settings-content"></div>`;
  container.appendChild(layout);

  const navigation = layout.querySelector('.settings-navigation');
  const content = layout.querySelector('.settings-content');
  const pages = {};
  pageDefinitions.forEach(({ id }) => {
    const page = document.createElement('div');
    page.className = id === 'allgemein' ? 'settings-subpage active' : 'settings-subpage';
    page.dataset.subpage = id;
    pages[id] = page;
    content.appendChild(page);
  });

  pages.allgemein.innerHTML = `
      ${pageHeader('Allgemein', 'Fensterverhalten, Drop-Target und Programmupdates.')}
      <div class="settings-section-label">Oberfläche</div>
      <div class="settings-row language-settings-row">
        <label id="languagePickerLabel">Sprache</label>
        <div class="language-picker" id="languagePicker" data-language="${globalSettings.language === 'de' ? 'de' : 'en'}" role="group" aria-labelledby="languagePickerLabel">
          <span class="language-picker-indicator" aria-hidden="true"></span>
          <button type="button" class="language-option" data-language="en" aria-pressed="${globalSettings.language !== 'de'}">
            <span class="language-flag language-flag-en" aria-hidden="true"></span>
            <span>Englisch</span>
          </button>
          <button type="button" class="language-option" data-language="de" aria-pressed="${globalSettings.language === 'de'}">
            <span class="language-flag language-flag-de" aria-hidden="true"></span>
            <span>Deutsch</span>
          </button>
        </div>
        <select class="settings-autosave" id="languageInput" hidden aria-hidden="true" tabindex="-1">
          <option value="en" ${globalSettings.language !== 'de' ? 'selected' : ''}>Englisch</option>
          <option value="de" ${globalSettings.language === 'de' ? 'selected' : ''}>Deutsch</option>
        </select>
      </div>
      <div class="settings-grid-mini">
        <div class="settings-row checkbox-row">
          <label for="alwaysOnTopInput">Immer im Vordergrund</label>
          <input type="checkbox" class="settings-autosave" id="alwaysOnTopInput" ${alwaysOnTopState ? 'checked' : ''}>
        </div>
        <div class="settings-row checkbox-row">
          <label for="showDropTargetInput">Drop-Target anzeigen</label>
          <input type="checkbox" class="settings-autosave" id="showDropTargetInput" ${globalSettings.showDropTarget ? 'checked' : ''}>
        </div>
      </div>
      <div class="settings-section-label">Programmupdate</div>
      <div class="settings-row program-update-row program-update-card">
        <div class="program-update-copy">
          <strong class="program-update-title">Nach neuer Version suchen</strong>
          <span class="program-update-description">Verfügbare Updates werden zusammen mit dem Changelog angezeigt.</span>
        </div>
        <button class="btn btn-xs btn-secondary" id="manualUpdateCheckBtn">Nach Updates suchen</button>
      </div>
  `;

  pages.uploads.innerHTML = `
      ${pageHeader('Upload-Verhalten', 'Globale Leistung, Warteschlange und Verhalten nach einem erfolgreichen Upload.')}
      <div class="settings-section-label">Leistung</div>
      <div class="settings-row">
        <label for="parallelUploadCountInput">Globale parallele Uploads</label>
        <input type="number" class="hs-input settings-autosave" id="parallelUploadCountInput" value="${globalSettings.parallelUploadCount ?? 0}" min="0" max="100">
        <span class="hint">0 = nur die Einstellung des jeweiligen Hosters verwenden</span>
      </div>
      <div class="settings-row">
        <label for="globalMaxSpeedMbsInput">Globales Speed-Limit</label>
        <input type="number" class="hs-input settings-autosave" id="globalMaxSpeedMbsInput" value="${globalSettings.globalMaxSpeedKbs > 0 ? (globalSettings.globalMaxSpeedKbs / 1024).toFixed(2).replace(/\\.00$/, '') : '0'}" min="0" step="0.1">
        <span class="hint">MB/s · 0 = unbegrenzt</span>
      </div>
      <div class="settings-option">
        <div class="settings-option-copy">
          <label for="scaleParallelUploadsInput">Hoster-Limits automatisch hochskalieren</label>
          <span class="settings-option-description">Verteilt die globale Parallelität auf vorhandene Accounts eines Hosters.</span>
        </div>
        <input type="checkbox" class="settings-autosave" id="scaleParallelUploadsInput" ${globalSettings.scaleParallelUploads ? 'checked' : ''}>
      </div>
      <div class="settings-section-label">Warteschlange</div>
      <div class="settings-option">
        <div class="settings-option-copy">
          <label for="removeFromQueueOnDoneInput">Nach Abschluss aus der Liste entfernen</label>
          <span class="settings-option-description">Erfolgreich hochgeladene Dateien verschwinden automatisch aus der Upload-Liste.</span>
        </div>
        <input type="checkbox" class="settings-autosave" id="removeFromQueueOnDoneInput" ${globalSettings.removeFromQueueOnDone ? 'checked' : ''}>
      </div>
      <div class="settings-option">
        <div class="settings-option-copy">
          <label for="resumeQueueOnLaunchInput">Warteschlange beim Start wiederherstellen</label>
          <span class="settings-option-description">Noch nicht abgeschlossene Uploads werden beim nächsten Programmstart erneut angezeigt.</span>
        </div>
        <input type="checkbox" class="settings-autosave" id="resumeQueueOnLaunchInput" ${globalSettings.resumeQueueOnLaunch === false ? '' : 'checked'}>
      </div>
      <div class="settings-hoster-pointer"><strong>Einstellungen einzelner Hoster</strong> wie Wiederholungen, Geschwindigkeit, Parallelität, Dateigröße und Logging findest du im <strong>Accounts</strong>-Tab direkt beim jeweiligen Hoster.</div>
  `;

  pages.automatik.innerHTML = `
      ${pageHeader('Automatik', 'Wiederholungen und überwachte Ordner für unbeaufsichtigte Uploads.')}
      <div class="settings-section-label">Unbeaufsichtigter Betrieb</div>
      <div class="settings-row automation-retry-row">
        <label for="autoRetryRoundsInput">Automatische Wiederholungsrunden</label>
        <div class="automation-retry-control">
          <input type="number" class="hs-input settings-autosave" id="autoRetryRoundsInput" min="0" max="5" value="${Number(globalSettings.autoRetryRounds) || 0}">
          <span class="hint">0 = aus. Nach Batch-Ende werden transiente Fehler (Netzwerk, Hoster-Flake) automatisch bis zu N Runden neu versucht.</span>
        </div>
      </div>
      <div class="settings-row automation-retry-row">
        <label for="autoRetryDelayMinInput">Wartezeit zwischen Runden</label>
        <div class="automation-retry-control">
          <input type="number" class="hs-input settings-autosave" id="autoRetryDelayMinInput" min="1" max="120" value="${Number(globalSettings.autoRetryDelayMin) || 5}">
          <span class="hint">Minuten · jede weitere Runde wartet entsprechend länger</span>
        </div>
      </div>
      <div class="settings-section-label">Ordnerüberwachung <span class="panel-status${fm.enabled && fm.folderPath ? ' active' : ''}" id="folderMonitorStatusBadge">${fm.enabled && fm.folderPath ? 'Aktiv' : 'Inaktiv'}</span></div>
      <div class="settings-row">
        <label>Ordnerpfad</label>
        <input type="text" class="key-input settings-autosave" id="fmFolderPathInput" value="${escapeAttr(fm.folderPath || '')}" placeholder="Ordner wählen..." style="flex:1">
        <button class="btn btn-xs btn-secondary" id="fmChooseFolderBtn">Wählen</button>
      </div>
      <div class="settings-row">
        <label>Dateierweiterungen</label>
        <select class="hs-input settings-autosave" id="fmFilterModeInput" style="width:auto;margin-right:6px">
          <option value="include" ${fm.filterMode === 'include' ? 'selected' : ''}>Nur diese</option>
          <option value="exclude" ${fm.filterMode === 'exclude' ? 'selected' : ''}>Alle außer</option>
        </select>
        <input type="text" class="key-input settings-autosave" id="fmExtensionsInput" value="${escapeAttr(fm.extensions || '')}" placeholder="mp4,mkv,avi" style="flex:1">
      </div>
      <div class="settings-row">
        <label>Verzögerung (Sekunden)</label>
        <input type="number" class="hs-input settings-autosave" id="fmDelaySecInput" value="${fm.delaySec ?? 3}" min="1" max="300" style="width:80px">
        <span class="hint">Warten bis Datei fertig geschrieben</span>
      </div>
      <div class="settings-section-label">Verhalten</div>
      <div class="settings-grid-mini">
        <div class="settings-row checkbox-row">
          <label>Aktiviert</label>
          <input type="checkbox" class="settings-autosave" id="fmEnabledInput" ${fm.enabled ? 'checked' : ''}>
        </div>
        <div class="settings-row checkbox-row">
          <label>Unterordner einbeziehen</label>
          <input type="checkbox" class="settings-autosave" id="fmRecursiveInput" ${fm.recursive ? 'checked' : ''}>
        </div>
        <div class="settings-row checkbox-row">
          <label>Duplikate überspringen</label>
          <input type="checkbox" class="settings-autosave" id="fmSkipDuplicatesInput" ${fm.skipDuplicates !== false ? 'checked' : ''}>
        </div>
        <div class="settings-row checkbox-row">
          <label>Auto-Upload starten</label>
          <input type="checkbox" class="settings-autosave" id="fmAutoStartInput" ${fm.autoStart !== false ? 'checked' : ''}>
        </div>
      </div>
      <div class="settings-section-label">Hoster-Vorauswahl</div>
      <div class="settings-grid-mini">
        ${configuredAccounts.map(({ name }) => `
        <div class="settings-row checkbox-row">
          <label>${escapeHtml(name)}</label>
          <input type="checkbox" class="settings-autosave fm-hoster-checkbox" data-fm-hoster="${name}" ${(fm.hosters || []).includes(name) ? 'checked' : ''}>
        </div>`).join('')}
      </div>
      ${configuredAccounts.length === 0 ? '<p class="hint" style="margin:0">Erst Accounts anlegen, dann hier auswählen.</p>' : '<p class="hint" style="margin:2px 0 0">Keine Auswahl = Hoster-Modal bei jeder Datei.</p>'}
  `;

  pages.benachrichtigungen.innerHTML = `
      ${pageHeader('Benachrichtigungen', 'Meldungen nach einem abgeschlossenen Upload-Batch versenden.')}
      <div class="settings-section-label">Webhook</div>
      <div class="settings-row settings-row-wide">
        <label for="webhookUrlInput">Webhook-Adresse</label>
        <input type="text" class="key-input settings-autosave" id="webhookUrlInput" value="${escapeAttr(globalSettings.webhookUrl || '')}" placeholder="https://discord.com/api/webhooks/… oder eigene URL">
        <button class="btn btn-xs btn-secondary" id="testWebhookBtn">Test senden</button>
        <span class="hint" id="webhookHint">Nach Batch-Ende wird eine Zusammenfassung versendet. Discord wird automatisch erkannt, andere Ziele erhalten JSON.</span>
      </div>
      <div class="settings-row settings-row-wide">
        <label for="webhookMentionInput">Discord-Erwähnung</label>
        <input type="text" class="key-input settings-autosave" id="webhookMentionInput" value="${escapeAttr(globalSettings.webhookMention || '')}" placeholder="User-ID, role:ROLLEN-ID, @here oder @everyone">
        <span class="hint">Optional · leer lassen, wenn die Nachricht ohne Ping gesendet werden soll</span>
      </div>
  `;

  pages.logs.innerHTML = `
      ${pageHeader('Logs & Support', 'Protokollierung verwalten, Log-Dateien öffnen und ein bereinigtes Support-Paket erstellen.')}
      <div class="settings-section-label">Log</div>
      <div class="settings-row log-file-path-row">
        <label>FileUploader Log</label>
        <input type="text" class="key-input settings-autosave" id="logFilePathInput" value="${escapeAttr(globalSettings.logFilePath || '')}" placeholder="Standardpfad verwenden">
        <button class="btn btn-xs btn-secondary" id="chooseLogFilePathBtn">Ordner wählen</button>
        <button class="btn btn-xs btn-secondary" id="openLogFolderBtn" title="Log-Ordner im Explorer öffnen">Öffnen</button>
      </div>
      <div class="settings-row">
        <label>Log-Datei-Modus</label>
        <select class="hs-input settings-autosave" id="logModeInput">
          <option value="single" ${(window.LogMode ? window.LogMode.normalizeLogMode(globalSettings) : (globalSettings.logMode || 'single')) === 'single' ? 'selected' : ''}>Eine Datei</option>
          <option value="daily" ${(window.LogMode ? window.LogMode.normalizeLogMode(globalSettings) : (globalSettings.logMode || 'single')) === 'daily' ? 'selected' : ''}>Pro Tag</option>
          <option value="session" ${(window.LogMode ? window.LogMode.normalizeLogMode(globalSettings) : (globalSettings.logMode || 'single')) === 'session' ? 'selected' : ''}>Pro Session</option>
        </select>
        <span class="hint">Pro Session = neue Datei bei jedem App-Start; nach komplettem Schließen + erneutem Öffnen beginnt eine neue Session.</span>
      </div>
      <div class="settings-row">
        <label>Verbose Logging</label>
        <label class="checkbox-row" style="margin:0">
          <input type="checkbox" class="settings-autosave" id="logVerboseInput" ${globalSettings.logVerbose ? 'checked' : ''}>
          <span>DEBUG-Einträge in debug.log schreiben (Performance ↓, Diagnostik ↑)</span>
        </label>
      </div>
      <div class="settings-section-label">Diagnose</div>
      <div class="settings-row" id="logPathsBlock">
        <label>Log-Dateien</label>
        <div class="log-paths-list" id="logPathsList" style="flex:1;display:flex;flex-direction:column;gap:4px">
          <span class="hint">Wird geladen…</span>
        </div>
      </div>
      <div class="settings-row">
        <label>Support-Paket</label>
        <button class="btn btn-xs btn-secondary" id="createSupportBundleBtn" title="Sammelt alle Logs + sanitierte Config (Credentials maskiert) + App-Versionen in eine einzelne .txt-Datei zum Teilen.">Diagnose-Paket exportieren</button>
        <span class="hint" id="supportBundleHint">Eine .txt mit Logs + sanitierter Config; Passwörter/API-Keys werden vor dem Speichern maskiert.</span>
      </div>
  `;

  pages.remote.innerHTML = `
      ${pageHeader('Fernsteuerung', 'Upload-Funktionen über einen verbundenen Client steuern.')}
      <div class="settings-section-label">Server <span class="panel-status${remoteSettings.enabled ? ' active' : ''}" id="remoteStatusBadge">${remoteSettings.enabled ? 'Aktiv' : 'Inaktiv'}</span></div>
      <div class="settings-grid-mini">
        <div class="settings-row checkbox-row">
          <label>Aktiviert</label>
          <input type="checkbox" class="settings-autosave" id="remoteEnabledInput" ${remoteSettings.enabled ? 'checked' : ''}>
        </div>
        <div class="settings-row checkbox-row">
          <label>Input erlauben</label>
          <input type="checkbox" class="settings-autosave" id="remoteAllowInputInput" ${remoteSettings.allowInput !== false ? 'checked' : ''}>
        </div>
      </div>
      <div class="settings-row">
        <label>Port</label>
        <input type="number" class="hs-input settings-autosave" id="remotePortInput" value="${remoteSettings.port || 9100}" min="1024" max="65535" style="width:100px">
      </div>
      <div class="settings-row">
        <label>API-Token</label>
        <input type="text" class="key-input" id="remoteTokenInput" value="${escapeAttr(remoteSettings.token || '')}" readonly style="flex:1">
        <button class="btn btn-xs btn-secondary" id="remoteCopyTokenBtn" title="Kopieren">Kopieren</button>
        <button class="btn btn-xs btn-secondary" id="remoteRegenerateTokenBtn" title="Neu generieren">Neu</button>
      </div>
      <div class="settings-section-label">Status</div>
      <div class="settings-row">
        <span id="remoteConnectionStatus" style="color:#94a3b8">Prüfe...</span>
      </div>
  `;

  pages.diagnose.innerHTML = `
      ${pageHeader('Diagnose-Zugriff', 'Zeitlich kontrollierter Lesezugriff für Fehleranalyse und Support.')}
      <div class="settings-section-label">Diagnose-Zugriff (nur lesen) <span class="panel-status" id="diagStatusBadge">…</span></div>
      <p class="hint" style="margin:0 0 12px;padding:8px 10px;border-left:3px solid #f59e0b;background:rgba(245,158,11,0.08)">
        Erlaubt <strong>nur lesenden</strong> Zugriff auf Logs, Queue-Status und bereinigte Einstellungen. Passwörter, API-Keys und Tokens werden maskiert. <strong>Bildschirm und Eingabesteuerung bleiben gesperrt.</strong> Der Verbindungs-Code ist ein Zugangsschlüssel — nur mit vertrauenswürdigen Stellen teilen; bei Verdacht „Neu" klicken. Standard-Bindung ist <code>127.0.0.1</code> und damit nur über einen SSH- oder VPN-Tunnel erreichbar.
      </p>
      <div class="settings-grid-mini">
        <div class="settings-row checkbox-row">
          <label>Aktiviert</label>
          <input type="checkbox" id="diagEnabledInput">
        </div>
      </div>
      <div class="settings-row">
        <label>Port</label>
        <input type="number" class="hs-input" id="diagPortInput" min="1024" max="65535" value="9110" style="width:100px">
      </div>
      <div class="settings-row">
        <label>Sichtbarkeit</label>
        <select class="hs-input" id="diagBindModeInput" style="width:auto">
          <option value="local">Nur lokal (127.0.0.1) — Tunnel/VPN</option>
          <option value="network">Im Netzwerk (0.0.0.0) — Allowlist nötig</option>
        </select>
      </div>
      <div class="settings-row">
        <label>Adresse für den Code</label>
        <input type="text" class="hs-input" id="diagPublicHostInput" placeholder="127.0.0.1 oder Tunnel-/Tailscale-Adresse" style="flex:1">
      </div>
      <div class="settings-row" id="diagSuggestRow" style="display:none">
        <label></label>
        <div id="diagSuggestChips" style="display:flex;gap:6px;flex-wrap:wrap"></div>
      </div>
      <div class="settings-row" id="diagAllowlistRow" style="display:none;align-items:flex-start">
        <label>Allowlist (IP/CIDR, eine pro Zeile)</label>
        <textarea class="hs-input" id="diagAllowlistInput" rows="3" style="flex:1;font-family:monospace" placeholder="100.64.0.0/10&#10;203.0.113.5"></textarea>
      </div>
      <div class="settings-row"><span class="hint" id="diagBindHint"></span></div>
      <div class="settings-row">
        <label>Verbindungs-Code</label>
        <input type="text" class="key-input" id="diagCodeInput" value="" readonly style="flex:1" placeholder="(aktivieren zum Erzeugen)">
        <button class="btn btn-xs btn-secondary" id="diagCopyCodeBtn" title="Kopieren">Kopieren</button>
        <button class="btn btn-xs btn-secondary" id="diagRegenerateBtn" title="Neu generieren (macht alte Codes ungültig)">Neu</button>
      </div>
      <div class="settings-row"><span class="hint" id="diagCodeIssued"></span></div>
      <div class="settings-section-label">Status</div>
      <div class="settings-row">
        <span id="diagConnectionStatus" style="color:#94a3b8">Prüfe…</span>
      </div>
  `;

  pages.backup.innerHTML = `
      ${pageHeader('Backup & Übertragen', 'Accounts und Einstellungen sichern oder auf ein anderes Gerät übernehmen.')}
      <p class="hint" style="margin:0 0 10px">Der Upload-Verlauf wird nicht übertragen und bleibt auf diesem Gerät.</p>
      <section class="online-backup-panel" aria-labelledby="onlineBackupHeading">
        <div>
          <h3 id="onlineBackupHeading">Verschlüsseltes Online-Backup</h3>
          <p>Die Verschlüsselung findet ausschließlich auf diesem Gerät statt. Der Server speichert nur verschlüsselte Daten.</p>
        </div>
        <div class="online-backup-action">
          <button class="btn btn-primary" id="createOnlineBackupBtn">Neuen Schlüssel erzeugen</button>
          <span class="hint">Jeder Export erzeugt einen neuen Schlüssel. Ältere Schlüssel bleiben gültig.</span>
        </div>
        <div class="online-backup-key-row">
          <label for="onlineBackupKeyOutput">Dein neuer Schlüssel</label>
          <input type="text" class="key-input" id="onlineBackupKeyOutput" readonly spellcheck="false" autocomplete="off" placeholder="Nach dem Export erscheint hier der 75-stellige Schlüssel">
          <button class="btn btn-secondary" id="copyOnlineBackupKeyBtn" disabled>Kopieren</button>
        </div>
        <div class="online-backup-key-row">
          <label for="onlineBackupKeyInput">Vorhandenen Schlüssel importieren</label>
          <input type="password" class="key-input" id="onlineBackupKeyInput" maxlength="75" pattern="MHU2-[A-Za-z0-9_-]{70}" spellcheck="false" autocomplete="off" placeholder="MHU2-…">
          <button class="btn btn-secondary" id="restoreOnlineBackupBtn" disabled>Online importieren</button>
        </div>
        <p class="online-backup-warning">Behandle den Schlüssel wie ein Passwort. Wer ihn besitzt, kann die verschlüsselten Einstellungen entschlüsseln.</p>
        <div class="online-backup-status" id="onlineBackupStatus" role="status" aria-live="polite"></div>
      </section>
      <div class="settings-section-label">Lokales Datei-Backup</div>
      <div class="backup-file-actions">
        <button class="btn btn-secondary" id="exportBackupBtn">Datei exportieren</button>
        <button class="btn btn-secondary" id="importBackupBtn">Datei importieren</button>
      </div>
  `;

  const activateSettingsPage = (target, focus = false) => {
    const activeButton = navigation.querySelector(`[data-settings-page="${target}"]`);
    if (!activeButton || activeButton.hidden) return;
    const indicator = navigation.querySelector('.settings-nav-indicator');
    if (indicator) indicator.hidden = false;
    navigation.querySelectorAll('.settings-nav-button').forEach((button) => {
      const active = button === activeButton;
      button.classList.toggle('active', active);
      button.setAttribute('aria-current', active ? 'page' : 'false');
    });
    Object.values(pages).forEach((page) => {
      page.classList.toggle('active', page.dataset.subpage === target);
    });
    _syncSidebarIndicator(activeButton);
    if (focus) activeButton.focus();
    content.scrollTop = 0;
  };

  navigation.addEventListener('click', (event) => {
    const button = event.target.closest('[data-settings-page]');
    if (button) activateSettingsPage(button.dataset.settingsPage);
  });

  navigation.addEventListener('keydown', (event) => {
    const button = event.target.closest('[data-settings-page]');
    if (!button || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const visibleButtons = [...navigation.querySelectorAll('.settings-nav-button')].filter((item) => !item.hidden);
    const currentIndex = visibleButtons.indexOf(button);
    let nextIndex = currentIndex;
    if (event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % visibleButtons.length;
    if (event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + visibleButtons.length) % visibleButtons.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = visibleButtons.length - 1;
    event.preventDefault();
    activateSettingsPage(visibleButtons[nextIndex].dataset.settingsPage, true);
  });

  const searchInput = layout.querySelector('#settingsSearchInput');
  const searchEmpty = layout.querySelector('#settingsSearchEmpty');
  searchInput.addEventListener('input', () => {
    const query = searchInput.value.trim().toLocaleLowerCase(getUiLocale());
    const visibleButtons = [];
    navigation.querySelectorAll('.settings-nav-button').forEach((button) => {
      const visible = !query || button.dataset.search.includes(query);
      button.hidden = !visible;
      if (visible) visibleButtons.push(button);
    });
    searchEmpty.hidden = visibleButtons.length > 0;
    const activeButton = navigation.querySelector('.settings-nav-button.active');
    if (visibleButtons.length === 0) {
      Object.values(pages).forEach((page) => page.classList.remove('active'));
      const indicator = navigation.querySelector('.settings-nav-indicator');
      if (indicator) indicator.hidden = true;
      return;
    }
    if (!activeButton || activeButton.hidden || !content.querySelector('.settings-subpage.active')) {
      activateSettingsPage((activeButton && !activeButton.hidden ? activeButton : visibleButtons[0]).dataset.settingsPage);
    } else {
      _syncSidebarIndicator(activeButton, true);
    }
  });

  _renderLogPathsList(document.getElementById('logPathsList'));
  const testWebhookBtn = document.getElementById('testWebhookBtn');
  if (testWebhookBtn) {
    testWebhookBtn.addEventListener('click', async () => {
      const url = (document.getElementById('webhookUrlInput')?.value || '').trim();
      const mention = (document.getElementById('webhookMentionInput')?.value || '').trim();
      const hint = document.getElementById('webhookHint');
      if (!url) { if (hint) hint.textContent = 'Keine URL eingetragen.'; return; }
      testWebhookBtn.disabled = true;
      const prev = testWebhookBtn.textContent;
      testWebhookBtn.textContent = 'Sende…';
      try {
        const res = await window.api.testWebhook({ url, mention });
        if (hint) hint.textContent = res && res.ok
          ? `Test erfolgreich gesendet (HTTP ${res.status}).`
          : `Test fehlgeschlagen: ${(res && (res.error || 'HTTP ' + res.status)) || 'unbekannt'}`;
      } catch (err) {
        if (hint) hint.textContent = `Test fehlgeschlagen: ${err.message || err}`;
      } finally {
        testWebhookBtn.disabled = false;
        testWebhookBtn.textContent = prev;
      }
    });
  }
  const verboseInput = document.getElementById('logVerboseInput');
  if (verboseInput) {
    verboseInput.addEventListener('change', () => {
      if (window.api && window.api.setLogVerbose) window.api.setLogVerbose(verboseInput.checked).catch(() => {});
    });
  }
  const sbBtn = document.getElementById('createSupportBundleBtn');
  if (sbBtn) {
    sbBtn.addEventListener('click', async () => {
      const hint = document.getElementById('supportBundleHint');
      sbBtn.disabled = true;
      const prevText = sbBtn.textContent;
      sbBtn.textContent = 'Exportiere…';
      try {
        const res = await window.api.createSupportBundle();
        if (res && res.ok) {
          if (hint) hint.textContent = `Gespeichert: ${res.path} (${(res.bytes/1024).toFixed(1)} KB)`;
        } else if (res && res.canceled) {
          if (hint) hint.textContent = 'Abgebrochen.';
        } else {
          if (hint) hint.textContent = `Fehler: ${(res && res.error) || 'unbekannt'}`;
        }
      } catch (err) {
        if (hint) hint.textContent = `Fehler: ${err.message || err}`;
      } finally {
        sbBtn.disabled = false;
        sbBtn.textContent = prevText;
      }
    });
  }

  const updateFmBadge = () => {
    const b = document.getElementById('folderMonitorStatusBadge');
    if (!b) return;
    const enabled = document.getElementById('fmEnabledInput')?.checked;
    const hasPath = (document.getElementById('fmFolderPathInput')?.value || '').trim();
    if (enabled && hasPath) { b.textContent = 'Aktiv'; b.className = 'panel-status active'; }
    else { b.textContent = 'Inaktiv'; b.className = 'panel-status'; }
  };
  document.getElementById('fmEnabledInput')?.addEventListener('change', updateFmBadge);
  document.getElementById('fmFolderPathInput')?.addEventListener('input', updateFmBadge);

  document.getElementById('fmChooseFolderBtn')?.addEventListener('click', async () => {
    const folder = await window.api.folderMonitorSelectFolder();
    if (folder) {
      document.getElementById('fmFolderPathInput').value = folder;
      updateFmBadge();
      scheduleSettingsSave();
    }
  });

  document.getElementById('remoteCopyTokenBtn').addEventListener('click', async () => {
    const token = document.getElementById('remoteTokenInput').value;
    if (token) {
      await window.api.copyToClipboard(token);
      document.getElementById('remoteCopyTokenBtn').textContent = 'Kopiert!';
      setTimeout(() => { document.getElementById('remoteCopyTokenBtn').textContent = 'Kopieren'; }, 1500);
    }
  });

  document.getElementById('remoteRegenerateTokenBtn').addEventListener('click', async () => {
    const newToken = await window.api.remoteGenerateToken();
    document.getElementById('remoteTokenInput').value = newToken;
    scheduleSettingsSave();
  });

  window.api.remoteStatus().then(status => {
    const el = document.getElementById('remoteConnectionStatus');
    if (!el) return;
    if (status.running) {
      el.textContent = `Aktiv auf Port ${status.port} — ${status.clientCount} Client(s) verbunden`;
      el.style.color = '#10b981';
    } else {
      el.textContent = 'Nicht aktiv';
      el.style.color = '#94a3b8';
    }
  }).catch(() => {});

  (function wireDiagnostics() {
    const enabledEl = document.getElementById('diagEnabledInput');
    const portEl = document.getElementById('diagPortInput');
    const modeEl = document.getElementById('diagBindModeInput');
    const publicHostEl = document.getElementById('diagPublicHostInput');
    const allowlistEl = document.getElementById('diagAllowlistInput');
    const allowlistRow = document.getElementById('diagAllowlistRow');
    const suggestRow = document.getElementById('diagSuggestRow');
    const suggestChips = document.getElementById('diagSuggestChips');
    const bindHintEl = document.getElementById('diagBindHint');
    const codeEl = document.getElementById('diagCodeInput');
    const issuedEl = document.getElementById('diagCodeIssued');
    const badgeEl = document.getElementById('diagStatusBadge');
    if (!enabledEl) return;

    const fmtIssued = (ts) => {
      if (!ts) return '';
      try { return 'Code erstellt: ' + new Date(ts).toLocaleString(getUiLocale()); } catch { return ''; }
    };
    const parseAllowlist = () => allowlistEl.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const renderModeUi = (suggestedHosts) => {
      const network = modeEl.value === 'network';
      allowlistRow.style.display = network ? '' : 'none';
      bindHintEl.innerHTML = network
        ? 'Bindet an <code>0.0.0.0</code>. Nur IPs/CIDRs aus der Allowlist dürfen verbinden (Loopback immer) — zusätzlich zum Token. Über Tailscale: trage deinen Tailnet-Bereich ein (z.B. <code>100.64.0.0/10</code>) und die Tailscale-IP/MagicDNS oben als Code-Adresse. Transport ist plaintext über den Tunnel — Tailscale/WireGuard verschlüsselt.'
        : 'Bindet nur an <code>127.0.0.1</code>. Fernzugriff nur über einen Tunnel (z.B. Tailscale/SSH) — die sicherste Variante.';
      const hosts = Array.isArray(suggestedHosts) ? suggestedHosts : [];
      if (hosts.length) {
        suggestRow.style.display = '';
        suggestChips.innerHTML = '';
        for (const h of hosts) {
          const b = document.createElement('button');
          b.className = 'btn btn-xs btn-secondary';
          b.textContent = h;
          b.addEventListener('click', () => { publicHostEl.value = h; save(); });
          suggestChips.appendChild(b);
        }
      } else {
        suggestRow.style.display = 'none';
      }
    };
    let lastSuggested = [];
    const applySettings = (s) => {
      if (!s) return;
      enabledEl.checked = !!s.enabled;
      portEl.value = s.port || 9110;
      modeEl.value = s.bindMode === 'network' ? 'network' : 'local';
      publicHostEl.value = s.publicHost || '';
      allowlistEl.value = Array.isArray(s.allowlist) ? s.allowlist.join('\n') : '';
      lastSuggested = Array.isArray(s.suggestedHosts) ? s.suggestedHosts : [];
      codeEl.value = s.code || '';
      issuedEl.textContent = fmtIssued(s.codeIssuedAt);
      renderModeUi(lastSuggested);
      if (badgeEl) {
        badgeEl.textContent = s.enabled ? 'Aktiv' : 'Inaktiv';
        badgeEl.className = 'panel-status' + (s.enabled ? ' active' : '');
      }
    };
    const refreshStatus = () => {
      window.api.diagnosticsStatus().then((st) => {
        const el = document.getElementById('diagConnectionStatus');
        if (!el || !st) return;
        if (st.running) {
          const last = st.lastAccess ? new Date(st.lastAccess).toLocaleString(getUiLocale()) : '—';
          const scope = st.bindMode === 'network' ? `Netzwerk (Allowlist: ${st.allowlistCount})` : 'nur lokal';
          el.textContent = `Aktiv auf ${st.bindAddress}:${st.port} (${scope}) — ${st.clientCount} Client(s) — Letzter Zugriff: ${last}`;
          el.style.color = '#10b981';
        } else {
          el.textContent = 'Nicht aktiv';
          el.style.color = '#94a3b8';
        }
      }).catch(() => {});
    };
    const save = async () => {
      const allowlist = parseAllowlist();
      if (enabledEl.checked && modeEl.value === 'network' && allowlist.length === 0) {
        if (bindHintEl) { bindHintEl.innerHTML = '<span style="color:#f59e0b">Netzwerkmodus braucht mindestens eine IP/CIDR in der Allowlist — sonst bleibt es fail-closed auf Loopback.</span>'; }
        return;
      }
      const diagnosticsSettings = {
        enabled: enabledEl.checked,
        port: parseInt(portEl.value, 10) || 9110,
        bindMode: modeEl.value,
        publicHost: publicHostEl.value.trim(),
        allowlist
      };
      await saveDiagnosticsSettingsTracked(diagnosticsSettings);
      applySettings(await window.api.diagnosticsGetSettings());
      refreshStatus();
    };

    window.api.diagnosticsGetSettings().then(applySettings).catch(() => {});
    refreshStatus();

    enabledEl.addEventListener('change', save);
    portEl.addEventListener('change', save);
    modeEl.addEventListener('change', () => { renderModeUi(lastSuggested); save(); });
    publicHostEl.addEventListener('change', save);
    allowlistEl.addEventListener('change', save);
    document.getElementById('diagCopyCodeBtn').addEventListener('click', async () => {
      if (!codeEl.value) return;
      await window.api.copyToClipboard(codeEl.value);
      const b = document.getElementById('diagCopyCodeBtn');
      b.textContent = 'Kopiert!';
      setTimeout(() => { b.textContent = 'Kopieren'; }, 1500);
    });
    document.getElementById('diagRegenerateBtn').addEventListener('click', async () => {
      const r = await runConfigWrite(() => window.api.diagnosticsRegenerate());
      if (r && r.code) { codeEl.value = r.code; issuedEl.textContent = fmtIssued(r.codeIssuedAt); }
      refreshStatus();
    });
  })();

  document.getElementById('exportBackupBtn').addEventListener('click', () => doBackupExport());
  document.getElementById('importBackupBtn').addEventListener('click', () => doBackupImport());
  document.getElementById('createOnlineBackupBtn').addEventListener('click', () => doOnlineBackupCreate());
  document.getElementById('copyOnlineBackupKeyBtn').addEventListener('click', async () => {
    const key = document.getElementById('onlineBackupKeyOutput').value;
    if (!key) return;
    await window.api.copyToClipboard(key);
    showCopyToast('Online-Schlüssel kopiert');
  });
  document.getElementById('onlineBackupKeyInput').addEventListener('input', (event) => {
    const valid = /^MHU2-[A-Za-z0-9_-]{70}$/.test(event.target.value.trim());
    document.getElementById('restoreOnlineBackupBtn').disabled = !valid;
    if (event.target.value && !valid) setOnlineBackupStatus('Der Schlüssel muss exakt 75 Zeichen lang sein.', '');
    else setOnlineBackupStatus('', '');
  });
  document.getElementById('restoreOnlineBackupBtn').addEventListener('click', () => doOnlineBackupRestore());

  document.getElementById('chooseLogFilePathBtn')?.addEventListener('click', chooseLogFilePath);
  document.getElementById('openLogFolderBtn')?.addEventListener('click', () => window.api.openLogFolder());
  document.getElementById('manualUpdateCheckBtn')?.addEventListener('click', requestUpdateCheck);
  _syncHeaderUpdateState();
  container.querySelectorAll('.settings-autosave').forEach((input) => {
    const eventName = input.type === 'checkbox' || input.tagName === 'SELECT' ? 'change' : 'input';
    input.addEventListener(eventName, () => {
      if (input.id === 'languageInput') {
        setUiLanguage(input.value);
        syncLanguagePicker(input.value);
      }
      markSettingsDirty();
    });
  });
  container.querySelectorAll('.language-option').forEach(button => {
    button.addEventListener('click', () => {
      const input = document.getElementById('languageInput');
      if (!input || input.value === button.dataset.language) return;
      input.value = button.dataset.language;
      input.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
  });
  syncLanguagePicker(globalSettings.language);
  establishSettingsBaseline();
  window.requestAnimationFrame(() => {
    if (layout.isConnected) _syncSidebarIndicator(navigation.querySelector('.settings-nav-button.active'), true);
  });
}

function syncLanguagePicker(value) {
  const language = window.I18n.normalizeLanguage(value);
  const picker = document.getElementById('languagePicker');
  if (!picker) return;
  picker.dataset.language = language;
  picker.querySelectorAll('.language-option').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.language === language));
  });
}

async function chooseLogFilePath() {
  const folders = await window.api.selectFolder();
  if (!folders || !folders[0]) return;
  const normalized = folders[0].replace(/[\\\/]+$/, '');
  document.getElementById('logFilePathInput').value = `${normalized}\\fileuploader.log`;
  markSettingsDirty();
}

function captureSettingsState() {
  const controls = Array.from(document.querySelectorAll('#settings-view .settings-autosave'));
  return JSON.stringify(controls.map(control => [
    control.id || control.name || '',
    control.type === 'checkbox' ? control.checked : control.value
  ]));
}

function syncSettingsSaveState(message) {
  const button = document.getElementById('saveSettingsBtn');
  const feedback = document.getElementById('saveFeedback');
  if (button) {
    button.disabled = settingsSaving || !settingsDirty;
    button.classList.toggle('btn-success', settingsDirty && !settingsSaving);
    button.classList.toggle('btn-secondary', !settingsDirty || settingsSaving);
  }
  if (feedback && message) feedback.textContent = message;
}

function establishSettingsBaseline(message = 'Keine ungespeicherten Änderungen') {
  settingsBaseline = captureSettingsState();
  settingsDirty = false;
  syncSettingsSaveState(message);
}

function markSettingsDirty() {
  settingsDirty = captureSettingsState() !== settingsBaseline;
  syncSettingsSaveState(settingsDirty ? 'Ungespeicherte Änderungen' : 'Keine ungespeicherten Änderungen');
}

function scheduleSettingsSave() {
  markSettingsDirty();
}

function saveSettings(options = {}) {
  const requestedState = captureSettingsState();
  settingsSaving = true;
  syncSettingsSaveState('Speichert…');
  return settingsSaveCoordinator.run(options).then(result => {
    const savedMessage = options.feedbackText || 'Gespeichert!';
    settingsBaseline = requestedState;
    settingsDirty = captureSettingsState() !== settingsBaseline;
    syncSettingsSaveState(settingsDirty ? 'Ungespeicherte Änderungen' : savedMessage);
    setTimeout(() => {
      const feedback = document.getElementById('saveFeedback');
      if (!settingsDirty && feedback?.textContent === savedMessage) syncSettingsSaveState('Keine ungespeicherten Änderungen');
    }, 1800);
    return result;
  }, error => {
    settingsSaving = false;
    settingsDirty = captureSettingsState() !== settingsBaseline;
    syncSettingsSaveState(`Speichern fehlgeschlagen: ${error.message}`);
    throw error;
  }).finally(() => {
    settingsSaving = false;
    syncSettingsSaveState();
  });
}

async function performSaveSettings(options = {}) {
  const { feedbackText = 'Gespeichert!' } = options;
  const newHosterSettings = { ...(config.hosterSettings || {}) };
  const cur = config.globalSettings || {};
  const curFm = cur.folderMonitor || {};
  const curRemote = cur.remote || {};
  const elTxt = (id, fb) => { const el = document.getElementById(id); return el ? el.value : fb; };
  const elChk = (id, fb) => { const el = document.getElementById(id); return el ? !!el.checked : fb; };
  const elInt = (id, curVal, dflt, lo, hi) => {
    const el = document.getElementById(id);
    if (!el) return curVal;
    const n = parseInt(el.value || String(dflt), 10) || dflt;
    return Math.max(lo, Math.min(hi, n));
  };

  const globalSettings = {
    ...cur,
    language: (() => {
      const el = document.getElementById('languageInput');
      return window.I18n.normalizeLanguage(el ? el.value : cur.language);
    })(),
    logFilePath: elTxt('logFilePathInput', cur.logFilePath || '').trim(),
    logMode: (() => {
      const el = document.getElementById('logModeInput');
      if (!el) return cur.logMode || 'single';
      const v = el.value;
      return (v === 'single' || v === 'daily' || v === 'session') ? v : 'single';
    })(),
    resumeQueueOnLaunch: elChk('resumeQueueOnLaunchInput', cur.resumeQueueOnLaunch !== false),
    parallelUploadCount: elInt('parallelUploadCountInput', cur.parallelUploadCount ?? 0, 0, 0, 100),
    scaleParallelUploads: elChk('scaleParallelUploadsInput', !!cur.scaleParallelUploads),
    removeFromQueueOnDone: elChk('removeFromQueueOnDoneInput', !!cur.removeFromQueueOnDone),
    showDropTarget: elChk('showDropTargetInput', !!cur.showDropTarget),
    globalMaxSpeedKbs: (() => {
      const el = document.getElementById('globalMaxSpeedMbsInput');
      if (!el) return cur.globalMaxSpeedKbs ?? 0;
      return Math.max(0, Math.round((parseFloat(el.value || '0') || 0) * 1024));
    })(),
    logVerbose: elChk('logVerboseInput', !!cur.logVerbose),
    webhookUrl: elTxt('webhookUrlInput', cur.webhookUrl || '').trim(),
    webhookMention: elTxt('webhookMentionInput', cur.webhookMention || '').trim(),
    autoRetryRounds: elInt('autoRetryRoundsInput', cur.autoRetryRounds ?? 0, 0, 0, 5),
    autoRetryDelayMin: elInt('autoRetryDelayMinInput', cur.autoRetryDelayMin ?? 5, 5, 1, 120),
    folderMonitor: {
      ...curFm,
      enabled: elChk('fmEnabledInput', !!curFm.enabled),
      folderPath: elTxt('fmFolderPathInput', curFm.folderPath || '').trim(),
      recursive: elChk('fmRecursiveInput', !!curFm.recursive),
      filterMode: (() => { const el = document.getElementById('fmFilterModeInput'); return el ? (el.value || 'include') : (curFm.filterMode || 'include'); })(),
      extensions: elTxt('fmExtensionsInput', curFm.extensions || '').trim(),
      skipDuplicates: elChk('fmSkipDuplicatesInput', curFm.skipDuplicates !== false),
      delaySec: elInt('fmDelaySecInput', curFm.delaySec ?? 3, 3, 1, 300),
      autoStart: elChk('fmAutoStartInput', curFm.autoStart !== false),
      hosters: document.querySelector('.fm-hoster-checkbox')
        ? Array.from(document.querySelectorAll('.fm-hoster-checkbox:checked')).map(el => el.dataset.fmHoster)
        : (curFm.hosters || [])
    },
    remote: {
      ...curRemote,
      enabled: elChk('remoteEnabledInput', !!curRemote.enabled),
      port: elInt('remotePortInput', curRemote.port || 9100, 9100, 1024, 65535),
      token: elTxt('remoteTokenInput', curRemote.token || '').trim(),
      allowInput: elChk('remoteAllowInputInput', curRemote.allowInput !== false)
    }
  };

  // Always on top setting
  const aotCheckbox = document.getElementById('alwaysOnTopInput');
  if (aotCheckbox) {
    const newAot = !!aotCheckbox.checked;
    if (newAot !== alwaysOnTopState) {
      alwaysOnTopState = newAot;
      await setAlwaysOnTopTracked(newAot);
    }
  }

  // Drop target window
  const dtCheckbox = document.getElementById('showDropTargetInput');
  if (dtCheckbox) {
    if (dtCheckbox.checked) await window.api.showDropTarget();
    else await window.api.hideDropTarget();
  }

  for (const name of HOSTERS) {
    const hs = { ...(hosterSettings[name] || {}) };
    document.querySelectorAll(`.hs-input[data-hoster="${name}"]`).forEach(input => {
      const field = input.dataset.hs;
      if (input.type === 'checkbox') hs[field] = input.checked;
      else if (field === 'maxSpeedMbs') hs.maxSpeedKbs = Math.max(0, Math.round((parseFloat(input.value) || 0) * 1024));
      else hs[field] = parseInt(input.value, 10) || 0;
    });
    newHosterSettings[name] = hs;
  }

  await Promise.all([
    saveHosterSettingsTracked(newHosterSettings),
    saveGlobalSettingsTracked(globalSettings)
  ]);
  config.hosterSettings = newHosterSettings;
  config.globalSettings = globalSettings;
  hosterSettings = newHosterSettings;
  clearTimeout(settingsSaveTimer);
  settingsSaveTimer = null;

  // Start/stop folder monitor based on settings
  const fmSettings = globalSettings.folderMonitor;
  const badge = document.getElementById('folderMonitorStatusBadge');
  if (fmSettings && fmSettings.enabled && fmSettings.folderPath) {
    try {
      await window.api.folderMonitorStart(fmSettings);
      if (badge) { badge.textContent = 'Aktiv'; badge.className = 'panel-status active'; }
    } catch {
      if (badge) { badge.textContent = 'Fehler'; badge.className = 'panel-status'; }
    }
  } else {
    await window.api.folderMonitorStop();
    if (badge) { badge.textContent = 'Inaktiv'; badge.className = 'panel-status'; }
  }

  // Start/stop remote server based on settings
  const remoteSettings = globalSettings.remote;
  const remoteBadge = document.getElementById('remoteStatusBadge');
  if (remoteSettings) {
    try {
      const remoteSaveResult = await saveRemoteSettingsTracked(remoteSettings);
      if (remoteSaveResult && remoteSaveResult.settings) {
        globalSettings.remote = { ...remoteSaveResult.settings };
        config.globalSettings = { ...(config.globalSettings || {}), remote: { ...remoteSaveResult.settings } };
        const tokenInput = document.getElementById('remoteTokenInput');
        if (tokenInput) tokenInput.value = remoteSaveResult.settings.token || '';
      }
      if (remoteSaveResult && remoteSaveResult.runtimeError) throw new Error(remoteSaveResult.runtimeError);
      if (remoteBadge) {
        remoteBadge.textContent = remoteSettings.enabled ? 'Aktiv' : 'Inaktiv';
        remoteBadge.className = `panel-status${remoteSettings.enabled ? ' active' : ''}`;
      }
      // Update status display
      const status = await window.api.remoteStatus();
      const statusEl = document.getElementById('remoteConnectionStatus');
      if (statusEl) {
        if (status.running) {
          statusEl.textContent = `Aktiv auf Port ${status.port} — ${status.clientCount} Client(s) verbunden`;
          statusEl.style.color = '#10b981';
        } else {
          statusEl.textContent = 'Nicht aktiv';
          statusEl.style.color = '#94a3b8';
        }
      }
    } catch {
      if (remoteBadge) {
        remoteBadge.textContent = 'Fehler';
        remoteBadge.className = 'panel-status';
      }
    }
  }

  const feedback = document.getElementById('saveFeedback');
  if (feedback) feedback.textContent = feedbackText;
}

// --- Accounts ---
function getCredentialLabel(name, account) {
  if (!account) return 'Keine Zugangsdaten';
  if (account.authType === 'api') return `API: ${maskCredential(account.apiKey) || 'nicht gesetzt'}`;
  if (account.authType === 'login') return `Login: ${account.username || 'nicht gesetzt'}`;
  // Fallback
  if (account.username && account.password) return `Login: ${account.username}`;
  if (account.apiKey) return `API: ${maskCredential(account.apiKey)}`;
  return 'Keine Zugangsdaten';
}

function _buildAccountCardHtml(name, account, idx) {
  const isDisabled = account.enabled === false;
  const st = accountStatuses[account.id] || { status: 'unchecked', message: '' };
  const statusPresentation = window.AccountStatus.getAccountStatusPresentation(isDisabled ? 'disabled' : st.status);
  const statusLabel = statusPresentation.label;
  const statusClass = statusPresentation.statusClass;
  const credLabel = getCredentialLabel(name, account);
  const userLabel = account.label && String(account.label).trim();
  // Subtitle: "Label: XYZ • API: ABC… • <status>" — the user-set label is the
  // disambiguator for accounts that otherwise look identical (e.g. two byse
  // API-key accounts where you can't tell what's what from the masked key).
  const subtitleText = (userLabel ? `Label: ${userLabel} • ` : '') + credLabel;
  const toggleLabel = isDisabled ? 'Aktivieren' : 'Deaktivieren';
  const priorityLabel = idx === 0 ? 'Primär' : `Fallback #${idx}`;

  const isSessionPaused = _sessionFailedKeys.has(`${name}:${account.id}`);
  const sessionPausedBadge = isSessionPaused
    ? `<span class="account-session-paused" title="Account wurde diese Session als fehlerhaft markiert. Klick = Wieder als aktiv markieren.">Pausiert (Session) <button class="account-session-reactivate" data-account-reactivate="${account.id}" data-account-reactivate-hoster="${name}" title="Wieder aktivieren">↻</button></span>`
    : '';
  const otpAction = !isDisabled && statusPresentation.requiresOtp
    ? `<div class="account-otp-action">
        <input class="key-input account-otp-input" data-account-otp-input="${escapeAttr(account.id)}" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="10" placeholder="Code aus E-Mail">
        <button class="btn btn-xs btn-primary" data-account-otp-submit="${escapeAttr(account.id)}">Prüfen und speichern</button>
      </div>`
    : '';

  return `
    <div class="account-card${isDisabled ? ' account-disabled' : ''}${isSessionPaused ? ' account-session-paused-card' : ''}" data-account-id="${account.id}" data-account-hoster="${name}" draggable="true">
      <div class="account-card-drag-handle" title="Ziehen zum Sortieren">&#9776;</div>
      <div class="account-card-info">
        <div class="account-card-title">${escapeHtml(getAccountDisplayName(name, account))} <span class="account-priority-badge">${priorityLabel}</span> ${sessionPausedBadge}</div>
        <div class="account-card-subtitle" title="${escapeAttr(subtitleText)}">${escapeHtml(subtitleText)}${st.message && !isDisabled ? ` • ${escapeHtml(st.message)}` : ''}</div>
        ${otpAction}
      </div>
      <span class="account-status status-${statusClass}">
        <span class="account-status-dot"></span>
        ${statusLabel}
      </span>
      <div class="account-card-actions">
        <button class="btn btn-xs btn-secondary" data-account-toggle="${account.id}">${toggleLabel}</button>
        <button class="btn btn-xs btn-secondary" data-account-check="${account.id}" ${isDisabled ? 'disabled' : ''}>Prüfen</button>
        <button class="btn btn-xs btn-secondary" data-account-edit="${account.id}">Bearbeiten</button>
        <button class="btn btn-xs btn-danger" data-account-delete="${account.id}">Löschen</button>
      </div>
    </div>`;
}

// Replace only the one card for `accountId` instead of re-rendering the whole
// container. Runs on enable/disable, single health check, priority-badge bumps
// after a reorder — anywhere we only change one card's state.
function updateAccountCard(accountId) {
  const container = document.getElementById('accountsList');
  if (!container) return;
  const found = findAccountById(accountId);
  if (!found) return;
  const card = container.querySelector(`.account-card[data-account-id="${accountId}"]`);
  if (!card) return;
  const accounts = config.hosters[found.name] || [];
  const idx = accounts.findIndex(a => a.id === accountId);
  if (idx < 0) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = _buildAccountCardHtml(found.name, found.account, idx);
  card.replaceWith(tmp.firstElementChild);
  _refreshHosterGroupHeader(found.name);
  updateAccountSidebarSummary();
  _applyAccountSidebarFilter();
}

function _refreshHosterGroupHeader(name) {
  const container = document.getElementById('accountsList');
  if (!container) return;
  const group = container.querySelector(`.account-hoster-group[data-hoster-group="${name}"]`);
  if (!group) return;
  const accounts = config.hosters[name] || [];
  const summary = _summarizeHosterGroup(accounts);
  const dot = window.AccountStatus.getAccountGroupStatus(summary);
  const dotEl = group.querySelector('.account-hoster-group-header .account-status-dot');
  if (dotEl) dotEl.className = `account-status-dot status-${dot}`;
  const countEl = group.querySelector('.account-hoster-group-count');
  if (countEl) countEl.textContent = `${summary.ok}/${summary.total}`;
  group.querySelectorAll('.account-hoster-group-meta').forEach(el => el.remove());
  const header = group.querySelector('.account-hoster-group-header');
  if (header) {
    if (summary.disabled) {
      const meta = document.createElement('span');
      meta.className = 'account-hoster-group-meta';
      meta.textContent = `${summary.disabled} deaktiviert`;
      header.appendChild(meta);
    }
    if (summary.error) {
      const meta = document.createElement('span');
      meta.className = 'account-hoster-group-meta error';
      meta.textContent = `${summary.error} Fehler`;
      header.appendChild(meta);
    }
  }
}

let _accountListenersBound = false;

function renderAccounts() {
  const container = document.getElementById('accountsList');
  if (!container) return;
  ensureAccountStatusEntries();

  const allAccounts = getAllAccountsFlat();
  updateAccountSidebarSummary(allAccounts);
  const runCheckBtn = document.getElementById('accountsRunHealthCheckBtn');
  if (runCheckBtn) runCheckBtn.disabled = healthCheckRunning;

  const footer = document.getElementById('accountsListFooter');

  if (allAccounts.length === 0) {
    container.innerHTML = `
      <div class="accounts-empty">
        <div class="accounts-empty-icon" aria-hidden="true">+</div>
        <h3>Noch keine Accounts</h3>
        <p>Füge deinen ersten Hoster-Account hinzu. Die Zugangsdaten werden vor dem Speichern geprüft.</p>
      </div>`;
    if (footer) footer.style.display = 'none';
    if (!_accountListenersBound) bindAccountListeners(container);
    _applyAccountSidebarFilter();
    return;
  }

  const byHoster = {};
  for (const { name, account } of allAccounts) {
    if (!byHoster[name]) byHoster[name] = [];
    byHoster[name].push(account);
  }

  let html = '';
  for (const name of HOSTERS) {
    const accounts = byHoster[name];
    if (!accounts || accounts.length === 0) continue;
    html += _buildAccountHosterGroupHtml(name, accounts);
  }
  container.innerHTML = html;

  if (footer) footer.style.display = '';
  _updateToggleAllAccountsBtn();

  if (!_accountListenersBound) bindAccountListeners(container);
  _applyAccountSidebarFilter();
}

function _summarizeHosterGroup(accounts) {
  let ok = 0, warn = 0, error = 0, checking = 0, unchecked = 0, disabled = 0;
  for (const a of accounts) {
    if (a.enabled === false) { disabled++; continue; }
    const s = (accountStatuses[a.id] && accountStatuses[a.id].status) || 'unchecked';
    if (s === 'ok') ok++;
    else if (s === 'warn' || s === 'otp_required') warn++;
    else if (s === 'error') error++;
    else if (s === 'checking') checking++;
    else unchecked++;
  }
  return { ok, warn, error, checking, unchecked, disabled, total: accounts.length };
}

function _hosterGroupOpenState(name, summary) {
  const prev = _hosterGroupOpenMemory.get(name);
  if (prev && typeof prev === 'object') {
    if (summary.error > (prev.errorsAtClose || 0)) {
      _hosterGroupOpenMemory.delete(name);
      return true;
    }
    return prev.state === 'open';
  }
  return summary.error > 0;
}

const _hosterGroupOpenMemory = new Map();

let _hosterSettingsSaveTimer = null;
const hosterSettingsSaveCoordinator = window.SerializedRunner.createSerializedRunner(performHosterSettingsSave);
function scheduleHosterSettingsSave() {
  if (closePreparationState !== 'open') return;
  clearTimeout(_hosterSettingsSaveTimer);
  _hosterSettingsSaveTimer = setTimeout(() => {
    _hosterSettingsSaveTimer = null;
    saveHosterSettingsFromDom().catch(() => {});
  }, 350);
}

function saveHosterSettingsFromDom() {
  return hosterSettingsSaveCoordinator.run();
}

async function performHosterSettingsSave() {
  const newHosterSettings = { ...(config.hosterSettings || {}) };
  for (const name of HOSTERS) {
    const inputs = document.querySelectorAll(`.account-hoster-settings-body .hs-input[data-hoster="${name}"]`);
    if (!inputs.length) continue;
    const hs = { ...(newHosterSettings[name] || {}) };
    inputs.forEach(input => {
      const field = input.dataset.hs;
      if (input.type === 'checkbox') hs[field] = input.checked;
      else if (field === 'maxSpeedMbs') hs.maxSpeedKbs = Math.max(0, Math.round((parseFloat(input.value) || 0) * 1024));
      else hs[field] = parseInt(input.value, 10) || 0;
    });
    newHosterSettings[name] = hs;
  }
  await saveHosterSettingsTracked(newHosterSettings);
  config.hosterSettings = newHosterSettings;
  hosterSettings = newHosterSettings;
}

async function recoverSerializedSave(coordinator, retry) {
  try {
    await coordinator.flush();
    return false;
  } catch {
    await flushConfigWrites();
    await retry();
    return true;
  }
}

async function flushPendingSettingsSaves() {
  const flushSettings = settingsSaveTimer !== null;
  const flushHosters = _hosterSettingsSaveTimer !== null;
  clearTimeout(settingsSaveTimer);
  clearTimeout(_hosterSettingsSaveTimer);
  settingsSaveTimer = null;
  _hosterSettingsSaveTimer = null;
  queuePersistThrottle.flushSync();
  const settingsRecovered = await recoverSerializedSave(
    settingsSaveCoordinator,
    () => saveSettings({ feedbackText: 'Automatisch gespeichert' })
  );
  const hostersRecovered = await recoverSerializedSave(
    hosterSettingsSaveCoordinator,
    saveHosterSettingsFromDom
  );
  if (flushSettings && !settingsRecovered) await saveSettings({ feedbackText: 'Automatisch gespeichert' });
  if (flushHosters && !hostersRecovered) await saveHosterSettingsFromDom();
  await Promise.all([settingsSaveCoordinator.flush(), hosterSettingsSaveCoordinator.flush()]);
  await flushConfigWrites();
  const persistedConfig = await window.api.getConfig();
  config = persistedConfig;
  hosterSettings = config.hosterSettings || {};
  alwaysOnTopState = !!(config.globalSettings && config.globalSettings.alwaysOnTop);
}

function _buildHosterSettingsHtml(name) {
  const hs = (config.hosterSettings && config.hosterSettings[name]) || {};
  const maxSpeedMbs = hs.maxSpeedKbs > 0 ? String(+(hs.maxSpeedKbs / 1024).toFixed(2)) : '0';
  return `<div class="account-hoster-settings">
    <div class="account-hoster-settings-header" data-hoster-settings-toggle="${name}" aria-expanded="false">
      <span class="panel-arrow">&#9654;</span>
      <span>Upload-Einstellungen</span>
    </div>
    <div class="account-hoster-settings-body account-collapse" aria-hidden="true" inert>
      <div class="account-collapse-content">
        <div class="account-hoster-settings-body-inner settings-grid-mini">
        <div class="settings-row">
          <label>Retries</label>
          <input type="number" class="hs-input" data-hoster="${name}" data-hs="retries" value="${hs.retries ?? 3}" min="0" max="500">
        </div>
        <div class="settings-row">
          <label>Max Speed (MB/s)</label>
          <input type="number" class="hs-input" data-hoster="${name}" data-hs="maxSpeedMbs" value="${maxSpeedMbs}" min="0" step="0.1">
          <span class="hint">0 = unbegrenzt</span>
        </div>
        <div class="settings-row">
          <label>Parallele Uploads</label>
          <input type="number" class="hs-input" data-hoster="${name}" data-hs="parallelCount" value="${hs.parallelCount ?? 2}" min="1" max="100">
        </div>
        <div class="settings-row">
          <label>Restart unter (kB/s)</label>
          <input type="number" class="hs-input" data-hoster="${name}" data-hs="restartBelowKbs" value="${hs.restartBelowKbs ?? 0}" min="0">
          <span class="hint">0 = aus</span>
        </div>
        <div class="settings-row">
          <label>Intervall (s)</label>
          <input type="number" class="hs-input" data-hoster="${name}" data-hs="timeIntervalSec" value="${hs.timeIntervalSec ?? 0}" min="0">
        </div>
        <div class="settings-row">
          <label>Max Size (MB)</label>
          <input type="number" class="hs-input" data-hoster="${name}" data-hs="maxSizeMb" value="${hs.maxSizeMb ?? 0}" min="0">
          <span class="hint">0 = unbegrenzt</span>
        </div>
        <div class="settings-row">
          <label>Links in Log schreiben</label>
          <input type="checkbox" class="hs-input" data-hoster="${name}" data-hs="logToFile" ${hs.logToFile !== false ? 'checked' : ''}>
          <span class="hint">Erfolgreiche Links in fileuploader.log.</span>
        </div>
        <div class="settings-row">
          <label>Accounts rotieren</label>
          <input type="checkbox" class="hs-input" data-hoster="${name}" data-hs="rotateAccounts" ${hs.rotateAccounts === true ? 'checked' : ''}>
          <span class="hint">Verteilt die Dateien reihum auf alle aktiven Accounts dieses Hosters (Datei 1 → Account 1, Datei 2 → Account 2 …). Hält z. B. byse-Accounts aktiv. Nur ein Account = kein Effekt.</span>
        </div>
        <div class="settings-row">
          <label>Größen-Limit merken</label>
          <input type="checkbox" class="hs-input" data-hoster="${name}" data-hs="sizeMemoEnabled" ${hs.sizeMemoEnabled !== false ? 'checked' : ''}>
          <span class="hint">Überspringt nach zwei verdächtigen Ablehnungen auf einem Account größere Dateien dort vorab ("Bekanntes Größen-Limit"). Abschalten = jede Datei wird immer wirklich versucht.</span>
        </div>
        </div>
      </div>
    </div>
  </div>`;
}

function _buildAccountHosterGroupHtml(name, accounts) {
  const summary = _summarizeHosterGroup(accounts);
  const isOpen = _hosterGroupOpenState(name, summary);
  const dot = window.AccountStatus.getAccountGroupStatus(summary);
  const countLabel = `${summary.ok}/${summary.total}`;
  let cardsHtml = '';
  accounts.forEach((account, idx) => { cardsHtml += _buildAccountCardHtml(name, account, idx); });
  const lifeStat = _hosterLifetimeStat(name);
  const lifeMeta = lifeStat && lifeStat.total > 0
    ? `<span class="account-hoster-group-meta" title="Erfolgsrate aus den letzten ${lifeStat.total} Uploads dieses Hosters">${Math.round(lifeStat.rate * 100)}% ok (${lifeStat.total})</span>`
    : '';
  return `<div class="account-hoster-group" data-hoster-group="${name}">
    <div class="account-hoster-group-header" data-hoster-toggle="${name}" aria-expanded="${isOpen}">
      <span class="panel-arrow">&#9654;</span>
      <span class="account-status-dot status-${dot}"></span>
      <span class="account-hoster-group-title">${escapeHtml(getHosterLabel(name))}</span>
      <span class="account-hoster-group-count">${countLabel}</span>
      ${summary.disabled ? `<span class="account-hoster-group-meta">${summary.disabled} deaktiviert</span>` : ''}
      ${summary.error ? `<span class="account-hoster-group-meta error">${summary.error} Fehler</span>` : ''}
      ${lifeMeta}
    </div>
    <div class="account-hoster-group-body account-collapse${isOpen ? ' is-open' : ''}" aria-hidden="${!isOpen}" ${isOpen ? '' : 'inert'}>
      <div class="account-collapse-content"><div class="account-hoster-group-body-inner">${cardsHtml}</div></div>
    </div>
    ${_buildHosterSettingsHtml(name)}
  </div>`;
}

let _hosterLifetimeCache = null;
function _hosterLifetimeStat(name) {
  if (!_hosterLifetimeCache && window.Stats && Array.isArray(window._historyForStats)) {
    _hosterLifetimeCache = window.Stats.summarizePerHoster(window._historyForStats, { lastNBatches: 50 });
  }
  return _hosterLifetimeCache ? _hosterLifetimeCache[name] : null;
}
function _invalidateHosterLifetimeCache() { _hosterLifetimeCache = null; }

function _allAccountGroupsOpen() {
  const bodies = document.querySelectorAll('#accountsList .account-hoster-group-body');
  if (!bodies.length) return false;
  for (const body of bodies) if (!body.classList.contains('is-open')) return false;
  return true;
}

function _setAccountCollapseOpen(trigger, body, open) {
  if (!body) return;
  body.classList.toggle('is-open', open);
  body.setAttribute('aria-hidden', String(!open));
  body.toggleAttribute('inert', !open);
  if (trigger) trigger.setAttribute('aria-expanded', String(open));
}

function _setAllAccountGroupsOpen(open) {
  const groups = document.querySelectorAll('#accountsList .account-hoster-group');
  groups.forEach(group => {
    const name = group.dataset.hosterGroup;
    const body = group.querySelector('.account-hoster-group-body');
    const header = group.querySelector('[data-hoster-toggle]');
    _setAccountCollapseOpen(header, body, open);
    if (name) {
      const summary = _summarizeHosterGroup(config.hosters[name] || []);
      _hosterGroupOpenMemory.set(name, { state: open ? 'open' : 'closed', errorsAtClose: summary.error });
    }
  });
  _updateToggleAllAccountsBtn();
}

function _updateToggleAllAccountsBtn() {
  const btn = document.getElementById('toggleAllAccountsBtn');
  if (!btn) return;
  btn.textContent = _allAccountGroupsOpen() ? 'Alle einklappen' : 'Alle ausklappen';
}

// Single set of delegated listeners on the accounts container. Bound once on
// the first render and reused for every subsequent in-place update / card
// swap. Previously we rebound 4 × N button listeners + 5 × N drag listeners
// per render — with 20 accounts that's 180 listener create/destroy cycles on
// every enable/disable click.
function bindAccountListeners(container) {
  _accountListenersBound = true;
  container.addEventListener('click', (e) => {
    const header = e.target.closest('[data-hoster-toggle]');
    if (header && !e.target.closest('button')) {
      const name = header.dataset.hosterToggle;
      const group = header.closest('.account-hoster-group');
      const body = group && group.querySelector('.account-hoster-group-body');
      if (body) {
        const willOpen = !body.classList.contains('is-open');
        _setAccountCollapseOpen(header, body, willOpen);
        const summary = _summarizeHosterGroup(config.hosters[name] || []);
        _hosterGroupOpenMemory.set(name, { state: willOpen ? 'open' : 'closed', errorsAtClose: summary.error });
      }
      return;
    }
    const settingsHeader = e.target.closest('[data-hoster-settings-toggle]');
    if (settingsHeader) {
      const body = settingsHeader.nextElementSibling;
      if (body) {
        const willOpen = !body.classList.contains('is-open');
        _setAccountCollapseOpen(settingsHeader, body, willOpen);
      }
      return;
    }
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.hasAttribute('data-account-empty-add')) return openAccountModal(null);
    if (btn.dataset.accountToggle) return toggleAccount(btn.dataset.accountToggle);
    if (btn.dataset.accountEdit) return openAccountModal(btn.dataset.accountEdit);
    if (btn.dataset.accountDelete) return openDeleteAccountModal(btn.dataset.accountDelete);
    if (btn.dataset.accountCheck) return checkSingleAccount(btn.dataset.accountCheck);
    if (btn.dataset.accountOtpSubmit) return submitAccountOtp(btn.dataset.accountOtpSubmit);
    if (btn.dataset.accountReactivate) {
      const accountId = btn.dataset.accountReactivate;
      const hoster = btn.dataset.accountReactivateHoster;
      if (!hoster || !accountId) return;
      e.stopPropagation();
      window.api.resetSessionFailedAccount({ hoster, accountId }).then(() => {
        _sessionFailedKeys.delete(`${hoster}:${accountId}`);
        renderAccounts();
        showCopyToast(`${getHosterLabel(hoster)} Account wieder aktiv — nächste Batch verwendet ihn`);
      }).catch(() => {});
      return;
    }
  });

  const onHosterSettingInput = (e) => {
    if (e.target && e.target.classList && e.target.classList.contains('hs-input')) scheduleHosterSettingsSave();
  };
  container.addEventListener('input', onHosterSettingInput);
  container.addEventListener('change', onHosterSettingInput);

  let draggedCard = null;
  container.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.account-card[draggable]');
    if (!card) return;
    draggedCard = card;
    card.classList.add('dragging');
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  });
  container.addEventListener('dragend', () => {
    if (draggedCard) draggedCard.classList.remove('dragging');
    draggedCard = null;
    container.querySelectorAll('.drag-over-above, .drag-over-below').forEach(c => c.classList.remove('drag-over-above', 'drag-over-below'));
  });
  container.addEventListener('dragover', (e) => {
    const card = e.target.closest('.account-card[draggable]');
    if (!card || !draggedCard || draggedCard === card) return;
    if (draggedCard.dataset.accountHoster !== card.dataset.accountHoster) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const rect = card.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    card.classList.toggle('drag-over-above', e.clientY < midY);
    card.classList.toggle('drag-over-below', e.clientY >= midY);
  });
  container.addEventListener('dragleave', (e) => {
    const card = e.target.closest('.account-card[draggable]');
    if (card) card.classList.remove('drag-over-above', 'drag-over-below');
  });
  container.addEventListener('drop', (e) => {
    const card = e.target.closest('.account-card[draggable]');
    if (!card || !draggedCard || draggedCard === card) return;
    e.preventDefault();
    card.classList.remove('drag-over-above', 'drag-over-below');
    const hosterName = card.dataset.accountHoster;
    if (draggedCard.dataset.accountHoster !== hosterName) return;

    const draggedId = draggedCard.dataset.accountId;
    const targetId = card.dataset.accountId;
    const accounts = config.hosters[hosterName];
    if (!Array.isArray(accounts)) return;

    const fromIdx = accounts.findIndex(a => a.id === draggedId);
    if (fromIdx < 0) return;
    const [moved] = accounts.splice(fromIdx, 1);
    const rect = card.getBoundingClientRect();
    const insertBefore = e.clientY < rect.top + rect.height / 2;
    const newToIdx = accounts.findIndex(a => a.id === targetId);
    accounts.splice(insertBefore ? newToIdx : newToIdx + 1, 0, moved);

    // Move the DOM node in place — no full re-render.
    if (insertBefore) card.before(draggedCard); else card.after(draggedCard);

    // The Primär / Fallback #N badges just changed for the whole group.
    for (let i = 0; i < accounts.length; i++) updateAccountCard(accounts[i].id);

    // Persist in the background. saveConfig is idempotent; we don't need to
    // await here or re-fetch — our in-memory config is already the truth.
    saveConfigTracked({ hosters: config.hosters }).catch(() => {});
  });
}

async function toggleAccount(accountId) {
  const found = findAccountById(accountId);
  if (!found) return;
  found.account.enabled = !found.account.enabled;
  syncSelectedUploadHosters();
  // In-place: swap only the one affected card. No full re-render, no IPC
  // refetch, no flicker. Rapid click-toggles now feel instant even with 50
  // accounts in the list.
  updateAccountCard(accountId);
  renderHosterSummary();
  saveConfigTracked({ hosters: config.hosters }).catch(() => {});
}

async function checkSingleAccount(accountId) {
  if (!accountId || healthCheckRunning) return;
  const found = findAccountById(accountId);
  if (!found) return;
  healthCheckRunning = true;
  accountStatuses[accountId] = { status: 'checking', message: '' };
  updateAccountCard(accountId);
  try {
    const result = await window.api.runHealthCheck({ hosters: [{ hoster: found.name, accountId }] });
    const rows = result && Array.isArray(result.results) ? result.results : [];
    const row = rows.find(r => r.accountId === accountId);
    if (row) accountStatuses[accountId] = { status: row.status || 'error', message: row.message || '' };
  } catch (err) {
    accountStatuses[accountId] = { status: 'error', message: err.message || 'Prüfung fehlgeschlagen' };
  } finally {
    healthCheckRunning = false;
  }
  updateAccountCard(accountId);
}

async function submitAccountOtp(accountId) {
  if (!accountId || healthCheckRunning) return;
  const found = findAccountById(accountId);
  if (!found || found.account.enabled === false) return;
  const card = Array.from(document.querySelectorAll('.account-card')).find(el => el.dataset.accountId === accountId);
  const otpInput = card?.querySelector('[data-account-otp-input]');
  const otp = otpInput?.value.trim() || '';
  if (otpInput) otpInput.setCustomValidity('');
  if (!otp) {
    if (otpInput) {
      otpInput.setCustomValidity('Bitte den OTP-Code eingeben.');
      otpInput.reportValidity();
    }
    return;
  }
  const submitButton = card?.querySelector('[data-account-otp-submit]');
  healthCheckRunning = true;
  accountStatuses[accountId] = { status: 'checking', message: 'OTP wird geprüft…' };
  if (otpInput) otpInput.disabled = true;
  if (submitButton) {
    submitButton.disabled = true;
    submitButton.textContent = 'Prüfe…';
  }
  try {
    const result = await window.api.runHealthCheck({ hosters: [{ hoster: found.name, accountId, otp }] });
    const row = result && Array.isArray(result.results)
      ? result.results.find(item => item.accountId === accountId)
      : null;
    accountStatuses[accountId] = row
      ? { status: row.status || 'error', message: row.message || '' }
      : { status: 'error', message: 'Keine Antwort vom Hoster erhalten' };
  } catch (err) {
    accountStatuses[accountId] = { status: 'error', message: err.message || 'OTP-Prüfung fehlgeschlagen' };
  } finally {
    healthCheckRunning = false;
    updateAccountCard(accountId);
    renderHosterModal();
  }
}

// Per-hoster overrides for the login form. VOE only accepts emails — the
// generic "Username / E-Mail" label sent users down a confusing rabbit hole
// (login fails → upload fetches login redirect → "CSRF token nicht gefunden").
// Other hosters that genuinely accept either keep the generic wording.
const LOGIN_FIELD_LABELS = {
  'voe.sx': { label: 'E-Mail', placeholder: 'E-Mail-Adresse', inputType: 'email' }
};

function getCredsFieldsHtml(authType, account, hoster) {
  account = account || {};
  if (authType === 'login') {
    const fld = (hoster && LOGIN_FIELD_LABELS[hoster]) || {
      label: 'Username / E-Mail', placeholder: 'Username oder E-Mail', inputType: 'text'
    };
    return `
      <div class="settings-row">
        <label for="accField_username">${escapeHtml(fld.label)}</label>
        <input type="${fld.inputType}" class="key-input" id="accField_username" name="username" autocomplete="username" spellcheck="false" value="${escapeAttr(account.username || '')}" placeholder="${escapeAttr(fld.placeholder)}">
      </div>
      <div class="settings-row">
        <label for="accField_password">Passwort</label>
        <input type="password" class="key-input" id="accField_password" name="password" autocomplete="current-password" value="${escapeAttr(account.password || '')}" placeholder="Passwort">
        <button class="toggle-vis" type="button" title="Passwort anzeigen" aria-label="Passwort anzeigen" aria-pressed="false">&#128065;</button>
      </div>`;
  }
  // API key
  return `
    <div class="settings-row">
      <label for="accField_apiKey">API-Key</label>
      <input type="password" class="key-input" id="accField_apiKey" name="apiKey" autocomplete="off" spellcheck="false" value="${escapeAttr(account.apiKey || '')}" placeholder="API-Key">
      <button class="toggle-vis" type="button" title="API-Key anzeigen" aria-label="API-Key anzeigen" aria-pressed="false">&#128065;</button>
    </div>`;
}

function wireCredentialVisibilityButtons(container) {
  container.querySelectorAll('.toggle-vis').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = btn.previousElementSibling;
      const visible = input.type === 'password';
      const fieldName = input.id === 'accField_apiKey' ? 'API-Key' : 'Passwort';
      input.type = visible ? 'text' : 'password';
      btn.setAttribute('aria-pressed', String(visible));
      btn.setAttribute('aria-label', `${fieldName} ${visible ? 'verbergen' : 'anzeigen'}`);
      btn.title = `${fieldName} ${visible ? 'verbergen' : 'anzeigen'}`;
    });
  });
}

let _accountModalReturnFocus = null;

function openAccountModal(editAccountId) {
  _accountModalReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  editingAccountId = editAccountId || null;
  _resetAccountModalState();
  const modal = document.getElementById('accountModal');
  const title = document.getElementById('accountModalTitle');
  const subtitle = document.getElementById('accountModalSubtitle');
  const hosterRow = document.getElementById('accountHosterRow');
  const hosterSelect = document.getElementById('accountHosterSelect');
  const credsContainer = document.getElementById('accountCredsFields');
  const statusEl = document.getElementById('accountModalStatus');
  const saveBtn = document.getElementById('saveAccountBtn');
  const labelInput = document.getElementById('accField_label');

  statusEl.textContent = '';
  statusEl.className = 'account-modal-status';

  if (editingAccountId) {
    // Edit mode
    const found = findAccountById(editingAccountId);
    if (!found) return;
    title.textContent = 'Account bearbeiten';
    subtitle.textContent = `Zugangsdaten für ${getAccountDisplayName(found.name, found.account)} bearbeiten und prüfen.`;
    hosterRow.style.display = 'none';
    saveBtn.textContent = window.AccountSubmit.getAccountSubmitLabel({ isEdit: true });
    if (labelInput) labelInput.value = found.account.label || '';
    credsContainer.innerHTML = getCredsFieldsHtml(found.account.authType || 'login', found.account, found.name);
  } else {
    // Add mode — always show all options (multiple accounts per hoster allowed)
    title.textContent = 'Account hinzufügen';
    subtitle.textContent = 'Wähle einen Hoster und gib deine Zugangsdaten ein. Der Account wird vor dem Anlegen geprüft.';
    hosterRow.style.display = 'flex';
    saveBtn.textContent = window.AccountSubmit.getAccountSubmitLabel({ isEdit: false });
    hosterSelect.innerHTML = HOSTER_ADD_OPTIONS.map(opt =>
      `<option value="${opt.value}">${escapeHtml(opt.label)}</option>`
    ).join('');
    const firstOpt = HOSTER_ADD_OPTIONS[0];
    if (labelInput) labelInput.value = '';
    credsContainer.innerHTML = getCredsFieldsHtml(firstOpt.authType, {}, firstOpt.value);
  }

  wireCredentialVisibilityButtons(credsContainer);

  _wireCredFieldInvalidation();

  modal.style.display = 'flex';
  requestAnimationFrame(() => {
    const firstControl = editingAccountId
      ? document.getElementById('accField_label')
      : hosterSelect;
    if (firstControl) firstControl.focus();
  });
}

function closeAccountModal() {
  document.getElementById('accountModal').style.display = 'none';
  _hideOtpField();
  editingAccountId = null;
  _resetAccountModalState();
  const returnFocus = _accountModalReturnFocus;
  _accountModalReturnFocus = null;
  const focusTarget = returnFocus && returnFocus.isConnected
    ? returnFocus
    : document.getElementById('addAccountBtn');
  if (focusTarget) focusTarget.focus();
}

function openDeleteAccountModal(accountId) {
  const found = findAccountById(accountId);
  if (!found) return;
  const modal = document.getElementById('deleteAccountModal');
  const msg = document.getElementById('deleteAccountMessage');
  msg.textContent = `Account "${getAccountDisplayName(found.name, found.account)}" wirklich löschen?`;
  modal.dataset.accountId = accountId;
  modal.style.display = 'flex';
}

function closeDeleteModal() {
  document.getElementById('deleteAccountModal').style.display = 'none';
}

async function deleteAccount(accountId) {
  const found = findAccountById(accountId);
  if (!found) return;
  // Remove account from the array
  const accounts = config.hosters[found.name];
  if (Array.isArray(accounts)) {
    config.hosters[found.name] = accounts.filter(a => a.id !== accountId);
  }
  delete accountStatuses[accountId];
  // saveConfig is async — close the modal immediately so the UI feels
  // responsive instead of waiting for the atomic write + safeStorage encrypt.
  // The in-memory config already reflects the delete; the IPC just persists it.
  closeDeleteModal();
  ensureAccountStatusEntries();
  syncSelectedUploadHosters();
  if (getAllAccountsFlat().length === 0) renderHealthCheckResults([]);
  renderAccounts();
  renderHosterSummary();
  // Fire-and-forget the persist. The earlier `await getConfig()` round-trip
  // was redundant (we already have the truth in memory) and was the main
  // source of perceived lag on add/delete.
  saveConfigTracked({ hosters: config.hosters }).catch((err) => {
    if (window.api && window.api.debugLog) window.api.debugLog(`deleteAccount saveConfig failed: ${err && err.message ? err.message : err}`);
    showCopyToast('Account-Löschung konnte nicht persistiert werden — bitte erneut versuchen.');
  });
}

function readAccountCredsFromModal(authType) {
  const label = (document.getElementById('accField_label')?.value || '').trim();
  if (authType === 'login') {
    const username = (document.getElementById('accField_username')?.value || '').trim();
    const password = (document.getElementById('accField_password')?.value || '').trim();
    return { enabled: !!(username && password), authType: 'login', username, password, label };
  }
  // API
  const apiKey = (document.getElementById('accField_apiKey')?.value || '').trim();
  return { enabled: !!apiKey, authType: 'api', apiKey, label };
}

const _accountSubmitter = window.AccountSubmit.createAccountSubmitter();
let _accountModalCommitLocked = false;
let _autoCloseTimer = null;
let _accountModalSession = 0;

function _resetAccountModalState() {
  _accountModalSession++;
  _accountModalCommitLocked = false;
  if (_autoCloseTimer) { clearTimeout(_autoCloseTimer); _autoCloseTimer = null; }
  _syncAccountSubmitButton();
}

function _credsSnapshotKey(authType, creds) {
  if (authType === 'login') return `login:${creds.username || ''}:${creds.password || ''}`;
  return `api:${creds.apiKey || ''}`;
}

function _defaultAccountSubmitButtonText(ctx) {
  return window.AccountSubmit.getAccountSubmitLabel({ isEdit: !!(ctx && ctx.isEdit) });
}

function _syncAccountSubmitButton() {
  const saveBtn = document.getElementById('saveAccountBtn');
  if (!saveBtn) return;
  saveBtn.textContent = _defaultAccountSubmitButtonText(_determineHosterContext());
  saveBtn.disabled = _accountSubmitter.isBusy() || _accountModalCommitLocked;
}

function _invalidateAccountSubmit() {
  _accountModalSession++;
  const statusEl = document.getElementById('accountModalStatus');
  if (statusEl) {
    statusEl.textContent = '';
    statusEl.className = 'account-modal-status';
  }
  const saveBtn = document.getElementById('saveAccountBtn');
  if (saveBtn && !_accountSubmitter.isBusy() && !_accountModalCommitLocked) {
    saveBtn.disabled = false;
    saveBtn.textContent = _defaultAccountSubmitButtonText(_determineHosterContext());
  }
}

function _wireCredFieldInvalidation() {
  const ids = ['accField_username', 'accField_password', 'accField_apiKey'];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el || el.dataset.invalidateBound === '1') continue;
    el.addEventListener('input', _invalidateAccountSubmit);
    el.dataset.invalidateBound = '1';
  }
}

function _determineHosterContext() {
  if (editingAccountId) {
    const found = findAccountById(editingAccountId);
    if (!found) return null;
    return { hosterName: found.name, authType: found.account.authType || 'login', accountId: editingAccountId, isEdit: true };
  }
  const selectValue = document.getElementById('accountHosterSelect')?.value;
  if (!selectValue) return null;
  const opt = HOSTER_ADD_OPTIONS.find(o => o.value === selectValue);
  if (!opt) return null;
  return { hosterName: opt.hoster, authType: opt.authType, accountId: null, isEdit: false };
}

function _isAccountSubmitCurrent(session, ctx, snapshotKey) {
  if (session !== _accountModalSession) return false;
  const currentCtx = _determineHosterContext();
  if (!currentCtx) return false;
  if (currentCtx.hosterName !== ctx.hosterName || currentCtx.authType !== ctx.authType) return false;
  if (currentCtx.accountId !== ctx.accountId || currentCtx.isEdit !== ctx.isEdit) return false;
  const currentCreds = readAccountCredsFromModal(currentCtx.authType);
  return _credsSnapshotKey(currentCtx.authType, currentCreds) === snapshotKey;
}

async function saveAccount() {
  if (_accountSubmitter.isBusy() || _accountModalCommitLocked) return;

  const ctx = _determineHosterContext();
  if (!ctx) return;
  const creds = readAccountCredsFromModal(ctx.authType);
  const statusEl = document.getElementById('accountModalStatus');
  const saveBtn = document.getElementById('saveAccountBtn');
  if (!creds.enabled) {
    statusEl.textContent = 'Bitte Zugangsdaten eingeben.';
    statusEl.className = 'account-modal-status error';
    return;
  }

  const snapshotKey = _credsSnapshotKey(ctx.authType, creds);
  const mySession = _accountModalSession;
  const otpInput = document.getElementById('accField_otp');
  const otp = otpInput ? otpInput.value.trim() : '';
  const payload = {
    hoster: ctx.hosterName,
    authType: ctx.authType,
    username: creds.username || '',
    password: creds.password || '',
    apiKey: creds.apiKey || '',
    otp
  };

  const submission = _accountSubmitter.submit({
    validate: () => window.api.validateCredentials(payload),
    commit: () => _persistAccount(ctx, creds),
    afterCommit: (persisted, validation) => _applyCommittedAccount(persisted, validation),
    isCurrent: () => _isAccountSubmitCurrent(mySession, ctx, snapshotKey)
  });
  if (!submission) return;
  saveBtn.disabled = true;
  saveBtn.textContent = _defaultAccountSubmitButtonText(ctx);
  statusEl.textContent = 'Prüfe Zugangsdaten…';
  statusEl.className = 'account-modal-status checking';

  let result;
  try {
    result = await submission;
  } catch (error) {
    result = { status: 'error', error };
  }

  const current = _isAccountSubmitCurrent(mySession, ctx, snapshotKey);
  if (result.status === 'committed' && current) {
    _accountModalCommitLocked = true;
    const validation = result.validation || {};
    statusEl.textContent = validation.status === 'warn'
      ? validation.message || 'Account wurde mit Warnung geprüft und gespeichert.'
      : validation.message || 'Account wurde erfolgreich geprüft und gespeichert.';
    statusEl.className = 'account-modal-status ok';
    _hideOtpField();
    saveBtn.textContent = _defaultAccountSubmitButtonText(ctx);
    saveBtn.disabled = true;
    if (_autoCloseTimer) clearTimeout(_autoCloseTimer);
    _autoCloseTimer = setTimeout(() => {
      _autoCloseTimer = null;
      closeAccountModal();
    }, 600);
    return;
  }

  _syncAccountSubmitButton();
  if (!current) return;

  if (result.status === 'otp_required') {
    const validation = result.validation || {};
    statusEl.textContent = validation.message || 'OTP wurde an deine E-Mail gesendet.';
    statusEl.className = 'account-modal-status error';
    _showOtpField();
    saveBtn.textContent = _defaultAccountSubmitButtonText(ctx);
    return;
  }

  const validation = result.validation || {};
  const msg = result.status === 'error'
    ? (result.error && result.error.message) || 'Prüfung oder Speichern fehlgeschlagen'
    : validation.message || 'Login fehlgeschlagen';
  statusEl.textContent = msg;
  statusEl.className = 'account-modal-status error';
}

function _copyHosterTree(hosters) {
  const candidate = {};
  for (const [name, accounts] of Object.entries(hosters || {})) {
    candidate[name] = Array.isArray(accounts) ? accounts.map(account => ({ ...account })) : accounts;
  }
  return candidate;
}

async function _persistAccount(ctx, creds) {
  const candidateHosters = _copyHosterTree(config.hosters);
  if (!Array.isArray(candidateHosters[ctx.hosterName])) candidateHosters[ctx.hosterName] = [];
  let accountId = ctx.accountId;
  if (ctx.isEdit) {
    const idx = candidateHosters[ctx.hosterName].findIndex(account => account.id === accountId);
    if (idx < 0) throw new Error('Account nicht mehr in der Config — wurde extern gelöscht. Modal schließen und neu anlegen.');
    candidateHosters[ctx.hosterName][idx] = { ...candidateHosters[ctx.hosterName][idx], ...creds };
  } else {
    accountId = `${ctx.hosterName}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    candidateHosters[ctx.hosterName].push({ id: accountId, ...creds });
  }
  await saveConfigTracked({ hosters: candidateHosters });
  return { accountId, candidateHosters, isEdit: ctx.isEdit };
}

function _applyCommittedAccount(persisted, validation) {
  const { accountId, candidateHosters, isEdit } = persisted;
  config.hosters = candidateHosters;
  accountStatuses[accountId] = { status: validation.status, message: validation.message || '' };
  ensureAccountStatusEntries();
  syncSelectedUploadHosters();
  if (isEdit) {
    updateAccountCard(accountId);
  } else {
    renderAccounts();
  }
  renderHosterSummary();
}

function _showOtpField() {
  if (document.getElementById('accField_otp')) return; // already visible
  const container = document.getElementById('accountCredsFields');
  const otpHtml = `
    <div class="settings-row" id="otpFieldRow">
      <label>OTP Code</label>
      <input type="text" class="key-input" id="accField_otp" placeholder="6-stelliger Code aus E-Mail" autocomplete="one-time-code" inputmode="numeric" maxlength="10">
    </div>`;
  container.insertAdjacentHTML('beforeend', otpHtml);
  // Auto-focus the OTP field
  setTimeout(() => document.getElementById('accField_otp')?.focus(), 50);
}

function _hideOtpField() {
  const row = document.getElementById('otpFieldRow');
  if (row) row.remove();
}

// --- History ---
let historyRetentionMenuToken = 0;

function syncHistoryRetentionPicker() {
  const select = document.getElementById('historyRetentionSelect');
  const value = document.getElementById('historyRetentionValue');
  const menu = document.getElementById('historyRetentionMenu');
  if (!select || !value || !menu) return;
  const labels = {
    all: 'Alles behalten',
    '7d': 'Letzte 7 Tage',
    '30d': 'Letzte 30 Tage',
    '90d': 'Letzte 90 Tage',
    '1000': 'Letzte 1000 Uploads',
    '100': 'Letzte 100 Uploads'
  };
  value.textContent = labels[select.value] || labels.all;
  menu.querySelectorAll('[data-history-retention]').forEach(option => {
    const selected = option.dataset.historyRetention === select.value;
    option.setAttribute('aria-selected', String(selected));
    option.tabIndex = selected ? 0 : -1;
  });
}

function openHistoryRetentionMenu(focusOption = false) {
  const trigger = document.getElementById('historyRetentionTrigger');
  const menu = document.getElementById('historyRetentionMenu');
  if (!trigger || !menu) return;
  historyRetentionMenuToken++;
  menu.classList.remove('menu-closing', 'menu-opening');
  menu.style.display = 'block';
  void menu.offsetHeight;
  menu.classList.add('menu-opening');
  trigger.setAttribute('aria-expanded', 'true');
  if (focusOption) {
    window.requestAnimationFrame(() => menu.querySelector('[aria-selected="true"]')?.focus());
  }
}

function closeHistoryRetentionMenu(returnFocus = false) {
  const trigger = document.getElementById('historyRetentionTrigger');
  const menu = document.getElementById('historyRetentionMenu');
  if (!trigger || !menu || window.getComputedStyle(menu).display === 'none') return;
  const token = ++historyRetentionMenuToken;
  menu.classList.remove('menu-opening', 'menu-closing');
  void menu.offsetHeight;
  menu.classList.add('menu-closing');
  trigger.setAttribute('aria-expanded', 'false');
  const finish = () => {
    if (!Object.is(historyRetentionMenuToken, token)) return;
    menu.style.display = 'none';
    menu.classList.remove('menu-closing');
    if (returnFocus) trigger.focus();
  };
  menu.addEventListener('animationend', finish, { once: true });
  window.setTimeout(finish, 220);
}

function selectHistoryRetentionOption(value) {
  const select = document.getElementById('historyRetentionSelect');
  if (!select || !select.querySelector(`option[value="${value}"]`)) return;
  select.value = value;
  syncHistoryRetentionPicker();
  closeHistoryRetentionMenu(true);
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
}

function syncHistoryClearAction() {
  const button = document.getElementById('clearHistoryBtn');
  if (button) button.disabled = historyRowsData.length === 0;
}

function closeHistoryClearModal() {
  const modal = document.getElementById('historyClearModal');
  if (!modal) return;
  modal.style.display = 'none';
  modal.setAttribute('aria-hidden', 'true');
  document.getElementById('clearHistoryBtn')?.focus();
}

function openHistoryClearModal() {
  const button = document.getElementById('clearHistoryBtn');
  const modal = document.getElementById('historyClearModal');
  if (!modal || !button || button.disabled) return;
  modal.style.display = 'flex';
  modal.setAttribute('aria-hidden', 'false');
  document.getElementById('confirmHistoryClearBtn')?.focus();
}

async function confirmHistoryClear() {
  const confirmButton = document.getElementById('confirmHistoryClearBtn');
  const cancelButton = document.getElementById('cancelHistoryClearBtn');
  if (!confirmButton || confirmButton.disabled) return;
  confirmButton.disabled = true;
  cancelButton.disabled = true;
  try {
    await runConfigWrite(() => window.api.clearHistory());
    await loadHistory();
    closeHistoryClearModal();
  } catch (error) {
    showCopyToast(error.message || String(error));
  } finally {
    confirmButton.disabled = false;
    cancelButton.disabled = false;
  }
}

async function loadHistory() {
  const history = await window.api.getHistory();
  window._historyForStats = history || [];
  _historyEverLoaded = true;
  _historyDirty = false;
  _invalidateHosterLifetimeCache();
  const retSel = document.getElementById('historyRetentionSelect');
  if (retSel) {
    retSel.value = (config.globalSettings && config.globalSettings.historyRetention) || 'all';
    syncHistoryRetentionPicker();
  }
  const container = document.getElementById('historyContainer');

  if (!history || history.length === 0) {
    historyRowsData = [];
    historySidebarCounts = { total: 0, success: 0, error: 0 };
    updateHistorySidebarSummary();
    syncHistoryClearAction();
    container.innerHTML = '<p class="empty-state">Noch keine Uploads.</p>';
    return;
  }

  historySortState = { key: 'date', direction: 'desc' };
  historyRowsData = [];
  historySidebarCounts = { total: 0, success: 0, error: 0 };
  let order = 0;

  for (const batch of history) {
    const dt = formatDateTime(batch.timestamp || new Date());
    for (const file of (batch.files || [])) {
      for (const result of (file.results || [])) {
        historySidebarCounts.total++;
        const isError = result.status === 'aborted' || result.status === 'error';
        if (isError) historySidebarCounts.error++;
        else historySidebarCounts.success++;
        const detail = isError
          ? String(result.error || result.message || (result.status === 'aborted' ? 'Abgebrochen' : 'Fehlgeschlagen'))
          : (result.download_url || result.embed_url || '');
        historyRowsData.push({
          date: dt.text, dateTs: dt.ts,
          filename: file.name || '', host: result.hoster || '',
          link: detail,
          isError, order: order++
        });
      }
    }
  }

  updateHistorySidebarSummary();
  syncHistoryClearAction();
  renderHistoryTable(container);
}

async function exportHistory() {
  const history = await window.api.getHistory();
  if (!history || history.length === 0) {
    alert('Kein Verlauf zum Exportieren vorhanden.');
    return;
  }

  const asCsv = confirm('Verlauf als CSV exportieren?\n\nOK = CSV\nAbbrechen = JSON');
  const format = asCsv ? 'csv' : 'json';
  const result = await window.api.exportHistory(format);

  if (!result || result.canceled) return;
  if (!result.ok) {
    alert(result.error || 'Export fehlgeschlagen.');
    return;
  }

  showCopyToast(`Verlauf exportiert (${result.totalRows || 0} Zeilen)`);
}

// Memoize sort result: invalidated only when data length changes or sort state changes.
// Selection changes and re-renders reuse the cached sorted array — a big win when
// the panel has thousands of rows and the sort is stable.
let _recentSortCache = { sig: '', result: [] };

function sortRecentFiles(data) {
  const { key, direction } = recentSortState;
  const sig = `${key}|${direction}|${data.length}|${_recentDataVersion}`;
  if (_recentSortCache.sig === sig) return _recentSortCache.result;

  const sorted = data.slice();
  const dir = direction === 'asc' ? 1 : -1;
  sorted.sort((a, b) => {
    if (key === 'date') return dir * ((a.dateTs - b.dateTs) || (a.order - b.order));
    if (key === 'filename') return dir * _collatorDE.compare(a.filename, b.filename);
    if (key === 'host') return dir * _collatorDE.compare(a.host, b.host);
    if (key === 'link') return dir * _collatorDE.compare(a.link, b.link);
    return 0;
  });
  _recentSortCache = { sig, result: sorted };
  return sorted;
}

function updateRecentSortHeaders() {
  const head = document.getElementById('recentFilesHead');
  if (!head) return;
  head.querySelectorAll('th[data-recent-sort]').forEach(th => {
    const key = th.dataset.recentSort;
    const active = recentSortState.key === key;
    const arrow = active ? (recentSortState.direction === 'asc' ? '▲' : '▼') : '↕';
    th.classList.toggle('active', active);
    const indicator = th.querySelector('.sort-indicator');
    if (indicator) indicator.textContent = arrow;
  });
}

let _recentListenersBound = false;

function _buildRecentRowHtml(row) {
  const cls = `recent-file-row${row.isError ? ' error' : ''}${selectedRecentIds.has(row.order) ? ' selected' : ''}`;
  return `<tr class="${cls}" data-order="${row.order}" data-link="${escapeAttr(row.link)}">`
    + `<td>${escapeHtml(row.date)}</td>`
    + `<td title="${escapeAttr(row.filename)}">${escapeHtml(row.filename)}</td>`
    + `<td>${escapeHtml(row.host)}</td>`
    + `<td title="${escapeAttr(row.link)}">${escapeHtml(row.link)}</td>`
    + `</tr>`;
}

// Tracks the last rendered dataset so we can append-only when the user is just
// accumulating new uploads (the default case: sort=date desc, rows only grow).
let _recentLastRenderedSig = '';
let _recentLastRenderedLen = 0;
let _recentPendingAppends = 0;
let _recentWorking = [];
let _recentLastRange = { start: -1, end: -1 };
let _recentScrollQueued = false;

function _onRecentScroll() {
  if (_recentScrollQueued) return;
  _recentScrollQueued = true;
  requestAnimationFrame(() => { _recentScrollQueued = false; _renderRecentVirtualRows(); });
}

function _renderRecentVirtualRows() {
  const wrap = document.querySelector('.recent-files-table-wrap');
  const tbody = document.getElementById('recentFilesBody');
  if (!wrap || !tbody) return;
  const total = _recentWorking.length;
  if (!total) return;
  const scrollTop = wrap.scrollTop;
  const viewportHeight = Math.max(wrap.clientHeight, 400);
  const startIdx = Math.max(0, Math.floor(scrollTop / VIRTUAL_ROW_HEIGHT) - VIRTUAL_OVERSCAN);
  const endIdx = Math.min(total, Math.ceil((scrollTop + viewportHeight) / VIRTUAL_ROW_HEIGHT) + VIRTUAL_OVERSCAN);
  if (startIdx === _recentLastRange.start && endIdx === _recentLastRange.end) return;
  _recentLastRange = { start: startIdx, end: endIdx };
  const topPad = startIdx * VIRTUAL_ROW_HEIGHT;
  const bottomPad = Math.max(0, (total - endIdx) * VIRTUAL_ROW_HEIGHT);
  const parts = [];
  if (topPad > 0) parts.push(`<tr class="virtual-spacer" style="height:${topPad}px"><td colspan="4"></td></tr>`);
  for (let i = startIdx; i < endIdx; i++) parts.push(_buildRecentRowHtml(_recentWorking[i]));
  if (bottomPad > 0) parts.push(`<tr class="virtual-spacer" style="height:${bottomPad}px"><td colspan="4"></td></tr>`);
  tbody.innerHTML = parts.join('');
}

function renderRecentUploadsPanel(appendOnly = false) {
  const tbody = document.getElementById('recentFilesBody');
  if (!tbody) return;
  _recentPendingAppends = 0;
  const wrap = tbody.closest('.recent-files-table-wrap');

  if (!sessionFilesData.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-state">Noch keine Uploads in dieser Session.</td></tr>';
    _recentWorking = [];
    _recentLastRange = { start: -1, end: -1 };
  } else {
    const prevLen = _recentWorking.length;
    _recentWorking = sortRecentFiles(sessionFilesData);
    _recentLastRange = { start: -1, end: -1 };
    const sig = `${recentSortState.key}|${recentSortState.direction}`;
    if (wrap) {
      const added = _recentWorking.length - prevLen;
      if (sig === 'date|desc' && wrap.scrollTop <= 48) wrap.scrollTop = 0;
      else if (sig === 'date|desc' && added > 0) wrap.scrollTop += added * VIRTUAL_ROW_HEIGHT;
    }
    _renderRecentVirtualRows();
  }

  // Event delegation – bind once, not per-row
  if (!_recentListenersBound) {
    _recentListenersBound = true;
    if (wrap) {
      wrap.addEventListener('scroll', _onRecentScroll, { passive: true });
      if (typeof window.ResizeObserver !== 'undefined') new window.ResizeObserver(_onRecentScroll).observe(wrap);
    }
    tbody.addEventListener('click', (e) => {
      const tr = e.target.closest('.recent-file-row');
      if (!tr) return;
      // Clear queue selection when clicking in recent panel — class-toggle only.
      if (selectedJobIds.size > 0) { selectedJobIds.clear(); applyQueueSelectionClasses(); updateQueueActionButtons(); }
      const id = parseInt(tr.dataset.order, 10);
      if (e.ctrlKey || e.metaKey) {
        if (selectedRecentIds.has(id)) selectedRecentIds.delete(id);
        else selectedRecentIds.add(id);
      } else if (e.shiftKey && selectedRecentIds.size > 0) {
        // Reuse the already-sorted array from the sort cache instead of
        // querying every .recent-file-row in the DOM (O(visible) vs O(N)
        // on large panels).
        const sortedOrders = (_recentSortCache.result || sortRecentFiles(sessionFilesData))
          .map(r => r.order);
        const lastIdx = sortedOrders.findIndex(o => selectedRecentIds.has(o));
        const curIdx = sortedOrders.indexOf(id);
        if (lastIdx >= 0 && curIdx >= 0) {
          const from = Math.min(lastIdx, curIdx);
          const to = Math.max(lastIdx, curIdx);
          for (let i = from; i <= to; i++) selectedRecentIds.add(sortedOrders[i]);
        }
      } else {
        selectedRecentIds.clear();
        selectedRecentIds.add(id);
      }
      // Selection change — toggle classes, no tbody rebuild.
      applyRecentSelectionClasses();
    });

    tbody.addEventListener('dblclick', (e) => {
      const tr = e.target.closest('.recent-file-row');
      if (!tr || tr.classList.contains('error')) return;
      const link = tr.dataset.link;
      if (link) { window.api.copyToClipboard(link); showCopyToast('Link kopiert'); }
    });
  }

  updateRecentSortHeaders();
}

const HISTORY_RENDER_CAP = 2000;
let _historyWorking = [];
let _historyLastRange = { start: -1, end: -1 };
let _historyListenersBound = false;
let _historyScrollQueued = false;

function _onHistoryScroll() {
  if (_historyScrollQueued) return;
  _historyScrollQueued = true;
  requestAnimationFrame(() => { _historyScrollQueued = false; _renderHistoryVirtualRows(); });
}

function _renderHistoryVirtualRows() {
  const container = document.getElementById('historyContainer');
  const tbody = document.getElementById('historyBody');
  if (!container || !tbody) return;
  const total = _historyWorking.length;
  const scrollTop = container.scrollTop;
  const viewportHeight = Math.max(container.clientHeight, 600);
  const startIdx = Math.max(0, Math.floor(scrollTop / VIRTUAL_ROW_HEIGHT) - VIRTUAL_OVERSCAN);
  const endIdx = Math.min(total, Math.ceil((scrollTop + viewportHeight) / VIRTUAL_ROW_HEIGHT) + VIRTUAL_OVERSCAN);
  if (startIdx === _historyLastRange.start && endIdx === _historyLastRange.end) return;
  _historyLastRange = { start: startIdx, end: endIdx };
  const topPad = startIdx * VIRTUAL_ROW_HEIGHT;
  const bottomPad = Math.max(0, (total - endIdx) * VIRTUAL_ROW_HEIGHT);
  const parts = [];
  if (topPad > 0) parts.push(`<tr class="virtual-spacer" style="height:${topPad}px"><td colspan="4"></td></tr>`);
  for (let i = startIdx; i < endIdx; i++) {
    const row = _historyWorking[i];
    const link = row.link || '';
    parts.push('<tr class="history-row');
    if (row.isError) parts.push(' error');
    parts.push('" data-link="');
    parts.push(escapeAttr(link));
    parts.push(`" style="height:${VIRTUAL_ROW_HEIGHT}px"><td class="col-date">`);
    parts.push(escapeHtml(row.date));
    parts.push('</td><td class="col-filename">');
    parts.push(escapeHtml(row.filename));
    parts.push('</td><td class="col-host">');
    parts.push(escapeHtml(row.host));
    parts.push('</td><td class="col-link"><div class="history-link-cell"><span class="history-link-text" title="');
    parts.push(escapeAttr(link));
    parts.push('">');
    parts.push(escapeHtml(link));
    parts.push('</span><button class="history-copy-link" type="button" data-copy-link aria-label="Link kopieren" title="Link kopieren">⧉</button></div></td></tr>');
  }
  if (bottomPad > 0) parts.push(`<tr class="virtual-spacer" style="height:${bottomPad}px"><td colspan="4"></td></tr>`);
  tbody.innerHTML = parts.join('');
}

function _getVisibleHistoryRows() {
  if (historySidebarFilter === 'success') return historyRowsData.filter(row => !row.isError);
  if (historySidebarFilter === 'error') return historyRowsData.filter(row => row.isError);
  return historyRowsData;
}

function renderHistoryTable(container) {
  const visibleRows = _getVisibleHistoryRows();
  if (!container || !visibleRows.length) {
    if (container) container.innerHTML = '<p class="empty-state">Noch keine Uploads.</p>';
    const emptyNotice = document.getElementById('historyCapNotice');
    if (emptyNotice) emptyNotice.style.display = 'none';
    _historyWorking = [];
    return;
  }

  const total = visibleRows.length;
  const working = total > HISTORY_RENDER_CAP ? visibleRows.slice(-HISTORY_RENDER_CAP) : visibleRows;
  const notice = document.getElementById('historyCapNotice');
  if (notice) {
    if (total > HISTORY_RENDER_CAP) {
      notice.style.display = '';
      notice.textContent = `Zeige neueste ${HISTORY_RENDER_CAP.toLocaleString(getUiLocale())} von ${total.toLocaleString(getUiLocale())} Einträgen. Der vollständige Verlauf bleibt gespeichert und ist über „Verlauf exportieren“ verfügbar.`;
    } else {
      notice.style.display = 'none';
    }
  }

  _historyWorking = sortHistoryRows(working);
  _historyLastRange = { start: -1, end: -1 };
  const headerCell = (key, label) => {
    const active = historySortState.key === key;
    const dir = active ? (historySortState.direction === 'asc' ? '▲' : '▼') : '↕';
    return `<th class="sortable${active ? ' active' : ''}" data-history-sort="${key}">${label}<span class="sort-indicator">${dir}</span></th>`;
  };

  container.innerHTML = `<table class="results-table history-table"><thead><tr>
    ${headerCell('date', 'Datum')}${headerCell('filename', 'Dateiname')}${headerCell('host', 'Hoster')}${headerCell('link', 'Link')}
  </tr></thead><tbody id="historyBody"></tbody></table>`;

  if (!_historyListenersBound) {
    _historyListenersBound = true;
    container.addEventListener('scroll', _onHistoryScroll, { passive: true });
    if (typeof window.ResizeObserver !== 'undefined') new window.ResizeObserver(_onHistoryScroll).observe(container);
    container.addEventListener('click', (e) => {
      const th = e.target.closest('th.sortable');
      if (th && container.contains(th)) {
        const key = th.dataset.historySort;
        const defaultDir = key === 'date' ? 'desc' : 'asc';
        if (!_historySortClicked || historySortState.key !== key) {
          _historySortClicked = true;
          historySortState.key = key;
          historySortState.direction = defaultDir;
        } else {
          historySortState.direction = historySortState.direction === 'asc' ? 'desc' : 'asc';
        }
        container.scrollTop = 0;
        renderHistoryTable(container);
        return;
      }
      const copyButton = e.target.closest('.history-copy-link');
      if (copyButton && container.contains(copyButton)) {
        const link = copyButton.closest('.history-row')?.dataset.link;
        if (link) { window.api.copyToClipboard(link); showCopyToast('Link kopiert'); }
        e.stopPropagation();
        return;
      }
      const row = e.target.closest('.history-row');
      if (row && !row.classList.contains('error')) {
        const link = row.dataset.link;
        if (link) { window.api.copyToClipboard(link); showCopyToast('Link kopiert'); }
      }
    });
  }

  _renderHistoryVirtualRows();
}

function sortHistoryRows(rows) {
  const { key, direction } = historySortState;
  const factor = direction === 'asc' ? 1 : -1;
  return rows.slice().sort((a, b) => {
    const cmp = key === 'date' ? a.dateTs - b.dateTs : _collatorDE.compare(String(a[key] || ''), String(b[key] || ''));
    return (cmp || a.order - b.order) * factor;
  });
}

let closePreparationPromise = null;
let closePreparationInertState = [];
let closePreparationOverlayState = null;
let closePreparationGeneration = 0;
let activeClosePreparationAttempt = null;
const CLOSE_PREPARATION_TIMEOUT_MS = 1200;

function waitForClosePreparationStep(promise) {
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Speichern vor dem Beenden hat zu lange gedauert')), CLOSE_PREPARATION_TIMEOUT_MS))
  ]);
}

function setClosePreparationUi(active) {
  const overlay = document.getElementById('shutdownOverlay');
  const message = document.getElementById('shutdownMessage');
  const cancelButton = document.getElementById('cancelShutdownBtn');
  if (!overlay || !message || !cancelButton) return;
  if (active) {
    if (closePreparationOverlayState) return;
    closePreparationOverlayState = {
      display: overlay.style.display,
      message: message.innerHTML,
      cancelDisplay: cancelButton.style.display
    };
    closePreparationInertState = Array.from(document.body.children)
      .filter(element => element !== overlay && 'inert' in element)
      .map(element => ({ element, inert: element.inert }));
    closePreparationInertState.forEach(({ element }) => { element.inert = true; });
    message.textContent = 'Einstellungen werden gespeichert…';
    cancelButton.style.display = 'none';
    overlay.style.display = 'flex';
    return;
  }
  closePreparationInertState.forEach(({ element, inert }) => {
    if (element.isConnected) element.inert = inert;
  });
  closePreparationInertState = [];
  overlay.style.display = closePreparationOverlayState ? closePreparationOverlayState.display : 'none';
  message.innerHTML = closePreparationOverlayState ? closePreparationOverlayState.message : '';
  cancelButton.style.display = closePreparationOverlayState ? closePreparationOverlayState.cancelDisplay : '';
  closePreparationOverlayState = null;
}

function isCurrentClosePreparation(generation, attempt) {
  return generation === closePreparationGeneration && attempt === activeClosePreparationAttempt;
}

async function recoverWindowClose(generation, attempt, originalError) {
  if (!isCurrentClosePreparation(generation, attempt)) return;
  closePreparationState = 'recovering';
  let restored = false;
  try {
    restored = await waitForClosePreparationStep(window.api.finishClosePreparation({ ready: false, attempt }));
  } catch (error) {
    if (isCurrentClosePreparation(generation, attempt)) showCopyToast(error.message || String(error), 8000);
    return;
  }
  if (!isCurrentClosePreparation(generation, attempt)) return;
  if (restored !== true) {
    showCopyToast('Die Anwendung konnte nach dem fehlgeschlagenen Speichern nicht entsperrt werden', 8000);
    return;
  }
  try {
    await waitForClosePreparationStep(withCloseWriteAccess(async () => {
      await flushConfigWrites();
      if (!isCurrentClosePreparation(generation, attempt)) return;
      await persistQueueStateNow();
      await flushConfigWrites();
      if (failedConfigWriteOperations.length !== 0) throw new Error('Nicht alle Einstellungen konnten gespeichert werden');
    }));
  } catch (error) {
    if (isCurrentClosePreparation(generation, attempt)) showCopyToast(error.message || String(error), 8000);
    return;
  }
  if (!isCurrentClosePreparation(generation, attempt)) return;
  closePreparationPromise = null;
  activeClosePreparationAttempt = null;
  closePreparationState = 'open';
  setClosePreparationUi(false);
  showCopyToast(originalError.message || String(originalError), 8000);
}

function prepareForWindowClose(attempt) {
  if (!Number.isInteger(attempt)) return Promise.resolve(false);
  if (closePreparationPromise && activeClosePreparationAttempt === attempt) return closePreparationPromise;
  const generation = ++closePreparationGeneration;
  activeClosePreparationAttempt = attempt;
  closePreparationState = 'preparing';
  setClosePreparationUi(true);
  closePreparationPromise = (async () => {
    if (_doneRemovalCoalescer) _doneRemovalCoalescer.drainSync();
    await waitForClosePreparationStep(withCloseWriteAccess(flushPendingSettingsSaves));
    if (!isCurrentClosePreparation(generation, attempt)) return;
    const pendingQueue = buildPersistedQueueState();
    closePreparationState = 'sealed';
    await waitForClosePreparationStep(flushConfigWrites());
    if (!isCurrentClosePreparation(generation, attempt)) return;
    const accepted = await waitForClosePreparationStep(window.api.finishClosePreparation({ ready: true, attempt, pendingQueue }));
    if (!accepted) throw new Error('Einstellungen konnten vor dem Beenden nicht gespeichert werden');
  })();
  closePreparationPromise.catch(error => recoverWindowClose(generation, attempt, error));
  return closePreparationPromise;
}

// --- Setup Listeners ---
function setupListeners() {
  try { initMenuBar(); } catch (err) { console.error('menu bar init failed', err); }
  document.querySelectorAll('[data-upload-sidebar-target]').forEach(button => {
    button.addEventListener('click', () => setUploadSidebarFilter(button.dataset.uploadSidebarTarget));
  });
  document.querySelectorAll('[data-accounts-sidebar-filter]').forEach(button => {
    button.addEventListener('click', () => setAccountSidebarFilter(button.dataset.accountsSidebarFilter));
  });
  document.querySelectorAll('[data-history-filter]').forEach(button => {
    button.addEventListener('click', () => setHistorySidebarFilter(button.dataset.historyFilter));
  });
  _syncSidebarFilterButtons('[data-upload-sidebar-target]', 'uploadSidebarTarget', uploadSidebarFilter);
  _syncSidebarFilterButtons('[data-accounts-sidebar-filter]', 'accountsSidebarFilter', accountSidebarFilter);
  _syncSidebarFilterButtons('[data-history-filter]', 'historyFilter', historySidebarFilter);
  let sidebarResizeFrame = 0;
  window.addEventListener('resize', () => {
    window.cancelAnimationFrame(sidebarResizeFrame);
    sidebarResizeFrame = window.requestAnimationFrame(() => {
      document.querySelectorAll('.view.active .view-sidebar-navigation > .view-sidebar-item.active, .view.active .settings-navigation > .settings-nav-button.active').forEach(button => {
        _syncSidebarIndicator(button, true);
      });
    });
  });
  document.getElementById('addFilesBtn').addEventListener('click', pickFiles);
  document.getElementById('addFolderBtn').addEventListener('click', pickFolder);
  document.getElementById('startUploadBtn').addEventListener('click', startUpload);
  document.getElementById('startSelectedBtn').addEventListener('click', startSelectedUpload);

  // Recent files sort headers
  document.getElementById('recentFilesHead').addEventListener('click', (e) => {
    const th = e.target.closest('th[data-recent-sort]');
    if (!th) return;
    const key = th.dataset.recentSort;
    if (recentSortState.key === key) {
      recentSortState.direction = recentSortState.direction === 'desc' ? 'asc' : 'desc';
    } else {
      recentSortState.key = key;
      recentSortState.direction = key === 'date' ? 'desc' : 'asc';
    }
    _recentLastRenderedSig = '';
    renderRecentUploadsPanel();
  });

  // Recent files context menu
  document.getElementById('recentFilesBody').addEventListener('contextmenu', (e) => {
    const tr = e.target.closest('.recent-file-row');
    if (!tr) return;
    e.preventDefault();
    e.stopPropagation();
    const id = parseInt(tr.dataset.order, 10);
    if (!selectedRecentIds.has(id)) {
      selectedRecentIds.clear();
      selectedRecentIds.add(id);
      renderRecentUploadsPanel();
    }
    const menu = document.getElementById('recentContextMenu');
    menu.style.display = 'block';
    menu.style.left = Math.min(e.clientX, window.innerWidth - 180) + 'px';
    menu.style.top = Math.min(e.clientY, window.innerHeight - 80) + 'px';
  });

  document.getElementById('recentContextMenu').addEventListener('click', (e) => {
    const item = e.target.closest('.ctx-item');
    if (!item) return;
    hideContextMenu();
    const action = item.dataset.action;
    if (action === 'recent-copy-links') copySelectedRecentLinks();
    else if (action === 'recent-delete') deleteSelectedRecentFiles();
  });
  document.getElementById('reuploadSelectedBtn').addEventListener('click', retrySelectedJobs);
  document.getElementById('abortSelectedBtn').addEventListener('click', abortSelectedJobs);
  document.getElementById('finishStopBtn').addEventListener('click', finishUploadsInProgress);
  document.getElementById('abortAllBtn').addEventListener('click', abortAllUploads);
  document.getElementById('moveTopBtn').addEventListener('click', () => moveSelectedJobs('top'));
  document.getElementById('moveUpBtn').addEventListener('click', () => moveSelectedJobs('up'));
  document.getElementById('moveDownBtn').addEventListener('click', () => moveSelectedJobs('down'));
  document.getElementById('moveBottomBtn').addEventListener('click', () => moveSelectedJobs('bottom'));
  document.getElementById('accountsRunHealthCheckBtn').addEventListener('click', () => runHealthCheck('manual'));
  document.getElementById('toggleAllAccountsBtn').addEventListener('click', () => _setAllAccountGroupsOpen(!_allAccountGroupsOpen()));
  document.getElementById('copyAllLinksBtn').addEventListener('click', copyAllLinks);
  document.getElementById('clearRecentFilesBtn').addEventListener('click', clearAllRecentFiles);
  document.getElementById('exportRecentFilesBtn').addEventListener('click', exportAllRecentFiles);
  document.getElementById('retryFailedBtn').addEventListener('click', () => {
    queueJobs.forEach(j => { if (j.status === 'error') selectedJobIds.add(j.id); });
    retrySelectedJobs();
  });
  document.getElementById('importLogBtn').addEventListener('click', importUploadLog);
  document.getElementById('confirmHosterModalBtn').addEventListener('click', applyHosterSelection);
  document.getElementById('cancelHosterModalBtn').addEventListener('click', cancelHosterModal);
  document.getElementById('closeHosterModalBtn').addEventListener('click', cancelHosterModal);
  document.getElementById('selectAllHostersBtn').addEventListener('click', () => {
    document.querySelectorAll('input[data-hoster-modal]').forEach(input => {
      input.checked = true;
      input.closest('.hoster-option')?.classList.add('selected');
    });
  });
  document.getElementById('clearHostersBtn').addEventListener('click', () => {
    document.querySelectorAll('input[data-hoster-modal]').forEach(input => {
      input.checked = false;
      input.closest('.hoster-option')?.classList.remove('selected');
    });
  });
  document.getElementById('saveSettingsBtn').addEventListener('click', saveSettings);
  document.getElementById('appAlertConfirmBtn').addEventListener('click', closeAppAlert);
  document.getElementById('appAlertCloseBtn').addEventListener('click', closeAppAlert);
  document.getElementById('appAlertModal').addEventListener('click', event => {
    if (event.target.id === 'appAlertModal') closeAppAlert();
  });
  document.addEventListener('keydown', event => {
    const modal = document.getElementById('appAlertModal');
    if (modal?.style.display !== 'flex') return;
    if (event.key === 'Escape' || event.key === 'Enter') {
      event.preventDefault();
      closeAppAlert();
    }
  }, true);

  document.getElementById('clearHistoryBtn').addEventListener('click', openHistoryClearModal);
  document.getElementById('confirmHistoryClearBtn').addEventListener('click', confirmHistoryClear);
  document.getElementById('cancelHistoryClearBtn').addEventListener('click', closeHistoryClearModal);
  document.getElementById('closeHistoryClearModalBtn').addEventListener('click', closeHistoryClearModal);
  document.getElementById('historyClearModal').addEventListener('click', event => {
    if (event.target.id === 'historyClearModal') closeHistoryClearModal();
  });
  document.addEventListener('keydown', event => {
    const modal = document.getElementById('historyClearModal');
    if (modal?.style.display !== 'flex' || event.key !== 'Escape') return;
    event.preventDefault();
    closeHistoryClearModal();
  }, true);
  document.getElementById('exportHistoryBtn').addEventListener('click', exportHistory);

  const historyRetentionPicker = document.getElementById('historyRetentionPicker');
  const historyRetentionTrigger = document.getElementById('historyRetentionTrigger');
  const historyRetentionMenu = document.getElementById('historyRetentionMenu');
  historyRetentionTrigger.addEventListener('click', event => {
    event.stopPropagation();
    if (window.getComputedStyle(historyRetentionMenu).display === 'none' || historyRetentionMenu.classList.contains('menu-closing')) {
      openHistoryRetentionMenu();
    } else {
      closeHistoryRetentionMenu();
    }
  });
  historyRetentionTrigger.addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    openHistoryRetentionMenu(true);
  });
  historyRetentionMenu.addEventListener('click', event => {
    const option = event.target.closest('[data-history-retention]');
    if (option) selectHistoryRetentionOption(option.dataset.historyRetention);
  });
  historyRetentionMenu.addEventListener('keydown', event => {
    const options = [...historyRetentionMenu.querySelectorAll('[data-history-retention]')];
    const current = options.indexOf(document.activeElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      closeHistoryRetentionMenu(true);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      const option = event.target.closest('[data-history-retention]');
      if (!option) return;
      event.preventDefault();
      selectHistoryRetentionOption(option.dataset.historyRetention);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? options.length - 1
        : (Math.max(0, current) + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
    options[next]?.focus();
  });
  historyRetentionPicker.addEventListener('focusout', () => {
    window.setTimeout(() => {
      if (!historyRetentionPicker.contains(document.activeElement)) closeHistoryRetentionMenu();
    }, 0);
  });
  document.addEventListener('mousedown', event => {
    if (!historyRetentionPicker.contains(event.target)) closeHistoryRetentionMenu();
  });

  const historyRetentionSelect = document.getElementById('historyRetentionSelect');
  if (historyRetentionSelect) {
    historyRetentionSelect.addEventListener('change', async () => {
      const value = historyRetentionSelect.value;
      const prev = (config.globalSettings && config.globalSettings.historyRetention) || 'all';
      if (value !== 'all') {
        const preview = await window.api.pruneHistory(value, { dryRun: true });
        if (preview && preview.removedRows > 0) {
          const ok = confirm(`${preview.removedRows.toLocaleString(getUiLocale())} Verlaufseinträge werden dauerhaft entfernt.\n\nFortfahren?`);
          if (!ok) {
            historyRetentionSelect.value = prev;
            syncHistoryRetentionPicker();
            return;
          }
        }
      }
      try {
        const res = await runConfigWrite(() => window.api.pruneHistory(value));
        config.globalSettings = { ...(config.globalSettings || {}), historyRetention: value };
        if (res && res.removedRows > 0) showCopyToast(`Verlauf gekürzt: ${res.removedRows.toLocaleString(getUiLocale())} entfernt`);
        loadHistory();
      } catch (error) {
        historyRetentionSelect.value = prev;
        syncHistoryRetentionPicker();
        showCopyToast(error.message || String(error));
      }
    });
  }

  // Auto health check toggle
  const autoToggle = document.getElementById('autoHealthCheckToggle');
  if (autoToggle) {
    autoToggle.checked = autoHealthCheckEnabled;
    autoToggle.addEventListener('change', (e) => {
      autoHealthCheckEnabled = !!e.target.checked;
      try { localStorage.setItem(AUTO_CHECK_PREF_KEY, autoHealthCheckEnabled ? '1' : '0'); } catch {}
    });
  }

  // Virtual scroll for large queues
  const queueContainer = document.getElementById('queueContainer');
  if (queueContainer) queueContainer.addEventListener('scroll', _onQueueScroll, { passive: true });
  if (queueContainer && typeof window.ResizeObserver !== 'undefined') {
    new window.ResizeObserver(_onQueueScroll).observe(queueContainer);
  }

  // Queue table sorting
  document.querySelectorAll('#queueTable th.sortable').forEach(th => {
    th.addEventListener('click', (e) => {
      // Don't sort if click was on the resizer handle
      if (e.target.classList.contains('col-resizer')) return;
      const key = th.dataset.sort;
      if (queueSortState.key === key) queueSortState.direction = queueSortState.direction === 'asc' ? 'desc' : 'asc';
      else { queueSortState.key = key; queueSortState.direction = 'asc'; }
      _lastVisibleRange = { start: -1, end: -1 }; // force full rebuild after re-sort
      renderQueueTable();
    });
  });

  // Queue table column resizing (JDownloader-style)
  setupColumnResizing();

  // Shutdown cancel
  document.getElementById('cancelShutdownBtn').addEventListener('click', async () => {
    await window.api.cancelShutdown();
    if (shutdownCountdownInterval) { clearInterval(shutdownCountdownInterval); shutdownCountdownInterval = null; }
    document.getElementById('shutdownOverlay').style.display = 'none';
  });

  // Click on empty area in queue → deselect all
  document.getElementById('upload-view').addEventListener('click', (e) => {
    if (e.target.closest('.view-main') && !e.target.closest('.queue-row') && !e.target.closest('.btn') && !e.target.closest('.context-menu') && !e.target.closest('.recent-files-panel')) {
      if (selectedJobIds.size > 0) {
        selectedJobIds.clear();
        renderQueueTable();
        updateQueueActionButtons();
      }
    }
  });

  // Right-click on upload view background
  document.getElementById('upload-view').addEventListener('contextmenu', (e) => {
    if (e.target.closest('.queue-row')) return; // handled per row
    if (queueJobs.length === 0 && selectedFiles.length === 0) return; // nothing in queue
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY);
  });

  document.getElementById('hosterModal').addEventListener('click', (e) => {
    if (e.target.id === 'hosterModal') cancelHosterModal();
  });

  // Account management
  document.getElementById('addAccountBtn').addEventListener('click', () => openAccountModal(null));
  document.getElementById('closeAccountModalBtn').addEventListener('click', closeAccountModal);
  document.getElementById('cancelAccountModalBtn').addEventListener('click', closeAccountModal);
  document.getElementById('saveAccountBtn').addEventListener('click', saveAccount);
  document.getElementById('accountModal').addEventListener('click', (e) => {
    if (e.target.id === 'accountModal') closeAccountModal();
  });

  // Account hoster select change → update credential fields
  document.getElementById('accountHosterSelect').addEventListener('change', (e) => {
    _invalidateAccountSubmit();
    const opt = HOSTER_ADD_OPTIONS.find(o => o.value === e.target.value);
    const authType = opt ? opt.authType : 'login';
    const credsContainer = document.getElementById('accountCredsFields');
    credsContainer.innerHTML = getCredsFieldsHtml(authType, {}, e.target.value);
    wireCredentialVisibilityButtons(credsContainer);
    _wireCredFieldInvalidation();
  });

  // Delete account modal
  document.getElementById('closeDeleteModalBtn').addEventListener('click', closeDeleteModal);
  document.getElementById('cancelDeleteBtn').addEventListener('click', closeDeleteModal);
  document.getElementById('confirmDeleteBtn').addEventListener('click', () => {
    const modal = document.getElementById('deleteAccountModal');
    const accountId = modal.dataset.accountId;
    if (accountId) deleteAccount(accountId);
  });
  document.getElementById('deleteAccountModal').addEventListener('click', (e) => {
    if (e.target.id === 'deleteAccountModal') closeDeleteModal();
  });

  // Job log modal
  document.getElementById('closeJobLogBtn')?.addEventListener('click', hideJobLogModal);
  document.getElementById('closeJobLogBtn2')?.addEventListener('click', hideJobLogModal);
  document.getElementById('copyJobLogBtn')?.addEventListener('click', copyJobLogToClipboard);
  document.getElementById('jobLogModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'jobLogModal') hideJobLogModal();
  });

  document.getElementById('headerUpdateBtn')?.addEventListener('click', requestUpdateCheck);
  document.getElementById('installUpdateBtn')?.addEventListener('click', installKnownUpdate);
  document.getElementById('dismissUpdateBtn')?.addEventListener('click', closeUpdateDialog);
  document.getElementById('updateCloseBtn')?.addEventListener('click', closeUpdateDialog);
  document.getElementById('updateBanner')?.addEventListener('click', (event) => {
    if (event.target.id === 'updateBanner') closeUpdateDialog();
  });
  document.addEventListener('keydown', _handleUpdateDialogKeydown, true);
  _syncHeaderUpdateState();
}

// --- Update UI ---
function _formatUpdateReleaseNotes(value) {
  const output = [];
  let pendingBlank = false;
  for (const rawLine of String(value || '').replace(/\r\n?/g, '\n').split('\n')) {
    let line = rawLine.trim();
    if (!line) {
      if (output.length > 0) pendingBlank = true;
      continue;
    }
    line = line
      .replace(/^#{1,6}\s+/, '')
      .replace(/^[-*+]\s+/, '• ')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    if (pendingBlank && output.at(-1) !== '') output.push('');
    output.push(line);
    pendingBlank = false;
  }
  return output.join('\n');
}

function showUpdateBanner(info) {
  if (!info) return;
  _knownUpdateInfo = { ...info, available: true };
  if (_updateInstallBusy) {
    _syncHeaderUpdateState();
    _setUpdateDialogVisible(true);
    return;
  }
  _updateInstallBusy = false;
  const version = String(info.remoteVersion || '').replace(/^v/i, '') || 'unbekannt';
  const title = document.getElementById('updateDialogTitle');
  const message = document.getElementById('updateMessage');
  const notes = document.getElementById('updateReleaseNotes');
  const notesBody = document.getElementById('updateReleaseNotesBody');
  const installButton = document.getElementById('installUpdateBtn');
  if (title) title.textContent = 'Eine neue Version ist verfügbar';
  if (message) {
    message.textContent = `Update v${version} verfügbar`;
    message.hidden = false;
  }
  if (notes && notesBody) {
    const releaseNotes = _formatUpdateReleaseNotes(info.releaseNotes);
    notesBody.textContent = releaseNotes.length > 2400 ? `${releaseNotes.slice(0, 2399)}…` : releaseNotes;
    notes.hidden = !releaseNotes;
  }
  if (installButton) {
    installButton.disabled = false;
    installButton.textContent = 'Jetzt installieren';
  }
  _setUpdateProgress(0, 'Bereit zum Download');
  _setUpdateDialogBusy(false);
  _syncHeaderUpdateState();
  _setUpdateDialogVisible(true);
}

function handleUpdateProgress(data) {
  const progress = data || {};
  const message = document.getElementById('updateMessage');
  const button = document.getElementById('installUpdateBtn');
  if (progress.stage === 'starting') {
    _updateInstallBusy = true;
    _setUpdateDialogBusy(true);
    _setUpdateProgress(0, 'Download 0%');
    if (message) message.hidden = true;
    if (button) button.textContent = 'Download 0%';
  } else if (progress.stage === 'downloading') {
    const percent = Math.max(0, Math.min(100, Math.round(Number(progress.percent) || 0)));
    _updateInstallBusy = true;
    _setUpdateDialogBusy(true);
    _setUpdateProgress(percent, `Download ${percent}%`);
    if (message) message.hidden = true;
    if (button) button.textContent = `Download ${percent}%`;
  } else if (progress.stage === 'verifying') {
    _updateInstallBusy = true;
    _setUpdateDialogBusy(true);
    _setUpdateProgress(100, 'Prüfen…');
    if (message) message.hidden = true;
    if (button) button.textContent = 'Prüfen…';
  } else if (progress.stage === 'prepared') {
    _updateInstallBusy = true;
    _setUpdateDialogBusy(true);
    _setUpdateProgress(100, 'Neustart…');
    if (message) message.hidden = true;
    if (button) button.textContent = 'Neustart…';
  } else if (progress.stage === 'launching' || progress.stage === 'done') {
    _updateInstallBusy = true;
    _setUpdateDialogBusy(true);
    _setUpdateProgress(100, 'Neustart…');
    if (message) message.hidden = true;
    if (button) button.textContent = 'Neustart…';
  } else if (progress.stage === 'error') {
    _updateInstallBusy = false;
    _setUpdateDialogBusy(false);
    _setUpdateProgress(0, 'Update fehlgeschlagen');
    if (message) {
      message.hidden = false;
      message.textContent = `Update fehlgeschlagen: ${String(progress.error || 'Unbekannter Fehler').slice(0, 400)}`;
    }
    if (button) {
      button.disabled = false;
      button.textContent = 'Wiederholen';
    }
    _setUpdateDialogVisible(true);
  }
}

function _isUpdateDialogVisible() {
  const overlay = document.getElementById('updateBanner');
  return Boolean(overlay && overlay.style.display !== 'none' && overlay.getAttribute('aria-hidden') !== 'true');
}

function _setUpdateBackgroundInert(active) {
  const overlay = document.getElementById('updateBanner');
  if (!overlay) return;
  if (active) {
    if (_updateDialogInertState.length > 0) return;
    _updateDialogInertState = Array.from(document.body.children)
      .filter(element => element !== overlay && 'inert' in element)
      .map(element => ({ element, inert: element.inert }));
    _updateDialogInertState.forEach(({ element }) => { element.inert = true; });
    return;
  }
  _updateDialogInertState.forEach(({ element, inert }) => {
    if (element.isConnected) element.inert = inert;
  });
  _updateDialogInertState = [];
}

function _getUpdateDialogFocusable() {
  const dialog = document.querySelector('#updateBanner .update-dialog');
  if (!dialog) return [];
  return Array.from(dialog.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'))
    .filter(element => !element.hidden && element.getClientRects().length > 0 && window.getComputedStyle(element).visibility !== 'hidden');
}

function _focusUpdateDialog() {
  const dialog = document.querySelector('#updateBanner .update-dialog');
  if (!dialog) return;
  const target = _getUpdateDialogFocusable()[0] || dialog;
  target.focus();
}

function _handleUpdateDialogKeydown(event) {
  if (!_isUpdateDialogVisible()) return;
  const dialog = document.querySelector('#updateBanner .update-dialog');
  if (!dialog) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!_updateInstallBusy) closeUpdateDialog();
    return;
  }
  if (event.key !== 'Tab') {
    if (!dialog.contains(event.target)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      _focusUpdateDialog();
    }
    return;
  }
  const focusable = _getUpdateDialogFocusable();
  if (focusable.length === 0) {
    event.preventDefault();
    event.stopImmediatePropagation();
    dialog.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const activeElement = document.activeElement;
  if (!dialog.contains(activeElement) || (!event.shiftKey && activeElement === last) || (event.shiftKey && activeElement === first)) {
    event.preventDefault();
    event.stopImmediatePropagation();
    (event.shiftKey ? last : first).focus();
  }
}

function _setUpdateDialogVisible(visible) {
  const overlay = document.getElementById('updateBanner');
  if (!overlay) return;
  if (visible) {
    const wasVisible = _isUpdateDialogVisible();
    if (!wasVisible) {
      _updateDialogReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      _setUpdateBackgroundInert(true);
    }
    overlay.style.display = 'flex';
    overlay.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => {
      const dialog = overlay.querySelector('.update-dialog');
      if (_isUpdateDialogVisible() && dialog && !dialog.contains(document.activeElement)) _focusUpdateDialog();
    });
  } else {
    overlay.style.display = 'none';
    overlay.setAttribute('aria-hidden', 'true');
    _setUpdateBackgroundInert(false);
    const returnFocus = _updateDialogReturnFocus;
    _updateDialogReturnFocus = null;
    if (returnFocus && returnFocus.isConnected && typeof returnFocus.focus === 'function') returnFocus.focus();
  }
}

function closeUpdateDialog() {
  if (_updateInstallBusy) return false;
  _setUpdateDialogVisible(false);
  return true;
}

function _setUpdateDialogBusy(busy) {
  const dialog = document.querySelector('#updateBanner .update-dialog');
  if (dialog) dialog.setAttribute('aria-busy', busy ? 'true' : 'false');
  ['installUpdateBtn', 'dismissUpdateBtn', 'updateCloseBtn'].forEach(id => {
    const button = document.getElementById(id);
    if (button) button.disabled = busy;
  });
  if (busy && dialog && (!dialog.contains(document.activeElement) || document.activeElement.matches?.(':disabled'))) dialog.focus();
}

function _setUpdateProgress(percent, text) {
  const value = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  const progressText = document.getElementById('updateProgressText');
  const progressBar = document.getElementById('updateProgressBar');
  if (progressText) progressText.textContent = text;
  if (progressBar) {
    progressBar.setAttribute('aria-valuenow', String(value));
    progressBar.setAttribute('aria-valuetext', String(text || `${value}%`));
    if ('value' in progressBar) progressBar.value = value;
    progressBar.style.width = `${value}%`;
  }
}

async function installKnownUpdate() {
  if (_updateInstallBusy) return;
  if (!_knownUpdateInfo || !_knownUpdateInfo.available) {
    await requestUpdateCheck();
    return;
  }
  _updateInstallBusy = true;
  _setUpdateDialogBusy(true);
  _setUpdateProgress(0, 'Download 0%');
  const message = document.getElementById('updateMessage');
  const button = document.getElementById('installUpdateBtn');
  if (message) message.hidden = true;
  if (button) button.textContent = 'Download 0%';
  try {
    await persistQueueStateNow();
    const result = await window.api.installUpdate();
    if (result && result.started === false) throw new Error(result.error || 'Update konnte nicht gestartet werden');
  } catch (error) {
    handleUpdateProgress({ stage: 'error', error: error && error.message ? error.message : String(error) });
  }
}

// --- Shutdown ---
let shutdownCountdownInterval = null;
function handleShutdownCountdown(data) {
  const overlay = document.getElementById('shutdownOverlay');
  const msgEl = document.getElementById('shutdownMessage');
  const secEl = document.getElementById('shutdownSeconds');
  overlay.style.display = 'flex';

  const labels = { sleep: 'Ruhezustand', shutdown: 'Herunterfahren', restart: 'Neustart' };
  let remaining = data.seconds || 60;
  secEl.textContent = remaining;
  msgEl.textContent = `${labels[data.mode] || data.mode} in ${remaining}s...`;

  if (shutdownCountdownInterval) clearInterval(shutdownCountdownInterval);
  shutdownCountdownInterval = setInterval(() => {
    remaining--;
    secEl.textContent = remaining;
    msgEl.textContent = `${labels[data.mode] || data.mode} in ${remaining}s...`;
    if (remaining <= 0) { clearInterval(shutdownCountdownInterval); }
  }, 1000);
}

// --- Auto-deduplicate restored queue against own upload log on startup ---
async function _autoDeduplicateFromLog() {
  if (queueJobs.length === 0 && selectedFiles.length === 0) return;
  try {
    const entries = await window.api.readOwnUploadLog();
    if (!entries || entries.length === 0) return;
    // Drops 'done' jobs present in the log (declutter) AND any job that the log
    // shows completed at/after the snapshot's savedAt (a stale 'preview' ghost).
    // Pending jobs matching only OLDER log lines survive — intentional re-uploads.
    // Decision lives in lib/queue-dedup.js (Node-tested, see tests/queue-dedup.test.js)
    // so it can't silently regress to nuking the whole restored queue on restart.
    const { kept, removed } = window.QueueDedup.partitionRestoredJobsByLog(queueJobs, entries, _restoredSnapshotSavedAt);
    if (removed.length > 0) {
      queueJobs = kept;
      for (const job of removed) {
        if (job.file && job.hoster) _completedUploadKeys.add(`${job.file}|${job.hoster}`);
      }
      rebuildJobIndex();
      syncSelectedFilesFromQueue();
      window.api.debugLog(`auto-dedup: removed ${removed.length} already-uploaded (done) jobs from restored queue (${entries.length} log entries)`);
    }
    const seedKeys = window.QueueDedup.completedSelectionKeys(selectedFiles, getSelectedHosters(), entries, _restoredSnapshotSavedAt);
    if (seedKeys.length > 0) {
      for (const k of seedKeys) _completedUploadKeys.add(k);
      window.api.debugLog(`auto-dedup: seeded ${seedKeys.length} completed file|hoster keys from log so buildQueuePreview won't re-create ghosts`);
    }
  } catch {}
}

// --- Log import: remove already-uploaded file+hoster combos from queue ---
async function importUploadLog() {
  const result = await window.api.importUploadLog();
  if (!result || result.canceled) return;
  const entries = result.entries || [];
  if (entries.length === 0) {
    showCopyToast('Keine Einträge im Log gefunden');
    return;
  }

  // Build lookup Set: "filename_lower|hoster"
  const logKeys = new Set();
  for (const entry of entries) {
    logKeys.add(`${entry.fileName.toLowerCase()}|${entry.hoster.toLowerCase()}`);
  }

  // Find queue jobs that match (already uploaded)
  let removed = 0;
  queueJobs = queueJobs.filter(job => {
    const key = `${job.fileName.toLowerCase()}|${job.hoster.toLowerCase()}`;
    if (logKeys.has(key) && job.status !== 'done') {
      removeJobFromIndex(job);
      // Mark as completed so buildQueuePreview won't re-create them
      if (job.file && job.hoster) _completedUploadKeys.add(`${job.file}|${job.hoster}`);
      removed++;
      return false;
    }
    return true;
  });

  if (removed > 0) {
    selectedJobIds.clear();
    syncSelectedFilesFromQueue();
    rebuildJobIndex();
    renderQueueTable();
    updateUploadView();
    updateStatusBar();
    persistQueueStateSoon(true);
  }

  showCopyToast(`${removed} bereits hochgeladene Jobs aus Queue entfernt (${entries.length} Log-Einträge gelesen)`);
}

// --- Link operations ---
function copyAllLinks() {
  const rows = queueJobs
    .filter(j => j.status === 'done' && j.result)
    .map(j => ({
      fileName: j.fileName || '',
      hoster: j.hoster || '',
      url: j.result.download_url || j.result.embed_url || ''
    }))
    .filter(r => r.url);
  if (rows.length === 0) return;
  const formatEl = document.getElementById('linkExportFormat');
  const fmt = (formatEl && formatEl.value) || 'plain';
  const text = window.Stats ? window.Stats.formatLinks(rows, fmt) : rows.map(r => r.url).join('\n');
  window.api.copyToClipboard(text);
  showCopyToast(`${rows.length} Link${rows.length === 1 ? '' : 's'} als ${fmt.toUpperCase()} kopiert`);
}

// --- Utilities ---
function formatSize(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' kB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function formatSpeed(kbs) {
  if (!kbs || kbs <= 0) return '0 kB/s';
  if (kbs >= 1024) return (kbs / 1024).toFixed(1) + ' MB/s';
  return Math.round(kbs) + ' kB/s';
}

function formatTime(seconds) {
  if (!seconds || seconds <= 0) return '00:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${pad(h)}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
}

function pad(n) { return String(Math.floor(n)).padStart(2, '0'); }

function formatDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  return {
    ts: safeDate.getTime(),
    text: safeDate.toLocaleDateString(getUiLocale(), { day: '2-digit', month: '2-digit', year: 'numeric' })
      + ' ' + safeDate.toLocaleTimeString(getUiLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  };
}

function loadAutoCheckPreference() {
  try { const r = localStorage.getItem(AUTO_CHECK_PREF_KEY); return r === null || r === '1'; }
  catch { return true; }
}

// --- Queue table column resizing (JDownloader-style) ---
// Two-tier widths: _idealColumnWidths is what the user set (persisted); the
// displayed widths are scaled proportionally if the window is too narrow to fit
// all ideals (fullscreen → windowed). We never overwrite ideals just because
// the window shrunk — only an explicit drag updates the ideal for that column.
const _idealColumnWidths = {};

function restoreQueueColumnWidths() {
  try {
    const raw = localStorage.getItem(QUEUE_COL_WIDTHS_KEY);
    if (raw) {
      const widths = JSON.parse(raw);
      if (widths && typeof widths === 'object') {
        for (const [col, px] of Object.entries(widths)) {
          if (typeof px === 'number' && px > 20) _idealColumnWidths[col] = px;
        }
      }
    }
    _applyFittedColumnWidths();
  } catch {}
}

function saveDraggedColumnWidth(col, width) {
  // Called from the resizer onUp: the dragged column's new width becomes its
  // new ideal. Other columns keep their saved ideals untouched (so a drag
  // while the window is small doesn't bake the scaled values in).
  if (!col || typeof width !== 'number' || width < 40) return;
  _idealColumnWidths[col] = width;
  try { localStorage.setItem(QUEUE_COL_WIDTHS_KEY, JSON.stringify(_idealColumnWidths)); } catch {}
  _applyFittedColumnWidths();
}

function _applyFittedColumnWidths() {
  const container = document.getElementById('queueContainer');
  if (!container) return;
  const ths = document.querySelectorAll('#queueTable th[data-col]');
  if (!ths.length) return;

  const entries = [];
  let total = 0;
  ths.forEach(th => {
    // Fall back to the column's currently-measured width if no ideal exists
    // yet (first render before the user ever dragged).
    const ideal = _idealColumnWidths[th.dataset.col] || th.getBoundingClientRect().width || 0;
    entries.push({ th, ideal });
    total += ideal;
  });
  if (total <= 0) return;

  const available = container.clientWidth;
  if (available <= 0) return;
  const MIN = 40;

  if (total <= available) {
    entries.forEach(({ th, ideal }) => { th.style.width = ideal + 'px'; });
    return;
  }
  // Scale all columns proportionally so they exactly fit the available width.
  const scale = available / total;
  entries.forEach(({ th, ideal }) => {
    th.style.width = Math.max(MIN, Math.round(ideal * scale)) + 'px';
  });
}

// Debounced window-resize refit. Fires on every window size change — fullscreen
// → windowed, dragging the window edge, monitor unplug — and reshapes columns
// to the new viewport so the user never has to drag the window wider just to
// see a hidden column.
let _columnRefitTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(_columnRefitTimer);
  _columnRefitTimer = setTimeout(_applyFittedColumnWidths, 60);
});

function setupColumnResizing() {
  const headers = document.querySelectorAll('#queueTable th[data-col]');
  headers.forEach(th => {
    const resizer = th.querySelector('.col-resizer');
    if (!resizer) return;

    resizer.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const startX = e.clientX;
      const startWidth = th.getBoundingClientRect().width;
      resizer.classList.add('dragging');
      document.body.classList.add('col-resizing');

      const onMove = (ev) => {
        const delta = ev.clientX - startX;
        const newWidth = Math.max(40, startWidth + delta);
        th.style.width = newWidth + 'px';
      };

      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        resizer.classList.remove('dragging');
        document.body.classList.remove('col-resizing');
        // Only the dragged column's new width becomes its new ideal; other
        // columns keep their saved ideals (so dragging while the window is
        // narrow doesn't permanently shrink everything else).
        saveDraggedColumnWidth(th.dataset.col, th.getBoundingClientRect().width);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });
}

// Single-pass escape instead of 4 chained .replace(/x/g, ...) calls.
// Hot path on large table rebuilds — every text cell runs through one of these.
const _HTML_ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const _HTML_ESC_RE = /[&<>"]/g;
const _ATTR_ESC_MAP = { '&': '&amp;', '"': '&quot;', "'": '&#39;' };
const _ATTR_ESC_RE = /[&"']/g;

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(_HTML_ESC_RE, (c) => _HTML_ESC_MAP[c]);
}

function escapeAttr(str) {
  if (!str) return '';
  return String(str).replace(_ATTR_ESC_RE, (c) => _ATTR_ESC_MAP[c]);
}

function showCopyToast(msg, durationMs) {
  const toast = document.getElementById('copyToast');
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('show'), durationMs || 1500);
}

// --- Resize handle for recent-files panel ---
{
  const resizer = document.getElementById('recentFilesResizer');
  const panel = document.getElementById('recentFilesPanel');
  if (resizer && panel) {
    let startY = 0;
    let startH = 0;

    resizer.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startY = e.clientY;
      startH = panel.getBoundingClientRect().height;
      resizer.classList.add('dragging');
      document.body.style.cursor = 'ns-resize';
      document.body.style.userSelect = 'none';

      const onMove = (e2) => {
        const delta = startY - e2.clientY;
        const newH = Math.max(60, Math.min(window.innerHeight * 0.7, startH + delta));
        panel.style.flex = `0 0 ${newH}px`;
      };

      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        resizer.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }
}

// --- Recent panel tabs ---
document.querySelectorAll('.recent-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.recent-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.recent-tab-body').forEach(b => b.classList.remove('active'));
    tab.classList.add('active');
    const panel = document.getElementById(tab.dataset.panel);
    if (panel) panel.classList.add('active');
    const hint = document.getElementById('recentFilesHint');
    if (hint) hint.textContent = tab.dataset.panel === 'statsTab' ? 'Upload-Statistiken' : 'Zuletzt erzeugte Upload-Links';
  });
});

// --- Stats panel update ---
let statsStartTime = 0;
let statsRunTimer = null;

function formatBytes(bytes) {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 2 : 0) + ' ' + units[i];
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function updateStatsPanel() {
  const stats = _computeQueueStats();
  const remaining = stats.total - stats.done - stats.errors;

  const el = (id) => document.getElementById(id);
  if (el('statQueueTotal')) el('statQueueTotal').textContent = stats.total;
  if (el('statQueueDone')) el('statQueueDone').textContent = stats.done;
  if (el('statQueueRemaining')) el('statQueueRemaining').textContent = remaining;
  if (el('statQueueInProgress')) el('statQueueInProgress').textContent = stats.inProgress;
  if (el('statQueueError')) el('statQueueError').textContent = stats.errors;
  if (el('statSizeTotal')) el('statSizeTotal').textContent = formatBytes(stats.totalSize);
  if (el('statSizeRemaining')) el('statSizeRemaining').textContent = formatBytes(stats.remainingSize);

  const speed = lastUploadStats.globalSpeedKbs || 0;
  if (el('statSpeed')) el('statSpeed').textContent = speed > 0 ? formatBytes(speed * 1024) + '/s' : '0 B/s';
  if (el('statEta')) {
    if (speed > 0 && stats.remainingSize > 0) {
      el('statEta').textContent = formatDuration(Math.round(stats.remainingSize / (speed * 1024)));
    } else {
      el('statEta').textContent = '--:--';
    }
  }
  if (el('statSessionBytes')) el('statSessionBytes').textContent = formatBytes(lastUploadStats.totalBytes || 0);
}

// --- Start ---
window.api.onUpdateAvailable(showUpdateBanner);
window.api.onUpdateProgress(handleUpdateProgress);
window.api.onPrepareClose(prepareForWindowClose);
init().then(() => {
  window.api.signalCloseHandshakeReady();
}).catch((err) => {
  try {
    if (window.api && window.api.debugLog) window.api.debugLog(`init failed: ${err && err.stack ? err.stack : err}`);
    const root = document.getElementById('app') || document.body;
    if (root) {
      const banner = document.createElement('div');
      banner.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#5a1e1e;color:#fff;padding:8px;z-index:99999;font-family:sans-serif;font-size:13px';
      banner.textContent = 'Initialisierung fehlgeschlagen: ' + (err && err.message ? err.message : err) + ' — bitte Diagnose-Paket exportieren oder Programm neu starten.';
      root.appendChild(banner);
    }
  } catch {}
});
