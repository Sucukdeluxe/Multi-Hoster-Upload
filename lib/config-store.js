const fs = require('fs');
const path = require('path');
const secretStore = require('./secret-store');
const { normalizeLogMode } = require('./log-mode');
const { normalizeUploadSchedule } = require('./upload-schedule');

const HOSTER_SETTINGS_DEFAULTS = {
  retries: 3,
  maxSpeedKbs: 0,       // 0 = unlimited
  parallelCount: 2,     // 1-100
  restartBelowKbs: 0,   // 0 = off
  timeIntervalSec: 0,   // delay between jobs
  maxSizeMb: 0,         // 0 = unlimited
  logToFile: true,      // write this hoster's successful links to fileuploader.log
  rotateAccounts: false,
  sizeMemoEnabled: true
};

// Template for each hoster type (used as defaults for new accounts)
const HOSTER_ACCOUNT_TEMPLATES = {
  'doodstream.com': { enabled: true, authType: 'login', username: '', password: '' },
  'doodstream.com:api': { enabled: true, authType: 'api', apiKey: '' },
  'voe.sx': { enabled: true, authType: 'login', username: '', password: '' },
  'voe.sx:api': { enabled: true, authType: 'api', apiKey: '' },
  'vidmoly.me': { enabled: true, authType: 'login', username: '', password: '' },
  'byse.sx': { enabled: true, authType: 'api', apiKey: '' },
  'clouddrop.cc': { enabled: true, authType: 'api', apiKey: '' }
};

// All known hoster names (used for iteration)
const HOSTER_NAMES = ['doodstream.com', 'voe.sx', 'vidmoly.me', 'byse.sx', 'clouddrop.cc'];

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

const DEFAULTS = {
  hosters: {
    'doodstream.com': [],
    'voe.sx': [],
    'vidmoly.me': [],
    'byse.sx': [],
    'clouddrop.cc': []
  },
  hosterSettings: {
    'doodstream.com': { ...HOSTER_SETTINGS_DEFAULTS },
    'voe.sx': { ...HOSTER_SETTINGS_DEFAULTS },
    'vidmoly.me': { ...HOSTER_SETTINGS_DEFAULTS },
    'byse.sx': { ...HOSTER_SETTINGS_DEFAULTS },
    'clouddrop.cc': { ...HOSTER_SETTINGS_DEFAULTS }
  },
  globalSettings: {
    language: 'en',
    alwaysOnTop: false,
    shutdownAfterFinish: 'nothing', // nothing | sleep | shutdown | restart
    logFilePath: '',
    sessionLog: false,                  // legacy boolean (kept for back-compat reads); normalized into logMode on load
    logVerbose: false,                  // when true, [DEBUG] level entries are written to debug.log
    webhookUrl: '',                     // POST target on batch-done (Discord or generic JSON)
    webhookMention: '',                 // optional Discord ping target: user-id, role:id, @here, @everyone
    autoRetryRounds: 0,                 // 0 = off; 1-5 automatic retry rounds for transient failures after batch end
    autoRetryDelayMin: 5,               // base delay in minutes between auto-retry rounds (linear backoff: round N waits N*delay)
    historyRetention: 'all',            // 'all' | '7d' | '30d' | '90d' | '1000' | '100' — storage cap for upload history
    // NOTE: logMode is intentionally NOT in DEFAULTS. If it were, the deep-merge
    // would seed logMode='single' for every load, which would beat (and silently
    // erase) the legacy sessionLog:true → "daily" migration. normalizeLogMode in
    // load() sets logMode after the merge, looking at the saved-only data.
    resumeQueueOnLaunch: true,
    autoStartRestoredQueue: false,
    parallelUploadCount: 0, // 0 = use per-hoster limits only
    scaleParallelUploads: false,
    lastBrowseDirectory: '',
    removeFromQueueOnDone: false,
    deleteSourceAfterSuccessfulUpload: false,
    filenameFilter: {
      enabled: false,
      action: 'include',
      matchMode: 'all',
      conditions: []
    },
    uploadSchedule: {
      enabled: false,
      weekdays: [1, 2, 3, 4, 5, 6, 0],
      start: '00:00',
      end: '23:59'
    },
    showDropTarget: false,
    globalMaxSpeedKbs: 0, // 0 = unlimited global speed
    pendingQueue: null,
    uploadRecovery: null,
    scramble: {
      active: false,
      prefix: '',
      suffix: '',
      chars: 'both', // 'letters' | 'numbers' | 'both'
      length: 0       // 0 = same as original basename length
    },
    folderMonitor: {
      enabled: false,
      folderPath: '',
      recursive: false,
      includeExisting: false,
      filterMode: 'include',  // 'include' | 'exclude'
      extensions: '',          // comma-separated: 'mp4,mkv,avi'
      skipDuplicates: true,
      delaySec: 3,
      autoStart: true,
      hosters: []              // pre-selected hosters, empty = ask via modal
    },
    remote: {
      enabled: false,
      port: 9100,
      token: '',
      allowInput: true
    },
    diagnostics: {
      enabled: false,
      port: 9110,
      token: '',
      label: '',
      codeIssuedAt: 0,
      bindMode: 'local',
      publicHost: '',
      allowlist: [],
      bindAddress: '127.0.0.1'
    }
  },
  history: [],
  rotationCursors: {}
};

