const { EventEmitter } = require('events');
const path = require('path');
const { assertUploadConfirmation } = require('./upload-confirmation');
const fs = require('fs');
const crypto = require('crypto');
const { uploadFile, prefetchBaseline, createRecoveryClaimRegistry } = require('./hosters');
const VidmolyUploader = require('./vidmoly-upload');
const VoeUploader = require('./voe-upload');
const DoodstreamUploader = require('./doodstream-upload');
const ClouddropUploader = require('./clouddrop-upload');
const Semaphore = require('./semaphore');
const Throttle = require('./throttle');
const { probeFileHead } = require('./file-probe');
const { normalizeFailureDetails } = require('./upload-diagnostics');

const DEFAULT_SETTINGS = {
  retries: 3,
  maxSpeedKbs: 0,
  parallelCount: 2,
  restartBelowKbs: 0,
  timeIntervalSec: 0,
  maxSizeMb: 0,
  sizeMemoEnabled: true
};

class UploadManager extends EventEmitter {
  constructor(hosterSettings, globalSettings, accountPools) {
    super();
    this.hosterSettings = hosterSettings || {};
    this.globalSettings = globalSettings || {};
    this.accountPools = accountPools || {};
    this.semaphores = {};
    this.globalSemaphore = null;
    this.abortController = new AbortController();
    this.running = false;
    this.stopAfterActive = false;
    this.statsInterval = null;
    this.startTime = 0;
    this.activeJobs = new Map(); // uploadId -> { jobId, speedKbs, bytesUploaded, hoster }
    this.jobAbortControllers = new Map(); // jobId -> AbortController
    this.cancelledJobIds = new Set();
    this.pendingCancelledJobIds = new Set();
    this.pendingCancelAll = false;
    this.sessionBytes = 0;
    this._transientErrorTotal = 0;
    this.lastStartTime = {}; // hoster -> timestamp of last upload start
    this.intervalLocks = {}; // hoster -> Promise chain for serialized interval waits
    this.globalThrottle = null;
    this._failedAccounts = new Map(); // hoster -> Set of failed accountIds
    this._accountOverrides = new Map(); // hoster -> fallback account object
    this._suspectSizeMemo = new Map(); // 'hoster:accountId' -> { size: smallest suspect-rejected fileSize, count: confirmed rejections }; blocks only after 2nd rejection
    this._suspectGoodAccounts = new Map(); // hoster -> accountId that accepted a suspect-class file
    this._doodApiKeyCache = new Map(); // accountId/username -> derived doodstream API key ('' = tried, none)
    this._baselineCache = new Map(); // hoster:apiKey -> Promise<Set<file_code>> (one fetch shared across all jobs in batch)
    this._recoveryClaims = createRecoveryClaimRegistry();
  }

  updateAccountPools(accountPools) {
    if (accountPools && typeof accountPools === 'object') {
      this.accountPools = accountPools;
    }
  }

  replaceAccountPools(accountPools) {
    this.accountPools = accountPools && typeof accountPools === 'object' ? accountPools : {};
    this._failedAccounts.clear();
    this._accountOverrides.clear();
    this._suspectSizeMemo.clear();
    this._suspectGoodAccounts.clear();
    this._doodApiKeyCache.clear();
    this._baselineCache.clear();
    this._recoveryClaims.clear();
  }

  switchAccount(hoster, fallbackAccount) {
    const prev = this._accountOverrides.get(hoster);
    this._accountOverrides.set(hoster, fallbackAccount);
    this._rotLog('switchAccount', {
      hoster,
      prevOverrideId: prev ? prev.id : null,
      toAccountId: fallbackAccount ? fallbackAccount.id : null
    });
  }

  // Introspection helpers used by main.js to re-resolve fallbacks when the
  // config changes mid-batch (e.g. user adds a new account after their only
  // one ran out of space). Without this, an account that got marked failed
  // before a fallback existed stays stuck until the app restarts.
  getFailedAccountKeys() {
    return Array.from(this._failedAccounts.keys());
  }

  getOverride(hoster) {
    return this._accountOverrides.get(hoster) || null;
  }

  getActiveJobCount() {
    return this.activeJobs.size;
  }

  getDiagnostics() {
    const activeByHoster = {};
    for (const v of this.activeJobs.values()) {
      const h = v && v.hoster ? v.hoster : 'unknown';
      activeByHoster[h] = (activeByHoster[h] || 0) + 1;
    }
    let pending = 0;
    for (const sem of Object.values(this.semaphores)) pending += (sem && sem.pending) || 0;
    return { activeByHoster, transientErrors: this._transientErrorTotal, pending, active: this.activeJobs.size };
  }

  clearFailedAccount(hoster, accountId) {
    return this._failedAccounts.delete(`${hoster}:${accountId}`);
  }

  clearAllFailedAccounts() {
    const n = this._failedAccounts.size;
    this._failedAccounts.clear();
    return n;
  }

  // True if the hoster has a usable override stored that differs from the
  // account currently in the task and isn't itself already marked failed.
  // Used by the retry loop to decide "retry on same account vs break to
  // rotation" — skipping wasted attempts on a likely-bad primary when a
  // pre-resolved fallback is ready to try.
  _hasPendingOverride(hoster, currentAccountId) {
    const override = this._accountOverrides.get(hoster);
    if (!override) return false;
    if (override.id === currentAccountId) return false;
    if (this._failedAccounts.has(hoster + ':' + override.id)) return false;
    return true;
  }

  _rotLog(event, data) {
    this.emit('rot-log', { ts: Date.now(), event, ...data });
  }

  _noteSuspectReject(hoster, accountId, fileSize) {
    if (!accountId || !Number.isFinite(fileSize) || fileSize <= 0) return;
    const key = hoster + ':' + accountId;
    const prev = this._suspectSizeMemo.get(key);
    if (prev === undefined) this._suspectSizeMemo.set(key, { size: fileSize, count: 1 });
    else this._suspectSizeMemo.set(key, { size: Math.min(prev.size, fileSize), count: prev.count + 1 });
  }

  _suspectMemoBlocks(hoster, accountId, fileSize) {
    if (this.hosterSettings[hoster] && this.hosterSettings[hoster].sizeMemoEnabled === false) return false;
    const memo = this._suspectSizeMemo.get(hoster + ':' + accountId);
    return !!memo && memo.count >= 2 && fileSize > memo.size;
  }

  // File-specific rejections from the hoster: the same file will get rejected
  // on any account, so rotation is pointless. Matches the `err.fileRejected`
  // flag set by parsers plus known rejection phrases.
  // NOTE: We deliberately do NOT match the generic "lehnte Datei ab" prefix
  // here — that phrase is used by the Byse parser for both file- AND
  // account-level errors. Account-level ones set err.accountError instead,
  // which takes priority in _shouldSkipRetryOnAccountError.
  _isFileRejectedError(err) {
    if (!err) return false;
    if (err.transientNetwork === true) return false;
    if (err.accountError === true) return false; // explicit account-level wins
    if (err.fileRejected === true) return true;
    if (!err.message) return false;
    const m = String(err.message);
    return /(Not video file format|Duplicate|Datei zu (klein|gross|groß)|File too (small|large)|Invalid file|Unsupported format)/i.test(m);
  }

  // Hoster-side transient flake — the hoster's backend accepted the upload but
  // returned a malformed/empty result (e.g. doodstream CDN form with no fn/no
  // st). Same account + same file works on a later attempt; this is NOT an
  // account problem. Treated exactly like a transient network error: skip
  // remaining in-batch retries (the flake won't clear in 3s and a re-upload of
  // 95 MB is expensive), don't blacklist the account, fail this file cleanly.
  // The user's next manual retry — or a later batch — can use the same account.
  _isHosterTransientError(err) {
    if (!err) return false;
    if (err.hosterTransient === true) return true; // explicit flag — primary
    if (!err.message) return false;
    // Defensive fallback: catch the same class of error if it bubbles up
    // wrapped (e.g. through a different code path) without the flag set.
    return /Server gab leeren Link zurueck|kein Filecode/i.test(String(err.message));
  }

