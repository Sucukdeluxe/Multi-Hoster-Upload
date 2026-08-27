process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '8';
const { monitorEventLoopDelay, PerformanceObserver } = require('perf_hooks');
const { app, BrowserWindow, ipcMain, dialog, clipboard, nativeTheme, Tray, Menu, nativeImage } = require('electron');
const { createStartupWindow, createStartupQuery } = require('./lib/startup-renderer');
nativeTheme.themeSource = 'dark';
const path = require('path');
const { pathToFileURL } = require('node:url');
const fs = require('fs');
const ConfigStore = require('./lib/config-store');
const UploadManager = require('./lib/upload-manager');
const { createSourceFileCleanup } = require('./lib/source-file-cleanup');
const SourceDeleteJournal = require('./lib/source-delete-journal');
const { HOSTER_CONFIGS } = require('./lib/hosters');
const VidmolyUploader = require('./lib/vidmoly-upload');
const VoeUploader = require('./lib/voe-upload');
const DoodstreamUploader = require('./lib/doodstream-upload');
const { selectUploadAuth } = require('./lib/account-auth');
const { createAccountCooldownController, createAccountPicker } = require('./lib/account-rotation');
const ClouddropUploader = require('./lib/clouddrop-upload');
const { checkForUpdate, prepareUpdate, launchPreparedUpdate, abortUpdate, createUpdateAnnouncementState } = require('./lib/updater');
const backupCrypto = require('./lib/backup-crypto');
const { downloadOnlineBackup } = require('./lib/online-backup');
const { createOnlineBackupKeyring } = require('./lib/online-backup-keyring');
const { createOnlineBackupManager } = require('./lib/online-backup-manager');
const { createPortableSettingsSnapshot, prepareImportedSettings } = require('./lib/settings-backup');
const { createSettingsImportGate } = require('./lib/settings-import-gate');
const FolderMonitor = require('./lib/folder-monitor');
const { walkFolderAsync } = require('./lib/file-discovery');
const RemoteServer = require('./lib/remote-server');
const { maybeRotateLogFile } = require('./lib/log-rotation');
const { hosterLogToFileEnabled } = require('./lib/log-policy');
const { formatUploadLogLine, iterateUploadLogEntries, summarizeBatchPlan, formatUploadPlanLogLine } = require('./lib/upload-log');
const { createInternalLogPathResolver, createInternalLogWriter, createUploadAuditWriter, createBufferedInternalLogFlusher, getLogOpenDirectory } = require('./lib/upload-audit');
const { selectOrphanTmps } = require('./lib/orphan-tmp');
const { sanitizeConfig, buildSupportBundleText, collectSecretValues, redactLogText, valueScrub, collectFile, REDACTED } = require('./lib/support-bundle');
const { buildWebhookRequest, isAllAborted } = require('./lib/webhook-notify');
const stats = require('./lib/stats');
const { createCollectors } = require('./lib/diagnostics-collectors');
const { createAgent } = require('./lib/diagnostics-agent');
const { buildSessionReport, buildSessionReportCsv } = require('./lib/session-report');
const { inspectImportEntries, inspectReadableImportPath } = require('./lib/import-preflight');
const { normalizeAutomationSettings, automationCompletionKey, createAutomationCompletionWriter, isPathWithinAutomationFolder, normalizeAutomationCompletion } = require('./lib/automation-control');

const _eventLoopDelay = monitorEventLoopDelay({ resolution: 10 });
_eventLoopDelay.enable();
let _eldLastLog = 0;
let _lastCpu = process.cpuUsage();
let _lastCpuT = Date.now();
let _gcCount = 0;
let _gcTotalMs = 0;
let _gcMaxMs = 0;
try {
  const _gcObserver = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      _gcCount++;
      _gcTotalMs += entry.duration;
      if (entry.duration > _gcMaxMs) _gcMaxMs = entry.duration;
    }
  });
  _gcObserver.observe({ entryTypes: ['gc'] });
} catch {}

const _perfOn = process.env.MHU_PERF !== '0';
let _lastIpcChannel = '';
if (_perfOn) {
  let _driftTick = Date.now();
  setInterval(() => {
    const now = Date.now();
    const drift = now - _driftTick - 100;
    _driftTick = now;
    if (drift >= 100) {
      try { logInfo(`main-longtask blocked=${drift}ms lastIpc=${_lastIpcChannel || '-'} gc=${_gcCount} gcMax=${_gcMaxMs.toFixed(0)}ms`); } catch {}
    }
  }, 100).unref();

  const IPC_SLOW_MS = 50;
  const _ipcLog = (m) => { try { logInfo(m); } catch {} };
  const _rawHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, fn) => _rawHandle(channel, function (evt, ...args) {
    _lastIpcChannel = channel;
    const t0 = performance.now();
    let p;
    try { p = fn.call(this, evt, ...args); }
    catch (e) { _ipcLog(`ipc ${channel} sync-throw wall=${(performance.now() - t0).toFixed(0)}ms`); throw e; }
    const sync = performance.now() - t0;
    if (p && typeof p.then === 'function') {
      return Promise.resolve(p).finally(() => {
        const total = performance.now() - t0;
        if (total >= IPC_SLOW_MS) _ipcLog(`ipc ${channel} wall=${total.toFixed(0)}ms sync=${sync.toFixed(0)}ms`);
      });
    }
    if (sync >= IPC_SLOW_MS) _ipcLog(`ipc ${channel} wall=${sync.toFixed(0)}ms sync`);
    return p;
  });
  const _rawOn = ipcMain.on.bind(ipcMain);
  ipcMain.on = (channel, fn) => _rawOn(channel, function (evt, ...args) {
    _lastIpcChannel = channel;
    const t0 = performance.now();
    try { return fn.call(this, evt, ...args); }
    finally { const dt = performance.now() - t0; if (dt >= IPC_SLOW_MS) _ipcLog(`ipc ${channel} wall=${dt.toFixed(0)}ms sync-on`); }
  });
}

let mainWindow;
let closeFlushApproved = false;
let closeFlushRequested = false;
let closeHandshakeReady = false;
let closeFlushTimer = null;
let restartAfterClosePreparation = false;
let quitTeardownStarted = false;
let closePreparationAttempt = 0;
let closeQuiesceOwnerAttempt = null;
let lastRestoredCloseAttempt = null;
let closeFolderMonitorWasRunning = false;
let folderMonitorLifecycleGeneration = 0;
let folderMonitorRendererGeneration = 0;
let folderMonitorRendererReadyGeneration = null;
let folderMonitorStartupReconcile = null;
let preparedUpdate = null;
let updatePreparationPromise = null;
let updateQuitPending = false;
let preparedUpdateLaunchStarted = false;
let updateCheckInterval = null;
const updateAnnouncementState = createUpdateAnnouncementState();
let _lastImportPath = null;
let dropTargetWindow = null;
let tray = null;
let _cachedLogSettings = null;
const configStore = new ConfigStore(app);
configStore.setPerfLog((m) => { try { logInfo(m); } catch {} });
_setLogSettingsSnapshot((configStore.load() || {}).globalSettings);
const onlineBackupKeyring = createOnlineBackupKeyring({
  filePath: path.join(app.getPath('userData'), 'online-backup-keys.json')
});
const onlineBackupManager = createOnlineBackupManager({
  keyring: onlineBackupKeyring,
  loadSettings: async () => {
    await waitForConfigStoreWrites();
    return createPortableSettingsSnapshot(configStore.load());
  },
  appVersion: () => app.getVersion(),
  copyText: value => clipboard.writeText(value)
});
let uploadManager = null;
let lastSessionSummary = null;
let sourceDeleteJournal = null;
const pendingUploadFinalizations = new Map();

async function waitForUploadManagerRelease(manager, timeoutMs = 300000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (uploadManager !== manager) return true;
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

function requestUploadFinalization(summary, preserveQueue = false) {
  const finalizationId = `upload-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingUploadFinalizations.delete(finalizationId);
      resolve(false);
    }, 15000);
    pendingUploadFinalizations.set(finalizationId, {
      resolve(value) {
        clearTimeout(timer);
        pendingUploadFinalizations.delete(finalizationId);
        resolve(value);
      }
    });
    safeSend('upload-batch-done', { summary, finalizationId, preserveQueue });
  });
}
const activeUploadProducerTrackers = new Set();
const settingsImportGate = createSettingsImportGate(() => !!(uploadManager && uploadManager.running));
let diagnosticAgent = null;
let _diagHandler = null;

function assertConfigWriteAllowed() {
  if (!settingsImportGate.canStartUpload()) throw new Error('Einstellungen werden gerade importiert');
}

async function waitForConfigStoreWrites() {
  await configStore.drainWrites();
  await configStore.drainAutomationCompletionWrites();
}

const ONLINE_BACKUP_RENDERER_URL = pathToFileURL(path.join(__dirname, 'renderer', 'index.html'));

function isExpectedOnlineBackupRendererUrl(value) {
  try {
    const candidate = new URL(value);
    return candidate.protocol === ONLINE_BACKUP_RENDERER_URL.protocol
      && candidate.username === ONLINE_BACKUP_RENDERER_URL.username
      && candidate.password === ONLINE_BACKUP_RENDERER_URL.password
      && candidate.host === ONLINE_BACKUP_RENDERER_URL.host
      && candidate.pathname === ONLINE_BACKUP_RENDERER_URL.pathname
      && candidate.hash === '';
  } catch {
    return false;
  }
}

function isTrustedOnlineBackupIpcEvent(event) {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    const webContents = mainWindow.webContents;
    if (!webContents || webContents.isDestroyed()) return false;
    const mainFrame = webContents.mainFrame;
    if (!mainFrame || event?.sender !== webContents || event.senderFrame !== mainFrame) return false;
    if (mainFrame.url !== webContents.getURL()) return false;
    return isExpectedOnlineBackupRendererUrl(mainFrame.url);
  } catch {
    return false;
  }
}

function invokeTrustedOnlineBackupIpc(event, operation) {
  if (!isTrustedOnlineBackupIpcEvent(event)) {
    return { ok: false, error: 'Online-Sicherungsanfrage wurde abgewiesen' };
  }
  return operation();
}

function requireCanonicalOnlineBackupId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(id)) {
    throw new Error('Online-Sicherungs-ID ist ungültig');
  }
  const decoded = Buffer.from(id, 'base64url');
  if (decoded.length !== 16 || decoded.toString('base64url') !== id) {
    throw new Error('Online-Sicherungs-ID ist ungültig');
  }
  return id;
}

function clearCloseFlushTimer() {
  if (closeFlushTimer) clearTimeout(closeFlushTimer);
  closeFlushTimer = null;
}

function waitForCloseOperation(promise, timeoutMs) {
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Speichern vor dem Beenden hat zu lange gedauert')), timeoutMs))
  ]);
}

function trackUploadProducer(manager) {
  let settled = false;
  let resolveProducer;
  const promise = new Promise(resolve => { resolveProducer = resolve; });
  const tracker = {
    manager,
    promise,
    finish() {
      if (settled) return;
      settled = true;
      activeUploadProducerTrackers.delete(tracker);
      resolveProducer();
    }
  };
  activeUploadProducerTrackers.add(tracker);
  return tracker;
}

function isClosePreparationActive(attempt) {
  return closeFlushRequested && !closeFlushApproved && attempt === closePreparationAttempt;
}

function acquireCloseQuiesce(attempt) {
  if (!isClosePreparationActive(attempt)) return false;
  if (closeQuiesceOwnerAttempt !== null && closeQuiesceOwnerAttempt !== attempt) return false;
  closeQuiesceOwnerAttempt = attempt;
  configStore.setWritesQuiesced(true);
  return true;
}

function releaseCloseQuiesce(attempt) {
  if (closeQuiesceOwnerAttempt !== attempt) return false;
  closeQuiesceOwnerAttempt = null;
  configStore.setWritesQuiesced(false);
  return true;
}

function rejectPendingUpdate(error) {
  if (!preparedUpdate && !updateQuitPending) return false;
  preparedUpdate = null;
  updateQuitPending = false;
  preparedUpdateLaunchStarted = false;
  safeSend('app:update-progress', {
    stage: 'error',
    error: error && error.message ? error.message : String(error || 'Einstellungen konnten vor dem Update nicht gespeichert werden')
  });
  return true;
}

function restoreClosePreparation(attempt, clearRestart = true) {
  if (!isClosePreparationActive(attempt)) return lastRestoredCloseAttempt === attempt;
  closeFlushApproved = false;
  closeFlushRequested = false;
  clearCloseFlushTimer();
  releaseCloseQuiesce(attempt);
  lastRestoredCloseAttempt = attempt;
  if (clearRestart) restartAfterClosePreparation = false;
  if (closeFolderMonitorWasRunning) {
    closeFolderMonitorWasRunning = false;
    const settings = configStore.load().globalSettings?.folderMonitor;
    if (settings?.enabled && settings.folderPath) {
      void startFolderMonitor(settings).catch(error => debugLog(`folder-monitor close recovery failed: ${error.message}`));
    }
  }
  rejectPendingUpdate(new Error('Das Update wurde nicht gestartet, weil die Einstellungen vor dem Beenden nicht gespeichert werden konnten'));
  return true;
}

function armCloseFlushTimer(attempt, timeoutMs) {
  clearCloseFlushTimer();
  closeFlushTimer = setTimeout(() => {
    closeFlushTimer = null;
    restoreClosePreparation(attempt);
  }, timeoutMs);
}

function requestClosePreparation() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed() || !closeHandshakeReady) return false;
  if (closeFlushRequested) return true;
  const attempt = ++closePreparationAttempt;
  closeFlushRequested = true;
  closeFolderMonitorWasRunning = !!folderMonitor.running;
  try { stopFolderMonitor(); } catch {}
  try { if (uploadManager) uploadManager.cancel(); } catch {}
  (async () => {
    try {
      await waitForCloseOperation(Promise.all(Array.from(activeUploadProducerTrackers, tracker => tracker.promise)), 2500);
      if (attempt !== closePreparationAttempt || !closeFlushRequested) return;
      safeSend('app:prepare-close', attempt);
      armCloseFlushTimer(attempt, 1500);
    } catch {
      restoreClosePreparation(attempt);
    }
  })();
  return true;
}

const _hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!_hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });
}
// Rotation memory that survives batch-done → new UploadManager within the
// same app session. Without this, clicking "Retry failed" after a batch
// ended would burn the full retry budget on accounts we already know are
// dead. Cleared on app restart (which is the user's signal for "try fresh").
let _sessionAccountPauseRevision = 0;
function _accountPauseSnapshot(records, cause = 'snapshot') {
  return {
    version: 2,
    revision: _sessionAccountPauseRevision,
    now: Date.now(),
    cause,
    accounts: Array.isArray(records) ? records : []
  };
}
function _publishAccountPauseState(records, cause) {
  _sessionAccountPauseRevision++;
  safeSend('session-failed-accounts-changed', _accountPauseSnapshot(records, cause));
}
const _accountCooldowns = createAccountCooldownController({
  onClearAccount: (hoster, accountId) => {
    if (uploadManager && typeof uploadManager.clearFailedAccount === 'function') {
      try { uploadManager.clearFailedAccount(hoster, accountId); } catch {}
    }
  },
  onChange: _publishAccountPauseState
});
const _sessionAccountOverrides = new Map(); // hoster -> account object

// Per-job log collector: backs the right-click "Log anzeigen" modal so the
// user can see the full rot-log + status trail for a single file without
// grepping account-rotation.log. Ring buffer per job keeps memory bounded.
const _jobLogCollector = new Map(); // jobId -> Array<entry>
const _MAX_LOG_ENTRIES_PER_JOB = 200;
// Cap the total number of jobs we keep history for — without this the Map
// keeps growing across batch-done boundaries (only start-upload clears it).
// 1000 jobs × 200 entries × ~100 bytes ≈ 20 MB worst case, bounded.
const _MAX_TRACKED_JOBS = 1000;
function _appendJobLog(jobId, entry) {
  if (!jobId) return;
  let arr = _jobLogCollector.get(jobId);
  if (!arr) {
    arr = [];
    _jobLogCollector.set(jobId, arr);
    // Evict oldest tracked job (insertion order) once we're past the cap.
    // Map iteration is insertion-ordered in spec, so .keys().next() is FIFO.
    if (_jobLogCollector.size > _MAX_TRACKED_JOBS) {
      const oldestId = _jobLogCollector.keys().next().value;
      if (oldestId !== undefined) _jobLogCollector.delete(oldestId);
    }
  }
  if (arr.length >= _MAX_LOG_ENTRIES_PER_JOB) arr.shift();
  arr.push(entry);
}
const folderMonitor = new FolderMonitor();
let remoteServer = null;
let captureWindow = null;
let captureWindowReady = false;
let signalingQueue = [];
const HEALTH_CHECK_TIMEOUT = 25000;

// --- Debug logging (writes to upload-debug.log next to the app) ---
function getDebugLogPath() {
  const baseDir = app.isPackaged
    ? path.dirname(process.execPath)
    : __dirname;
  return path.join(baseDir, 'upload-debug.log');
}

// Buffered async writer: debugLog is called hundreds of times per second during
// busy uploads (unhandledRejection traces, progress transitions, folder-monitor
// events). Sync appendFileSync per call blocked the main event loop. We now
// queue lines in memory and flush on a short interval / on process exit.
const _debugLogBuffer = [];
let _debugLogFlushTimer = null;
let _debugLogWriting = false;

// 25 MB cap for upload-debug.log + 10 MB for account-rotation.log. Each
// keeps 2 numbered backups, so the on-disk worst case is bounded:
// upload-debug ~75 MB, account-rotation ~30 MB. Reuses the same
// lib/log-rotation.js helper that fileuploader.log already uses.
const DEBUG_LOG_MAX_BYTES = 25 * 1024 * 1024;
const ROT_LOG_MAX_BYTES = 10 * 1024 * 1024;
const INTERNAL_LOG_MAX_BACKUPS = 2;
const _resolveInternalLogPath = createInternalLogPathResolver({
  fs,
  path,
  userDataPath: app.getPath('userData')
});
const _rotLogWriter = createInternalLogWriter({
  fs,
  path,
  fileName: 'account-rotation.log',
  resolveInternalLogPath: _resolveInternalLogPath,
  rotateLogFile: maybeRotateLogFile,
  maxBytes: ROT_LOG_MAX_BYTES,
  maxBackups: INTERNAL_LOG_MAX_BACKUPS,
  reportError: (label, error) => debugLog(`${label} append failed: ${error.message}`)
});

function _flushDebugLog() {
  if (_debugLogWriting || _debugLogBuffer.length === 0) return;
  const chunk = _debugLogBuffer.join('');
  _debugLogBuffer.length = 0;
  _debugLogWriting = true;
  const target = getDebugLogPath();
  // Pass a noop logger here — debugLog() is THIS file's writer, recursing
  // into it would deadlock the buffer/timer state.
  maybeRotateLogFile(target, DEBUG_LOG_MAX_BYTES, INTERNAL_LOG_MAX_BACKUPS, () => {});
  fs.appendFile(target, chunk, 'utf-8', () => {
    _debugLogWriting = false;
    // If more lines arrived during the write, flush them next tick.
    if (_debugLogBuffer.length) setImmediate(_flushDebugLog);
  });
}

function debugLog(msg) {
  try {
    const ts = new Date().toISOString();
    _debugLogBuffer.push(`[${ts}] ${msg}\n`);
    if (!_debugLogFlushTimer) {
      _debugLogFlushTimer = setTimeout(() => {
        _debugLogFlushTimer = null;
        _flushDebugLog();
      }, 500);
    }
  } catch {}
}

let _logVerbose = false;
function setLogVerbose(v) { _logVerbose = !!v; try { require('./lib/doodstream-upload').setDebugVerbose(_logVerbose); } catch {} }
function _ctxTag(ctx) {
  if (!ctx || typeof ctx !== 'object') return '';
  const tags = [];
  if (ctx.batch) tags.push(`b:${String(ctx.batch).slice(0, 8)}`);
  if (ctx.job) tags.push(`j:${String(ctx.job).slice(-8)}`);
  if (ctx.hoster) tags.push(ctx.hoster);
  if (ctx.attempt !== undefined && ctx.attempt !== null) tags.push(`a:${ctx.attempt}`);
  return tags.length ? `[${tags.join(' ')}] ` : '';
}
function _split(a, b) {
  if (typeof a === 'string') return { ctx: null, msg: a, extra: b };
  return { ctx: a, msg: b, extra: arguments[2] };
}
function logDebug(a, b) {
  if (!_logVerbose) return;
  const s = _split(a, b);
  debugLog(`[DEBUG] ${_ctxTag(s.ctx)}${s.msg}`);
}
function logInfo(a, b) {
  const s = _split(a, b);
  debugLog(`[INFO ] ${_ctxTag(s.ctx)}${s.msg}`);
}
function logError(a, b, c) {
  let ctx, msg, err;
  if (typeof a === 'string') { ctx = null; msg = a; err = b; }
  else { ctx = a; msg = b; err = c; }
  const errStr = err ? ` :: ${err.stack || err.message || err}` : '';
  debugLog(`[ERROR] ${_ctxTag(ctx)}${msg}${errStr}`);
}
function logMarker(label, fields) {
  let extra = '';
  if (fields && typeof fields === 'object') {
    extra = ' ' + Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' ');
  }
  debugLog(`────── ${label}${extra} ──────`);
}

function _maybeLogEventLoopDelay(activeJobs) {
  const now = Date.now();
  if (now - _eldLastLog < 5000) return;
  _eldLastLog = now;
  try {
    const ns = 1e6;
    const mean = (_eventLoopDelay.mean / ns).toFixed(1);
    const max = (_eventLoopDelay.max / ns).toFixed(1);
    const p99 = (_eventLoopDelay.percentile(99) / ns).toFixed(1);
    const stddev = (_eventLoopDelay.stddev / ns).toFixed(1);
    let resStr = '';
    try {
      const info = process.getActiveResourcesInfo();
      const hist = {};
      for (const t of info) hist[t] = (hist[t] || 0) + 1;
      const top = Object.entries(hist).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k}:${v}`).join(',');
      resStr = ` resources=${info.length} {${top}}`;
    } catch {}
    let cpuStr = '';
    try {
      const d = process.cpuUsage(_lastCpu);
      const wall = now - _lastCpuT;
      const pct = wall > 0 ? Math.round((d.user + d.system) / 1000 / wall * 100) : 0;
      const mem = process.memoryUsage();
      const rss = Math.round(mem.rss / 1048576);
      const heap = Math.round(mem.heapUsed / 1048576);
      const ext = Math.round(mem.external / 1048576);
      const ab = Math.round((mem.arrayBuffers || 0) / 1048576);
      cpuStr = ` cpu=${pct}%core rss=${rss}MB heap=${heap}MB ext=${ext}MB ab=${ab}MB`;
      _lastCpu = process.cpuUsage();
      _lastCpuT = now;
    } catch {}
    let gcStr = '';
    try {
      gcStr = ` gc=${_gcCount} gcTotal=${_gcTotalMs.toFixed(0)}ms gcMax=${_gcMaxMs.toFixed(0)}ms`;
      _gcCount = 0; _gcTotalMs = 0; _gcMaxMs = 0;
    } catch {}
    let upStr = '';
    try {
      if (uploadManager && typeof uploadManager.getDiagnostics === 'function') {
        const d = uploadManager.getDiagnostics();
        const byHoster = Object.entries(d.activeByHoster || {}).map(([h, c]) => `${h.replace(/\..*$/, '')}:${c}`).join(',');
        upStr = ` active-by-hoster={${byHoster}} transient-errs=${d.transientErrors || 0} pending=${d.pending || 0}`;
      }
    } catch {}
    logInfo(`eventloop-delay active=${activeJobs} mean=${mean}ms p99=${p99}ms max=${max}ms stddev=${stddev}ms threadpool=${process.env.UV_THREADPOOL_SIZE}${cpuStr}${gcStr}${resStr}${upStr}`);
    _eventLoopDelay.reset();
  } catch {}
}