const HISTORY_RETENTION_OPTIONS = [
  { value: 'all', label: 'Alles behalten' },
  { value: '7d', label: 'Letzte 7 Tage' },
  { value: '30d', label: 'Letzte 30 Tage' },
  { value: '90d', label: 'Letzte 90 Tage' },
  { value: '1000', label: 'Letzte 1000 Uploads' },
  { value: '100', label: 'Letzte 100 Uploads' }
];

const DIAGNOSTIC_ERROR_MESSAGES = Object.freeze({
  DIAGNOSTIC_CONFIG_READ_FAILED: 'Die Diagnosekonfiguration konnte nicht gelesen werden',
  DIAGNOSTIC_CONFIG_INVALID: 'Die Diagnosekonfiguration ist ungültig',
  DIAGNOSTIC_HISTORY_NOT_FOUND: 'Die Diagnoseverlaufsdatei wurde nicht gefunden',
  DIAGNOSTIC_HISTORY_READ_FAILED: 'Die Diagnoseverlaufsdatei konnte nicht gelesen werden',
  DIAGNOSTIC_HISTORY_INVALID: 'Die Diagnoseverlaufsdatei ist ungültig'
});

function diagnosticStoreError(code) {
  const error = new Error(DIAGNOSTIC_ERROR_MESSAGES[code]);
  error.code = code;
  return error;
}

function batchTimestampMs(batch) {
  const raw = batch && batch.timestamp;
  if (raw === null || raw === undefined || raw === '') return null;
  const ms = typeof raw === 'number' ? raw : Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

function batchRowCount(batch) {
  let n = 0;
  const files = (batch && batch.files) || [];
  for (const file of files) {
    n += (file.results || []).length;
  }
  return n;
}

function countHistoryRows(history) {
  let n = 0;
  for (const batch of (history || [])) n += batchRowCount(batch);
  return n;
}

function applyHistoryRetention(history, retention, nowMs) {
  if (!Array.isArray(history) || history.length === 0) return history;
  const policy = String(retention || 'all');
  if (policy === 'all') return history;

  if (/^\d+d$/.test(policy)) {
    const days = parseInt(policy, 10);
    if (!Number.isFinite(days) || days <= 0) return history;
    const cutoff = nowMs - days * 86400000;
    return history.filter(b => {
      const ts = batchTimestampMs(b);
      return ts === null || ts >= cutoff;
    });
  }

  const maxRows = parseInt(policy, 10);
  if (!Number.isFinite(maxRows) || maxRows <= 0) return history;
  const keptReversed = [];
  let acc = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    keptReversed.push(history[i]);
    acc += batchRowCount(history[i]);
    if (acc >= maxRows) break;
  }
  return keptReversed.reverse();
}

class ConfigStore {
  constructor(app) {
    const useUserDataDir = app && (
      app.isPackaged ||
      (app.commandLine && typeof app.commandLine.hasSwitch === 'function' && app.commandLine.hasSwitch('user-data-dir'))
    );
    const dir = useUserDataDir
      ? app.getPath('userData')
      : path.join(__dirname, '..');
    this.filePath = path.join(dir, 'electron-config.json');
    this.historyPath = path.join(dir, 'electron-history.json');
    this._writeQueue = Promise.resolve(); // Serializes all writes to prevent race conditions
    this._historyWriteQueue = Promise.resolve();
    this._pendingWriteOperations = new Set();
    this._writesQuiesced = false;
    this._historyMigrated = false;
    this._cache = null;
    this._cacheKey = '';
    this._perfLog = null;
    this._wqDepth = 0;

    // Migrate config from old location if current doesn't exist
    if (!fs.existsSync(this.filePath) && app && app.isPackaged) {
      this._migrateFromOldPath(app);
    }
    if (app && app.isPackaged) {
      this._migrateHistory();
    }
  }