  // Transient network errors — the account is fine, the network or the
  // hoster's own backend hiccuped. Retrying on the SAME account is the right
  // move; marking it failed would wrongly poison the fallback chain. If all
  // retries on the current account still hit this class of error, we bail
  // out for this file without blacklisting the account, so other jobs in the
  // batch still get a fresh chance on it.
  _isTransientNetworkError(err) {
    if (!err) return false;
    if (err.transientNetwork === true) return true;
    if (!err.message) return false;
    const m = String(err.message);
    const TRANSIENT = [
      /ENOTFOUND/i,
      /ECONNRESET/i,
      /ECONNREFUSED/i,
      /ETIMEDOUT/i,
      /EAI_AGAIN/i,
      /EHOSTUNREACH/i,
      /ENETUNREACH/i,
      /EPIPE/i,
      /socket hang up/i,
      /network (error|failure|problem)/i,
      /dns (lookup|error|failed)/i,
      /getaddrinfo/i,
      /fetch failed/i,
      /\bconnect (ETIMEDOUT|ECONN)/i,
      /HTTP 5\d\d\b/i,
      /Bad Gateway/i,
      /Service Unavailable/i,
      /Gateway Time-?out/i
    ];
    return TRANSIENT.some(p => p.test(m));
  }

  // Error classes that mean "this account is the problem, retrying on it won't
  // help" — we skip the remaining retries and go straight to the fallback
  // account. Keeps single runs fast when an account is rate-limited, banned,
  // or out of quota.
  _shouldSkipRetryOnAccountError(err) {
    if (!err) return false;
    if (err.transientNetwork === true) return false;
    // Explicit account-level flag from hoster parsers — highest priority.
    if (err.accountError === true) return true;
    if (!err.message) return false;
    const m = String(err.message);
    const PATTERNS = [
      /Kein Upload-Server/i,
      /No upload server/i,
      /kein server/i,
      /quota/i,
      /limit (reached|exceeded|überschritten)/i,
      /rate[- ]?limit/i,
      /too many requests/i,
      /\b(401|403|429)\b/,
      /Falscher (User|Username|Passwort)/i,
      /Incorrect (Login|Password)/i,
      /invalid (credentials|api[- ]?key|token|session)/i,
      /(account|user) (banned|suspended|disabled|gesperrt)/i,
      /not authorized/i,
      /forbidden/i,
      /session (expired|abgelaufen)/i,
      // Session/CSRF hints — the account's server session went stale, which
      // no amount of retrying will fix. Re-login happens on the next account.
      /CSRF[- ]?Token nicht gefunden/i,
      /CSRF[- ]?token not found/i,
      /Bist du eingeloggt/i,
      /not logged in/i,
      // Storage exhaustion — account is full. Rotate instead of hammering it.
      /not enough (disk )?(space|storage)/i,
      /insufficient (disk )?space/i,
      /disk (space )?full/i,
      /storage (exhausted|full|voll|limit)/i,
      /account (full|voll)/i
    ];
    return PATTERNS.some(p => p.test(m));
  }

  updateSettings(hosterSettings, globalSettings) {
    this.hosterSettings = hosterSettings || this.hosterSettings;
    this.globalSettings = globalSettings || this.globalSettings;
    // Live-update semaphores for running uploads
    for (const [hoster, sem] of Object.entries(this.semaphores)) {
      const settings = this._getSettings(hoster);
      sem.updateLimit(settings.parallelCount);
    }
    // Update global throttle if speed limit changed
    const newKbs = (this.globalSettings.globalMaxSpeedKbs || 0);
    if (newKbs > 0) {
      if (this.globalThrottle) {
        this.globalThrottle.updateRate(newKbs * 1024);
      } else {
        this.globalThrottle = new Throttle(newKbs * 1024);
      }
    } else {
      this.globalThrottle = null;
    }
    // Update global semaphore live
    const globalLimit = this._getGlobalParallelLimit();
    if (globalLimit > 0 && this.globalSemaphore) {
      this.globalSemaphore.updateLimit(globalLimit);
    }
  }

  _getSettings(hoster) {
    const settings = { ...DEFAULT_SETTINGS, ...(this.hosterSettings[hoster] || {}) };
    const globalLimit = this._getGlobalParallelLimit();
    if (this.globalSettings.scaleParallelUploads && globalLimit > 0) {
      settings.parallelCount = Math.min(settings.parallelCount || 1, globalLimit);
    }
    return settings;
  }

  _getGlobalParallelLimit() {
    const raw = Number(this.globalSettings.parallelUploadCount || 0);
    if (!Number.isFinite(raw) || raw <= 0) return 0;
    return Math.max(1, Math.min(100, Math.round(raw)));
  }

  _getGlobalSemaphore() {
    const limit = this._getGlobalParallelLimit();
    if (limit <= 0) return null;
    if (!this.globalSemaphore) {
      this.globalSemaphore = new Semaphore(limit);
    } else {
      this.globalSemaphore.updateLimit(limit);
    }
    return this.globalSemaphore;
  }

  _getGlobalThrottle() {
    const kbs = Number(this.globalSettings.globalMaxSpeedKbs || 0);
    if (!Number.isFinite(kbs) || kbs <= 0) return null;
    if (!this.globalThrottle) {
      this.globalThrottle = new Throttle(kbs * 1024);
    } else {
      this.globalThrottle.updateRate(kbs * 1024);
    }
    return this.globalThrottle;
  }

  _getSemaphore(hoster) {
    if (!this.semaphores[hoster]) {
      const settings = this._getSettings(hoster);
      this.semaphores[hoster] = new Semaphore(settings.parallelCount);
    } else {
      this.semaphores[hoster].updateLimit(this._getSettings(hoster).parallelCount);
    }
    return this.semaphores[hoster];
  }