function getRotLogPath() {
  return _rotLogWriter.getPath();
}
const _rotLogBuffer = [];
let _rotLogFlushTimer = null;
const _rotLogFlusher = createBufferedInternalLogFlusher({
  buffer: _rotLogBuffer,
  writer: _rotLogWriter,
  schedule: setImmediate,
  reportError: (label, error) => debugLog(`${label} append failed: ${error.message}`)
});

function _flushRotLog() {
  void _rotLogFlusher.flush('rot-log').then(written => {
    if (written === false) debugLog('rot-log append failed: no writable target');
  });
}

function getAllLogPaths() {
  const configuredUpload = getLogFilePath();
  const uploadTarget = _resolveUploadLogTarget();
  const upload = uploadTarget ? uploadTarget.path : configuredUpload;
  const debugPath = getDebugLogPath();
  const rot = getRotLogPath();
  const dir = path.dirname(debugPath);
  return {
    fileuploader: upload,
    uploadAudit: _uploadAuditWriter.getPath(),
    debug: debugPath,
    accountRotation: rot,
    doodstreamDebug: path.join(dir, 'doodstream-debug.log'),
    crashLog: path.join(dir, 'crash.log'),
    logDir: dir
  };
}

function rotLog(msg, ts) {
  try {
    const iso = new Date(ts || Date.now()).toISOString();
    const line = `[${iso}] ${msg}\n`;
    _rotLogBuffer.push(line);
    if (!_rotLogFlushTimer) {
      _rotLogFlushTimer = setTimeout(() => { _rotLogFlushTimer = null; _flushRotLog(); }, 500);
    }
    _debugLogBuffer.push(`[${iso}] [ROT] ${msg}\n`);
    if (!_debugLogFlushTimer) {
      _debugLogFlushTimer = setTimeout(() => { _debugLogFlushTimer = null; _flushDebugLog(); }, 500);
    }
  } catch {}
}

function _sleepMs(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function _postWebhookWithRetry(req, maxAttempts) {
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        signal: AbortSignal.timeout(10_000)
      });
      if (res.status === 429) {
        let waitMs = 2000 * attempt;
        try {
          const ra = res.headers.get('retry-after');
          if (ra) waitMs = Math.min(60_000, Math.max(waitMs, Math.ceil(parseFloat(ra) * 1000)));
        } catch {}
        debugLog(`webhook: 429 rate-limited, retrying in ${waitMs}ms (attempt ${attempt}/${maxAttempts})`);
        if (attempt < maxAttempts) { await _sleepMs(waitMs); continue; }
        return { ok: false, status: 429 };
      }
      if (res.status >= 200 && res.status < 300) {
        return { ok: true, status: res.status };
      }
      if (res.status >= 400 && res.status < 500) {
        debugLog(`webhook: client error HTTP ${res.status} — not retrying (check URL/payload)`);
        return { ok: false, status: res.status };
      }
      debugLog(`webhook: server error HTTP ${res.status} (attempt ${attempt}/${maxAttempts})`);
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
      debugLog(`webhook: send error: ${err && err.message ? err.message : err} (attempt ${attempt}/${maxAttempts})`);
    }
    if (attempt < maxAttempts) await _sleepMs(2000 * attempt);
  }
  return { ok: false, error: lastErr && lastErr.message ? lastErr.message : String(lastErr) };
}

async function sendBatchWebhook(summary, durationSec, extra) {
  try {
    const gs = configStore.load().globalSettings || {};
    const url = String(gs.webhookUrl || '').trim();
    if (!url || !/^https?:\/\//i.test(url)) return { ok: false, skipped: true };
    const req = buildWebhookRequest(url, summary, {
      durationSec: Math.max(0, Number(durationSec) || 0),
      appVersion: app.getVersion(),
      machineName: require('os').hostname() || 'unknown-host',
      mention: gs.webhookMention || '',
      language: gs.language || 'en',
      aborted: !!(extra && extra.aborted),
      timestamp: new Date().toISOString()
    });
    const result = await _postWebhookWithRetry(req, 3);
    if (result.ok) debugLog(`webhook: sent batch-done notification (HTTP ${result.status})`);
    else debugLog(`webhook: gave up after retries (${result.status || result.error || 'unknown'})`);
    return result;
  } catch (err) {
    debugLog(`webhook: build failed: ${err && err.message ? err.message : err}`);
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

function safeSend(channel, data) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  try {
    mainWindow.webContents.send(channel, data);
    return true;
  } catch (err) {
    debugLog(`safeSend(${channel}) failed: ${err && err.message ? err.message : err}`);
    return false;
  }
}

function _writeCrashLog(prefix, err, extra) {
  try {
    const ts = new Date().toISOString();
    const line = `[${ts}] ${prefix} ${err && err.stack ? err.stack : (err && err.message) || String(err)}${extra ? ' :: ' + JSON.stringify(extra) : ''}\n`;
    try {
      const target = getDebugLogPath();
      fs.appendFileSync(target, line, 'utf-8');
    } catch {}
    try {
      const crashDir = path.dirname(getDebugLogPath());
      fs.appendFileSync(path.join(crashDir, 'crash.log'), line, 'utf-8');
    } catch {}
  } catch {}
}

process.on('unhandledRejection', (reason) => {
  debugLog(`UNHANDLED REJECTION: ${reason && reason.stack ? reason.stack : reason}`);
  _writeCrashLog('UNHANDLED REJECTION', reason);
});

process.on('uncaughtException', (err, origin) => {
  _writeCrashLog('UNCAUGHT EXCEPTION (' + origin + ')', err);
  debugLog(`UNCAUGHT EXCEPTION (${origin}): ${err && err.stack ? err.stack : err}`);
});

process.on('exit', (code) => {
  try { _writeCrashLog('PROCESS EXIT', new Error('code=' + code)); } catch {}
});

process.on('warning', (warning) => {
  debugLog(`PROCESS WARNING: ${warning.name} ${warning.message}`);
});

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  try {
    process.on(sig, () => {
      _writeCrashLog('SIGNAL ' + sig, new Error('process received ' + sig));
      try {
        if (_debugLogBuffer.length) fs.appendFileSync(getDebugLogPath(), _debugLogBuffer.join(''), 'utf-8');
      } catch {}
      process.exit(0);
    });
  } catch {}
}

function withTimeout(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} Timeout`));
    }, timeoutMs);

    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function normalizeApiError(payload, fallback) {
  if (!payload || typeof payload !== 'object') return fallback;
  const msg = String(payload.msg || payload.message || '').trim();
  if (msg) return msg;
  if (payload.status) return `API Status ${payload.status}`;
  return fallback;
}

function getDefaultLogFilePath() {
  // In packaged builds the exe dir is %LOCALAPPDATA%\Programs\Multi-Hoster-Upload
  // — a hidden, install-managed location that NSIS may even prune on
  // uninstall. Default to the user's Desktop so the file is actually
  // findable; fall back to userData if Desktop isn't available, and
  // finally to the project dir in dev mode.
  if (app.isPackaged) {
    try {
      const desktop = app.getPath('desktop');
      if (desktop) return path.join(desktop, 'fileuploader.log');
    } catch {}
    try {
      return path.join(app.getPath('userData'), 'fileuploader.log');
    } catch {}
    return path.join(path.dirname(process.execPath), 'fileuploader.log');
  }
  return path.join(__dirname, 'fileuploader.log');
}

// The log flush paths resolve the log file ~8x/second during uploads. Going
// through configStore.load() there meant re-reading + cloning the whole config
// (incl. an 8 MB+ history) on every flush — a major long-running main-thread
// drag. logFilePath/logMode change only when the user saves settings, so cache
// the two strings and invalidate on those saves (see _invalidateLogSettings).
function _setLogSettingsSnapshot(globalSettings) {
  const settings = globalSettings || {};
  _cachedLogSettings = {
    logFilePath: String(settings.logFilePath || '').trim(),
    logMode: settings.logMode || 'single'
  };
}
function _getLogSettings() {
  return _cachedLogSettings || { logFilePath: '', logMode: 'single' };
}
function _invalidateLogSettings(globalSettings) {
  _setLogSettingsSnapshot(globalSettings);
  _invalidateUploadLogEvidenceCache();
}

function getBaseLogFilePath() {
  const customPath = _getLogSettings().logFilePath;
  return customPath || getDefaultLogFilePath();
}

// Log-mode bookkeeping. Three modes (see lib/log-mode.js): single, daily, session.
// The session-id is stamped ONCE at main-process startup so every write of a
// given session lands in the same file. A close→reopen of the app starts a new
// main process, so a new SESSION_ID, so a new session file. A 6-digit random is
// appended as a cheap hedge against same-minute restart collisions.
const { resolveLogFileName, formatSessionStamp, formatDateStamp, stripModeStampFromFileName, isManagedUploadLogFileName } = require('./lib/log-mode');
const SESSION_ID = formatSessionStamp(new Date(), String(Math.floor(100000 + Math.random() * 900000)));
let _activeLogKey = null;   // remembers (mode + date-or-session) so cache rolls correctly
let _activeLogPath = null;

function getLogFilePath() {
  const mode = _getLogSettings().logMode;
  const base = getBaseLogFilePath();
  const dir = path.dirname(base);
  const ext = path.extname(base);
  const name = path.basename(base, ext);
  const now = new Date();
  // Cache key changes when the user toggles mode mid-run OR when the daily date
  // rolls over at midnight — so the cached path can't be served stale.
  const datePart = mode === 'daily' ? formatDateStamp(now) : '';
  const key = `${mode}|${datePart}|${SESSION_ID}|${base}`;
  if (_activeLogKey !== key) {
    _activeLogPath = path.join(dir, resolveLogFileName({ baseName: name, ext, mode, date: now, sessionId: SESSION_ID }));
    _activeLogKey = key;
  }
  return _activeLogPath;
}

function buildFallbackLogName(dir) {
  // Match the active log-mode's naming so the fallback file is consistent with
  // what the primary write would have produced.
  const mode = _getLogSettings().logMode;
  return path.join(dir, resolveLogFileName({ baseName: 'fileuploader', ext: '.log', mode, date: new Date(), sessionId: SESSION_ID }));
}

function getSafeDesktopDir() {
  try {
    const desktop = app.getPath('desktop');
    if (desktop && fs.existsSync(desktop)) return desktop;
  } catch {}
  return null;
}

let _uploadLogFallbackWarned = false;
// Buffer upload-log lines so a burst of completing jobs (e.g. 20 files finishing
// within a second) becomes one file write instead of 20 sync writes.
const _uploadLogBuffer = [];
let _uploadLogFlushTimer = null;
let _uploadLogWriting = false;

// Cache the resolved upload-log target across flushes — mkdirSync + path
// assembly on every 500ms flush during uploads is wasted work once we've
// confirmed a writable directory. Invalidated when the user changes the log
// path or when the daily-log date rolls over.
let _cachedUploadLogTarget = null;
let _cachedUploadLogKey = '';

function _invalidateUploadLogTargetCache() {
  _cachedUploadLogTarget = null;
  _cachedUploadLogKey = '';
}

function _resolveUploadLogTarget(excludedPath) {
  const primary = getLogFilePath();
  // The primary path already encodes the mode + date/session, so it changes
  // when the user toggles mode, daily rolls at midnight, or this is a new
  // process — cache invalidates naturally on path change.
  const key = primary;
  if (_cachedUploadLogKey === key && _cachedUploadLogTarget && _cachedUploadLogTarget.path !== excludedPath) return _cachedUploadLogTarget;

  const commit = (t) => {
    _cachedUploadLogTarget = t;
    _cachedUploadLogKey = key;
    return t;
  };

  // Try primary → desktop → userData, mirror the original fallback ladder.
  if (primary !== excludedPath) {
    try {
      fs.mkdirSync(path.dirname(primary), { recursive: true });
      return commit({ path: primary, isFallback: false });
    } catch (err) {
      debugLog(`uploadLog primary dir unavailable (${err.message})`);
    }
  }
  const desktop = getSafeDesktopDir();
  if (desktop) {
    try {
      const p = buildFallbackLogName(desktop);
      if (p !== excludedPath) {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        return commit({ path: p, isFallback: true });
      }
    } catch {}
  }
  try {
    const p = buildFallbackLogName(app.getPath('userData'));
    if (p === excludedPath) return null;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    return commit({ path: p, isFallback: true });
  } catch (err) {
    debugLog(`uploadLog: no writable target (${err.message})`);
    return null;
  }
}

// Cap the upload log file size. Beyond this we rotate to .1 (and shift
// older numbered backups up) so a multi-month-running install can't fill
// the disk. 50 MB ≈ ~600k log lines, plenty for human inspection.
const UPLOAD_LOG_MAX_BYTES = 50 * 1024 * 1024;
const UPLOAD_LOG_MAX_BACKUPS = 3;
const _uploadAuditWriter = createUploadAuditWriter({
  fs,
  path,
  resolveInternalLogPath: _resolveInternalLogPath,
  rotateLogFile: maybeRotateLogFile,
  reportError: (label, error) => debugLog(`${label} audit append failed: ${error.message}`)
});

function _flushUploadLog() {
  if (_uploadLogWriting || _uploadLogBuffer.length === 0) return;
  const target = _resolveUploadLogTarget();
  if (!target) { _uploadLogBuffer.length = 0; return; }
  // Guard against the file's parent directory having been deleted/moved
  // since the cache was filled. mkdirSync(recursive:true) is a no-op when
  // the dir already exists; recreates it otherwise. Without this, every
  // subsequent flush silently fails with ENOENT and entries are lost.
  try { fs.mkdirSync(path.dirname(target.path), { recursive: true }); } catch {}
  // Cheap size check + rotation right before the append, so we never grow
  // a single log file beyond the cap regardless of session length.
  maybeRotateLogFile(target.path, UPLOAD_LOG_MAX_BYTES, UPLOAD_LOG_MAX_BACKUPS, debugLog);
  const chunk = _uploadLogBuffer.join('');
  _uploadLogBuffer.length = 0;
  _uploadLogWriting = true;
  fs.appendFile(target.path, chunk, 'utf-8', (err) => {
    _uploadLogWriting = false;
    if (err) {
      debugLog(`uploadLog append failed: ${err.message}`);
      // Recovery: drop the cached target so the next flush re-resolves
      // (could be ENOENT after dir delete, ENOSPC, EBUSY etc.) and
      // restore the chunk so we don't lose entries on the retry.
      _invalidateUploadLogTargetCache();
      _uploadLogBuffer.unshift(chunk);
      // Retry on the next event-loop tick rather than tight-looping.
      if (!_uploadLogFlushTimer) {
        _uploadLogFlushTimer = setTimeout(() => {
          _uploadLogFlushTimer = null;
          _flushUploadLog();
        }, 1000);
      }
    } else {
      _invalidateUploadLogEvidenceCache();
      if (target.isFallback && !_uploadLogFallbackWarned) {
        _uploadLogFallbackWarned = true;
        // Auto-persist the working fallback into the user's config so the
        // next session writes here directly (no more fallback ladder) and
        // the Settings input reflects reality.
        _persistFallbackLogPath(target.path);
        safeSend('upload-log-fallback', { fallbackPath: target.path });
      }
    }
    if (_uploadLogBuffer.length && !_uploadLogFlushTimer) setImmediate(_flushUploadLog);
  });
}

async function _persistFallbackLogPath(workingPath) {
  try {
    if (!settingsImportGate.canStartUpload()) return false;
    const cfg = configStore.load();
    const gs = cfg.globalSettings || {};
    const mode = gs.logMode || 'single';
    // Strip the mode-specific suffix so logFilePath stores the BARE base path.
    // Otherwise daily would compound into "...-2026-06-03-2026-06-04.log" and
    // session would compound a second session-stamp onto the first — which split
    // a session's lines across two files (the first few before _persistFallback
    // ran, the rest after, into the doubly-stamped path). gated on logMode (the
    // legacy `sessionLog` field is no longer the source of truth).
    let toSave = workingPath;
    if (mode === 'daily' || mode === 'session') {
      const dir = path.dirname(workingPath);
      const base = path.basename(workingPath);
      toSave = path.join(dir, stripModeStampFromFileName(base));
    }
    if (gs.logFilePath === toSave) return true;
    gs.logFilePath = toSave;
    cfg.globalSettings = gs;
    await configStore.save({ globalSettings: gs });
    _invalidateUploadLogTargetCache();
    _invalidateLogSettings(gs);
    safeSend('log-path-auto-updated', { logFilePath: toSave });
    return true;
  } catch (err) {
    debugLog(`persist fallback logpath failed: ${err.message}`);
    return false;
  }
}

// Whether this hoster's successful links should land in fileuploader.log.
// Reads the LIVE uploadManager.hosterSettings (kept current via
// updateSettings) so a mid-batch toggle takes effect immediately. Falls back
// to the persisted config if no batch is active, then defaults to enabled.
function shouldLogHosterToFile(hoster) {
  const live = uploadManager && uploadManager.hosterSettings ? uploadManager.hosterSettings : null;
  if (live) return hosterLogToFileEnabled(live, hoster);
  try {
    return hosterLogToFileEnabled(configStore.load().hosterSettings, hoster);
  } catch {
    return true;
  }
}

function appendUploadLog(hoster, link, fileName) {
  _uploadLogBuffer.push(formatUploadLogLine(new Date(), hoster, link, fileName));
  if (!_uploadLogFlushTimer) {
    _uploadLogFlushTimer = setTimeout(() => {
      _uploadLogFlushTimer = null;
      _flushUploadLog();
    }, 500);
  }
}

async function appendUploadAuditLine(line, label) {
  return _uploadAuditWriter.append(line, label);
}

async function appendSourceCleanupAudit(event) {
  debugLog(`source-cleanup: ${event.outcome} ${event.file} trigger=${event.trigger || '-'}`);
  return appendUploadAuditLine(`# SOURCE-CLEANUP ${JSON.stringify(event)}\r\n`, 'source-cleanup');
}