  _readHistoryFile() {
    try {
      const raw = fs.readFileSync(this.historyPath, 'utf-8');
      if (!raw || raw.trim().length < 2) return [];
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && Array.isArray(parsed.history)) return parsed.history;
      return [];
    } catch {
      return null;
    }
  }

  _readHistoryFileStrict() {
    let raw;
    try {
      raw = fs.readFileSync(this.historyPath, 'utf-8');
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        throw diagnosticStoreError('DIAGNOSTIC_HISTORY_NOT_FOUND');
      }
      throw diagnosticStoreError('DIAGNOSTIC_HISTORY_READ_FAILED');
    }
    if (!raw || raw.trim().length < 2) {
      throw diagnosticStoreError('DIAGNOSTIC_HISTORY_INVALID');
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw diagnosticStoreError('DIAGNOSTIC_HISTORY_INVALID');
    }
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.history)) return parsed.history;
    throw diagnosticStoreError('DIAGNOSTIC_HISTORY_INVALID');
  }

  _writeHistoryFileDurable(arr) {
    const tmp = this.historyPath + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, JSON.stringify(arr));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.historyPath);
  }

  async _writeHistoryFileAtomic(arr) {
    const tmp = this.historyPath + '.tmp';
    let handle;
    let operationError;
    try {
      handle = await fs.promises.open(tmp, 'w');
      await handle.writeFile(JSON.stringify(arr), 'utf-8');
      await handle.sync();
    } catch (error) {
      operationError = error;
    }
    if (handle) {
      try {
        await handle.close();
      } catch (error) {
        if (!operationError) operationError = error;
      }
    }
    if (operationError) throw operationError;
    await fs.promises.rename(tmp, this.historyPath);
    let directoryHandle;
    try {
      directoryHandle = await fs.promises.open(path.dirname(this.historyPath), 'r');
      await directoryHandle.sync();
    } catch (error) {
      if (!['EINVAL', 'EISDIR', 'EPERM', 'ENOTSUP'].includes(error.code)) throw error;
    } finally {
      if (directoryHandle) await directoryHandle.close();
    }
  }

  _quiescedWriteError() {
    const error = new Error('Die Anwendung wird gerade beendet');
    error.code = 'CONFIG_WRITES_QUIESCED';
    return error;
  }

  setWritesQuiesced(quiesced) {
    this._writesQuiesced = !!quiesced;
  }

  _enqueueHistoryWrite(fn, options = {}) {
    if (this._writesQuiesced && !options.allowDuringQuiesce) return Promise.reject(this._quiescedWriteError());
    const operation = this._historyWriteQueue.then(fn, fn);
    this._pendingWriteOperations.add(operation);
    this._historyWriteQueue = operation.then(() => undefined, () => undefined);
    operation.then(
      () => this._pendingWriteOperations.delete(operation),
      () => this._pendingWriteOperations.delete(operation)
    );
    return operation;
  }

  _migrateHistory() {
    try {
      if (fs.existsSync(this.historyPath)) {
        this._historyMigrated = Array.isArray(this._readHistoryFile());
        return;
      }
      let cfg = null;
      try { cfg = this._readAndParse(this.filePath); } catch {}
      const hist = (cfg && Array.isArray(cfg.history)) ? cfg.history : [];
      this._writeHistoryFileDurable(hist);
      const check = this._readHistoryFile();
      if (Array.isArray(check) && check.length === hist.length) {
        if (hist.length > 0) {
          try { fs.copyFileSync(this.filePath, this.filePath + '.pre-history-split.bak'); } catch {}
        }
        this._historyMigrated = true;
      } else {
        this._historyMigrated = false;
      }
    } catch {
      this._historyMigrated = false;
    }
  }

  _migrateFromOldPath(app) {
    try {
      const appDataDir = path.dirname(app.getPath('userData'));
      // Check alternate folder names that may have been used
      const candidates = ['multi-hoster-uploader', 'Multi-Hoster-Upload'];
      for (const name of candidates) {
        const oldPath = path.join(appDataDir, name, 'electron-config.json');
        if (oldPath !== this.filePath && fs.existsSync(oldPath)) {
          fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
          fs.copyFileSync(oldPath, this.filePath);
          return;
        }
      }
      // Also check next to the executable (portable mode previous location)
      const exeDir = path.dirname(app.getPath('exe'));
      const portablePath = path.join(exeDir, 'electron-config.json');
      if (portablePath !== this.filePath && fs.existsSync(portablePath)) {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        fs.copyFileSync(portablePath, this.filePath);
      }
    } catch {}
  }

  _readAndParse(filePath) {
    const raw = fs.readFileSync(filePath, 'utf-8');
    if (!raw || raw.trim().length < 2) return null;
    return JSON.parse(raw);
  }

  _readConfigFileStrict() {
    let raw;
    try {
      raw = fs.readFileSync(this.filePath, 'utf-8');
    } catch {
      throw diagnosticStoreError('DIAGNOSTIC_CONFIG_READ_FAILED');
    }
    if (!raw || raw.trim().length < 2) {
      throw diagnosticStoreError('DIAGNOSTIC_CONFIG_INVALID');
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw diagnosticStoreError('DIAGNOSTIC_CONFIG_INVALID');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data) ||
        !data.hosters || typeof data.hosters !== 'object' || Array.isArray(data.hosters) ||
        !data.globalSettings || typeof data.globalSettings !== 'object' || Array.isArray(data.globalSettings) ||
        (data.history !== undefined && !Array.isArray(data.history))) {
      throw diagnosticStoreError('DIAGNOSTIC_CONFIG_INVALID');
    }
    return data;
  }

  _clone(obj) {
    try { return structuredClone(obj); }
    catch { return JSON.parse(JSON.stringify(obj)); }
  }

  setPerfLog(fn) { this._perfLog = typeof fn === 'function' ? fn : null; }

  _pqLen(globalSettings) {
    const pq = globalSettings && globalSettings.pendingQueue;
    return pq && Array.isArray(pq.queueJobs) ? pq.queueJobs.length : 0;
  }

  _callerTag() {
    const lines = (new Error().stack || '').split('\n');
    const out = [];
    for (let i = 2; i < lines.length && out.length < 3; i++) {
      const line = lines[i].trim();
      if (/config-store\.js/.test(line)) continue;
      const m = line.match(/at (?:async )?([^ (]+)/);
      if (m) out.push(m[1].split('.').pop());
    }
    return out.join('<') || '?';
  }

  load() {
    if (!this._perfLog) return this._loadImpl();
    const hadCache = !!this._cache;
    const t0 = performance.now();
    const r = this._loadImpl();
    const dt = performance.now() - t0;
    if (dt >= 20) {
      const q = this._pqLen(r && r.globalSettings);
      const h = (r && r.history || []).length;
      this._perfLog(`config-load wall=${dt.toFixed(0)}ms cache=${hadCache ? 'hit' : 'miss'} hist=${h} queue=${q} via=${this._callerTag()}`);
    }
    return r;
  }

  loadDiagnosticsConfig() {
    return this._loadImpl(true);
  }

  _loadImpl(strict = false) {
    try {
      // In-memory cache keyed on the file's mtime+size. The processed config
      // (merged + credential-decrypted) is reparsed/re-decrypted from disk ONLY
      // when the file actually changes. Our own writes refresh the cache (see
      // _commit), and an external edit changes mtime/size so the cache misses
      // and we reread. Without this, every one of the ~38 main.js load() call
      // sites (incl. the per-500ms log-flush path) re-read disk + JSON.parse the
      // whole growing history + DPAPI-decrypt every credential — the dominant
      // long-running main-thread drag. load() always returns a CLONE so callers
      // can mutate the result without corrupting the cache.
      let stat = null;
      if (!strict) {
        try { stat = fs.statSync(this.filePath); } catch {}
      }
      const statKey = stat ? `${stat.mtimeMs}:${stat.size}` : '';
      if (!strict && stat && this._cache && this._cacheKey === statKey) {
        return this._clone(this._cache);
      }

      let data = null;
      if (strict) {
        data = this._readConfigFileStrict();
      } else {
        // Try main config
        try { data = this._readAndParse(this.filePath); } catch {}
        // Fallback to backup if main is empty/corrupt
        if (!data) {
          try { data = this._readAndParse(this.filePath + '.bak'); } catch {}
        }
        if (!data) {
          try { data = this._readAndParse(this.filePath + '.pre-history-split.bak'); } catch {}
        }
      }
      if (!data) {
        const fresh = JSON.parse(JSON.stringify(DEFAULTS));
        fresh.globalSettings.logMode = normalizeLogMode(fresh.globalSettings);
        return fresh;
      }

      // Migrate old single-object format to array format
      for (const [name, val] of Object.entries(data.hosters || {})) {
        if (val && !Array.isArray(val)) {
          if (!val.id) val.id = `${name}-migrated-${Date.now()}`;
          // Infer authType for old format accounts
          if (!val.authType) {
            if (name === 'byse.sx') val.authType = 'api';
            else if (name === 'vidmoly.me') val.authType = 'login';
            else if (val.username && val.password) val.authType = 'login';
            else if (val.apiKey) val.authType = 'api';
            else val.authType = 'login';
          }
          data.hosters[name] = [val];
        }
      }

      // Merge hosters: ensure all known hosters exist as arrays
      const hosters = {};
      for (const name of HOSTER_NAMES) {
        const saved = data.hosters && data.hosters[name];
        if (Array.isArray(saved) && saved.length > 0) {
          hosters[name] = saved.map((acc, i) => {
            // Ensure authType is set on every account
            if (!acc.authType) {
              if (name === 'byse.sx') acc.authType = 'api';
              else if (name === 'vidmoly.me') acc.authType = 'login';
              else if (acc.username && acc.password) acc.authType = 'login';
              else if (acc.apiKey) acc.authType = 'api';
              else acc.authType = 'login';
            }
            return {
              ...acc,
              id: acc.id || `${name}-${Date.now()}-${i}`
            };
          });
        } else {
          hosters[name] = [];
        }
      }

      // Merge hoster settings with defaults
      const hosterSettings = {};
      for (const name of Object.keys(DEFAULTS.hosterSettings)) {
        hosterSettings[name] = {
          ...HOSTER_SETTINGS_DEFAULTS,
          ...(data.hosterSettings && data.hosterSettings[name] || {})
        };
      }
      const savedGlobal = data.globalSettings || {};
      const globalSettings = {
        ...DEFAULTS.globalSettings,
        ...savedGlobal
      };
      delete globalSettings.allowPlaintextCredentialStorage;
      // Deep-merge nested objects so new keys are always present
      for (const key of Object.keys(DEFAULTS.globalSettings)) {
        const def = DEFAULTS.globalSettings[key];
        if (def && typeof def === 'object' && !Array.isArray(def)) {
          globalSettings[key] = { ...def, ...(savedGlobal[key] || {}) };
        }
      }
      // Normalize logMode at this single boundary. Legacy sessionLog: true
      // means *daily* (the old field was named after a misnomer); see log-mode.js.
      // Downstream readers consume logMode only and must NOT derive from
      // sessionLog at call sites.
      globalSettings.logMode = normalizeLogMode(globalSettings);
      globalSettings.uploadSchedule = normalizeUploadSchedule(globalSettings.uploadSchedule);
      const rotationCursors = (data.rotationCursors && typeof data.rotationCursors === 'object' && !Array.isArray(data.rotationCursors))
        ? data.rotationCursors
        : {};
      const result = { hosters, hosterSettings, globalSettings, history: this._historyMigrated ? [] : (data.history || []), rotationCursors };
      // Decrypt credentials stored with safeStorage so the rest of the app
      // keeps working with plaintext in memory.
      secretStore.decryptCredentials(result);
      if (!strict && stat) {
        this._cache = result;
        this._cacheKey = statKey;
      }
      return this._clone(result);
    } catch (error) {
      if (strict || error instanceof secretStore.SecretStoreError) throw error;
      const fresh = JSON.parse(JSON.stringify(DEFAULTS));
      fresh.globalSettings.logMode = normalizeLogMode(fresh.globalSettings);
      return fresh;
    }
  }

  // Encrypt credential fields without mutating the caller's plaintext object.
  // Only `hosters` carries credentials, so we clone ONLY that subtree — the rest
  // (history, globalSettings, …) is referenced read-only into the stringified
  // object. Deep-cloning the whole config here (incl. an ever-growing history)
  // on every write was a primary long-running main-thread stall.
  _serializeForDisk(config) {
    const hosters = this._clone(config.hosters || {});
    const globalSettings = this._clone(config.globalSettings || {});
    delete globalSettings.allowPlaintextCredentialStorage;
    globalSettings.uploadSchedule = normalizeUploadSchedule(globalSettings.uploadSchedule);
    secretStore.encryptCredentials({ hosters });
    return JSON.stringify({ ...config, globalSettings, hosters }, null, 2);
  }

  _commit(config) {
    if (!this._perfLog) return this._atomicWrite(this._serializeForDisk(config));
    const t0 = performance.now();
    const data = this._serializeForDisk(config);
    const dt = performance.now() - t0;
    if (dt >= 20) {
      const q = this._pqLen(config.globalSettings);
      const h = (config.history || []).length;
      this._perfLog(`config-serialize wall=${dt.toFixed(0)}ms bytes=${data.length} hist=${h} queue=${q} wqDepth=${this._wqDepth} via=${this._callerTag()}`);
    }
    return this._atomicWrite(data);
  }

  _enqueueWrite(fn, options = {}) {
    if (this._writesQuiesced && !options.allowDuringQuiesce) return Promise.reject(this._quiescedWriteError());
    this._wqDepth++;
    const operation = this._writeQueue.then(fn, fn);
    this._pendingWriteOperations.add(operation);
    this._writeQueue = operation.then(
      () => { this._wqDepth--; },
      () => {
        this._wqDepth--;
      }
    );
    operation.then(
      () => this._pendingWriteOperations.delete(operation),
      () => this._pendingWriteOperations.delete(operation)
    );
    return operation;
  }

  async drainWrites() {
    while (this._pendingWriteOperations.size > 0) {
      const pending = Array.from(this._pendingWriteOperations);
      const results = await Promise.allSettled(pending);
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
    }
  }

  _anyHosters(cfg) {
    const h = cfg && cfg.hosters;
    return !!h && typeof h === 'object' && Object.values(h).some(a => Array.isArray(a) && a.length > 0);
  }

  _recoverHostersFromDisk() {
    for (const p of [this.filePath, this.filePath + '.bak', this.filePath + '.pre-history-split.bak']) {
      try {
        const raw = fs.readFileSync(p, 'utf-8');
        if (!raw || raw.trim().length < 2) continue;
        const data = JSON.parse(raw);
        if (this._anyHosters(data)) return data.hosters;
      } catch {}
    }
    return null;
  }

  _guardHosters(current, hostersIntentional) {
    if (!hostersIntentional && !this._anyHosters(current)) {
      const recovered = this._recoverHostersFromDisk();
      if (recovered) {
        current.hosters = recovered;
        if (this._perfLog) this._perfLog('config-guard: prevented account wipe — restored hosters from on-disk backup after a corrupt/empty read');
      }
    }
    return current;
  }

  save(config) {
    return this._enqueueWrite(() => {
      const current = this.load();
      if (config.hosters) current.hosters = config.hosters;
      if (config.hosterSettings) current.hosterSettings = config.hosterSettings;
      if (config.globalSettings) current.globalSettings = config.globalSettings;
      this._guardHosters(current, !!config.hosters);
      return this._commit(current);
    });
  }

  savePendingQueue(pendingQueue, options = {}) {
    const snapshot = pendingQueue === null || pendingQueue === undefined ? null : this._clone(pendingQueue);
    return this._enqueueWrite(() => {
      const current = this.load();
      current.globalSettings = {
        ...(current.globalSettings || {}),
        pendingQueue: snapshot
      };
      this._guardHosters(current, false);
      return this._commit(current);
    }, options);
  }

  saveUploadRecovery(uploadRecovery, options = {}) {
    const snapshot = uploadRecovery === null || uploadRecovery === undefined ? null : this._clone(uploadRecovery);
    return this._enqueueWrite(() => {
      const current = this.load();
      current.globalSettings = {
        ...(current.globalSettings || {}),
        uploadRecovery: snapshot
      };
      this._guardHosters(current, false);
      return this._commit(current);
    }, options);
  }

  saveLastBrowseDirectory(directory) {
    const snapshot = String(directory || '').trim();
    return this._enqueueWrite(() => {
      const current = this.load();
      current.globalSettings = {
        ...(current.globalSettings || {}),
        lastBrowseDirectory: snapshot
      };
      this._guardHosters(current, false);
      return this._commit(current);
    });
  }

  saveFallbackLogPath(logFilePath) {
    const snapshot = String(logFilePath || '').trim();
    return this._enqueueWrite(() => {
      const current = this.load();
      current.globalSettings = {
        ...(current.globalSettings || {}),
        logFilePath: snapshot
      };
      this._guardHosters(current, false);
      return this._commit(current);
    });
  }

  saveRendererGlobalSettings(globalSettings) {
    const snapshot = this._clone(globalSettings || {});
    return this._enqueueWrite(() => {
      const current = this.load();
      const currentGlobalSettings = current.globalSettings || {};
      const currentRemote = currentGlobalSettings.remote || {};
      const incomingRemote = snapshot.remote || {};
      current.globalSettings = {
        ...snapshot,
        pendingQueue: currentGlobalSettings.pendingQueue ?? null,
        uploadRecovery: currentGlobalSettings.uploadRecovery ?? null,
        lastBrowseDirectory: currentGlobalSettings.lastBrowseDirectory || '',
        diagnostics: this._clone(currentGlobalSettings.diagnostics || {}),
        historyRetention: currentGlobalSettings.historyRetention || 'all',
        remote: {
          ...incomingRemote,
          token: incomingRemote.token || currentRemote.token || ''
        }
      };
      this._guardHosters(current, false);
      return this._commit(current);
    });
  }

  saveRemoteSettings(remoteSettings, createToken) {
    const incoming = this._clone(remoteSettings || {});
    return this._enqueueWrite(async () => {
      const current = this.load();
      const currentGlobalSettings = current.globalSettings || {};
      const currentRemote = currentGlobalSettings.remote || {};
      const token = incoming.token || currentRemote.token || (incoming.enabled && typeof createToken === 'function' ? createToken() : '');
      const canonical = { ...incoming, token };
      current.globalSettings = { ...currentGlobalSettings, remote: canonical };
      this._guardHosters(current, false);
      await this._commit(current);
      return this._clone(canonical);
    });
  }

  replaceSettings(config) {
    return this._enqueueWrite(() => {
      const current = this.load();
      const globalSettings = this._clone(config.globalSettings);
      globalSettings.pendingQueue = current.globalSettings.pendingQueue ?? null;
      globalSettings.uploadRecovery = current.globalSettings.uploadRecovery ?? null;
      return this._commit({
        hosters: this._clone(config.hosters),
        hosterSettings: this._clone(config.hosterSettings),
        globalSettings,
        history: this._clone(current.history || []),
        rotationCursors: {}
      });
    });
  }

  loadHistory() {
    if (this._historyMigrated) {
      return this._readHistoryFile() || [];
    }
    const config = this.load();
    return config.history || [];
  }

  loadDiagnosticsHistory() {
    if (this._historyMigrated) return this._readHistoryFileStrict();
    try {
      return this._readHistoryFileStrict();
    } catch (error) {
      if (!error || error.code !== 'DIAGNOSTIC_HISTORY_NOT_FOUND') throw error;
    }
    const config = this.loadDiagnosticsConfig();
    if (!Array.isArray(config.history)) {
      throw diagnosticStoreError('DIAGNOSTIC_HISTORY_INVALID');
    }
    return config.history;
  }

  _atomicWrite(data) {
    return new Promise((resolve, reject) => {
      const tmpPath = this.filePath + '.tmp';
      const backupPath = this.filePath + '.bak';
      let fd;
      try {
        fd = fs.openSync(tmpPath, 'w');
        fs.writeSync(fd, data);
        fs.fsyncSync(fd);
      } catch (e) {
        try { if (fd !== undefined) fs.closeSync(fd); } catch {}
        return reject(e);
      }
      try { fs.closeSync(fd); } catch {}
      Promise.resolve().then(() => {
        try {
          try {
            if (fs.existsSync(this.filePath)) {
              const cur = fs.readFileSync(this.filePath, 'utf-8');
              if (cur && cur.trim().length > 2) fs.writeFileSync(backupPath, cur, 'utf-8');
            }
          } catch {}
          fs.renameSync(tmpPath, this.filePath);
        } catch (e) { return reject(e); }
        // Invalidate the read cache: the next load() re-reads + re-merges the
        // freshly-written file (the on-disk format is sparse — load() fills
        // defaults — so we must NOT serve a pre-merge in-memory object).
        this._cache = null;
        this._cacheKey = '';
        resolve();
      });
    });
  }

  appendHistory(entry) {
    if (this._historyMigrated) {
      return this._enqueueHistoryWrite(() => {
        const cur = this._readHistoryFile();
        if (cur === null && fs.existsSync(this.historyPath)) {
          throw new Error('Die Verlaufsdatei ist beschädigt und wurde nicht verändert');
        }
        const arr = cur || [];
        arr.push(entry);
        const gs = this.load().globalSettings;
        const retention = (gs && gs.historyRetention) || 'all';
        const pruned = applyHistoryRetention(arr, retention, Date.now());
        return this._writeHistoryFileAtomic(pruned);
      });
    }
    return this._enqueueWrite(() => {
      const config = this.load();
      config.history.push(entry);
      const retention = (config.globalSettings && config.globalSettings.historyRetention) || 'all';
      config.history = applyHistoryRetention(config.history, retention, Date.now());
      return this._commit(config);
    });
  }

  pruneHistory(retention, opts = {}) {
    const dryRun = !!opts.dryRun;
    if (this._historyMigrated) {
      return this._enqueueHistoryWrite(async () => {
        const storedHistory = this._readHistoryFile();
        if (storedHistory === null && fs.existsSync(this.historyPath)) {
          throw new Error('Die Verlaufsdatei ist beschädigt und wurde nicht verändert');
        }
        const current = storedHistory || [];
        const beforeBatches = current.length;
        const beforeRows = countHistoryRows(current);
        const pruned = applyHistoryRetention(current, retention, Date.now());
        const result = {
          removedBatches: beforeBatches - pruned.length,
          removedRows: beforeRows - countHistoryRows(pruned),
          keptBatches: pruned.length,
          keptRows: countHistoryRows(pruned)
        };
        if (dryRun) return result;
        return this._enqueueWrite(async () => {
          const config = this.load();
          const previousGlobalSettings = this._clone(config.globalSettings || {});
          config.globalSettings = { ...previousGlobalSettings, historyRetention: String(retention || 'all') };
          this._guardHosters(config, false);
          await this._commit(config);
          try {
            await this._writeHistoryFileAtomic(pruned);
          } catch (historyError) {
            config.globalSettings = previousGlobalSettings;
            try {
              await this._commit(config);
            } catch (rollbackError) {
              throw new AggregateError([historyError, rollbackError], 'Verlauf und Aufbewahrung konnten nicht konsistent gespeichert werden');
            }
            throw historyError;
          }
          return result;
        });
      });
    }
    return this._enqueueWrite(() => {
      const config = this.load();
      const beforeBatches = config.history.length;
      const beforeRows = countHistoryRows(config.history);
      const pruned = applyHistoryRetention(config.history, retention, Date.now());
      const result = {
        removedBatches: beforeBatches - pruned.length,
        removedRows: beforeRows - countHistoryRows(pruned),
        keptBatches: pruned.length,
        keptRows: countHistoryRows(pruned)
      };
      if (dryRun) return result;
      config.history = pruned;
      if (config.globalSettings) config.globalSettings.historyRetention = String(retention || 'all');
      return this._commit(config).then(() => result);
    });
  }

  clearHistory() {
    if (this._historyMigrated) {
      return this._enqueueHistoryWrite(() => this._writeHistoryFileAtomic([]));
    }
    return this._enqueueWrite(() => {
      const config = this.load();
      config.history = [];
      return this._commit(config);
    });
  }

  saveRotationCursors(cursors) {
    return this._enqueueWrite(() => {
      const config = this.load();
      config.rotationCursors = (cursors && typeof cursors === 'object' && !Array.isArray(cursors)) ? cursors : {};
      this._guardHosters(config, false);
      return this._commit(config);
    });
  }
}

module.exports = ConfigStore;
module.exports.HOSTER_ACCOUNT_TEMPLATES = HOSTER_ACCOUNT_TEMPLATES;
module.exports.HOSTER_NAMES = HOSTER_NAMES;
module.exports.HOSTER_ADD_OPTIONS = HOSTER_ADD_OPTIONS;
module.exports.HISTORY_RETENTION_OPTIONS = HISTORY_RETENTION_OPTIONS;
module.exports.applyHistoryRetention = applyHistoryRetention;
module.exports.countHistoryRows = countHistoryRows;