  async startBatch(tasks, opts = {}) {
    const pendingCancelledJobIds = new Set(this.pendingCancelledJobIds);
    const pendingCancelAll = this.pendingCancelAll;
    this.pendingCancelledJobIds.clear();
    this.pendingCancelAll = false;
    this.running = true;
    this.stopAfterActive = pendingCancelAll;
    this.abortController = new AbortController();
    if (pendingCancelAll) this.abortController.abort();
    this.startTime = Date.now();
    this.sessionBytes = 0;
    this.activeJobs.clear();
    this.jobAbortControllers.clear();
    this.cancelledJobIds.clear();
    for (const jobId of pendingCancelledJobIds) this.cancelledJobIds.add(jobId);
    this._doodApiKeyCache.clear(); // re-derive doodstream keys fresh each batch
    this._baselineCache.clear(); // re-fetch baselines per batch (a long batch could outlast remote-side relevance)
    this._recoveryClaims.clear();
    this.semaphores = {};
    this.globalSemaphore = null;
    this.globalThrottle = null;
    this.lastStartTime = {};
    // Reset account-rotation state each batch — but optionally re-prime from
    // app-session memory so a "Retry failed" right after batch-done doesn't
    // burn 5 retries on the account we already know is dead. Caller (main.js)
    // passes the session-scoped failed/override state.
    this._failedAccounts.clear();
    this._accountOverrides.clear();
    this._suspectSizeMemo.clear();
    this._suspectGoodAccounts.clear();
    if (Array.isArray(opts.primeFailedAccounts)) {
      for (const key of opts.primeFailedAccounts) this._failedAccounts.set(key, true);
    }
    if (Array.isArray(opts.primeOverrides)) {
      for (const entry of opts.primeOverrides) {
        if (Array.isArray(entry) && entry.length === 2) this._accountOverrides.set(entry[0], entry[1]);
      }
    }
    this._rotLog('batch-start', {
      taskCount: tasks.length,
      primedFailed: this._failedAccounts.size,
      primedOverrides: this._accountOverrides.size
    });

    const { signal } = this.abortController;
    const batchId = `batch-${Date.now()}`;
    const results = new Map(); // filePath -> { name, size, results: [] }
    this._batchResults = results;
    this._additionalPromises = []; // Track jobs added mid-batch via addJobs()

    const DEDUP_CHUNK = 200;
    for (let i = 0; i < tasks.length; i += DEDUP_CHUNK) {
      if (signal.aborted) break;
      const end = Math.min(i + DEDUP_CHUNK, tasks.length);
      const toStat = [];
      for (let j = i; j < end; j++) {
        const task = tasks[j];
        if (!results.has(task.file)) {
          results.set(task.file, { name: path.basename(task.file), size: 0, results: [] });
          toStat.push(task.file);
        }
      }
      await Promise.all(toStat.map(async (f) => {
        try { const st = await fs.promises.stat(f); const e = results.get(f); if (e) e.size = st.size; } catch {}
      }));
    }

    this._startStatsTimer();

    const SPAWN_CHUNK = 100;
    const promises = [];
    for (let i = 0; i < tasks.length; i += SPAWN_CHUNK) {
      if (signal.aborted) break;
      const end = Math.min(i + SPAWN_CHUNK, tasks.length);
      for (let j = i; j < end; j++) promises.push(this._runJob(tasks[j], results, signal));
      if (end < tasks.length) await new Promise(setImmediate);
    }
    await Promise.allSettled(promises);
    // Wait for any jobs added mid-batch via addJobs()
    while (this._additionalPromises.length > 0) {
      const batch = this._additionalPromises.splice(0);
      await Promise.allSettled(batch);
    }

    this.running = false;
    this._stopStatsTimer();
    this._emitStats();

    const files = Array.from(results.values());
    const total = tasks.length;
    const succeeded = files.reduce((count, file) => count + file.results.filter((result) => result.status === 'done').length, 0);
    const skipped = files.reduce((count, file) => count + file.results.filter((result) => result.status === 'skipped').length, 0);

    const summary = {
      id: batchId,
      timestamp: new Date().toISOString(),
      total,
      succeeded,
      failed: total - succeeded - skipped,
      skipped,
      files
    };

    this.emit('batch-done', summary);
  }