async function appendUploadPlanAudit(plan, mode) {
  debugLog(`upload-plan: mode=${mode} files=${plan.fileCount} destinations=${plan.destinationCount} uploads=${plan.plannedUploadCount}`);
  return appendUploadAuditLine(formatUploadPlanLogLine(new Date(), plan, mode), 'upload-plan');
}

function flattenHistoryForExport(history) {
  const rows = [];
  const list = Array.isArray(history) ? history : [];

  for (const batch of list) {
    const batchId = batch && batch.id ? String(batch.id) : '';
    const rawTs = batch && batch.timestamp ? String(batch.timestamp) : '';
    const parsedTs = rawTs ? new Date(rawTs) : null;
    const batchTimestamp = parsedTs && !Number.isNaN(parsedTs.getTime())
      ? parsedTs.toISOString()
      : rawTs;
    const files = Array.isArray(batch && batch.files) ? batch.files : [];

    for (const file of files) {
      const fileName = file && file.name ? String(file.name) : '';
      const filePath = file && file.path ? String(file.path) : '';
      const fileSize = Number.isFinite(Number(file && file.size)) ? Number(file.size) : '';
      const results = Array.isArray(file && file.results) ? file.results : [];

      if (results.length === 0) {
        rows.push({
          batchId,
          batchTimestamp,
          fileName,
          filePath,
          fileSize,
          hoster: '',
          status: '',
          link: '',
          error: ''
        });
        continue;
      }

      for (const result of results) {
        // Only accept real URLs. file_code alone is just an opaque ID and
        // ends up looking like "nur sone Nummerierung" in the CSV.
        const rawLink = result && (result.download_url || result.embed_url) || '';
        const link = /^https?:\/\//i.test(String(rawLink)) ? String(rawLink) : '';
        rows.push({
          batchId,
          batchTimestamp,
          fileName,
          filePath,
          fileSize,
          hoster: result && result.hoster ? String(result.hoster) : '',
          status: result && result.status ? String(result.status) : '',
          link,
          error: result && (result.error || result.message) ? String(result.error || result.message) : ''
        });
      }
    }
  }

  return rows;
}

function toCsvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function buildHistoryCsv(rows) {
  const header = [
    'Batch ID',
    'Batch Timestamp',
    'File Name',
    'File Path',
    'File Size Bytes',
    'Hoster',
    'Status',
    'Link',
    'Error'
  ];
  const lines = [header.map(toCsvCell).join(',')];
  for (const row of rows) {
    lines.push([
      row.batchId,
      row.batchTimestamp,
      row.fileName,
      row.filePath,
      row.fileSize,
      row.hoster,
      row.status,
      row.link,
      row.error
    ].map(toCsvCell).join(','));
  }
  return `${lines.join('\n')}\n`;
}

// --- Multi-account helpers ---
function hosterAccountHasCreds(name, account) {
  if (!account) return false;
  if (account.authType === 'api') return !!account.apiKey;
  if (account.authType === 'login') return !!(account.username && account.password);
  // Fallback for old format
  if (name === 'vidmoly.me') return !!(account.username && account.password);
  if (name === 'voe.sx' || name === 'doodstream.com') return !!(account.username && account.password) || !!account.apiKey;
  if (name === 'clouddrop.cc') return !!account.apiKey;
  return !!account.apiKey;
}

function getNextFallbackAccount(config, hosterName, failedAccountId) {
  const accounts = config.hosters[hosterName];
  if (!Array.isArray(accounts)) return null;
  const failedIndex = accounts.findIndex(a => a.id === failedAccountId);
  if (failedIndex < 0) return null;
  for (let i = failedIndex + 1; i < accounts.length; i++) {
    if (accounts[i].enabled !== false && hosterAccountHasCreds(hosterName, accounts[i])) {
      return accounts[i];
    }
  }
  return null;
}

function buildAccountPools(config) {
  const pools = {};
  const all = config && config.hosters ? config.hosters : {};
  for (const [hoster, accounts] of Object.entries(all)) {
    if (!Array.isArray(accounts)) continue;
    const usable = accounts.filter(a => a && a.enabled !== false && hosterAccountHasCreds(hoster, a));
    if (usable.length > 0) pools[hoster] = usable;
  }
  return pools;
}

function buildTaskFromAccount(hoster, account, extra) {
  const task = { ...extra, hoster, accountId: account.id, ...selectUploadAuth(hoster, account) };
  return task;
}

let _rotationCursors = null;
function rotationCursors() {
  if (_rotationCursors === null) {
    const persisted = configStore.load().rotationCursors;
    _rotationCursors = (persisted && typeof persisted === 'object') ? { ...persisted } : {};
  }
  return _rotationCursors;
}

function makeAccountPicker(config) {
  return createAccountPicker({
    hosters: config.hosters,
    hosterSettings: config.hosterSettings,
    hasCreds: hosterAccountHasCreds,
    indices: rotationCursors()
  });
}

function persistRotation(pick) {
  if (!pick.dirty()) return;
  _rotationCursors = { ...rotationCursors(), ...pick.indices() };
  configStore.saveRotationCursors(_rotationCursors).catch(error => debugLog(`rotation cursor save failed: ${error.message}`));
}

function buildUploadTasks(config, files, hosters, pick) {
  const tasks = [];
  for (const file of files) {
    for (const hoster of hosters) {
      const account = pick(hoster);
      if (!account) { debugLog(`  skip ${hoster}: no enabled account with creds`); continue; }
      tasks.push(buildTaskFromAccount(hoster, account, { file }));
    }
  }
  return tasks;
}

function buildUploadTasksFromJobs(config, jobs, pick) {
  if (!Array.isArray(jobs)) return [];
  const tasks = [];
  for (const job of jobs) {
    if (!job || !job.file || !job.hoster) continue;
    const account = pick(job.hoster);
    if (!account) { debugLog(`  skip ${job.hoster}: no enabled account`); continue; }
    tasks.push(buildTaskFromAccount(job.hoster, account, {
      file: job.file,
      jobId: job.id || job.jobId || null,
      sourceCleanupToken: job.sourceCleanupToken || null
    }));
  }
  return tasks;
}

async function registerAutomationCompletionJobs(manager, jobs) {
  if (!manager || !Array.isArray(jobs)) return;
  if (!manager._automationCompletionMetadata) manager._automationCompletionMetadata = new Map();
  const folderSettings = configStore.load().globalSettings?.folderMonitor || {};
  const candidates = jobs.filter(job => {
    const monitoredManualJob = folderSettings.enabled === true && isPathWithinAutomationFolder(job?.file, folderSettings.folderPath, folderSettings.recursive === true);
    return (job?.automationAdmission === true || monitoredManualJob) && job.id && job.file && job.hoster;
  });
  let cursor = 0;
  const hasFiniteMetadata = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
  async function worker() {
    while (cursor < candidates.length) {
      const job = candidates[cursor++];
      const sourceSize = job.sourceSize ?? job.automationSize ?? job.bytesTotal;
      const sourceMtimeMs = job.sourceMtimeMs ?? job.automationMtimeMs;
      let size = hasFiniteMetadata(sourceSize) ? Number(sourceSize) : Number.NaN;
      let mtimeMs = hasFiniteMetadata(sourceMtimeMs) ? Number(sourceMtimeMs) : Number.NaN;
      if (!Number.isFinite(size) || !Number.isFinite(mtimeMs)) {
        try {
          const stat = await fs.promises.stat(job.file);
          size = Number(stat.size);
          mtimeMs = Number(stat.mtimeMs);
        } catch {}
      }
      if (!Number.isFinite(size) || !Number.isFinite(mtimeMs)) continue;
      manager._automationCompletionMetadata.set(job.id, {
        path: job.file,
        size,
        mtimeMs,
        hoster: job.hoster
      });
    }
  }
  await Promise.all(Array.from({ length: Math.min(16, candidates.length) }, worker));
}

async function checkDoodstreamHealth(hosterConfig, otp) {
  const username = hosterConfig && hosterConfig.username
    ? String(hosterConfig.username).trim()
    : '';
  const password = hosterConfig && hosterConfig.password
    ? String(hosterConfig.password).trim()
    : '';

  // Login-based check (preferred)
  if (username && password) {
    const uploader = new DoodstreamUploader();
    try {
      await uploader.login(username, password, otp || undefined);
    } catch (err) {
      if (err.otpRequired) {
        return { status: 'otp_required', message: err.message || 'OTP erforderlich' };
      }
      throw err;
    }
    return { status: 'ok', message: 'Login ok, Upload-Seite bereit' };
  }

  // Fall back to API key check
  const apiKey = hosterConfig && hosterConfig.apiKey
    ? String(hosterConfig.apiKey).trim()
    : '';

  if (!apiKey) {
    return { status: 'error', message: 'Login oder API Key fehlt' };
  }

  const apiBase = HOSTER_CONFIGS['doodstream.com'].apiBase;

  const accountRes = await fetch(`${apiBase}/api/account/info?key=${encodeURIComponent(apiKey)}`, {
    method: 'GET',
    redirect: 'follow'
  });
  const accountPayload = await accountRes.json().catch(() => null);
  if (!accountPayload || typeof accountPayload !== 'object') {
    return { status: 'error', message: 'Account-Check lieferte kein gültiges JSON' };
  }

  if (Number(accountPayload.status || 0) !== 200) {
    return {
      status: 'error',
      message: normalizeApiError(accountPayload, 'Account-Check fehlgeschlagen')
    };
  }

  const serverRes = await fetch(`${apiBase}/api/upload/server?key=${encodeURIComponent(apiKey)}`, {
    method: 'GET',
    redirect: 'follow'
  });
  const serverPayload = await serverRes.json().catch(() => null);
  if (!serverPayload || typeof serverPayload !== 'object') {
    return { status: 'warn', message: 'Upload-Server-Check lieferte kein gültiges JSON' };
  }

  const serverResult = serverPayload.result;
  if (typeof serverResult === 'string' && /^https?:\/\//i.test(serverResult.trim())) {
    return { status: 'ok', message: 'API Key gültig, Upload-Server verfügbar' };
  }

  const serverMsg = String(serverPayload.msg || serverPayload.message || '').trim();
  if (/no servers available/i.test(serverMsg)) {
    return {
      status: 'warn',
      message: 'API Key gültig, aktuell kein Server von API (Uploader nutzt Fallback)'
    };
  }

  return {
    status: 'warn',
    message: serverMsg || 'API Key gültig, Upload-Server aktuell nicht geliefert'
  };
}

async function checkVidmolyHealth(hosterConfig) {
  const username = hosterConfig && hosterConfig.username
    ? String(hosterConfig.username).trim()
    : '';
  const password = hosterConfig && hosterConfig.password
    ? String(hosterConfig.password).trim()
    : '';

  if (!username || !password) {
    return { status: 'error', message: 'Username oder Passwort fehlt' };
  }

  const uploader = new VidmolyUploader();
  await uploader.login(username, password);
  const { uploadUrl, fileFieldName } = await uploader.getUploadParams();

  if (!uploadUrl || !/^https?:\/\//i.test(uploadUrl)) {
    return { status: 'error', message: 'Upload-URL wurde nicht erkannt' };
  }

  return {
    status: 'ok',
    message: `Login ok, Upload-Form bereit (Dateifeld: ${fileFieldName || 'file'})`
  };
}

async function checkVoeHealth(hosterConfig) {
  const username = hosterConfig && hosterConfig.username
    ? String(hosterConfig.username).trim()
    : '';
  const password = hosterConfig && hosterConfig.password
    ? String(hosterConfig.password).trim()
    : '';

  if (!username || !password) {
    // Fall back to API key check if no login
    const apiKey = hosterConfig && hosterConfig.apiKey
      ? String(hosterConfig.apiKey).trim()
      : '';
    if (!apiKey) {
      return { status: 'error', message: 'Login oder API Key fehlt' };
    }
    // Quick API check
    const res = await fetch(`https://voe.sx/api/upload/server?key=${encodeURIComponent(apiKey)}`, { method: 'GET' });
    const data = await res.json().catch(() => null);
    if (data && data.result && typeof data.result === 'string' && /^https?:\/\//i.test(data.result.trim())) {
      return { status: 'ok', message: 'API Key gültig, Upload-Server verfügbar' };
    }
    const msg = data && (data.msg || data.message) ? String(data.msg || data.message).trim() : '';
    if (/no servers/i.test(msg)) {
      return { status: 'warn', message: 'API Key gültig, aktuell kein Server verfügbar' };
    }
    return { status: 'error', message: msg || 'API Key ungültig oder Server nicht erreichbar' };
  }

  const uploader = new VoeUploader();
  await uploader.login(username, password);
  const { csrfToken } = await uploader._getUploadParams();

  if (!csrfToken) {
    return { status: 'error', message: 'Login ok, aber Upload-Seite liefert kein CSRF-Token' };
  }

  return {
    status: 'ok',
    message: 'Login ok, Upload-Seite bereit'
  };
}

async function checkByseHealth(hosterConfig) {
  const apiKey = hosterConfig && hosterConfig.apiKey
    ? String(hosterConfig.apiKey).trim()
    : '';

  if (!apiKey) {
    return { status: 'error', message: 'API Key fehlt' };
  }

  const apiBase = 'https://api.byse.sx';

  const serverRes = await fetch(`${apiBase}/upload/server?key=${encodeURIComponent(apiKey)}`, {
    method: 'GET',
    redirect: 'follow'
  });
  const serverPayload = await serverRes.json().catch(() => null);

  if (!serverPayload || typeof serverPayload !== 'object') {
    return { status: 'error', message: 'API lieferte kein gültiges JSON' };
  }

  const serverResult = serverPayload.result;
  if (typeof serverResult === 'string' && /^https?:\/\//i.test(serverResult.trim())) {
    return { status: 'ok', message: 'API Key gültig, Upload-Server verfügbar' };
  }

  const msg = String(serverPayload.msg || serverPayload.message || '').trim();

  // Byse API returns { msg: "OK", result: <server-url> } on success.
  // If msg is "OK" but result wasn't a valid URL, treat as success with warning.
  if (/^ok$/i.test(msg)) {
    return { status: 'ok', message: 'API Key gültig' };
  }

  if (msg) {
    return { status: 'error', message: msg };
  }

  return { status: 'error', message: 'API Key ungültig oder Server nicht erreichbar' };
}

async function checkClouddropHealth(hosterConfig) {
  const apiKey = hosterConfig && hosterConfig.apiKey
    ? String(hosterConfig.apiKey).trim()
    : '';
  if (!apiKey) return { status: 'error', message: 'API Key fehlt' };
  try {
    const uploader = new ClouddropUploader(apiKey);
    await uploader.checkAuth();
    return { status: 'ok', message: 'API Key gültig' };
  } catch (err) {
    return { status: 'error', message: err && err.message ? err.message : 'Clouddrop Auth fehlgeschlagen' };
  }
}

// requestedChecks can be:
// - array of strings (hoster names) for legacy/all-accounts check
// - array of { hoster, accountId } for specific account checks
async function runHosterHealthCheck(config, requestedChecks) {
  const allowed = ['doodstream.com', 'vidmoly.me', 'voe.sx', 'byse.sx', 'clouddrop.cc'];

  // Normalize input to [{ hoster, accountId? }]
  let checks;
  if (!Array.isArray(requestedChecks) || requestedChecks.length === 0) {
    // Check all accounts for all hosters
    checks = [];
    for (const name of allowed) {
      const accounts = config.hosters[name];
      if (Array.isArray(accounts)) {
        for (const acc of accounts) {
          if (hosterAccountHasCreds(name, acc)) checks.push({ hoster: name, accountId: acc.id });
        }
      }
    }
  } else if (typeof requestedChecks[0] === 'string') {
    // Legacy: array of hoster names — check all accounts for each
    checks = [];
    for (const name of requestedChecks) {
      const accounts = config.hosters[name];
      if (Array.isArray(accounts)) {
        for (const acc of accounts) {
          if (hosterAccountHasCreds(name, acc)) checks.push({ hoster: name, accountId: acc.id });
        }
      }
    }
  } else {
    checks = requestedChecks;
  }

  {
    const seen = new Set();
    const cleaned = [];
    for (const c of checks) {
      if (!c || !c.hoster) continue;
      if (!c.accountId) { cleaned.push({ ...c, _invalid: true }); continue; }
      const key = `${c.hoster}|${c.accountId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cleaned.push(c);
    }
    checks = cleaned;
  }

  const runOne = async ({ hoster, accountId, otp, _invalid }) => {
    if (_invalid) {
      return { hoster, accountId, status: 'error', message: 'Account-ID fehlt im Check-Payload' };
    }
    if (!allowed.includes(hoster)) {
      return { hoster, accountId, status: 'skipped', message: 'Kein Health-Check für diesen Hoster' };
    }
    const accounts = config.hosters[hoster];
    const hosterConfig = Array.isArray(accounts) ? accounts.find(a => a.id === accountId) : null;
    try {
      const result = await _dispatchHealthCheck(hoster, hosterConfig, otp || '');
      return { hoster, accountId, ...result };
    } catch (err) {
      return { hoster, accountId, status: 'error', message: err && err.message ? err.message : 'Health-Check fehlgeschlagen' };
    }
  };

  const groups = new Map();
  for (const c of checks) {
    if (!groups.has(c.hoster)) groups.set(c.hoster, []);
    groups.get(c.hoster).push(c);
  }
  const groupResults = await Promise.all(Array.from(groups.values()).map(async (group) => {
    const out = [];
    for (const c of group) {
      out.push(await runOne(c));
    }
    return out;
  }));
  const indexByCheck = new Map();
  groupResults.flat().forEach((r) => { indexByCheck.set(`${r.hoster}|${r.accountId || ''}`, r); });
  const results = checks.map(c => indexByCheck.get(`${c.hoster}|${c.accountId || ''}`));

  return { checkedAt: new Date().toISOString(), results };
}

function createWindow() {
  const startupWindow = createStartupWindow(BrowserWindow, {
    title: 'Multi Hoster Uploader',
    width: 1100,
    height: 750,
    minWidth: 800,
    minHeight: 550,
    backgroundColor: '#0f0f0f',
    icon: path.join(__dirname, 'assets', 'app_icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  mainWindow = startupWindow.window;
  closePreparationAttempt++;
  closeFlushApproved = false;
  closeFlushRequested = false;
  closeHandshakeReady = false;
  folderMonitorLifecycleGeneration = 0;
  folderMonitorRendererGeneration = 0;
  folderMonitorRendererReadyGeneration = null;
  folderMonitorStartupReconcile = null;
  closeQuiesceOwnerAttempt = null;
  lastRestoredCloseAttempt = null;
  configStore.setWritesQuiesced(false);
  clearCloseFlushTimer();

  mainWindow.on('close', (event) => {
    if (closeFlushApproved || !closeHandshakeReady || mainWindow.webContents.isDestroyed()) return;
    event.preventDefault();
    requestClosePreparation();
  });

  mainWindow.on('closed', () => {
    folderMonitorRendererReadyGeneration = null;
    invalidateFolderMonitorLifecycle();
  });

  mainWindow.webContents.setBackgroundThrottling(false);

  mainWindow.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isInPlace || !isMainFrame) return;
    closeHandshakeReady = false;
    folderMonitorRendererGeneration++;
    folderMonitorRendererReadyGeneration = null;
    updateAnnouncementState.reset();
    restoreClosePreparation(closePreparationAttempt);
  });

  mainWindow.webContents.on('did-finish-load', () => {
    safeSend('folder-monitor:renderer-generation', folderMonitorRendererGeneration);
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    folderMonitorRendererReadyGeneration = null;
    _writeCrashLog('RENDER PROCESS GONE', new Error(details.reason || 'unknown'), details);
    debugLog(`RENDER PROCESS GONE: reason=${details.reason} exitCode=${details.exitCode}`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        const choice = dialog.showMessageBoxSync(mainWindow, {
          type: 'error',
          title: shellText('Renderer abgestürzt', 'Renderer crashed'),
          message: shellText(`Der Renderer-Prozess ist abgestürzt (${details.reason}).`, `The renderer process crashed (${details.reason}).`),
          detail: shellText('Bitte Diagnose-Paket exportieren und einsenden. Klick "Neu laden" um die UI wiederherzustellen — laufende Uploads im Main-Process bleiben aktiv.', 'Export and send a diagnostics package. Click "Reload" to restore the interface; uploads running in the main process remain active.'),
          buttons: [shellText('Neu laden', 'Reload'), shellText('Beenden', 'Quit')],
          defaultId: 0,
          cancelId: 1
        });
        if (choice === 0) {
          mainWindow.webContents.reload();
        } else {
          app.exit(1);
        }
      } catch {
        try { mainWindow.webContents.reload(); } catch {}
      }
    }
  });

  mainWindow.webContents.on('unresponsive', () => {
    _writeCrashLog('RENDERER UNRESPONSIVE', new Error('webContents unresponsive'));
    debugLog('RENDERER UNRESPONSIVE');
  });

  mainWindow.webContents.on('responsive', () => {
    debugLog('RENDERER RESPONSIVE AGAIN');
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    _writeCrashLog('DID-FAIL-LOAD', new Error(errorDescription), { errorCode, validatedURL });
    debugLog(`DID-FAIL-LOAD: ${errorCode} ${errorDescription} url=${validatedURL}`);
  });

  app.on('child-process-gone', (_event, details) => {
    _writeCrashLog('CHILD PROCESS GONE', new Error(details.reason || 'unknown'), details);
    debugLog(`CHILD PROCESS GONE: type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`);
  });

  let startupQuery = createStartupQuery(null, app.getVersion());
  try { startupQuery = createStartupQuery(configStore.load(), app.getVersion()); } catch {}
  startupWindow.load(path.join(__dirname, 'renderer', 'index.html'), (err) => {
    _writeCrashLog('LOAD FILE FAILED', err);
    debugLog(`LOAD FILE FAILED: ${err && err.stack ? err.stack : err}`);
  }, { query: startupQuery });
}

function createTray() {
  try {
    const candidates = [
      path.join(process.resourcesPath || __dirname, 'assets', 'app_icon.ico'),
      path.join(__dirname, 'assets', 'app_icon.ico'),
      path.join(__dirname, 'assets', 'icon.png')
    ];
    let icon = null;
    for (const p of candidates) {
      try {
        const img = nativeImage.createFromPath(p);
        if (img && !img.isEmpty()) { icon = img; break; }
      } catch {}
    }
    tray = new Tray(icon || nativeImage.createEmpty());
    refreshTrayLanguage();

    tray.on('click', () => {
      if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
    });
  } catch (err) {
    tray = null;
    debugLog(`createTray failed (non-fatal): ${err && err.message ? err.message : err}`);
  }
}

function updateTrayTooltip(text) {
  if (tray && !tray.isDestroyed()) tray.setToolTip(text);
}

function announceAvailableUpdate(result) {
  if (!updateAnnouncementState.canAnnounce(result, closeHandshakeReady)) return false;
  if (!safeSend('app:update-available', result)) return false;
  updateAnnouncementState.markAnnounced(result);
  return true;
}

async function runAutomaticUpdateCheck(forceRefresh) {
  try {
    logInfo('update-check: starting');
    const result = await checkForUpdate({ forceRefresh });
    logInfo(`update-check: available=${result && result.available}, remote=${result && result.remoteVersion}`);
    logDebug(`update-check result: ${JSON.stringify(result)}`);
    announceAvailableUpdate(result);
  } catch (err) {
    logError('update-check failed', err);
  }
}

app.whenReady().then(async () => {
  if (!_hasSingleInstanceLock) return;
  try {
    const _bootCfg = configStore.load();
    setLogVerbose(!!(_bootCfg.globalSettings && _bootCfg.globalSettings.logVerbose));
  } catch {}
  logMarker('APP START', {
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    verbose: _logVerbose,
    pid: process.pid
  });
  _sweepOrphanConfigTmps();
  sourceDeleteJournal = new SourceDeleteJournal(
    path.join(app.getPath('userData'), 'source-delete-journal.jsonl')
  );
  try {
    const outcomes = await sourceDeleteJournal.recover();
    for (const outcome of outcomes) {
      debugLog(`source-delete recovery: ${outcome.outcome} ${outcome.file}`);
      await appendSourceCleanupAudit({
        timestamp: new Date().toISOString(),
        outcome: `recovery-${outcome.outcome}`,
        file: outcome.file,
        hosters: [],
        trigger: 'startup-delete-journal'
      });
    }
  } catch (error) {
    debugLog(`source-delete recovery failed: ${error.message}`);
  }
  createWindow();
  createTray();

  // Minimize to tray instead of taskbar
  mainWindow.on('minimize', () => {
    mainWindow.hide();
  });

  try {
    const launchConfig = configStore.load();
    const fm = launchConfig.globalSettings && launchConfig.globalSettings.folderMonitor;
    if (fm && fm.enabled && fm.folderPath) {
      await startFolderMonitor(fm, { deferStartupReconcile: true });
    }
  } catch (err) {
    debugLog(`folder-monitor auto-start failed: ${err.message}`);
  }

  // Auto-start remote server if enabled
  try {
    const _remCfg = configStore.load();
    const remoteConfig = _remCfg.globalSettings && _remCfg.globalSettings.remote;
    if (remoteConfig && remoteConfig.enabled) {
      startRemoteServer().catch(err => {
        debugLog(`remote-server auto-start failed: ${err.message}`);
      });
    }
    const diagConfig = _remCfg.globalSettings && _remCfg.globalSettings.diagnostics;
    if (diagConfig && diagConfig.enabled) {
      startDiagnosticAgent().catch(err => {
        debugLog(`diagnostics-agent auto-start failed: ${err.message}`);
      });
    }
  } catch (err) {
    debugLog(`remote-server auto-start failed: ${err.message}`);
  }

  // Auto-show drop target if enabled
  try {
    const dtConfig = configStore.load();
    if (dtConfig.globalSettings && dtConfig.globalSettings.showDropTarget) {
      createDropTargetWindow();
    }
  } catch {}

  void runAutomaticUpdateCheck(true);
  updateCheckInterval = setInterval(() => { void runAutomaticUpdateCheck(true); }, 5 * 60 * 1000);
  updateCheckInterval.unref?.();
});

app.on('window-all-closed', () => {
  const activeJobs = uploadManager && typeof uploadManager.getActiveJobCount === 'function' ? uploadManager.getActiveJobCount() : 0;
  debugLog(`window-all-closed: activeJobs=${activeJobs}, uploadManager=${!!uploadManager}`);
  _writeCrashLog('WINDOW-ALL-CLOSED', new Error('all windows closed'), { activeJobs, uploadManager: !!uploadManager });
  app.quit();
});

app.on('before-quit', (event) => {
  if (!closeFlushApproved && mainWindow && !mainWindow.isDestroyed() && closeHandshakeReady) {
    event.preventDefault();
    requestClosePreparation();
  }
});

app.on('will-quit', () => {
  if (quitTeardownStarted) return;
  quitTeardownStarted = true;
  folderMonitorRendererReadyGeneration = null;
  if (updateCheckInterval) clearInterval(updateCheckInterval);
  updateCheckInterval = null;
  if (preparedUpdate && updateQuitPending && closeFlushApproved && !preparedUpdateLaunchStarted) {
    preparedUpdateLaunchStarted = true;
    try {
      launchPreparedUpdate(preparedUpdate);
    } catch (error) {
      logError('prepared update launch failed', error);
    }
  }
  preparedUpdate = null;
  updateQuitPending = false;
  if (restartAfterClosePreparation) app.relaunch();
  if (uploadManager) try { uploadManager.cancel(); } catch {}
  try { stopFolderMonitor(); } catch {}
  try {
    if (remoteServer) { remoteServer.stop(); remoteServer = null; }
    destroyCaptureWindow();
  } catch {}
  try { stopDiagnosticAgent(); } catch {}
  try { destroyDropTargetWindow(); } catch {}
  try { if (tray && !tray.isDestroyed()) { tray.destroy(); tray = null; } } catch {}
  // Flush pending log buffers synchronously so no lines are lost.
  try {
    if (_debugLogBuffer.length) {
      fs.appendFileSync(getDebugLogPath(), _debugLogBuffer.join(''), 'utf-8');
      _debugLogBuffer.length = 0;
    }
  } catch {}
  try {
    if (_uploadLogBuffer.length) {
      const target = _resolveUploadLogTarget();
      if (target) fs.appendFileSync(target.path, _uploadLogBuffer.join(''), 'utf-8');
      _uploadLogBuffer.length = 0;
    }
  } catch {}
  try {
    if (_rotLogBuffer.length) {
      _rotLogFlusher.flushSync('rot-log');
    }
  } catch {}
});

// --- IPC Handlers ---

// Debug log from renderer
ipcMain.handle('debug-log', (_event, msg) => {
  debugLog(`[RENDERER] ${msg}`);
  return true;
});

ipcMain.handle('get-config', () => {
  return configStore.load();
});

ipcMain.handle('save-config', async (_event, config) => {
  assertConfigWriteAllowed();
  await configStore.save(config);
  if (config && config.globalSettings) _invalidateLogSettings(config.globalSettings);
  try {
    if (config && config.globalSettings && Object.prototype.hasOwnProperty.call(config.globalSettings, 'logVerbose')) {
      setLogVerbose(!!config.globalSettings.logVerbose);
    }
  } catch {}
  // If a batch is running and some accounts got marked failed before any
  // fallback existed, re-resolve now — the user may have just added one.
  // Without this re-probe, those accounts stay stuck with no override until
  // the app restarts, and every subsequent job wastes an attempt on them.
  if (uploadManager && typeof uploadManager.getFailedAccountKeys === 'function') {
    try {
      const cfg = configStore.load();
      const keys = uploadManager.getFailedAccountKeys();
      for (const key of keys) {
        const sep = key.indexOf(':');
        if (sep < 0) continue;
        const hoster = key.slice(0, sep);
        const failedAccountId = key.slice(sep + 1);
        if (uploadManager.getOverride(hoster)) continue; // already has a fallback
        const fallback = getNextFallbackAccount(cfg, hoster, failedAccountId);
        if (fallback) {
          rotLog(`main: config-updated → late fallback ${fallback.id} for ${hoster} (was stuck on ${failedAccountId})`);
          uploadManager.switchAccount(hoster, fallback);
          _sessionAccountOverrides.set(hoster, fallback);
          safeSend('account-switched', {
              hoster, fromAccountId: failedAccountId, toAccountId: fallback.id
            });
        }
      }
    } catch (err) {
      debugLog(`save-config re-resolve failed: ${err && err.message ? err.message : err}`);
    }
  }
  if (uploadManager && typeof uploadManager.updateAccountPools === 'function') {
    try {
      uploadManager.updateAccountPools(buildAccountPools(configStore.load()));
    } catch (err) {
      debugLog(`save-config pool refresh failed: ${err && err.message ? err.message : err}`);
    }
  }
  return true;
});

ipcMain.handle('get-history', () => {
  return configStore.loadHistory();
});

ipcMain.handle('prune-history', async (_event, payload) => {
  const retention = payload && payload.retention;
  const dryRun = !!(payload && payload.dryRun);
  if (!dryRun) assertConfigWriteAllowed();
  return configStore.pruneHistory(retention, { dryRun });
});

ipcMain.handle('save-text-file', async (_event, defaultName, content, filters) => {
  const safeName = String(defaultName || `export-${new Date().toISOString().slice(0, 10)}.txt`);
  const safeFilters = Array.isArray(filters) && filters.length
    ? filters
    : [{ name: 'Textdatei', extensions: ['txt', 'csv', 'log'] }];
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: shellText('Speichern unter', 'Save as'),
    defaultPath: safeName,
    filters: safeFilters
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  fs.writeFileSync(filePath, String(content === null || content === undefined ? '' : content), 'utf-8');
  return { ok: true, path: filePath };
});

ipcMain.handle('export-history', async (_event, format) => {
  const normalizedFormat = String(format || 'csv').toLowerCase() === 'json' ? 'json' : 'csv';
  const history = configStore.loadHistory();
  const rows = flattenHistoryForExport(history);
  const datePrefix = new Date().toISOString().slice(0, 10);

  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: shellText('Upload-Verlauf exportieren', 'Export upload history'),
    defaultPath: `upload-history-${datePrefix}.${normalizedFormat}`,
    filters: normalizedFormat === 'json'
      ? [{ name: shellText('JSON-Datei', 'JSON file'), extensions: ['json'] }]
      : [{ name: shellText('CSV-Datei', 'CSV file'), extensions: ['csv'] }]
  });

  if (canceled || !filePath) return { ok: false, canceled: true };

  if (normalizedFormat === 'json') {
    const payload = {
      exportedAt: new Date().toISOString(),
      totalBatches: Array.isArray(history) ? history.length : 0,
      totalRows: rows.length,
      history
    };
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');
  } else {
    fs.writeFileSync(filePath, buildHistoryCsv(rows), 'utf-8');
  }

  return {
    ok: true,
    path: filePath,
    format: normalizedFormat,
    totalBatches: Array.isArray(history) ? history.length : 0,
    totalRows: rows.length
  };
});

ipcMain.handle('run-health-check', async (_event, payload) => {
  const config = configStore.load();
  const hosters = payload && Array.isArray(payload.hosters) ? payload.hosters : [];
  return runHosterHealthCheck(config, hosters);
});

// Validate ephemeral credentials WITHOUT persisting them to config.hosters.
// This is the IPC that backs the two-step "Prüfen → Anlegen" modal flow: the
// new account is never on disk until the user confirms after a green check, so
// failed/OTP-pending creds can't leak into config (and a double-click on the
// Prüfen button cannot create duplicates because nothing is written until the
// second, distinct "Anlegen" click). NOTE: this payload carries plaintext creds
// across the IPC boundary — same trust level as save-config — DO NOT log it.
ipcMain.handle('validate-credentials', async (_event, payload) => {
  if (!payload || !payload.hoster) {
    return { status: 'error', message: 'Hoster fehlt' };
  }
  const ephemeralHosterConfig = {
    username: payload.username || '',
    password: payload.password || '',
    apiKey: payload.apiKey || '',
    enabled: true
  };
  try {
    return await _dispatchHealthCheck(payload.hoster, ephemeralHosterConfig, payload.otp || '');
  } catch (err) {
    return { status: 'error', message: err && err.message ? err.message : 'Validierung fehlgeschlagen' };
  }
});

async function _dispatchHealthCheck(hoster, hosterConfig, otp) {
  // Mirrors the per-hoster switch in runHosterHealthCheck so both code paths
  // (batch check by accountId and ephemeral validate) go through identical
  // checkers + timeout wrappers and surface identical result shapes.
  if (hoster === 'doodstream.com') {
    return withTimeout(checkDoodstreamHealth(hosterConfig, otp), HEALTH_CHECK_TIMEOUT, 'Doodstream-Check');
  }
  if (hoster === 'vidmoly.me') {
    return withTimeout(checkVidmolyHealth(hosterConfig), HEALTH_CHECK_TIMEOUT, 'Vidmoly-Check');
  }
  if (hoster === 'voe.sx') {
    return withTimeout(checkVoeHealth(hosterConfig), HEALTH_CHECK_TIMEOUT, 'VOE-Check');
  }
  if (hoster === 'byse.sx') {
    return withTimeout(checkByseHealth(hosterConfig), HEALTH_CHECK_TIMEOUT, 'Byse-Check');
  }
  if (hoster === 'clouddrop.cc') {
    return withTimeout(checkClouddropHealth(hosterConfig), HEALTH_CHECK_TIMEOUT, 'Clouddrop-Check');
  }
  return { status: 'skipped', message: 'Kein Health-Check für diesen Hoster' };
}

function getUploadBrowseDirectory() {
  const savedDirectory = configStore.load().globalSettings.lastBrowseDirectory;
  if (savedDirectory) {
    try {
      if (fs.statSync(savedDirectory).isDirectory()) return savedDirectory;
    } catch {}
  }
  return app.getPath('downloads');
}

function getConfiguredLanguage() {
  try { return configStore.load().globalSettings?.language === 'de' ? 'de' : 'en'; }
  catch { return 'en'; }
}

function shellText(german, english) {
  return getConfiguredLanguage() === 'de' ? german : english;
}

function refreshTrayLanguage() {
  if (!tray || tray.isDestroyed()) return;
  tray.setToolTip('Multi Hoster Uploader');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: shellText('Öffnen', 'Open'), click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
    { type: 'separator' },
    { label: shellText('Beenden', 'Quit'), click: () => { app.quit(); } }
  ]));
}

async function rememberUploadBrowseDirectory(selectedPath, selectedDirectory = false) {
  if (!selectedPath) return;
  const directory = selectedDirectory ? selectedPath : path.dirname(selectedPath);
  await configStore.saveLastBrowseDirectory(directory);
}

ipcMain.handle('select-files', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    defaultPath: getUploadBrowseDirectory(),
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: shellText('Alle Dateien', 'All files'), extensions: ['*'] },
      { name: shellText('Videos', 'Videos'), extensions: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm'] }
    ]
  });
  if (result.canceled || !result.filePaths.length) return null;
  await rememberUploadBrowseDirectory(result.filePaths[0]);
  return result.filePaths;
});

// Debug self-test: runs a minimal upload in the main process to verify events work
ipcMain.handle('debug-test-upload', async () => {
  if (configStore.load().globalSettings?.folderMonitor?.paused === true) {
    return { error: 'Automatik ist pausiert' };
  }
  const testFile = path.join(__dirname, 'test-self-check.txt');
  try {
    fs.writeFileSync(testFile, 'selftest ' + Date.now(), 'utf-8');
    const mgr = new UploadManager({ 'voe.sx': { retries: 0, parallelCount: 1, maxSpeedKbs: 0, restartBelowKbs: 0, timeIntervalSec: 0, maxSizeMb: 0 } });
    const events = [];
    return new Promise((resolve) => {
      mgr.on('progress', (data) => { events.push({ s: data.status, e: data.error || null }); });
      mgr.on('batch-done', (summary) => {
        try { fs.unlinkSync(testFile); } catch {}
        resolve({ ok: true, events, summary: { ok: summary.succeeded, fail: summary.failed } });
      });
      mgr.startBatch([{ file: testFile, hoster: 'voe.sx', apiKey: 'invalid-test-key' }]);
      setTimeout(() => {
        try { fs.unlinkSync(testFile); } catch {}
        resolve({ ok: false, events, timeout: true });
      }, 20000);
    });
  } catch (err) {
    try { fs.unlinkSync(testFile); } catch {}
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    defaultPath: getUploadBrowseDirectory(),
    properties: ['openDirectory', 'multiSelections']
  });
  if (result.canceled || !result.filePaths.length) return null;
  await rememberUploadBrowseDirectory(result.filePaths[0], true);

  const files = [];
  for (const folder of result.filePaths) files.push(...await walkFolderAsync(folder));
  return files.length > 0 ? files.map(f => f.path) : null;
});

ipcMain.handle('select-folder-with-sizes', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    defaultPath: getUploadBrowseDirectory(),
    properties: ['openDirectory', 'multiSelections']
  });
  if (result.canceled || !result.filePaths.length) return null;
  await rememberUploadBrowseDirectory(result.filePaths[0], true);

  const files = [];
  for (const folder of result.filePaths) files.push(...await walkFolderAsync(folder));
  return files.length > 0 ? files : null;
});

ipcMain.handle('resolve-folder-files', async (_event, folderPath) => {
  return walkFolderAsync(folderPath);
});

ipcMain.handle('export-session-report', async (_event, format) => {
  if (!lastSessionSummary) return { ok: false, error: 'Für diese Sitzung liegt noch kein abgeschlossener Upload vor' };
  const normalizedFormat = String(format || 'csv').toLowerCase() === 'json' ? 'json' : 'csv';
  const report = buildSessionReport(lastSessionSummary);
  const datePrefix = new Date().toISOString().slice(0, 10);
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: shellText('Sitzungsbericht exportieren', 'Export session report'),
    defaultPath: `upload-session-report-${datePrefix}.${normalizedFormat}`,
    filters: normalizedFormat === 'json'
      ? [{ name: shellText('JSON-Datei', 'JSON file'), extensions: ['json'] }]
      : [{ name: shellText('CSV-Datei', 'CSV file'), extensions: ['csv'] }]
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  fs.writeFileSync(filePath, normalizedFormat === 'json' ? JSON.stringify(report, null, 2) : buildSessionReportCsv(report), 'utf-8');
  return { ok: true, path: filePath, format: normalizedFormat, totalRows: report.totals.total };
});

ipcMain.handle('get-file-sizes', async (_event, paths) => {
  if (!Array.isArray(paths)) return {};
  const fsp = fs.promises;
  const out = {};
  let i = 0;
  for (const p of paths) {
    try { out[p] = (await fsp.stat(p)).size; } catch { out[p] = 0; }
    if ((++i % 32) === 0) await new Promise(setImmediate);
  }
  return out;
});

ipcMain.handle('inspect-import-files', async (_event, payload) => {
  const input = payload && typeof payload === 'object' ? payload : {};
  return inspectImportEntries(input.entries, {
    existingPaths: input.existingPaths,
    concurrency: 8,
    inspectPath: filePath => inspectReadableImportPath(filePath, fs.promises.open)
  });
});

async function rejectPreparedUploadStart(manager, producerTracker, error, clearRecovery) {
  try { manager.cancel(); } catch {}
  if (uploadManager === manager) {
    uploadManager = null;
    globalThis._mhuUploadManagerRef = null;
  }
  producerTracker.finish();
  if (clearRecovery) {
    try { await configStore.saveUploadRecovery(null); } catch (cleanupError) {
      debugLog(`upload recovery state could not be cleared after rejected start: ${cleanupError.message}`);
    }
  }
  return { error };
}

function preparedUploadStartGate(manager) {
  if (uploadManager !== manager) return 'Upload-Start wurde verworfen';
  if (closeFlushRequested) return 'Die Anwendung wird gerade beendet';
  if (configStore.load().globalSettings?.folderMonitor?.paused === true) return 'Automatik ist pausiert';
  return '';
}

function observePreparedUploadAcceptance(batchPromise) {
  const settled = batchPromise && typeof batchPromise.then === 'function'
    ? batchPromise.then(
      () => ({ settled: true }),
      error => ({ rejected: true, error })
    )
    : Promise.resolve({ settled: true });
  return Promise.race([
    settled,
    new Promise(resolve => queueMicrotask(() => resolve({ accepted: true })))
  ]);
}

function startPreparedUploadBatch({ manager, tasks, producerTracker, recovery, isAutoRetry }) {
  return new Promise(resolve => {
    setImmediate(() => {
      void (async () => {
        let gateError = preparedUploadStartGate(manager);
        if (gateError) return rejectPreparedUploadStart(manager, producerTracker, gateError, false);
        try {
          await configStore.saveUploadRecovery(recovery);
        } catch {
          return rejectPreparedUploadStart(manager, producerTracker, 'Upload-Wiederherstellung konnte nicht vorbereitet werden', true);
        }
        gateError = preparedUploadStartGate(manager);
        if (gateError) return rejectPreparedUploadStart(manager, producerTracker, gateError, true);
        _accountCooldowns.releaseExpired();
        const pausedAccounts = _accountCooldowns.activeKeys();
        let batchPromise;
        try {
          batchPromise = manager.startBatch(tasks, {
            primeFailedAccounts: pausedAccounts,
            primeOverrides: Array.from(_sessionAccountOverrides.entries())
          });
        } catch {
          return rejectPreparedUploadStart(manager, producerTracker, 'Upload konnte nicht gestartet werden', true);
        }
        const acceptance = await observePreparedUploadAcceptance(batchPromise);
        if (acceptance.rejected) {
          return rejectPreparedUploadStart(manager, producerTracker, 'Upload konnte nicht gestartet werden', true);
        }
        if (acceptance.accepted) {
          Promise.resolve(batchPromise).catch((err) => {
            debugLog(`startBatch REJECTED: ${err && err.stack ? err.stack : err}`);
            const errorSummary = {
              id: 'error',
              timestamp: new Date().toISOString(),
              total: tasks.length,
              succeeded: 0,
              failed: tasks.length,
              files: [],
              error: err ? err.message : 'Unbekannter Fehler'
            };
            safeSend('upload-batch-done', errorSummary);
            configStore.saveUploadRecovery(null).catch(error => debugLog(`upload recovery state could not be cleared after start failure: ${error.message}`));
            producerTracker.finish();
            if (!isAutoRetry) sendBatchWebhook(errorSummary, 0);
            if (uploadManager === manager) { uploadManager = null; globalThis._mhuUploadManagerRef = null; }
          });
        }
        logMemorySnapshot('batch-start');
        return { started: true };
      })().then(resolve, async () => {
        resolve(await rejectPreparedUploadStart(manager, producerTracker, 'Upload konnte nicht gestartet werden', true));
      });
    });
  });
}

ipcMain.handle('start-upload', async (_event, payload) => {
  if (configStore.load().globalSettings?.folderMonitor?.paused === true) {
    return { error: 'Automatik ist pausiert' };
  }
  if (closeFlushRequested) return { error: 'Die Anwendung wird gerade beendet' };
  if (!settingsImportGate.canStartUpload()) return { error: 'Einstellungen werden gerade importiert' };
  if (uploadManager) {
    const existingManager = uploadManager;
    if (existingManager.running || !(await waitForUploadManagerRelease(existingManager)) || uploadManager) {
      return { error: 'Ein Upload wird bereits ausgeführt oder abgeschlossen' };
    }
  }
  const config = configStore.load();
  const files = payload && Array.isArray(payload.files) ? payload.files : [];
  const hosters = payload && Array.isArray(payload.hosters) ? payload.hosters : [];
  const jobs = payload && Array.isArray(payload.jobs) ? payload.jobs : [];
  const isAutoRetry = !!(payload && payload.isAutoRetry);
  const sourceCleanupGroups = payload && Array.isArray(payload.sourceCleanupGroups) ? payload.sourceCleanupGroups : [];
  const batchPlan = summarizeBatchPlan({ files, hosters, jobs });

  // At 500+ jobs JSON.stringify blew up the debug log with MB-sized lines
  // per start-upload and added noticeable delay — log counts only.
  logMarker('BATCH START', batchPlan);
  debugLog(`start-upload: files=${batchPlan.fileCount}, hosters=${batchPlan.destinationCount}, jobs=${batchPlan.plannedUploadCount}`);

  const pick = makeAccountPicker(config);
  const tasks = jobs.length > 0
    ? buildUploadTasksFromJobs(config, jobs, pick)
    : buildUploadTasks(config, files, hosters, pick);
  persistRotation(pick);

  // Identify jobs that were skipped (no account/credentials)
  const taskJobIds = new Set(tasks.map(t => t.jobId).filter(Boolean));
  const skippedJobs = jobs.filter(j => j.id && !taskJobIds.has(j.id)).map(j => ({
    jobId: j.id,
    file: j.file,
    fileName: j.fileName || path.basename(j.file || ''),
    size: Number(j.bytesTotal) || 0,
    hoster: j.hoster,
    reason: 'Kein gültiger Account für diesen Hoster'
  }));
  if (skippedJobs.length > 0) {
    debugLog(`  skipped ${skippedJobs.length} jobs: ${skippedJobs.map(s => s.hoster).join(', ')}`);
  }

  debugLog(`  tasks built: ${tasks.length}`);

  if (tasks.length === 0) {
    await appendUploadPlanAudit(batchPlan, 'start');
    if (configStore.load().globalSettings?.folderMonitor?.paused === true) {
      return { error: 'Automatik ist pausiert' };
    }
    const skippedSummary = stats.mergeSkippedIntoSummary({
      id: `skipped-${Date.now()}`,
      timestamp: new Date().toISOString(),
      total: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      files: []
    }, skippedJobs);
    try { await configStore.appendHistory(skippedSummary); } catch (error) {
      debugLog(`appendHistory for skipped jobs failed: ${error.message}`);
    }
    setImmediate(() => safeSend('upload-batch-done', skippedSummary));
    return { started: true, taskCount: 0, skippedJobs };
  }

  uploadManager = new UploadManager(config.hosterSettings || {}, config.globalSettings || {}, buildAccountPools(config));
  globalThis._mhuUploadManagerRef = uploadManager;
  const _thisManager = uploadManager;
  await registerAutomationCompletionJobs(_thisManager, jobs);

  await appendUploadPlanAudit(batchPlan, 'start');
  if (configStore.load().globalSettings?.folderMonitor?.paused === true) {
    if (uploadManager === _thisManager) { uploadManager = null; globalThis._mhuUploadManagerRef = null; }
    return { error: 'Automatik ist pausiert' };
  }

  const recovery = {
    id: `upload-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    startedAt: new Date().toISOString(),
    jobIds: tasks.map(task => task.jobId).filter(Boolean)
  };

  // Pre-resolve a fallback for every hoster that has one. Lets the upload
  // manager break out of the retry loop after a single generic failure and
  // try the alternate account immediately, instead of hammering a probably-
  // dead primary 5× before the account-failed event even fires. Doesn't
  // trigger pre-job-swap (which only fires when the current account is in
  // _failedAccounts), so jobs still start on the primary as expected.
  const hostersInBatch = new Set(tasks.map(t => t.hoster).filter(Boolean));
  for (const hoster of hostersInBatch) {
    if (_sessionAccountOverrides.has(hoster)) continue; // already learned from past batch
    const accounts = config.hosters && config.hosters[hoster];
    if (!Array.isArray(accounts) || accounts.length < 2) continue;
    const primary = accounts.find(a => a && a.enabled !== false && hosterAccountHasCreds(hoster, a));
    if (!primary) continue;
    const next = getNextFallbackAccount(config, hoster, primary.id);
    if (next) {
      _sessionAccountOverrides.set(hoster, next);
      rotLog(`main: pre-resolved fallback for ${hoster} → ${next.id} (primary ${primary.id} will try acc2 on first failure)`);
    }
  }

  // Fresh collector for this new batch — old entries from the previous
  // batch's jobs are dropped (user's signal for "fresh log" is starting a
  // new upload; addJobs during a running batch keeps them).
  _jobLogCollector.clear();

  const sourceCleanup = createSourceFileCleanup({
    fs,
    path,
    platform: process.platform,
    isEnabled: () => configStore.load().globalSettings?.deleteSourceAfterSuccessfulUpload === true,
    audit: appendSourceCleanupAudit,
    journal: sourceDeleteJournal
  });
  let sourceCleanupFingerprints;
  try {
    sourceCleanupFingerprints = await sourceCleanup.registerGroups(sourceCleanupGroups);
  } catch (error) {
    if (uploadManager === _thisManager) {
      uploadManager = null;
      globalThis._mhuUploadManagerRef = null;
    }
    return { error: `Quelldatei-Schutz konnte nicht vorbereitet werden: ${error.message}` };
  }
  if (configStore.load().globalSettings?.folderMonitor?.paused === true) {
    if (uploadManager === _thisManager) { uploadManager = null; globalThis._mhuUploadManagerRef = null; }
    try { await configStore.saveUploadRecovery(null); } catch (error) { debugLog(`upload recovery state could not be cleared after automation pause: ${error.message}`); }
    return { error: 'Automatik ist pausiert' };
  }
  for (const skipped of skippedJobs) sourceCleanup.markSkipped(skipped.jobId);
  _thisManager.sourceFileCleanup = sourceCleanup;
  const _producerTracker = trackUploadProducer(_thisManager);

  const _progressByJob = new Map();
  const _progressTerminalQueue = [];
  let _progressFlushTimer = null;
  const PROGRESS_BATCH_INTERVAL_MS = 100;
  function _scheduleProgressFlush() {
    if (_progressFlushTimer) return;
    _progressFlushTimer = setTimeout(() => {
      _progressFlushTimer = null;
      if (!mainWindow || mainWindow.isDestroyed()) {
        _progressByJob.clear();
        _progressTerminalQueue.length = 0;
        return;
      }
      const batch = _progressTerminalQueue.splice(0);
      for (const v of _progressByJob.values()) batch.push(v);
      _progressByJob.clear();
      if (batch.length) safeSend('upload-progress-batch', batch);
    }, PROGRESS_BATCH_INTERVAL_MS);
  }

  function _queueProgressForRenderer(data) {
    const isTerminal = data.status === 'done' || data.status === 'error' || data.status === 'aborted' || data.status === 'skipped';
    if (isTerminal) {
      if (data.jobId) _progressByJob.delete(data.jobId);
      _progressTerminalQueue.push(data);
    } else if (data.jobId) {
      _progressByJob.set(data.jobId, data);
    } else {
      _progressTerminalQueue.push(data);
    }
    _scheduleProgressFlush();
  }

  _thisManager._automationCompletionProgress = new Map();
  _thisManager._automationCompletionWriter = createAutomationCompletionWriter({
    schedule: callback => setTimeout(callback, 100),
    save: entries => configStore.saveAutomationCompletions(entries),
    onPersisted: entries => {
      for (const entry of entries) {
        const key = automationCompletionKey(entry);
        const progress = _thisManager._automationCompletionProgress.get(key);
        if (!progress) continue;
        _thisManager._automationCompletionProgress.delete(key);
        _queueProgressForRenderer(progress);
      }
    },
    onError: error => debugLog(`automation completion ledger failed: ${error.message}`)
  });

  uploadManager.on('progress', (data) => {
    if (data.status !== 'uploading') {
      debugLog(`progress: ${data.fileName} ${data.hoster} ${data.status} ${data.error || ''}`);
      _appendJobLog(data.jobId, {
        ts: Date.now(), kind: 'progress', status: data.status,
        hoster: data.hoster, accountId: data.accountId || null,
        error: data.error || null, attempt: data.attempt || 0, maxAttempts: data.maxAttempts || 0
      });
    }
    if (data.status === 'done' && data.result) {
      _invalidateUploadLogEvidenceCache();
      const link = data.result.download_url || data.result.embed_url || data.result.file_code || '';
      if (link) {
        if (shouldLogHosterToFile(data.hoster)) {
          appendUploadLog(data.hoster || '', link, data.fileName || '');
        } else {
          debugLog(`upload-log: skip ${data.fileName} @ ${data.hoster} (logToFile disabled for hoster)`);
        }
      } else {
        debugLog(`WARNING: done but no link for ${data.fileName} @ ${data.hoster}: ${JSON.stringify(data.result)}`);
      }
    }
    if (data.status === 'done' && data.jobId) {
      const completion = _thisManager._automationCompletionMetadata?.get(data.jobId);
      if (completion) {
        const entry = { ...completion, completedAt: Date.now() };
        _thisManager._automationCompletionProgress.set(automationCompletionKey(entry), data);
        _thisManager._automationCompletionWriter.add(entry);
        return;
      }
    }
    _queueProgressForRenderer(data);
  });

  uploadManager.on('stats', (data) => {
    try {
      if (!data || typeof data !== 'object') return;
      safeSend('upload-stats', data);
      if (data.state === 'uploading' && data.activeJobs > 0) {
        const speedMb = ((Number(data.globalSpeedKbs) || 0) / 1024).toFixed(1);
        updateTrayTooltip(`Upload: ${data.activeJobs} aktiv - ${speedMb} MB/s`);
        _maybeLogEventLoopDelay(data.activeJobs);
      } else {
        updateTrayTooltip('Multi-Hoster-Upload');
      }
    } catch (e) { debugLog(`stats listener error: ${e && e.message}`); }
  });

  uploadManager.on('job-settled', (event) => {
    sourceCleanup.settle(event);
  });

  uploadManager.on('account-paused', ({ hoster, accountId, mode }) => {
    const record = _accountCooldowns.markFailure({ hoster, accountId, mode });
    if (record) rotLog(`main: account-paused ${hoster} ${accountId} mode=${record.mode} failures=${record.failures} until=${record.pausedUntil || 'manual'}`);
  });

  uploadManager.on('account-succeeded', ({ hoster, accountId }) => {
    if (_accountCooldowns.markSuccess(hoster, accountId)) rotLog(`main: account-pause reset after success ${hoster} ${accountId}`);
  });

  uploadManager.on('account-failed', ({ hoster, accountId }) => {
    const cfg = configStore.load();
    const fallback = getNextFallbackAccount(cfg, hoster, accountId);
    if (fallback) {
      rotLog(`main: account-failed ${hoster} ${accountId} → resolved fallback ${fallback.id}`);
      uploadManager.switchAccount(hoster, fallback);
      _sessionAccountOverrides.set(hoster, fallback);
      safeSend('account-switched', { hoster, fromAccountId: accountId, toAccountId: fallback.id });
    } else {
      rotLog(`main: account-failed ${hoster} ${accountId} → NO fallback available (end of chain)`);
    }
  });

  const ROT_LOG_RENDERER_EVENTS = new Set([
    'switchAccount',
    'pre-job-swap',
    'try-alternate-after-fail',
    'mark-failed',
    'rotation-end',
    'doodstream-via-api',
    'doodstream-via-web',
    'suspect-reject-alt',
    'suspect-reject-exhausted'
  ]);
  uploadManager.on('rot-log', (entry) => {
    try {
      if (!entry || typeof entry !== 'object') return;
      const { ts, event, ...rest } = entry;
      const pairs = Object.entries(rest)
        .map(([k, v]) => {
          let sv;
          try { sv = typeof v === 'string' ? v : JSON.stringify(v); }
          catch { sv = '<unserializable>'; }
          return `${k}=${sv}`;
        })
        .join(' ');
      rotLog(`[${event}] ${pairs}`, ts);
      if (entry.jobId) {
        _appendJobLog(entry.jobId, { ts: ts || Date.now(), kind: 'rot', event, ...rest });
      }
      if (ROT_LOG_RENDERER_EVENTS.has(event)) {
        safeSend('account-rotation-log', entry);
      }
    } catch (e) { debugLog(`rot-log listener error: ${e && e.message}`); }
  });

  // Capture the manager identity at listener-registration time so the post-
  // batch null-out can compare against IT — not against whatever the global
  // happens to point at after an `await`. Without this, a renderer that
  // fires start-upload while we're still awaiting appendHistory would
  // create a fresh manager which the trailing `uploadManager = null` then
  // orphans (cancel/addJobs see null, the new batch keeps running invisibly).
  uploadManager.on('batch-done', async (summary) => {
    summary = stats.mergeSkippedIntoSummary(summary, skippedJobs);
    let automationCompletionsPersisted = true;
    try { await _thisManager._automationCompletionWriter?.flush(); } catch (error) {
      automationCompletionsPersisted = false;
      debugLog(`automation completion ledger failed: ${error.message}`);
    }
    if (!automationCompletionsPersisted) {
      const failedJobIds = new Set();
      for (const progress of _thisManager._automationCompletionProgress.values()) {
        if (progress.jobId) failedJobIds.add(progress.jobId);
        _queueProgressForRenderer({
          ...progress,
          status: 'error',
          error: 'Automatik-Abschlussnachweis konnte nicht gespeichert werden'
        });
      }
      _thisManager._automationCompletionProgress.clear();
      let changed = 0;
      for (const file of summary.files || []) {
        for (const result of file.results || []) {
          if (!failedJobIds.has(result.jobId)) continue;
          result.status = 'error';
          result.error = 'Automatik-Abschlussnachweis konnte nicht gespeichert werden';
          changed++;
        }
      }
      summary.succeeded = Math.max(0, Number(summary.succeeded) - changed);
      summary.failed = Math.max(0, Number(summary.failed) + changed);
    }
    lastSessionSummary = summary;
    debugLog(`batch-done: total=${summary.total} ok=${summary.succeeded} fail=${summary.failed}`);
    logMarker('BATCH END', { total: summary.total, ok: summary.succeeded, fail: summary.failed });
    logMemorySnapshot('batch-done');
    const _batchDurationSec = _thisManager && _thisManager.startTime
      ? Math.round((Date.now() - _thisManager.startTime) / 1000)
      : 0;
    let historyPersisted = true;
    try { await configStore.appendHistory(summary); } catch (err) {
      historyPersisted = false;
      debugLog(`appendHistory failed: ${err.message}`);
    }
    if (_progressFlushTimer) {
      clearTimeout(_progressFlushTimer);
      _progressFlushTimer = null;
    }
    const finalProgressBatch = _progressTerminalQueue.splice(0);
    for (const value of _progressByJob.values()) finalProgressBatch.push(value);
    _progressByJob.clear();
    if (finalProgressBatch.length) safeSend('upload-progress-batch', finalProgressBatch);
    const queuePersisted = await requestUploadFinalization(summary, !automationCompletionsPersisted);
    const finalizationPersisted = queuePersisted && automationCompletionsPersisted;
    if (finalizationPersisted) {
      try { await configStore.saveUploadRecovery(null); } catch (error) { debugLog(`upload recovery state could not be cleared: ${error.message}`); }
    }
    if (!finalizationPersisted) debugLog('upload finalization blocked: queue or automation completion evidence was not persisted');
    await sourceCleanup.finishBatch({ historyPersisted, queuePersisted: finalizationPersisted });
    _producerTracker.finish();

    const fullyAborted = isAllAborted(summary);
    if (isAutoRetry) {
      debugLog('webhook: skipped — auto-retry round (initial batch already notified)');
    } else if (fullyAborted) {
      debugLog('webhook: skipped — batch fully aborted/cancelled');
    } else {
      await sendBatchWebhook(summary, _batchDurationSec, { aborted: fullyAborted });
    }

    // Shutdown after finish
    handleShutdownAfterFinish();
    if (uploadManager === _thisManager) { uploadManager = null; globalThis._mhuUploadManagerRef = null; }
    else debugLog('batch-done: skipping uploadManager null-out — a newer manager replaced this one mid-await');
  });

  const startResult = await startPreparedUploadBatch({
    manager: _thisManager,
    tasks,
    producerTracker: _producerTracker,
    recovery,
    isAutoRetry
  });
  if (!startResult.started) return startResult;
  debugLog('start-upload returning started=true after startBatch acceptance');
  return { ...startResult, taskCount: tasks.length, skippedJobs, sourceCleanupFingerprints };
});