  async _runJob(task, results, batchSignal) {
    const settings = this._getSettings(task.hoster);
    const hosterSemaphore = this._getSemaphore(task.hoster);
    const globalSemaphore = this._getGlobalSemaphore();
    const uploadId = crypto.randomBytes(8).toString('hex');
    const jobId = task.jobId || uploadId;
    const fileName = path.basename(task.file);
    const jobStartedAt = Date.now();
    let fileSize = 0;
    let fileNotFound = false;
    const cachedResult = results && results.get(task.file);
    if (cachedResult && typeof cachedResult.size === 'number' && cachedResult.size > 0) {
      fileSize = cachedResult.size;
    } else {
      try { fileSize = (await fs.promises.stat(task.file)).size; } catch { fileNotFound = true; }
    }

    const maxAttempts = Math.max(1, (settings.retries || 0) + 1);
    const jobAbortController = new AbortController();
    if (this.cancelledJobIds.has(jobId)) jobAbortController.abort();
    const { signal, cleanup: cleanupSignals } = this._combineSignals(batchSignal, jobAbortController.signal);
    this.jobAbortControllers.set(jobId, jobAbortController);

    let hosterSlotAcquired = false;
    let globalSlotAcquired = false;
    let finalResultRecorded = false;
    let finalStatus = 'error';
    let lastError = null;
    let lastFailureDetails = null;
    let finalAttempt = 0;

    const recordFinalResult = (status, payload = {}) => {
      if (finalResultRecorded) return;
      finalResultRecorded = true;
      finalStatus = status;

      const result = {
        jobId,
        hoster: task.hoster,
        status,
        error: payload.error || null,
        accountId: task.accountId || null,
        attempt: payload.attempt || finalAttempt,
        maxAttempts,
        durationSec: Number.isFinite(payload.elapsed) ? payload.elapsed : Math.round((Date.now() - jobStartedAt) / 1000),
        failureDetails: payload.failureDetails || lastFailureDetails,
        download_url: payload.result ? payload.result.download_url || null : null,
        embed_url: payload.result ? payload.result.embed_url || null : null,
        file_code: payload.result ? payload.result.file_code || null : null
      };

      results.get(task.file).results.push(result);
    };

    const emitFinalStatus = (status, payload = {}) => {
      if (status === 'aborted' && this.abortController.signal.aborted) return;
      this._emitProgress(uploadId, fileName, task.hoster, { accountId: task.accountId,
        jobId,
        status,
        progress: status === 'done' ? 1 : 0,
        bytesUploaded: status === 'done' ? fileSize : 0,
        bytesTotal: fileSize,
        speedKbs: payload.speedKbs || 0,
        elapsed: payload.elapsed || 0,
        remaining: 0,
        error: payload.error || null,
        failureDetails: payload.failureDetails || lastFailureDetails,
        result: payload.result || null,
        attempt: payload.attempt || maxAttempts,
        maxAttempts
      });
    };

    try {
      if (signal.aborted || this.cancelledJobIds.has(jobId)) {
        const error = 'Abgebrochen';
        emitFinalStatus('aborted', { error, attempt: 0 });
        recordFinalResult('aborted', { error });
        return;
      }
      if (fileNotFound) {
        const error = 'Datei nicht gefunden';
        emitFinalStatus('skipped', { error, attempt: 0 });
        recordFinalResult('skipped', { error });
        return;
      }
      if (fileSize <= 0) {
        const error = 'Datei ist leer (0 Bytes)';
        emitFinalStatus('skipped', { error, attempt: 0 });
        recordFinalResult('skipped', { error });
        return;
      }
      if (settings.maxSizeMb > 0 && fileSize > settings.maxSizeMb * 1024 * 1024) {
        const error = `Datei zu groß (Max: ${settings.maxSizeMb} MB)`;
        emitFinalStatus('skipped', { error, attempt: 0 });
        recordFinalResult('skipped', { error });
        return;
      }

      // The initial 'queued' emit per job is suppressed: with N=2000+ tasks
      // it produces 2000+ main→renderer IPCs back-to-back at startBatch and
      // freezes the renderer event loop for tens of seconds. The renderer
      // already holds each job in 'queued'/'preview' state from its own
      // queueJobs array; the first event it actually needs from main is the
      // 'getting-server' / 'uploading' transition for the jobs that the
      // semaphore lets through.
      await hosterSemaphore.acquire(signal);
      hosterSlotAcquired = true;

      let fileProbe = null;
      try {
        fileProbe = await probeFileHead(task.file, 512);
      } catch (err) {
        fileProbe = { ok: false, error: err && err.message, kind: 'unreadable' };
      }
      this._rotLog('upload-start', {
        jobId, hoster: task.hoster, accountId: task.accountId, fileName,
        fileSize,
        detectedKind: fileProbe && fileProbe.kind ? fileProbe.kind : 'unknown',
        isVideoLike: !!(fileProbe && fileProbe.isVideoLike),
        headHex: fileProbe && fileProbe.headHex ? fileProbe.headHex.slice(0, 32) : null
      });

      if (globalSemaphore) {
        await globalSemaphore.acquire(signal);
        globalSlotAcquired = true;
      }

      if (settings.timeIntervalSec > 0) {
        await this._waitForInterval(task.hoster, settings.timeIntervalSec * 1000, signal);
      }

      // Pre-job-swap: if this account was marked failed WHILE this task was
      // waiting in the semaphore queue, jump straight to the override instead
      // of burning a guaranteed-to-fail upload attempt. Critical at scale:
      // with 500 queued jobs and 1 parallel slot, without this check every
      // job still hits the original dead account first.
      if (task.accountId && this._failedAccounts.has(task.hoster + ':' + task.accountId)) {
        const override = this._accountOverrides.get(task.hoster);
        if (override && !this._failedAccounts.has(task.hoster + ':' + override.id)) {
          this._rotLog('pre-job-swap', {
            jobId, hoster: task.hoster, fileName, fromAccountId: task.accountId, toAccountId: override.id
          });
          task.accountId = override.id;
          task.username = override.username;
          task.password = override.password;
          task.apiKey = override.apiKey;
        } else {
          this._rotLog('pre-job-swap-blocked', {
            jobId, hoster: task.hoster, fileName, accountId: task.accountId,
            hasOverride: !!override,
            overrideAlsoFailed: override ? this._failedAccounts.has(task.hoster + ':' + override.id) : false
          });
        }
      }

      // A previous file of at least this size already got a suspect rejection
      // on this exact account — skip the guaranteed-to-fail multi-GB upload
      // and go straight to the alternate-account walk below.
      let memoSuspect = null;
      if (fileProbe && fileProbe.isVideoLike === true && task.accountId
          && this._suspectMemoBlocks(task.hoster, task.accountId, fileSize)) {
        memoSuspect = new Error('Bekanntes Größen-Limit auf diesem Account (frühere verdächtige Ablehnung)');
        memoSuspect.fileRejected = true;
        memoSuspect.suspectReject = true;
        lastError = memoSuspect;
        this._rotLog('suspect-memo-skip', {
          jobId, hoster: task.hoster, fileName, accountId: task.accountId, fileSize
        });
      }

      const attemptsAllowed = memoSuspect ? 0 : maxAttempts;
      for (let attempt = 1; attempt <= attemptsAllowed; attempt++) {
        finalAttempt = attempt;
        if (signal.aborted || this.stopAfterActive) break;

        if (attempt > 1) {
          this._emitProgress(uploadId, fileName, task.hoster, { accountId: task.accountId,
            jobId,
            status: 'retrying',
            progress: 0,
            bytesUploaded: 0,
            bytesTotal: fileSize,
            speedKbs: 0,
            elapsed: 0,
            remaining: 0,
            error: lastError ? lastError.message : null,
            result: null,
            attempt,
            maxAttempts
          });
          await this._sleep(3000, signal);
        }

        const jobStart = Date.now();
        let lastBytes = 0;
        let lastSpeedTime = jobStart;
        let currentSpeedKbs = 0;
        let lowSpeedSince = 0;
        let speedAbort = null;
        let speedMonitor = null;
        let uploadSignalBundle = { signal, cleanup() {} };

        try {
          this._emitProgress(uploadId, fileName, task.hoster, { accountId: task.accountId,
            jobId,
            status: 'getting-server',
            progress: 0,
            bytesUploaded: 0,
            bytesTotal: fileSize,
            speedKbs: 0,
            elapsed: 0,
            remaining: 0,
            error: null,
            result: null,
            attempt,
            maxAttempts
          });

          const hosterThrottle = settings.maxSpeedKbs > 0
            ? new Throttle(settings.maxSpeedKbs * 1024)
            : null;
          const globalThrottle = this._getGlobalThrottle();
          const throttle = hosterThrottle && globalThrottle
            ? { consume: async (bytes, sig) => { await hosterThrottle.consume(bytes, sig); await globalThrottle.consume(bytes, sig); } }
            : hosterThrottle || globalThrottle;

          if (settings.restartBelowKbs > 0) {
            speedAbort = new AbortController();
            uploadSignalBundle = this._combineManySignals([signal, speedAbort.signal]);
            speedMonitor = setInterval(() => {
              try {
                if (currentSpeedKbs > 0 && currentSpeedKbs < settings.restartBelowKbs) {
                  if (!lowSpeedSince) lowSpeedSince = Date.now();
                  if (Date.now() - lowSpeedSince > 6000) {
                    speedAbort.abort();
                  }
                } else {
                  lowSpeedSince = 0;
                }
              } catch (e) { this._rotLog('speed-monitor-error', { jobId, error: e && e.message }); }
            }, 2000);
          }

          // Mutate this single object on each progress callback instead of
          // allocating a fresh one — callback fires on every stream chunk
          // (hundreds/sec per active job).
          const activeEntry = { jobId, speedKbs: 0, bytesUploaded: 0, hoster: task.hoster };
          this.activeJobs.set(uploadId, activeEntry);

          let lastEmitTime = 0;
          const PROGRESS_EMIT_INTERVAL = 250; // ms – throttle UI updates

          const progressCb = (bytesUploaded, bytesTotal) => {
            try {
              const now = Date.now();
              const elapsed = Math.round((now - jobStart) / 1000);
              const timeDelta = (now - lastSpeedTime) / 1000;
              if (Number.isFinite(timeDelta) && timeDelta >= 1) {
                const bytesDelta = bytesUploaded - lastBytes;
                currentSpeedKbs = Math.round(bytesDelta / timeDelta / 1024);
                lastBytes = bytesUploaded;
                lastSpeedTime = now;
              }

              activeEntry.speedKbs = currentSpeedKbs;
              activeEntry.bytesUploaded = bytesUploaded;

              if (now - lastEmitTime < PROGRESS_EMIT_INTERVAL) return;
              lastEmitTime = now;

              const remaining = currentSpeedKbs > 0
                ? Math.round((bytesTotal - bytesUploaded) / (currentSpeedKbs * 1024))
                : 0;

              this._emitProgress(uploadId, fileName, task.hoster, { accountId: task.accountId,
                jobId,
                status: 'uploading',
                progress: bytesTotal > 0 ? Math.min(1, bytesUploaded / bytesTotal) : 0,
                bytesUploaded,
                bytesTotal,
                speedKbs: currentSpeedKbs,
                elapsed,
                remaining,
                error: null,
                result: null,
                attempt,
                maxAttempts
              });
            } catch { /* progress callbacks must never throw — swallowing is correct, the stream keeps going */ }
          };

          const result = await this._executeUpload(task, progressCb, uploadSignalBundle.signal, throttle, fileProbe);

          if (signal.aborted || this.cancelledJobIds.has(jobId)) throw new Error('Aborted');

          const elapsed = Math.round((Date.now() - jobStart) / 1000);
          this.sessionBytes += fileSize;
          this.activeJobs.delete(uploadId);

          emitFinalStatus('done', {
            result,
            speedKbs: currentSpeedKbs,
            elapsed,
            attempt
          });
          recordFinalResult('done', { result });
          return;
        } catch (err) {
          this.activeJobs.delete(uploadId);
          if (this._isTransientNetworkError(err)) this._transientErrorTotal++;

          const isSpeedRestart = speedAbort && speedAbort.signal.aborted && !signal.aborted;
          if (!signal.aborted && !isSpeedRestart) {
            const diag = (err && typeof err === 'object' && err.diagnostic) || {};
            lastFailureDetails = normalizeFailureDetails(diag);
            this._rotLog('upload-failure', {
              jobId, hoster: task.hoster, accountId: task.accountId, fileName,
              attempt,
              error: err && err.message ? err.message : String(err),
              fileRejected: !!(err && err.fileRejected),
              accountError: !!(err && err.accountError),
              hosterTransient: !!(err && err.hosterTransient),
              http: diag.http || null,
              contentType: diag.contentType || null,
              detectedKind: (typeof fileProbe !== 'undefined' && fileProbe && fileProbe.kind) ? fileProbe.kind : null,
              isVideoLike: !!(typeof fileProbe !== 'undefined' && fileProbe && fileProbe.isVideoLike),
              headHex: (typeof fileProbe !== 'undefined' && fileProbe && fileProbe.headHex) ? fileProbe.headHex.slice(0, 32) : null,
              payloadSnippet: lastFailureDetails ? lastFailureDetails.responseSnippet || null : null
            });
          }
          if (signal.aborted) {
            lastError = new Error('Abgebrochen');
            break;
          }

          if (this.stopAfterActive) {
            lastError = new Error('Angehalten');
            break;
          }

          if (isSpeedRestart && attempt < maxAttempts) {
            lastError = new Error('Geschwindigkeit zu niedrig - Neustart');
            await this._sleep(3000, signal);
            continue;
          }

          lastError = err;
          // File-specific rejection — re-uploading won't change the server's
          // mind. Break out immediately; the outer file-rejected branch then
          // records the final error without burning through 5 × 3s retries.
          if (this._isFileRejectedError(err)) break;
          // Hoster-side transient flake (e.g. doodstream empty CDN form). Server
          // flake won't clear in 3s and re-uploading the whole file 4× is pure
          // bandwidth waste; bail out of the retry loop so the post-loop branch
          // can fail this file without blacklisting the account.
          if (this._isHosterTransientError(err)) {
            this._rotLog('hoster-transient', {
              jobId, hoster: task.hoster, fileName, accountId: task.accountId,
              attempt, error: err && err.message ? err.message : String(err)
            });
            break;
          }
          // Account-specific errors — don't waste retries on the same account,
          // jump straight to rotation.
          if (this._shouldSkipRetryOnAccountError(err)) {
            this._rotLog('fast-fail', {
              jobId, hoster: task.hoster, fileName, accountId: task.accountId,
              attempt, error: err && err.message ? err.message : String(err)
            });
            break;
          }
          // Generic non-transient error AND a fallback is already resolved for
          // this hoster: bail to rotation instead of burning more retries on a
          // possibly-dead primary. The fallback (pre-resolved at batch-start)
          // deserves a real shot. Transient network errors stay on the same
          // account — the network is the issue, not the account.
          if (!this._isTransientNetworkError(err) &&
              this._hasPendingOverride(task.hoster, task.accountId)) {
            this._rotLog('try-alternate-after-fail', {
              jobId, hoster: task.hoster, fileName, accountId: task.accountId,
              attempt, error: err && err.message ? err.message : String(err)
            });
            break;
          }
          if (attempt >= maxAttempts) break;
          // Wait 3 seconds before retry
          await this._sleep(3000, signal);
        } finally {
          if (speedMonitor) clearInterval(speedMonitor);
          uploadSignalBundle.cleanup();
        }
      }

      const wasStopped = this.stopAfterActive && !signal.aborted;
      const wasAborted = signal.aborted || this.cancelledJobIds.has(jobId);
      if (wasStopped || wasAborted) {
        const error = wasStopped ? 'Warteschlange angehalten' : 'Abgebrochen';
        emitFinalStatus('aborted', { error });
        recordFinalResult('aborted', { error });
        return;
      }

      // Account rotation: mark the current account failed (if not already),
      // wait for main to resolve the next fallback, then retry. Loops so
      // A → B → C → ... works for hosters with 3+ accounts.
      //
      // CRITICAL: we must ALWAYS check for an existing override, even if this
      // account is already in _failedAccounts (e.g. another concurrent job
      // already marked it failed). Otherwise the second job falls straight
      // through to final-error instead of using the already-resolved fallback.
      this._rotLog('retries-exhausted', {
        jobId, hoster: task.hoster, fileName, accountId: task.accountId,
        lastError: lastError ? lastError.message : null
      });
      // File-specific rejection → same file will get the same verdict on
      // every other account, rotation is pointless. Don't blacklist, don't
      // retry siblings, just fail this file cleanly.
      //
      // EXCEPT suspect rejections (err.suspectReject, e.g. byse "Not video
      // file format" on a probe-verified video): those verdicts are
      // account-conditional in practice (per-account size tiers), so the file
      // gets one attempt on each remaining account — WITHOUT blacklisting the
      // current one, which keeps working for files the hoster does accept.
      if (this._isFileRejectedError(lastError)) {
        if (lastError.suspectReject === true && fileProbe && fileProbe.isVideoLike === true) {
          this._noteSuspectReject(task.hoster, task.accountId, fileSize);
          const alt = await this._trySuspectRejectAlternates(task, { uploadId, jobId, fileName, fileSize, settings, signal, fileProbe });
          if (alt) {
            if (signal.aborted || this.cancelledJobIds.has(jobId)) {
              const error = 'Abgebrochen';
              emitFinalStatus('aborted', { error });
              recordFinalResult('aborted', { error });
              return;
            }
            emitFinalStatus('done', { result: alt.result, speedKbs: alt.speedKbs, elapsed: alt.elapsed, attempt: 1 });
            recordFinalResult('done', { result: alt.result });
            return;
          }
          const stoppedInAlternates = this.stopAfterActive && !signal.aborted;
          const abortedInAlternates = signal.aborted || this.cancelledJobIds.has(jobId);
          if (stoppedInAlternates || abortedInAlternates) {
            const error = stoppedInAlternates ? 'Warteschlange angehalten' : 'Abgebrochen';
            emitFinalStatus('aborted', { error });
            recordFinalResult('aborted', { error });
            return;
          }
        }
        this._rotLog('skip-rotation-file-rejected', {
          jobId, hoster: task.hoster, fileName, accountId: task.accountId,
          lastError: lastError ? lastError.message : null
        });
        const error = lastError.message || 'Datei abgelehnt';
        emitFinalStatus('error', { error });
        recordFinalResult('error', { error });
        return;
      }
      // Hoster-side transient flake → identical handling to network-transient:
      // the account is fine, don't blacklist it, just fail this file. Critical
      // to keep the account usable across batches — otherwise one empty-form
      // response poisons every subsequent batch with `pre-job-swap-blocked`.
      if (this._isHosterTransientError(lastError)) {
        this._rotLog('skip-rotation-hoster-transient', {
          jobId, hoster: task.hoster, fileName, accountId: task.accountId,
          lastError: lastError ? lastError.message : null
        });
        const error = lastError.message || 'Hoster-Backend lieferte leeres Ergebnis';
        emitFinalStatus('error', { error });
        recordFinalResult('error', { error });
        return;
      }
      // If the reason for failure was a transient network error we do NOT
      // blacklist the account. Other jobs on the same account in this batch
      // can still try fresh. This file just errors out for now.
      if (this._isTransientNetworkError(lastError)) {
        this._rotLog('skip-rotation-transient', {
          jobId, hoster: task.hoster, fileName, accountId: task.accountId,
          lastError: lastError ? lastError.message : null
        });
        const error = lastError.message || 'Netzwerkfehler';
        emitFinalStatus('error', { error });
        recordFinalResult('error', { error });
        return;
      }
      while (task.accountId) {
        if (signal.aborted || this.stopAfterActive) break;
        // The rotated-to account failed with a file-class error (file
        // rejection / hoster flake / network) — blacklisting it for that
        // would poison a working account for the whole batch. Fail only
        // this file instead.
        if (this._isFileRejectedError(lastError) || this._isHosterTransientError(lastError) || this._isTransientNetworkError(lastError)) {
          this._rotLog('skip-rotation-after-rotate', {
            jobId, hoster: task.hoster, fileName, accountId: task.accountId,
            lastError: lastError ? lastError.message : null
          });
          break;
        }
        const alreadyMarked = this._failedAccounts.has(task.hoster + ':' + task.accountId);
        if (!alreadyMarked) {
          this._failedAccounts.set(task.hoster + ':' + task.accountId, true);
          this._rotLog('mark-failed', {
            jobId, hoster: task.hoster, fileName, accountId: task.accountId,
            lastError: lastError ? lastError.message : null
          });
          this.emit('account-failed', { hoster: task.hoster, accountId: task.accountId });
          await this._sleep(800, signal);
          // Re-check after the await: the user could have cancelled while
          // we were waiting for main.js to resolve the fallback. Without
          // this, rotation proceeds another full attempt-loop's worth of
          // work before the next signal-check inside _executeUpload notices.
          if (signal.aborted || this.stopAfterActive) break;
        } else {
          this._rotLog('already-marked', {
            jobId, hoster: task.hoster, fileName, accountId: task.accountId
          });
        }
        const override = this._accountOverrides.get(task.hoster);
        if (!override) {
          this._rotLog('rotation-end', {
            jobId, hoster: task.hoster, fileName, reason: 'no-override-set',
            lastFailedAccountId: task.accountId
          });
          break;
        }
        if (this._failedAccounts.has(task.hoster + ':' + override.id)) {
          this._rotLog('rotation-end', {
            jobId, hoster: task.hoster, fileName, reason: 'override-already-failed',
            overrideId: override.id, lastFailedAccountId: task.accountId
          });
          break;
        }
        if (override.id === task.accountId) {
          this._rotLog('rotation-end', {
            jobId, hoster: task.hoster, fileName, reason: 'override-same-as-current',
            lastFailedAccountId: task.accountId
          });
          break;
        }
        // Switch to fallback account and retry this file
        this._rotLog('rotate', {
          jobId, hoster: task.hoster, fileName,
          fromAccountId: task.accountId, toAccountId: override.id
        });
        task.accountId = override.id;
        task.username = override.username;
        task.password = override.password;
        task.apiKey = override.apiKey;
        this._emitProgress(uploadId, fileName, task.hoster, { accountId: task.accountId,
          jobId, status: 'retrying', progress: 0, bytesUploaded: 0, bytesTotal: fileSize,
          speedKbs: 0, elapsed: 0, remaining: 0,
          error: 'Account-Wechsel zu Fallback', result: null, attempt: 1, maxAttempts
        });
        // Retry loop with the new account. On exhausted failure, the while
        // loop iterates: marks this account failed too, asks main for the next
        // fallback, and so on.
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          finalAttempt = attempt;
          if (signal.aborted || this.stopAfterActive) break;
          if (attempt > 1) {
            this._emitProgress(uploadId, fileName, task.hoster, { accountId: task.accountId,
              jobId, status: 'retrying', progress: 0, bytesUploaded: 0, bytesTotal: fileSize,
              speedKbs: 0, elapsed: 0, remaining: 0,
              error: lastError ? lastError.message : '', result: null, attempt, maxAttempts
            });
            await this._sleep(3000, signal);
          }
          try {
            const jobStart = Date.now();
            let lastBytes = 0;
            let lastSpeedTime = jobStart;
            let currentSpeedKbs = 0;
            const activeEntry = { jobId, speedKbs: 0, bytesUploaded: 0, hoster: task.hoster };
            this.activeJobs.set(uploadId, activeEntry);

            let lastEmitTime = 0;
            const PROGRESS_EMIT_INTERVAL = 250;
            const progressCb = (bytesUploaded, bytesTotal) => {
              const now = Date.now();
              const timeDelta = (now - lastSpeedTime) / 1000;
              if (timeDelta >= 1) {
                currentSpeedKbs = Math.round((bytesUploaded - lastBytes) / timeDelta / 1024);
                lastBytes = bytesUploaded;
                lastSpeedTime = now;
              }
              activeEntry.speedKbs = currentSpeedKbs;
              activeEntry.bytesUploaded = bytesUploaded;
              if (now - lastEmitTime < PROGRESS_EMIT_INTERVAL) return;
              lastEmitTime = now;
              const elapsed = Math.round((now - jobStart) / 1000);
              const remaining = currentSpeedKbs > 0 ? Math.round((bytesTotal - bytesUploaded) / (currentSpeedKbs * 1024)) : 0;
              this._emitProgress(uploadId, fileName, task.hoster, { accountId: task.accountId,
                jobId, status: 'uploading',
                progress: bytesTotal > 0 ? Math.min(1, bytesUploaded / bytesTotal) : 0,
                bytesUploaded, bytesTotal, speedKbs: currentSpeedKbs,
                elapsed, remaining, error: null, result: null, attempt, maxAttempts
              });
            };

            const hosterThrottle = settings.maxSpeedKbs > 0 ? new Throttle(settings.maxSpeedKbs * 1024) : null;
            const globalThrottle = this._getGlobalThrottle();
            const throttle = hosterThrottle && globalThrottle
              ? { consume: async (bytes, sig) => { await hosterThrottle.consume(bytes, sig); await globalThrottle.consume(bytes, sig); } }
              : hosterThrottle || globalThrottle;

            const result = await this._executeUpload(task, progressCb, signal, throttle, fileProbe);
            if (signal.aborted || this.cancelledJobIds.has(jobId)) throw new Error('Aborted');
            this.activeJobs.delete(uploadId);
            this.sessionBytes += fileSize;
            emitFinalStatus('done', { result, speedKbs: currentSpeedKbs, elapsed: Math.round((Date.now() - jobStart) / 1000), attempt });
            recordFinalResult('done', { result });
            return;
          } catch (err) {
            this.activeJobs.delete(uploadId);
            lastError = err;
            lastFailureDetails = normalizeFailureDetails(err && err.diagnostic);
            if (!signal.aborted) {
              this._rotLog('upload-failure', {
                jobId, hoster: task.hoster, accountId: task.accountId, fileName,
                attempt,
                error: err && err.message ? err.message : String(err),
                fileRejected: !!(err && err.fileRejected),
                accountError: !!(err && err.accountError),
                hosterTransient: !!(err && err.hosterTransient),
                rotationRetry: true
              });
            }
            if (signal.aborted || this.stopAfterActive) break;
            if (this._isFileRejectedError(err)) break;
            if (this._isHosterTransientError(err)) break;
            if (this._isTransientNetworkError(err)) break;
            if (attempt >= maxAttempts) break;
          }
        }
      }

      const stoppedLate = this.stopAfterActive && !signal.aborted;
      const abortedLate = signal.aborted || this.cancelledJobIds.has(jobId);
      if (stoppedLate || abortedLate) {
        const error = stoppedLate ? 'Warteschlange angehalten' : 'Abgebrochen';
        emitFinalStatus('aborted', { error });
        recordFinalResult('aborted', { error });
        return;
      }
      const error = lastError && lastError.message ? lastError.message : 'Unbekannter Fehler';
      this._rotLog('final-error', {
        jobId, hoster: task.hoster, fileName, lastFailedAccountId: task.accountId, error
      });
      emitFinalStatus('error', { error });
      recordFinalResult('error', { error });
    } catch (err) {
      const wasStopped = this.stopAfterActive && !signal.aborted;
      const error = wasStopped
        ? 'Warteschlange angehalten'
        : (signal.aborted || this.cancelledJobIds.has(jobId) ? 'Abgebrochen' : (err && err.message ? err.message : 'Unbekannter Fehler'));
      const status = signal.aborted || this.cancelledJobIds.has(jobId) || wasStopped ? 'aborted' : 'error';
      emitFinalStatus(status, { error });
      recordFinalResult(status === 'error' ? 'error' : 'aborted', { error });
    } finally {
      this.activeJobs.delete(uploadId);
      this.jobAbortControllers.delete(jobId);
      cleanupSignals();
      // Release in reverse order of acquire (global first, then hoster)
      if (globalSlotAcquired && globalSemaphore) globalSemaphore.release();
      if (hosterSlotAcquired) hosterSemaphore.release();
      this.emit('job-settled', {
        jobId,
        sourceCleanupToken: task.sourceCleanupToken || null,
        file: task.file,
        hoster: task.hoster,
        status: finalStatus
      });
    }
  }

  async _trySuspectRejectAlternates(task, ctx) {
    const { uploadId, jobId, fileName, fileSize, settings, signal, fileProbe } = ctx;
    const pool = this.accountPools && Array.isArray(this.accountPools[task.hoster])
      ? this.accountPools[task.hoster]
      : [];
    const original = { accountId: task.accountId, username: task.username, password: task.password, apiKey: task.apiKey };
    const goodId = this._suspectGoodAccounts.get(task.hoster);
    const ordered = [];
    for (const account of pool) {
      if (account && account.id === goodId) ordered.unshift(account);
      else ordered.push(account);
    }
    const tried = new Set([task.accountId]);
    let attempted = 0;
    for (const account of ordered) {
      if (signal.aborted || this.stopAfterActive) break;
      if (!account || !account.id || tried.has(account.id)) continue;
      if (this._failedAccounts.has(task.hoster + ':' + account.id)) continue;
      tried.add(account.id);
      if (this._suspectMemoBlocks(task.hoster, account.id, fileSize)) {
        this._rotLog('suspect-memo-skip-alt', {
          jobId, hoster: task.hoster, fileName, accountId: account.id, fileSize
        });
        continue;
      }
      attempted += 1;
      this._rotLog('suspect-reject-alt', {
        jobId, hoster: task.hoster, fileName, fromAccountId: task.accountId, toAccountId: account.id
      });
      task.accountId = account.id;
      task.username = account.username;
      task.password = account.password;
      task.apiKey = account.apiKey;
      this._emitProgress(uploadId, fileName, task.hoster, { accountId: task.accountId,
        jobId, status: 'retrying', progress: 0, bytesUploaded: 0, bytesTotal: fileSize,
        speedKbs: 0, elapsed: 0, remaining: 0,
        error: 'Ablehnung verdächtig - Versuch auf anderem Account', result: null, attempt: 1, maxAttempts: 1
      });
      const jobStart = Date.now();
      let lastBytes = 0;
      let lastSpeedTime = jobStart;
      let currentSpeedKbs = 0;
      const activeEntry = { jobId, speedKbs: 0, bytesUploaded: 0, hoster: task.hoster };
      this.activeJobs.set(uploadId, activeEntry);
      let lastEmitTime = 0;
      const PROGRESS_EMIT_INTERVAL = 250;
      const progressCb = (bytesUploaded, bytesTotal) => {
        const now = Date.now();
        const timeDelta = (now - lastSpeedTime) / 1000;
        if (timeDelta >= 1) {
          currentSpeedKbs = Math.round((bytesUploaded - lastBytes) / timeDelta / 1024);
          lastBytes = bytesUploaded;
          lastSpeedTime = now;
        }
        activeEntry.speedKbs = currentSpeedKbs;
        activeEntry.bytesUploaded = bytesUploaded;
        if (now - lastEmitTime < PROGRESS_EMIT_INTERVAL) return;
        lastEmitTime = now;
        const elapsed = Math.round((now - jobStart) / 1000);
        const remaining = currentSpeedKbs > 0 ? Math.round((bytesTotal - bytesUploaded) / (currentSpeedKbs * 1024)) : 0;
        this._emitProgress(uploadId, fileName, task.hoster, { accountId: task.accountId,
          jobId, status: 'uploading',
          progress: bytesTotal > 0 ? Math.min(1, bytesUploaded / bytesTotal) : 0,
          bytesUploaded, bytesTotal, speedKbs: currentSpeedKbs,
          elapsed, remaining, error: null, result: null, attempt: 1, maxAttempts: 1
        });
      };
      const hosterThrottle = settings.maxSpeedKbs > 0 ? new Throttle(settings.maxSpeedKbs * 1024) : null;
      const globalThrottle = this._getGlobalThrottle();
      const throttle = hosterThrottle && globalThrottle
        ? { consume: async (bytes, sig) => { await hosterThrottle.consume(bytes, sig); await globalThrottle.consume(bytes, sig); } }
        : hosterThrottle || globalThrottle;
      try {
        const result = await this._executeUpload(task, progressCb, signal, throttle, fileProbe);
        if (signal.aborted || this.cancelledJobIds.has(jobId)) throw new Error('Aborted');
        this.activeJobs.delete(uploadId);
        this.sessionBytes += fileSize;
        this._suspectGoodAccounts.set(task.hoster, account.id);
        return { result, speedKbs: currentSpeedKbs, elapsed: Math.round((Date.now() - jobStart) / 1000) };
      } catch (err) {
        this.activeJobs.delete(uploadId);
        if (!signal.aborted) {
          this._rotLog('upload-failure', {
            jobId, hoster: task.hoster, accountId: task.accountId, fileName,
            attempt: 1,
            error: err && err.message ? err.message : String(err),
            fileRejected: !!(err && err.fileRejected),
            accountError: !!(err && err.accountError),
            hosterTransient: !!(err && err.hosterTransient),
            suspectAlternate: true
          });
        }
        if (signal.aborted || this.stopAfterActive) break;
        if (err && err.suspectReject === true) {
          this._noteSuspectReject(task.hoster, account.id, fileSize);
        }
        // A genuine account-class error (quota, ban, full disk) positively
        // identifies a dead account — remember it so parallel and later
        // suspect jobs stop re-uploading multi-GB files to it. Deliberately
        // no 'account-failed' emit: that would re-point the hoster-wide
        // override and reroute normal-sized files away from a primary that
        // still works for them.
        if (err && err.accountError === true) {
          this._failedAccounts.set(task.hoster + ':' + account.id, true);
          this._rotLog('mark-failed', {
            jobId, hoster: task.hoster, fileName, accountId: account.id,
            lastError: err && err.message ? err.message : String(err),
            suspectAlternate: true
          });
        }
      }
    }
    task.accountId = original.accountId;
    task.username = original.username;
    task.password = original.password;
    task.apiKey = original.apiKey;
    if (!signal.aborted && !this.stopAfterActive) {
      this._rotLog('suspect-reject-exhausted', {
        jobId, hoster: task.hoster, fileName, alternatesTried: attempted
      });
    }
    return null;
  }

  async _executeUpload(task, progressCb, signal, throttle, fileProbe) {
    const result = await this._executeUploadUnchecked(task, progressCb, signal, throttle, fileProbe);
    return assertUploadConfirmation(result, task.hoster);
  }

  async _executeUploadUnchecked(task, progressCb, signal, throttle, fileProbe) {
    if (task.hoster === 'vidmoly.me' && task.username) {
      const vidmoly = new VidmolyUploader();
      await vidmoly.login(task.username, task.password);
      return vidmoly.upload(task.file, progressCb, signal, throttle);
    } else if (task.hoster === 'voe.sx' && task.username) {
      const voe = new VoeUploader();
      await voe.login(task.username, task.password);
      return voe.upload(task.file, progressCb, signal, throttle);
    } else if (task.hoster === 'doodstream.com' && task.username) {
      // Login-path reliability fix: the web-form upload returns the filecode in
      // an HTML form that comes back empty for large files (doodstream backend
      // registration timeout). Derive the account's API key from the logged-in
      // session ONCE per batch and upload via the official API instead — it
      // returns result[0].filecode directly and has no empty-form failure mode.
      // Falls back to the web-form upload if no valid key can be derived.
      const apiKey = await this._resolveDoodstreamApiKey(task);
      if (apiKey) {
        this._rotLog('doodstream-via-api', { accountId: task.accountId, fileName: path.basename(task.file) });
        return this._executeRecoveryAwareApiUpload('doodstream.com', task.file, apiKey, progressCb, signal, throttle, fileProbe);
      }
      this._rotLog('doodstream-via-web', { accountId: task.accountId, fileName: path.basename(task.file) });
      const dood = new DoodstreamUploader();
      await dood.login(task.username, task.password);
      return dood.upload(task.file, progressCb, signal, throttle);
    } else if (task.hoster === 'clouddrop.cc') {
      const clouddrop = new ClouddropUploader(task.apiKey);
      return clouddrop.upload(task.file, progressCb, signal, throttle);
    } else {
      if (task.hoster === 'byse.sx' || task.hoster === 'doodstream.com') {
        return this._executeRecoveryAwareApiUpload(task.hoster, task.file, task.apiKey, progressCb, signal, throttle, fileProbe);
      }
      return uploadFile(task.hoster, task.file, task.apiKey, progressCb, signal, throttle, {});
    }
  }

  async _executeRecoveryAwareApiUpload(hosterName, filePath, apiKey, progressCb, signal, throttle, fileProbe) {
    const recoveryClaim = this._recoveryClaims.forUpload(hosterName, apiKey, path.basename(filePath));
    return recoveryClaim.runExclusive(async () => {
      const options = { recoveryClaim };
      if (hosterName === 'byse.sx') {
        options.byseBaseline = await this._getBaseline(hosterName, apiKey, signal);
        if (fileProbe && fileProbe.ok !== false) options.probeIsVideoLike = fileProbe.isVideoLike === true;
      } else {
        options.doodBaseline = await this._getBaseline(hosterName, apiKey, signal);
      }
      return uploadFile(hosterName, filePath, apiKey, progressCb, signal, throttle, options);
    }, signal);
  }

  _getBaseline(hosterName, apiKey, signal) {
    if (!apiKey) return Promise.resolve(null);
    const key = `${hosterName}:${apiKey}`;
    let pending = this._baselineCache.get(key);
    if (pending) return pending;
    pending = prefetchBaseline(hosterName, apiKey, signal);
    this._baselineCache.set(key, pending);
    return pending;
  }

  // Resolve (and cache per batch) the doodstream API key for a login-only
  // account by logging in once and scraping+validating it from the session.
  // Returns the key string, or '' when none could be derived (cached either way
  // so a 40-file batch logs in + derives ONCE, not per file). The empty-string
  // sentinel distinguishes "tried, none" from "not yet tried" (undefined).
  async _resolveDoodstreamApiKey(task) {
    const cacheKey = task.accountId || task.username;
    const cached = this._doodApiKeyCache.get(cacheKey);
    if (cached !== undefined) return cached || null;

    let key = '';
    try {
      const probe = new DoodstreamUploader();
      await probe.login(task.username, task.password);
      key = (await probe.deriveApiKey()) || '';
    } catch {
      key = '';
    }
    this._doodApiKeyCache.set(cacheKey, key);
    return key || null;
  }

  _emitProgress(uploadId, fileName, hoster, data) {
    this.emit('progress', { uploadId, fileName, hoster, ...data });
  }

  _startStatsTimer() {
    if (this.statsInterval) clearInterval(this.statsInterval);
    this.statsInterval = setInterval(() => this._emitStats(), 1000);
  }

  _emitStats() {
    try {
      let globalSpeedKbs = 0;
      let activeCount = 0;
      let inProgressBytes = 0;
      for (const job of this.activeJobs.values()) {
        globalSpeedKbs += job.speedKbs || 0;
        inProgressBytes += job.bytesUploaded || 0;
        activeCount++;
      }

      const elapsed = Math.round((Date.now() - this.startTime) / 1000);

      this.emit('stats', {
        state: this.running ? (this.stopAfterActive ? 'stopping' : 'uploading') : 'idle',
        globalSpeedKbs,
        totalBytes: this.sessionBytes + inProgressBytes,
        elapsed,
        activeJobs: activeCount,
        pendingJobs: Object.values(this.semaphores).reduce((sum, semaphore) => sum + semaphore.pending, 0)
      });
    } catch {}
  }

  _stopStatsTimer() {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }
  }

  _combineSignals(signal1, signal2) {
    const controller = new AbortController();
    if (signal1.aborted || signal2.aborted) {
      controller.abort();
      return { signal: controller.signal, cleanup() {} };
    }

    const onAbort = () => {
      controller.abort();
      cleanup();
    };

    const cleanup = () => {
      signal1.removeEventListener('abort', onAbort);
      signal2.removeEventListener('abort', onAbort);
    };

    signal1.addEventListener('abort', onAbort, { once: true });
    signal2.addEventListener('abort', onAbort, { once: true });
    return { signal: controller.signal, cleanup };
  }

  _combineManySignals(signals) {
    const liveSignals = signals.filter(Boolean);
    const controller = new AbortController();

    if (liveSignals.some((signal) => signal.aborted)) {
      controller.abort();
      return { signal: controller.signal, cleanup() {} };
    }

    const listeners = liveSignals.map((signal) => {
      const handler = () => {
        controller.abort();
        cleanup();
      };
      signal.addEventListener('abort', handler, { once: true });
      return { signal, handler };
    });

    const cleanup = () => {
      for (const entry of listeners) {
        entry.signal.removeEventListener('abort', entry.handler);
      }
    };

    return { signal: controller.signal, cleanup };
  }

  _sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error('Aborted'));
      };

      const timer = setTimeout(() => {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);

      if (signal) {
        if (signal.aborted) {
          clearTimeout(timer);
          reject(new Error('Aborted'));
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  _waitForInterval(hoster, intervalMs, signal) {
    // Serialize interval waits per hoster so concurrent jobs queue up properly
    const prev = this.intervalLocks[hoster] || Promise.resolve();
    const next = prev.then(async () => {
      const now = Date.now();
      const last = this.lastStartTime[hoster] || 0;
      const elapsed = now - last;
      if (elapsed < intervalMs) {
        await this._sleep(intervalMs - elapsed, signal);
      }
      this.lastStartTime[hoster] = Date.now();
    });
    this.intervalLocks[hoster] = next.catch(() => {});
    return next;
  }

  addJobs(tasks) {
    if (!this.running || !tasks || tasks.length === 0) {
      return { added: 0, alreadyInBatchJobIds: [] };
    }
    const { signal } = this.abortController;
    const results = this._batchResults || new Map();
    const addResult = { added: 0, alreadyInBatchJobIds: [] };
    for (const task of tasks) {
      // Skip if this job is already being processed (prevent duplicates)
      if (task.jobId && this.jobAbortControllers.has(task.jobId)) {
        addResult.alreadyInBatchJobIds.push(task.jobId);
        continue;
      }
      const fileName = path.basename(task.file);
      if (!results.has(task.file)) {
        let size = 0;
        try { size = fs.statSync(task.file).size; } catch {}
        results.set(task.file, { name: fileName, size, results: [] });
      }
      this._additionalPromises.push(this._runJob(task, results, signal));
      addResult.added++;
    }
    return addResult;
  }

  cancelJobs(jobIds) {
    for (const jobId of jobIds || []) {
      if (!jobId) continue;
      if (!this.running) this.pendingCancelledJobIds.add(jobId);
      this.cancelledJobIds.add(jobId);
      const controller = this.jobAbortControllers.get(jobId);
      if (controller && !controller.signal.aborted) {
        controller.abort();
      }
    }
  }

  finishAfterActive() {
    this.stopAfterActive = true;
  }

  cancel() {
    if (!this.running) {
      this.pendingCancelAll = true;
      return;
    }
    this.abortController.abort();
    this.stopAfterActive = true;
    for (const controller of this.jobAbortControllers.values()) {
      if (!controller.signal.aborted) controller.abort();
    }
    this._stopStatsTimer();
    this._emitStats();
  }
}

module.exports = UploadManager;