// Logged at batch boundaries so we can spot memory growth between batches
// across long sessions (main process side only — the renderer's live view
// still uses DevTools for profiling). Non-invasive: single line per boundary.
function logMemorySnapshot(label) {
  try {
    const m = process.memoryUsage();
    const mb = (n) => (n / 1024 / 1024).toFixed(1);
    debugLog(`memory[${label}]: rss=${mb(m.rss)}MB heap=${mb(m.heapUsed)}/${mb(m.heapTotal)}MB external=${mb(m.external)}MB arrayBuffers=${mb(m.arrayBuffers)}MB`);
  } catch {}
}

ipcMain.handle('cancel-upload', () => {
  if (uploadManager) {
    uploadManager.cancel();
  }
  return true;
});

ipcMain.handle('cancel-selected-jobs', (_event, jobIds) => {
  if (uploadManager) {
    uploadManager.cancelJobs(Array.isArray(jobIds) ? jobIds : []);
  }
  return true;
});

ipcMain.handle('add-jobs-to-batch', async (_event, payload) => {
  if (configStore.load().globalSettings?.folderMonitor?.paused === true) {
    return { error: 'Automatik ist pausiert' };
  }
  if (closeFlushRequested) return { error: 'Die Anwendung wird gerade beendet' };
  if (!uploadManager || !uploadManager.running) {
    return { error: 'Kein Upload aktiv' };
  }
  const batchManager = uploadManager;
  if (batchManager.isStoppingAfterActive()) {
    return { error: 'Warteschlange angehalten' };
  }
  const config = configStore.load();
  const jobs = payload && Array.isArray(payload.jobs) ? payload.jobs : [];
  const sourceCleanupGroups = payload && Array.isArray(payload.sourceCleanupGroups) ? payload.sourceCleanupGroups : [];
  const pick = makeAccountPicker(config);
  const tasks = buildUploadTasksFromJobs(config, jobs, pick);
  persistRotation(pick);
  const taskJobIds = new Set(tasks.map(t => t.jobId).filter(Boolean));
  const skippedJobs = jobs
    .filter(j => j && j.id && !taskJobIds.has(j.id))
    .map(j => ({ jobId: j.id, hoster: j.hoster, reason: 'Kein gültiger Account für diesen Hoster' }));
  const sourceCleanupFingerprints = batchManager.sourceFileCleanup
    ? await batchManager.sourceFileCleanup.registerGroups(sourceCleanupGroups)
    : {};
  if (configStore.load().globalSettings?.folderMonitor?.paused === true) {
    return { error: 'Automatik ist pausiert' };
  }
  if (uploadManager !== batchManager || !batchManager.running) {
    return { error: 'Kein Upload aktiv' };
  }
  if (batchManager.isStoppingAfterActive()) {
    return { error: 'Warteschlange angehalten' };
  }
  if (batchManager.sourceFileCleanup) {
    for (const skipped of skippedJobs) batchManager.sourceFileCleanup.markSkipped(skipped.jobId);
  }

  if (tasks.length === 0) {
    debugLog(`add-jobs-to-batch: 0 tasks built (${skippedJobs.length} skipped: no account)`);
    if (jobs.length > 0) await appendUploadPlanAudit(summarizeBatchPlan({ jobs }), 'add');
    return { added: 0, skippedJobs, alreadyInBatchJobIds: [], sourceCleanupFingerprints };
  }

  await registerAutomationCompletionJobs(batchManager, jobs);
  const addResult = batchManager.addJobs(tasks);
  const added = typeof addResult === 'number' ? addResult : (addResult && addResult.added) || 0;
  const alreadyInBatchJobIds = (addResult && Array.isArray(addResult.alreadyInBatchJobIds))
    ? addResult.alreadyInBatchJobIds
    : [];
  debugLog(
    `add-jobs-to-batch: ${added} of ${tasks.length} tasks added (${alreadyInBatchJobIds.length} already in batch, ${skippedJobs.length} skipped)`
  );
  if (jobs.length > 0) await appendUploadPlanAudit(summarizeBatchPlan({ jobs }), 'add');
  return { added, skippedJobs, alreadyInBatchJobIds, sourceCleanupFingerprints };
});

ipcMain.handle('finish-after-active', () => {
  if (uploadManager) {
    uploadManager.finishAfterActive();
  }
  return true;
});

ipcMain.handle('get-session-failed-accounts', () => {
  _accountCooldowns.releaseExpired();
  return _accountCooldowns.activeKeys();
});

ipcMain.handle('get-session-failed-account-states', () => {
  _accountCooldowns.releaseExpired();
  return _accountPauseSnapshot(_accountCooldowns.list());
});

ipcMain.handle('reset-session-failed-account', (_event, payload) => {
  if (!payload || typeof payload !== 'object') return { ok: false };
  const { hoster, accountId } = payload;
  if (!hoster || !accountId) return { ok: false };
  const key = `${hoster}:${accountId}`;
  const removed = _accountCooldowns.reset(hoster, accountId);
  rotLog(`session-failed: manual reset ${key} (was set: ${removed})`);
  return { ok: true, removed };
});

ipcMain.handle('reset-all-session-failed-accounts', () => {
  const count = _accountCooldowns.clear();
  rotLog(`session-failed: cleared all (${count})`);
  return { ok: true, count };
});

ipcMain.handle('get-job-log', (_event, jobId) => {
  if (!jobId || typeof jobId !== 'string') return [];
  const arr = _jobLogCollector.get(jobId);
  return Array.isArray(arr) ? arr.slice() : [];
});

ipcMain.handle('get-log-paths', () => {
  return getAllLogPaths();
});

ipcMain.handle('get-app-info', () => {
  return {
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    platform: process.platform,
    arch: process.arch,
    osRelease: require('os').release(),
    pid: process.pid,
    isPackaged: app.isPackaged,
    logVerbose: _logVerbose
  };
});

ipcMain.handle('reveal-log-file', async (_event, target) => {
  const { shell } = require('electron');
  const paths = getAllLogPaths();
  const file = (target && typeof target === 'string' && paths[target]) || null;
  try {
    if (file && fs.existsSync(file)) {
      shell.showItemInFolder(file);
      return { ok: true, path: file };
    }
    const dir = getLogOpenDirectory(file, paths.logDir, path);
    if (dir) {
      fs.mkdirSync(dir, { recursive: true });
      shell.openPath(dir);
      return { ok: true, path: dir };
    }
    return { ok: false, error: 'Kein Log-Pfad gefunden' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('test-webhook', async (_event, payload) => {
  const target = (typeof payload === 'string' ? payload : (payload && payload.url) || '').trim();
  const mention = (payload && typeof payload === 'object' && payload.mention) || '';
  if (!target || !/^https?:\/\//i.test(target)) return { ok: false, error: 'Ungültige URL (muss mit http(s):// beginnen)' };
  try {
    const req = buildWebhookRequest(target, {
      total: 3, succeeded: 2, failed: 1,
      files: [{ name: 'test.mkv', results: [
        { hoster: 'voe.sx', status: 'done' },
        { hoster: 'byse.sx', status: 'done' },
        { hoster: 'doodstream.com', status: 'error', error: 'Testfehler' }
      ] }]
    }, {
      durationSec: 754,
      appVersion: app.getVersion(),
      machineName: require('os').hostname(),
      mention,
      timestamp: new Date().toISOString()
    });
    const res = await fetch(req.url, {
      method: req.method, headers: req.headers, body: req.body,
      signal: AbortSignal.timeout(10_000)
    });
    return { ok: res.status >= 200 && res.status < 300, status: res.status };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

ipcMain.handle('set-log-verbose', (_event, enabled) => {
  setLogVerbose(enabled);
  logMarker('VERBOSE TOGGLE', { enabled: _logVerbose });
  return { ok: true, verbose: _logVerbose };
});

ipcMain.handle('create-support-bundle', async () => {
  const { dialog } = require('electron');
  try {
    if (_debugLogBuffer.length) {
      try { fs.appendFileSync(getDebugLogPath(), _debugLogBuffer.join(''), 'utf-8'); _debugLogBuffer.length = 0; } catch {}
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const defaultName = `multi-hoster-support-${stamp}.txt`;
    const desktop = (() => { try { return app.getPath('desktop'); } catch { return app.getPath('userData'); } })();
    const res = await dialog.showSaveDialog(mainWindow || undefined, {
      title: shellText('Diagnose-Paket speichern', 'Save diagnostics package'),
      defaultPath: path.join(desktop, defaultName),
      filters: [{ name: 'Text', extensions: ['txt'] }]
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    const paths = getAllLogPaths();
    const cfg = configStore.load();
    const text = buildSupportBundleText({
      header: {
        App: app.getName(),
        Version: app.getVersion(),
        Electron: process.versions.electron,
        Node: process.versions.node,
        Chrome: process.versions.chrome,
        Platform: process.platform,
        Arch: process.arch,
        OS: `${require('os').type()} ${require('os').release()}`,
        Packaged: app.isPackaged,
        Verbose: _logVerbose,
        PID: process.pid,
        CreatedAt: new Date().toISOString()
      },
      sanitizedConfig: sanitizeConfig(cfg),
      secrets: collectSecretValues(cfg),
      files: [
        { label: 'debug.log (last 5 MB)', path: paths.debug, maxBytes: 5 * 1024 * 1024 },
        { label: 'account-rotation.log (last 2 MB)', path: paths.accountRotation, maxBytes: 2 * 1024 * 1024 },
        { label: 'doodstream-debug.log (last 2 MB)', path: paths.doodstreamDebug, maxBytes: 2 * 1024 * 1024 },
        { label: 'crash.log', path: path.join(paths.logDir || path.dirname(paths.debug), 'crash.log'), maxBytes: 1 * 1024 * 1024 },
        { label: 'upload-audit.log (last 2 MB)', path: paths.uploadAudit, maxBytes: 2 * 1024 * 1024 },
        { label: 'fileuploader.log (last 1 MB)', path: paths.fileuploader, maxBytes: 1 * 1024 * 1024 }
      ]
    });
    fs.writeFileSync(res.filePath, text, 'utf-8');
    logMarker('SUPPORT BUNDLE', { path: res.filePath, bytes: text.length });
    return { ok: true, path: res.filePath, bytes: text.length };
  } catch (err) {
    debugLog(`create-support-bundle failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('open-log-folder', async () => {
  // Reveal the active log file (or its directory) in the OS file manager.
  // Prefers the configured log path, then the rotation log, then just the
  // parent dir.
  const { shell } = require('electron');
  const primary = getLogFilePath();
  if (fs.existsSync(primary)) { shell.showItemInFolder(primary); return { ok: true, path: primary }; }
  const rot = getRotLogPath();
  if (fs.existsSync(rot)) { shell.showItemInFolder(rot); return { ok: true, path: rot }; }
  try {
    const dir = path.dirname(primary);
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
    return { ok: true, path: dir };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('clear-history', async () => {
  assertConfigWriteAllowed();
  await configStore.clearHistory();
  return true;
});

async function syncImportedRuntime(config) {
  const warnings = [];
  try {
    setLogVerbose(!!config.globalSettings.logVerbose);
    if (uploadManager) {
      uploadManager.updateSettings(config.hosterSettings, config.globalSettings);
      uploadManager.replaceAccountPools(buildAccountPools(config));
    }
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(!!config.globalSettings.alwaysOnTop);
  } catch (error) {
    debugLog(`backup runtime settings failed: ${error.message}`);
    warnings.push('allgemeine Laufzeiteinstellungen');
  }
  try {
    stopFolderMonitor();
    const folderSettings = config.globalSettings.folderMonitor;
    if (folderSettings && folderSettings.enabled && folderSettings.folderPath) await startFolderMonitor(folderSettings);
  } catch (error) {
    debugLog(`backup folder monitor sync failed: ${error.message}`);
    warnings.push('Ordnerüberwachung');
  }
  try {
    const remoteSettings = config.globalSettings.remote;
    if (remoteSettings && remoteSettings.enabled) await startRemoteServer();
    else if (remoteServer) {
      remoteServer.stop();
      remoteServer = null;
      destroyCaptureWindow();
    }
  } catch (error) {
    debugLog(`backup remote sync failed: ${error.message}`);
    warnings.push('Remote-Steuerung');
  }
  try {
    const diagnostics = config.globalSettings.diagnostics;
    if (diagnostics && diagnostics.enabled) await startDiagnosticAgent();
    else stopDiagnosticAgent();
  } catch (error) {
    debugLog(`backup diagnostics sync failed: ${error.message}`);
    warnings.push('Diagnose');
  }
  try {
    if (config.globalSettings.showDropTarget) createDropTargetWindow();
    else destroyDropTargetWindow();
  } catch (error) {
    debugLog(`backup drop target sync failed: ${error.message}`);
    warnings.push('Drop-Target');
  }
  return warnings;
}

async function applyImportedSettings(imported) {
  settingsImportGate.begin();
  try {
    await waitForConfigStoreWrites();
    const prepared = prepareImportedSettings(imported);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const preImportPath = configStore.filePath.replace('.json', `.pre-import-${ts}.json`);
    try { fs.copyFileSync(configStore.filePath, preImportPath); } catch {}
    await configStore.replaceSettings(prepared);
    _rotationCursors = {};
    _accountCooldowns.clear();
    _sessionAccountOverrides.clear();
    const config = configStore.load();
    _invalidateLogSettings(config.globalSettings);
    const warnings = await syncImportedRuntime(config);
    return { config, warnings };
  } finally {
    settingsImportGate.end();
  }
}

function readBackupFile(filePath) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error('Backup-Datei ist zu groß oder ungültig');
  return fs.readFileSync(filePath);
}

// --- Backup export / import ---
ipcMain.handle('export-backup', async (_event, options = {}) => {
  const password = typeof options?.password === 'string' ? options.password : undefined;
  if (password !== undefined && (password.length < 8 || password.length > 1024)) {
    throw new Error('Das Backup-Passwort muss zwischen 8 und 1024 Zeichen lang sein');
  }
  const _bd = new Date();
  const _bdate = `${String(_bd.getDate()).padStart(2, '0')}-${String(_bd.getMonth() + 1).padStart(2, '0')}-${_bd.getFullYear()}`;
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: shellText('Backup exportieren', 'Export backup'),
    defaultPath: `${_bdate}-multihoster-backup.mhu`,
    filters: [
      { name: shellText('Multi-Hoster Backup (verschlüsselt)', 'Multi Hoster backup (encrypted)'), extensions: ['mhu'] },
      { name: shellText('Multi-Hoster Backup (Klartext JSON)', 'Multi Hoster backup (plain JSON)'), extensions: ['json'] }
    ]
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  await waitForConfigStoreWrites();
  const config = createPortableSettingsSnapshot(configStore.load());
  if (filePath.toLowerCase().endsWith('.json')) {
    if (typeof password === 'string') throw new Error('Passwortgeschützte Backups müssen als .mhu gespeichert werden');
    fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf-8');
  } else {
    const encrypted = backupCrypto.encrypt(config, password);
    fs.writeFileSync(filePath, encrypted);
  }
  return { ok: true, path: filePath };
});

ipcMain.handle('import-backup', async (_event, legacyPassword) => {
  let buffer;
  let sourcePath = _lastImportPath;
  if (legacyPassword && sourcePath) {
    buffer = readBackupFile(sourcePath);
  } else {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: shellText('Backup importieren', 'Import backup'),
      filters: [
        { name: 'Multi Hoster backup', extensions: ['mhu', 'json'] },
        { name: 'Verschlüsselt (.mhu)', extensions: ['mhu'] },
        { name: 'Klartext (.json)', extensions: ['json'] }
      ],
      properties: ['openFile']
    });
    if (canceled || !filePaths.length) return { ok: false, canceled: true };
    sourcePath = filePaths[0];
    buffer = readBackupFile(sourcePath);
    _lastImportPath = sourcePath;
  }
  let imported;
  const looksLikeJson = buffer.length >= 1 && (buffer[0] === 0x7B || buffer[0] === 0x20 || buffer[0] === 0x0A || buffer[0] === 0x0D || buffer[0] === 0x09 || buffer[0] === 0xEF);
  if (looksLikeJson) {
    try {
      const text = buffer.toString('utf-8').replace(/^\uFEFF/, '');
      imported = JSON.parse(text);
    } catch (err) {
      _lastImportPath = null;
      return { ok: false, error: 'Klartext-Backup ist kein gültiges JSON: ' + (err.message || err) };
    }
  } else {
    try {
      imported = backupCrypto.decrypt(buffer, legacyPassword);
    } catch (err) {
      if (err && err.needsPassword) {
        return { ok: false, needsPassword: true, hint: 'Falls dieses Backup mit der aktuellen Version erzeugt wurde, ist die Datei vermutlich beim Transfer beschädigt worden (z. B. FTP-Text-Modus). Versuch es mit einem Klartext-JSON-Export.' };
      }
      _lastImportPath = null;
      throw err;
    }
  }
  _lastImportPath = null;
  try {
    return { ok: true, ...await applyImportedSettings(imported) };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
});

ipcMain.handle('online-backup:list-managed', (event) => (
  invokeTrustedOnlineBackupIpc(event, () => onlineBackupManager.listManaged())
));

ipcMain.handle('online-backup:create-managed', (event) => (
  invokeTrustedOnlineBackupIpc(event, () => onlineBackupManager.createManaged())
));

ipcMain.handle('online-backup:copy-managed', (event, id) => (
  invokeTrustedOnlineBackupIpc(event, () => {
    try {
      return onlineBackupManager.copyManaged(requireCanonicalOnlineBackupId(id));
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    }
  })
));

ipcMain.handle('online-backup:delete-managed', (event, id) => (
  invokeTrustedOnlineBackupIpc(event, () => {
    try {
      return onlineBackupManager.deleteManaged(requireCanonicalOnlineBackupId(id));
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    }
  })
));

ipcMain.handle('online-backup:restore', async (_event, key) => {
  try {
    const normalized = String(key || '').trim();
    if (normalized.length > 128) throw new Error('Online-Sicherungsschlüssel ist ungültig');
    const payload = await downloadOnlineBackup(normalized);
    return { ok: true, ...await applyImportedSettings(payload.settings) };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
});

let _uploadLogEvidenceCache = null;
let _uploadLogEvidenceInFlight = null;
let _uploadLogEvidenceGeneration = 0;

function _invalidateUploadLogEvidenceCache() {
  _uploadLogEvidenceCache = null;
  _uploadLogEvidenceGeneration++;
}

async function _scanOwnUploadLog() {
  const entries = new Map();
  const basePath = getBaseLogFilePath();
  const dir = path.dirname(basePath);
  const ext = path.extname(basePath);
  const name = path.basename(basePath, ext);
  const directories = new Set([dir]);
  if (_activeLogPath) directories.add(path.dirname(_activeLogPath));
  try {
    const desktop = app.getPath('desktop');
    if (desktop) directories.add(desktop);
  } catch {}
  try { directories.add(app.getPath('userData')); } catch {}
  const logFiles = new Set();
  for (const directory of directories) {
    try {
      const directoryHandle = await fs.promises.opendir(directory);
      let directoryEntries = 0;
      for await (const entry of directoryHandle) {
        directoryEntries++;
        if (directoryEntries > 50000) throw new Error('Upload-Log-Verzeichnis enthält zu viele Einträge');
        const file = entry.name;
        if (
          isManagedUploadLogFileName(file, { baseName: name, ext })
          || isManagedUploadLogFileName(file, { baseName: 'fileuploader', ext: '.log' })
        ) {
          logFiles.add(path.join(directory, file));
        }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  if (_activeLogPath) logFiles.add(_activeLogPath);
  logFiles.add(basePath);
  if (logFiles.size > 256) throw new Error('Zu viele verwaltete Upload-Logs');

  let expectedBytes = 0;
  let actualBytes = 0;
  for (const logPath of [...logFiles].sort()) {
    try {
      if (typeof fs.promises.stat === 'function') {
        const stat = await fs.promises.stat(logPath);
        expectedBytes += Number(stat.size) || 0;
        if (expectedBytes > 256 * 1024 * 1024) throw new Error('Upload-Logs überschreiten das Leselimit');
      }
      for await (const parsed of iterateUploadLogEntries(logPath, {
        maxBytes: 256 * 1024 * 1024,
        onBytes(bytes) {
          actualBytes += bytes;
          if (actualBytes > 256 * 1024 * 1024) throw new Error('Upload-Logs überschreiten das Leselimit');
        }
      })) {
        if (parsed.confirmed !== true) continue;
        const key = `${parsed.hoster.toLowerCase()}\u0000${parsed.fileName.toLowerCase()}`;
        const previous = entries.get(key);
        const timestamp = Number.isFinite(parsed.ts) ? parsed.ts : -Infinity;
        const previousTimestamp = Number.isFinite(previous?.ts) ? previous.ts : -Infinity;
        if (!previous || timestamp >= previousTimestamp) entries.set(key, parsed);
        if (entries.size > 250000) throw new Error('Upload-Log enthält zu viele eindeutige Einträge');
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return [...entries.values()];
}

ipcMain.handle('read-own-upload-log', async () => {
  const now = Date.now();
  if (_uploadLogEvidenceCache?.expiresAt > now) return _uploadLogEvidenceCache.entries;
  const generation = _uploadLogEvidenceGeneration;
  if (_uploadLogEvidenceInFlight?.generation === generation) return _uploadLogEvidenceInFlight.promise;
  const pending = _scanOwnUploadLog().then(entries => {
    if (generation === _uploadLogEvidenceGeneration) {
      _uploadLogEvidenceCache = { entries, expiresAt: Date.now() + 5000 };
    }
    return entries;
  });
  const inFlight = { generation, promise: pending };
  _uploadLogEvidenceInFlight = inFlight;
  try {
    return await pending;
  } finally {
    if (_uploadLogEvidenceInFlight === inFlight) _uploadLogEvidenceInFlight = null;
  }
});

ipcMain.handle('import-upload-log', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: shellText('Upload-Log importieren', 'Import upload log'),
    filters: [
      { name: shellText('Log-Dateien', 'Log files'), extensions: ['log', 'txt'] },
      { name: shellText('Alle Dateien', 'All files'), extensions: ['*'] }
    ],
    properties: ['openFile']
  });
  if (canceled || !filePaths.length) return { canceled: true };
  const content = fs.readFileSync(filePaths[0], 'utf-8');
  // Parse log format: date|hoster|link||filename|
  const entries = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split('|');
    if (parts.length >= 5) {
      const hoster = (parts[1] || '').trim();
      const fileName = (parts[4] || '').trim();
      if (hoster && fileName) entries.push({ hoster, fileName });
    }
  }
  return { entries, path: filePaths[0] };
});

ipcMain.handle('copy-to-clipboard', (_event, text) => {
  clipboard.writeText(text);
  return true;
});

ipcMain.handle('app:check-updates', async (_event, options) => {
  try {
    return await checkForUpdate({ forceRefresh: options && options.forceRefresh === true });
  } catch (err) {
    return { available: false, error: err.message };
  }
});

ipcMain.handle('app:install-update', async () => {
  if (updatePreparationPromise || preparedUpdate || updateQuitPending) {
    return { started: false, error: 'Ein Update wird bereits vorbereitet' };
  }
  updatePreparationPromise = (async () => {
    const prepared = await prepareUpdate((progress) => {
      safeSend('app:update-progress', progress);
    });
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed() || !closeHandshakeReady) {
      throw new Error('Die Anwendung ist noch nicht bereit, das Update sicher zu installieren');
    }
    preparedUpdate = prepared;
    updateQuitPending = true;
    preparedUpdateLaunchStarted = false;
    setImmediate(() => app.quit());
    return { started: true };
  })();
  try {
    return await updatePreparationPromise;
  } catch (error) {
    const canceled = error && error.message === 'Update abgebrochen';
    if (!canceled) {
      rejectPendingUpdate(error);
      safeSend('app:update-progress', { stage: 'error', error: error.message });
    }
    return { started: false, canceled, error: error.message };
  } finally {
    updatePreparationPromise = null;
  }
});

ipcMain.handle('app:abort-update', () => {
  return abortUpdate();
});

ipcMain.handle('app:get-version', () => {
  return app.getVersion();
});

ipcMain.handle('app:restart', () => {
  restartAfterClosePreparation = true;
  app.quit();
});

ipcMain.handle('app:quit', () => {
  app.quit();
});

ipcMain.on('app:close-handshake-ready', (event) => {
  if (mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents) {
    closeHandshakeReady = true;
    void checkForUpdate().then(announceAvailableUpdate).catch((error) => {
      logError('update-check failed', error);
    });
  }
});

ipcMain.on('folder-monitor:renderer-ready', (event, generation) => {
  if (mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents && Number.isSafeInteger(generation) && generation === folderMonitorRendererGeneration) {
    folderMonitorRendererReadyGeneration = generation;
    releaseFolderMonitorStartupReconcile();
  }
});

ipcMain.on('app:close-preparation-started', (event, attempt) => {
  if (mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents && isClosePreparationActive(attempt)) {
    armCloseFlushTimer(attempt, 3000);
  }
});

ipcMain.handle('app:finish-close', async (event, payload = true) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return false;
  const attempt = payload && typeof payload === 'object' && Number.isInteger(payload.attempt) ? payload.attempt : null;
  if (attempt === null) return false;
  const ready = payload && typeof payload === 'object' ? payload.ready !== false : payload !== false;
  if (!ready) {
    if (isClosePreparationActive(attempt)) {
      clearCloseFlushTimer();
      return restoreClosePreparation(attempt);
    }
    return lastRestoredCloseAttempt === attempt;
  }
  if (!isClosePreparationActive(attempt)) return false;
  clearCloseFlushTimer();
  let approved = false;
  try {
    if (!acquireCloseQuiesce(attempt)) return false;
    await waitForCloseOperation(waitForConfigStoreWrites(), 1000);
    if (!isClosePreparationActive(attempt)) return false;
    if (payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'pendingQueue')) {
      await waitForCloseOperation(configStore.savePendingQueue(payload.pendingQueue, { allowDuringQuiesce: true }), 1000);
    }
    if (!isClosePreparationActive(attempt)) return false;
    closeFlushApproved = true;
    approved = true;
    setImmediate(() => {
      app.quit();
    });
    return true;
  } catch {
    restoreClosePreparation(attempt);
    return false;
  } finally {
    if (!approved) releaseCloseQuiesce(attempt);
  }
});

// --- Hoster settings ---
ipcMain.handle('get-hoster-settings', () => {
  const config = configStore.load();
  return config.hosterSettings || {};
});

ipcMain.handle('save-hoster-settings', async (_event, hosterSettings) => {
  assertConfigWriteAllowed();
  await configStore.save({ hosterSettings });
  if (uploadManager) {
    try { uploadManager.updateSettings(hosterSettings, null); } catch (error) { debugLog(`hoster settings runtime update failed: ${error.message}`); }
  }
  return true;
});

// --- Global settings ---
ipcMain.handle('get-global-settings', () => {
  const config = configStore.load();
  return config.globalSettings || {};
});

ipcMain.handle('save-pending-queue', async (_event, pendingQueue) => {
  await configStore.savePendingQueue(pendingQueue);
  return true;
});

ipcMain.handle('complete-upload-finalization', async (_event, payload) => {
  const finalizationId = payload && payload.finalizationId;
  const pending = finalizationId && pendingUploadFinalizations.get(finalizationId);
  if (!pending) return false;
  try {
    await configStore.savePendingQueue(payload.pendingQueue ?? null);
    pending.resolve(true);
    return true;
  } catch (error) {
    debugLog(`upload finalization queue save failed: ${error.message}`);
    pending.resolve(false);
    return false;
  }
});

ipcMain.handle('save-global-settings', async (_event, globalSettings) => {
  assertConfigWriteAllowed();
  await configStore.saveRendererGlobalSettings(globalSettings);
  globalSettings = configStore.load().globalSettings;
  _invalidateLogSettings(globalSettings);
  if (uploadManager) {
    try { uploadManager.updateSettings(null, globalSettings); } catch (error) { debugLog(`global settings runtime update failed: ${error.message}`); }
  }
  refreshTrayLanguage();
  return true;
});

function _sleepSyncMs(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* spin */ }
  }
}

function _sweepOrphanConfigTmps() {
  try {
    const dir = path.dirname(configStore.filePath);
    const isAlive = (pid) => {
      try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
    };
    const orphans = selectOrphanTmps(fs.readdirSync(dir), {
      baseName: path.basename(configStore.filePath),
      currentPid: process.pid,
      isAlive
    });
    for (const file of orphans) {
      try { fs.unlinkSync(path.join(dir, file)); } catch {}
    }
  } catch {}
}

const automationLifecycleQueue = [];
let automationLifecycleRunning = false;
let automationLifecycleGeneration = 0;
let automationStatusSuppressionDepth = 0;

function drainAutomationLifecycleQueue() {
  if (automationLifecycleRunning) return;
  const next = automationLifecycleQueue.shift();
  if (!next) return;
  automationLifecycleRunning = true;
  let result;
  try {
    result = next.operation(next.generation);
  } catch (error) {
    result = Promise.reject(error);
  }
  Promise.resolve(result).then(next.resolve, next.reject).finally(() => {
    automationLifecycleRunning = false;
    drainAutomationLifecycleQueue();
  });
}

function enqueueAutomationLifecycle(operation) {
  const generation = ++automationLifecycleGeneration;
  return new Promise((resolve, reject) => {
    automationLifecycleQueue.push({ generation, operation, resolve, reject });
    drainAutomationLifecycleQueue();
  });
}

async function withAutomationStatusSuppressed(operation) {
  automationStatusSuppressionDepth++;
  try {
    return await operation();
  } finally {
    automationStatusSuppressionDepth--;
  }
}

function automationStatusSnapshot() {
  const settings = configStore.load().globalSettings?.folderMonitor || {};
  const normalized = normalizeAutomationSettings(settings);
  return Object.freeze({
    ...folderMonitor.status(),
    enabled: settings.enabled === true,
    configured: String(settings.folderPath || '').trim().length > 0,
    paused: settings.paused === true,
    pausedAt: settings.pausedAt ?? null,
    queueLimitJobs: normalized.queueLimitJobs,
    reconcileIntervalMinutes: normalized.reconcileIntervalMinutes
  });
}

function publishAutomationStatus(extra = null, generation = null) {
  const snapshot = Object.freeze({ ...automationStatusSnapshot(), ...(extra || {}) });
  const currentGeneration = generation === null || generation === automationLifecycleGeneration;
  if (automationStatusSuppressionDepth === 0 && currentGeneration) safeSend('automation:status', snapshot);
  return snapshot;
}

function bindFolderMonitorEvents(settings) {
  folderMonitor.removeAllListeners();
  folderMonitor.on('new-files', (files) => {
    debugLog(`folder-monitor: ${files.length} new file(s)`);
    safeSend('folder-monitor:new-files', files);
  });
  folderMonitor.on('error', (err) => {
    debugLog(`folder-monitor error: ${err.message}`);
  });
  folderMonitor.on('status', () => publishAutomationStatus());
  folderMonitor.on('initial-scan-complete', async () => {
    try {
      const latest = configStore.load();
      const current = latest.globalSettings?.folderMonitor;
      if (!current?.includeExisting || path.resolve(current.folderPath || '') !== path.resolve(settings.folderPath || '')) return;
      await configStore.save({
        globalSettings: {
          ...latest.globalSettings,
          folderMonitor: { ...current, includeExisting: false }
        }
      });
    } catch (error) {
      debugLog(`folder-monitor initial scan state failed: ${error.message}`);
    }
  });
}

function invalidateFolderMonitorLifecycle() {
  folderMonitorLifecycleGeneration++;
  folderMonitorStartupReconcile = null;
  return folderMonitorLifecycleGeneration;
}

function stopFolderMonitor() {
  invalidateFolderMonitorLifecycle();
  return folderMonitor.stop();
}

function releaseFolderMonitorStartupReconcile() {
  const pending = folderMonitorStartupReconcile;
  if (!pending || pending.monitorGeneration !== folderMonitorLifecycleGeneration) return false;
  if (folderMonitorRendererReadyGeneration !== folderMonitorRendererGeneration) return false;
  if (quitTeardownStarted || !folderMonitor.running) {
    folderMonitorStartupReconcile = null;
    return false;
  }
  folderMonitorStartupReconcile = null;
  try {
    void folderMonitor.scan({ emitFiles: true, trigger: 'startup' }).catch(error => {
      debugLog(`folder-monitor startup scan failed: ${error.message}`);
    });
  } catch (error) {
    debugLog(`folder-monitor startup scan failed: ${error.message}`);
  }
  return true;
}

function deferFolderMonitorStartupReconcile(monitorGeneration) {
  if (monitorGeneration !== folderMonitorLifecycleGeneration || folderMonitorStartupReconcile) return false;
  folderMonitorStartupReconcile = Object.freeze({ monitorGeneration });
  releaseFolderMonitorStartupReconcile();
  return true;
}

async function startFolderMonitor(settings, options = {}) {
  try {
    const monitorGeneration = invalidateFolderMonitorLifecycle();
    const persisted = configStore.load().globalSettings?.folderMonitor || {};
    const normalized = normalizeAutomationSettings(settings);
    const effectiveSettings = {
      ...settings,
      queueLimitJobs: normalized.queueLimitJobs,
      reconcileIntervalMinutes: normalized.reconcileIntervalMinutes,
      paused: persisted.paused === true,
      pausedAt: persisted.paused === true ? (persisted.pausedAt ?? null) : null
    };
    bindFolderMonitorEvents(effectiveSettings);
    if (persisted.paused === true) {
      folderMonitor.configure(effectiveSettings);
      debugLog(`folder-monitor configured while paused: ${effectiveSettings.folderPath}`);
      return { includesExisting: false, paused: true };
    }
    const result = folderMonitor.start(effectiveSettings);
    if (options.deferStartupReconcile === true) deferFolderMonitorStartupReconcile(monitorGeneration);
    else await folderMonitor.scan({ emitFiles: true, trigger: 'startup' });
    debugLog(`folder-monitor started: ${settings.folderPath}`);
    return result;
  } catch (err) {
    debugLog(`folder-monitor start failed: ${err.message}`);
    throw err;
  }
}

async function resumeFolderMonitor(settings) {
  invalidateFolderMonitorLifecycle();
  bindFolderMonitorEvents(settings);
  const result = await folderMonitor.resume(settings, { reconcile: false });
  debugLog(`folder-monitor resumed: ${settings.folderPath}`);
  return result;
}

ipcMain.handle('folder-monitor:start', async (_event, settings) => {
  const result = await startFolderMonitor(settings);
  if (result?.paused === true) return { error: 'Automatik ist pausiert' };
  return { ok: true, includesExisting: result?.includesExisting === true };
});

ipcMain.handle('folder-monitor:stop', () => {
  stopFolderMonitor();
  debugLog('folder-monitor stopped');
  return { ok: true };
});

ipcMain.handle('folder-monitor:status', () => {
  return folderMonitor.status();
});

ipcMain.handle('automation:get-status', () => {
  return automationStatusSnapshot();
});

ipcMain.handle('automation:get-completions', () => {
  return configStore.loadAutomationCompletions();
});

ipcMain.handle('automation:record-completions', async (_event, entries) => {
  const source = Array.isArray(entries) ? entries.slice(0, 10000) : [];
  const normalized = source.map(normalizeAutomationCompletion);
  if (source.length === 0 || normalized.some(entry => !entry)) throw new Error('Automatik-Abschlussnachweise sind ungültig');
  await configStore.saveAutomationCompletions(normalized);
  return true;
});

ipcMain.handle('automation:pause-after-active', () => enqueueAutomationLifecycle(async generation => {
  let monitorError = '';
  await withAutomationStatusSuppressed(async () => {
    const latest = configStore.load();
    const settings = latest.globalSettings?.folderMonitor || {};
    await configStore.saveFolderMonitorRuntimeState({ ...settings, paused: true, pausedAt: Date.now() });
    invalidateFolderMonitorLifecycle();
    try {
      await folderMonitor.pause();
    } catch {
      monitorError = 'Ordnerüberwachung konnte nicht pausiert werden';
    } finally {
      if (uploadManager) uploadManager.finishAfterActive();
    }
  });
  return publishAutomationStatus(monitorError ? { monitorError } : null, generation);
}));

ipcMain.handle('automation:resume', () => enqueueAutomationLifecycle(async generation => {
  let result;
  await withAutomationStatusSuppressed(async () => {
    const latest = configStore.load();
    const settings = latest.globalSettings?.folderMonitor || {};
    const normalized = normalizeAutomationSettings(settings);
    const pausedSettings = {
      ...settings,
      queueLimitJobs: normalized.queueLimitJobs,
      reconcileIntervalMinutes: normalized.reconcileIntervalMinutes,
      paused: settings.paused === true,
      pausedAt: settings.pausedAt ?? null
    };
    const resumedSettings = { ...pausedSettings, paused: false, pausedAt: null };
    try {
      if (resumedSettings.enabled && resumedSettings.folderPath) {
        await resumeFolderMonitor(resumedSettings);
      }
      await configStore.saveFolderMonitorRuntimeState(resumedSettings);
      if (uploadManager) await uploadManager.resumeAfterActive();
      if (resumedSettings.enabled && resumedSettings.folderPath) {
        await folderMonitor.scan({ emitFiles: true, trigger: 'resume' });
      }
    } catch {
      if (uploadManager) uploadManager.finishAfterActive();
      stopFolderMonitor();
      if (pausedSettings.enabled && pausedSettings.folderPath) {
        bindFolderMonitorEvents(pausedSettings);
        folderMonitor.configure(pausedSettings);
      }
      try {
        await configStore.saveFolderMonitorRuntimeState(pausedSettings);
      } catch {}
      result = { error: 'Automatik konnte nicht fortgesetzt werden' };
    }
  });
  return publishAutomationStatus(result, generation);
}));

ipcMain.handle('folder-monitor:test-scan', () => {
  return folderMonitor.scan({ emitFiles: false, trigger: 'test' });
});

ipcMain.handle('folder-monitor:reconcile', () => {
  if (configStore.load().globalSettings?.folderMonitor?.paused === true) {
    return { error: 'Automatik ist pausiert' };
  }
  return folderMonitor.scan({ emitFiles: true, trigger: 'manual' });
});

ipcMain.handle('folder-monitor:select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// --- Remote Control ---
function generateToken() {
  const crypto = require('crypto');
  return crypto.randomBytes(32).toString('hex');
}

// --- Remote Diagnostics (read-only) ---
function _diagAppInfo() {
  return {
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    packaged: app.isPackaged,
    pid: process.pid,
    uptimeSec: Math.round(process.uptime())
  };
}

function _diagSystemInfo() {
  const os = require('os');
  let disk = null;
  try {
    const sf = fs.statfsSync(app.getPath('userData'));
    disk = { freeBytes: sf.bavail * sf.bsize, totalBytes: sf.blocks * sf.bsize };
  } catch {}
  return {
    platform: process.platform,
    arch: process.arch,
    osType: os.type(),
    osRelease: os.release(),
    hostname: os.hostname(),
    totalMemBytes: os.totalmem(),
    freeMemBytes: os.freemem(),
    cpuCount: (os.cpus() || []).length,
    osUptimeSec: Math.round(os.uptime()),
    disk
  };
}

function _diagAgentInfo() {
  const cfg = configStore.load();
  const diag = (cfg.globalSettings && cfg.globalSettings.diagnostics) || {};
  return {
    version: app.getVersion(),
    port: diag.port || 9110,
    bindAddress: _diagBindHost(diag),
    clientCount: diagnosticAgent ? diagnosticAgent.getClientCount() : 0,
    lastAccess: diagnosticAgent ? diagnosticAgent.getLastAccess() : null
  };
}

function _buildDiagnosticHandler() {
  const collectors = createCollectors({
    loadConfig: () => configStore.load(),
    loadHistory: () => configStore.loadHistory(),
    getAllLogPaths,
    support: { sanitizeConfig, collectSecretValues, redactLogText, valueScrub, collectFile, REDACTED },
    stats,
    appInfo: _diagAppInfo,
    systemInfo: _diagSystemInfo,
    agentInfo: _diagAgentInfo
  });
  const agent = createAgent(collectors);
  return (msg, _client, reply) => {
    let result;
    try { result = agent.handle(msg.op, msg.args); }
    catch (e) { result = { ok: false, error: String((e && e.message) || e) }; }
    reply(result);
  };
}

function _getSuggestedRemoteHosts() {
  const os = require('os');
  const hosts = [];
  try {
    for (const entry of Object.values(os.networkInterfaces())) {
      for (const net of (entry || [])) {
        if (net && net.family === 'IPv4' && !net.internal && net.address) hosts.push(net.address);
      }
    }
  } catch {}
  return [...new Set(hosts)];
}

function _diagAllowlist(diag) {
  return Array.isArray(diag && diag.allowlist) ? diag.allowlist.map((x) => String(x).trim()).filter(Boolean) : [];
}

function _diagBindHost(diag) {
  const mode = (diag && diag.bindMode) || 'local';
  if (mode === 'network' && _diagAllowlist(diag).length > 0) return '0.0.0.0';
  return '127.0.0.1';
}

function _diagPublicHost(diag) {
  const explicit = String((diag && diag.publicHost) || '').trim();
  if (explicit) return explicit;
  if (_diagBindHost(diag) === '127.0.0.1') return '127.0.0.1';
  return _getSuggestedRemoteHosts()[0] || '127.0.0.1';
}

function buildDiagnosticCode(diag, fp) {
  const payload = { v: 1, h: _diagPublicHost(diag), p: diag.port || 9110, t: diag.token, n: diag.label || require('os').hostname() };
  if (fp) { payload.fp = fp; payload.s = 'wss'; }
  return 'mhu1_' + Buffer.from(JSON.stringify(payload)).toString('base64url');
}

async function startDiagnosticAgent() {
  if (diagnosticAgent) { try { diagnosticAgent.stop(); } catch {} diagnosticAgent = null; }
  const config = configStore.load();
  const diag = config.globalSettings && config.globalSettings.diagnostics;
  if (!diag || !diag.enabled) return;

  let token = diag.token;
  if (!token) {
    token = generateToken();
    const gs = { ...config.globalSettings, diagnostics: { ...diag, token, codeIssuedAt: Date.now() } };
    await configStore.save({ globalSettings: gs });
  }

  if (!_diagHandler) _diagHandler = _buildDiagnosticHandler();
  const host = _diagBindHost(diag);
  const allowlist = _diagAllowlist(diag);
  diagnosticAgent = new RemoteServer();
  try {
    await diagnosticAgent.start({
      port: diag.port || 9110,
      host,
      token,
      diagnosticMode: true,
      allowlist,
      onDiagnosticRequest: _diagHandler
    });
    debugLog(`diagnostics-agent started on ${host}:${diagnosticAgent.getPort()} (allowlist ${allowlist.length})`);
  } catch (e) {
    debugLog(`diagnostics-agent start failed: ${e.message}`);
    diagnosticAgent = null;
  }
}

function stopDiagnosticAgent() {
  if (diagnosticAgent) { try { diagnosticAgent.stop(); } catch {} diagnosticAgent = null; }
}

ipcMain.handle('diagnostics:get-settings', () => {
  const cfg = configStore.load();
  const diag = (cfg.globalSettings && cfg.globalSettings.diagnostics) || {};
  return {
    enabled: !!diag.enabled,
    port: diag.port || 9110,
    bindMode: diag.bindMode === 'network' ? 'network' : 'local',
    bindAddress: _diagBindHost(diag),
    publicHost: diag.publicHost || '',
    allowlist: _diagAllowlist(diag),
    suggestedHosts: _getSuggestedRemoteHosts(),
    label: diag.label || require('os').hostname(),
    codeIssuedAt: diag.codeIssuedAt || 0,
    code: diag.token ? buildDiagnosticCode(diag) : ''
  };
});

ipcMain.handle('diagnostics:save-settings', async (_e, incoming) => {
  assertConfigWriteAllowed();
  const cfg = configStore.load();
  const cur = (cfg.globalSettings && cfg.globalSettings.diagnostics) || {};
  const next = {
    ...cur,
    enabled: !!(incoming && incoming.enabled),
    port: (incoming && Number(incoming.port)) || cur.port || 9110,
    bindMode: (incoming && incoming.bindMode === 'network') ? 'network' : 'local',
    publicHost: (incoming && incoming.publicHost !== null && incoming.publicHost !== undefined) ? String(incoming.publicHost).trim() : (cur.publicHost || ''),
    allowlist: (incoming && Array.isArray(incoming.allowlist))
      ? incoming.allowlist.map((x) => String(x).trim()).filter(Boolean)
      : _diagAllowlist(cur),
    label: (incoming && incoming.label !== null && incoming.label !== undefined) ? String(incoming.label) : cur.label
  };
  next.bindAddress = _diagBindHost(next);
  const gs = { ...cfg.globalSettings, diagnostics: next };
  await configStore.save({ globalSettings: gs });
  await startDiagnosticAgent();
  return { ok: true, bindAddress: next.bindAddress, allowlistCount: next.allowlist.length };
});

ipcMain.handle('diagnostics:regenerate', async () => {
  assertConfigWriteAllowed();
  const cfg = configStore.load();
  const cur = (cfg.globalSettings && cfg.globalSettings.diagnostics) || {};
  const next = { ...cur, token: generateToken(), codeIssuedAt: Date.now() };
  const gs = { ...cfg.globalSettings, diagnostics: next };
  await configStore.save({ globalSettings: gs });
  if (next.enabled) await startDiagnosticAgent();
  return { ok: true, code: buildDiagnosticCode(next), codeIssuedAt: next.codeIssuedAt };
});

ipcMain.handle('diagnostics:status', () => {
  const cfg = configStore.load();
  const diag = (cfg.globalSettings && cfg.globalSettings.diagnostics) || {};
  return {
    running: !!diagnosticAgent,
    port: diagnosticAgent ? diagnosticAgent.getPort() : (diag.port || 9110),
    bindMode: diag.bindMode === 'network' ? 'network' : 'local',
    bindAddress: _diagBindHost(diag),
    publicHost: _diagPublicHost(diag),
    allowlistCount: _diagAllowlist(diag).length,
    clientCount: diagnosticAgent ? diagnosticAgent.getClientCount() : 0,
    lastAccess: diagnosticAgent ? diagnosticAgent.getLastAccess() : null
  };
});

function createCaptureWindow() {
  if (captureWindow && !captureWindow.isDestroyed()) return;
  captureWindowReady = false;
  captureWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'lib', 'remote-capture-preload.js')
    }
  });
  captureWindow.loadFile(path.join(__dirname, 'lib', 'remote-capture.html'));

  // Wait for window to be fully loaded before sending signaling messages
  captureWindow.webContents.on('dom-ready', () => {
    debugLog('remote: capture window ready, draining', signalingQueue.length, 'queued messages');
    captureWindowReady = true;
    for (const msg of signalingQueue) {
      captureWindow.webContents.send('remote:signaling-to-capture', msg);
    }
    signalingQueue = [];
  });

  // Crash recovery: if hidden window closes unexpectedly while clients connected, recreate it
  captureWindow.on('closed', () => {
    captureWindow = null;
    captureWindowReady = false;
    signalingQueue = [];
    if (remoteServer && remoteServer.getClientCount() > 0) {
      debugLog('remote: capture window crashed, recreating...');
      createCaptureWindow();
    }
  });
}

function destroyCaptureWindow() {
  if (captureWindow && !captureWindow.isDestroyed()) {
    captureWindow.close();
    captureWindow = null;
  }
}

async function startRemoteServer() {
  if (remoteServer) {
    remoteServer.stop();
    remoteServer = null;
  }

  const config = configStore.load();
  const remote = config.globalSettings && config.globalSettings.remote;
  if (!remote || !remote.enabled) return;

  let token = remote.token;
  if (!token) {
    const canonical = await configStore.saveRemoteSettings(remote, generateToken);
    token = canonical.token;
  }

  remoteServer = new RemoteServer();
  try {
    await remoteServer.start({
      port: remote.port || 9100,
      token,
      allowInput: remote.allowInput !== false,
      mainWindow,
      onSignalingToCapture: (data) => {
        if (!captureWindow || captureWindow.isDestroyed()) {
          debugLog('remote: signaling dropped, no capture window');
          return;
        }
        if (captureWindowReady) {
          captureWindow.webContents.send('remote:signaling-to-capture', data);
        } else {
          debugLog('remote: capture window not ready, queuing', data.type, 'message');
          signalingQueue.push(data);
        }
      },
      onCreateCaptureWindow: () => createCaptureWindow(),
      onDestroyCaptureWindow: () => destroyCaptureWindow()
    });
  } catch (error) {
    try { remoteServer.stop(); } catch {}
    remoteServer = null;
    destroyCaptureWindow();
    throw error;
  }

  debugLog(`remote-server started on port ${remoteServer.getPort()}`);
}

// IPC: Signaling from capture window back to dashboard client
ipcMain.on('remote:signaling-from-capture', (_event, data) => {
  if (remoteServer && data.clientId) {
    remoteServer.sendToClient(data.clientId, data);
  }
});

// IPC: Debug logging from capture window
ipcMain.on('remote:capture-log', (_event, msg) => {
  debugLog('remote-capture:', msg);
});

// IPC: Input events from capture window
ipcMain.on('remote:input-event', (_event, data) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const config = configStore.load();
  const remote = config.globalSettings && config.globalSettings.remote;
  if (!remote || !remote.allowInput) return;
  if (data.role !== 'admin') return;

  // Capture includes window frame (title bar) but NOT invisible DWM borders
  // sendInputEvent coordinates are relative to web content area
  const winBounds = mainWindow.getBounds();
  const contentBounds = mainWindow.getContentBounds();
  // Windows 10/11: getBounds() includes ~7px invisible resize borders not in capture
  const dwm = process.platform === 'win32' ? 7 : 0;
  const capturedW = winBounds.width - 2 * dwm;
  const capturedH = winBounds.height - dwm; // only bottom has invisible border
  const contentOffsetX = contentBounds.x - (winBounds.x + dwm);
  const contentOffsetY = contentBounds.y - winBounds.y;
  const rawX = typeof data.x === 'number' && isFinite(data.x) ? data.x : 0;
  const rawY = typeof data.y === 'number' && isFinite(data.y) ? data.y : 0;
  const x = Math.round(rawX * capturedW - contentOffsetX);
  const y = Math.round(rawY * capturedH - contentOffsetY);

  switch (data.type) {
    case 'mousemove':
      mainWindow.webContents.sendInputEvent({ type: 'mouseMove', x, y });
      break;
    case 'mousedown':
      mainWindow.webContents.sendInputEvent({
        type: 'mouseDown', x, y,
        button: data.button === 'right' ? 'right' : 'left',
        clickCount: 1
      });
      break;
    case 'mouseup':
      mainWindow.webContents.sendInputEvent({
        type: 'mouseUp', x, y,
        button: data.button === 'right' ? 'right' : 'left',
        clickCount: 1
      });
      break;
    case 'scroll':
      mainWindow.webContents.sendInputEvent({
        type: 'mouseWheel', x, y,
        deltaX: data.deltaX || 0,
        deltaY: data.deltaY || 0
      });
      break;
    case 'keydown':
      mainWindow.webContents.sendInputEvent({
        type: 'keyDown',
        keyCode: data.key,
        modifiers: buildModifiers(data)
      });
      if (data.key.length === 1) {
        mainWindow.webContents.sendInputEvent({
          type: 'char',
          keyCode: data.key,
          modifiers: buildModifiers(data)
        });
      }
      break;
    case 'keyup':
      mainWindow.webContents.sendInputEvent({
        type: 'keyUp',
        keyCode: data.key,
        modifiers: buildModifiers(data)
      });
      break;
  }
});

function buildModifiers(data) {
  const mods = [];
  if (data.shift) mods.push('shift');
  if (data.ctrl) mods.push('control');
  if (data.alt) mods.push('alt');
  return mods;
}

// IPC: Get capture source ID (desktopCapturer must run in main process in Electron 33+)
ipcMain.handle('remote:get-capture-source-id', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    debugLog('remote: capture source - mainWindow not available');
    return null;
  }
  // Use getMediaSourceId() for exact window capture without enumeration
  const sourceId = mainWindow.getMediaSourceId();
  debugLog('remote: capture source - getMediaSourceId:', sourceId);
  if (sourceId) return sourceId;

  // Fallback: enumerate sources
  const { desktopCapturer } = require('electron');
  const sources = await desktopCapturer.getSources({ types: ['window', 'screen'] });
  const title = mainWindow.getTitle();
  debugLog('remote: capture source - fallback, looking for title:', title);
  let source = sources.find(s => s.name === title);
  if (!source) source = sources.find(s => s.name.includes('Multi-Hoster'));
  if (!source) source = sources.find(s => s.id.startsWith('screen:'));
  debugLog('remote: capture source -', source ? `found: ${source.name} (${source.id})` : 'NONE FOUND');
  return source ? source.id : null;
});

// IPC: Client count updates from capture window
ipcMain.on('remote:client-count', (_event, count) => {
  safeSend('remote:client-count', count);
});

// IPC: Remote settings
ipcMain.handle('remote:get-settings', () => {
  const config = configStore.load();
  return config.globalSettings && config.globalSettings.remote || {};
});

ipcMain.handle('remote:save-settings', async (_event, remoteSettings) => {
  assertConfigWriteAllowed();
  const canonicalSettings = await configStore.saveRemoteSettings(remoteSettings, generateToken);

  let runtimeError = '';
  try {
    if (canonicalSettings.enabled) {
      await startRemoteServer();
    } else if (remoteServer) {
      remoteServer.stop();
      remoteServer = null;
      destroyCaptureWindow();
      debugLog('remote-server stopped');
    }
  } catch (error) {
    runtimeError = error && error.message ? error.message : String(error);
  }
  return {
    saved: true,
    runtimeError,
    settings: canonicalSettings
  };
});

ipcMain.handle('remote:generate-token', () => {
  return generateToken();
});

ipcMain.handle('remote:status', () => {
  return {
    running: !!remoteServer,
    port: remoteServer ? remoteServer.getPort() : null,
    clientCount: remoteServer ? remoteServer.getClientCount() : 0
  };
});

// --- Always on top ---
ipcMain.handle('set-always-on-top', async (_event, value) => {
  assertConfigWriteAllowed();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setAlwaysOnTop(!!value);
  }
  await configStore.save({ globalSettings: { ...configStore.load().globalSettings, alwaysOnTop: !!value } });
  return true;
});

ipcMain.handle('get-always-on-top', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return mainWindow.isAlwaysOnTop();
  }
  return false;
});

// --- Drop Target Window ---
function createDropTargetWindow() {
  if (dropTargetWindow && !dropTargetWindow.isDestroyed()) return;
  const { screen } = require('electron');
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize;
  dropTargetWindow = new BrowserWindow({
    width: 120,
    height: 120,
    x: width - 140,
    y: height - 140,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    focusable: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload-drop-target.js')
    }
  });
  dropTargetWindow.loadFile('renderer/drop-target.html');
  dropTargetWindow.on('closed', () => { dropTargetWindow = null; });
}

function destroyDropTargetWindow() {
  if (dropTargetWindow && !dropTargetWindow.isDestroyed()) {
    dropTargetWindow.close();
    dropTargetWindow = null;
  }
}

ipcMain.handle('show-drop-target', () => {
  createDropTargetWindow();
  return true;
});

ipcMain.handle('hide-drop-target', () => {
  destroyDropTargetWindow();
  return true;
});

ipcMain.on('drop-target:files', (_event, paths) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (!mainWindow.isVisible() || mainWindow.isMinimized()) {
      mainWindow.show();
      mainWindow.focus();
    }
    safeSend('drop-target:files', paths);
  }
});

// --- Shutdown after finish ---
let shutdownMode = 'nothing';
let shutdownTimer = null;

ipcMain.handle('set-shutdown-after-finish', (_event, mode) => {
  shutdownMode = mode || 'nothing';
  // Cancel active countdown if mode changed to 'nothing'
  if (shutdownMode === 'nothing' && shutdownTimer) {
    clearTimeout(shutdownTimer);
    shutdownTimer = null;
  }
  return true;
});

ipcMain.handle('get-shutdown-after-finish', () => {
  return shutdownMode;
});

ipcMain.handle('cancel-shutdown', () => {
  if (shutdownTimer) {
    clearTimeout(shutdownTimer);
    shutdownTimer = null;
  }
  shutdownMode = 'nothing';
  return true;
});

function handleShutdownAfterFinish() {
  if (shutdownMode === 'nothing') return;

  const { exec } = require('child_process');

  // Notify renderer
  safeSend('shutdown-countdown', { mode: shutdownMode, seconds: 60 });

  // Clear any previous countdown to prevent orphaned timers
  if (shutdownTimer) clearTimeout(shutdownTimer);

  shutdownTimer = setTimeout(() => {
    // Read current mode at execution time (not captured at scheduling time)
    if (shutdownMode === 'shutdown') {
      exec('shutdown /s /t 0', (err) => { if (err) debugLog(`shutdown failed: ${err.message}`); });
    } else if (shutdownMode === 'restart') {
      exec('shutdown /r /t 0', (err) => { if (err) debugLog(`restart failed: ${err.message}`); });
    } else if (shutdownMode === 'sleep') {
      exec('rundll32.exe powrprof.dll,SetSuspendState 0,1,0', (err) => { if (err) debugLog(`sleep failed: ${err.message}`); });
    }
    // else: mode was changed to 'nothing' during countdown — do nothing
  }, 60000);
}

// Restore always-on-top from config on window creation
app.on('browser-window-created', () => {
  const config = configStore.load();
  if (config.globalSettings && config.globalSettings.alwaysOnTop && mainWindow) {
    mainWindow.setAlwaysOnTop(true);
  }
});
