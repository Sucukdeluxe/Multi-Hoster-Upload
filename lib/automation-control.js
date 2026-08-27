(function initAutomationControl(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AutomationControl = api;
})(typeof window !== 'undefined' ? window : globalThis, function createAutomationControl() {
  const capacityStatuses = new Set(['preview', 'queued', 'getting-server', 'uploading', 'retrying']);
  const allowedIntervals = new Set([1, 5, 15, 30, 60]);

  function asObject(value) {
    return value && typeof value === 'object' ? value : {};
  }

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function normalizeQueueLimit(value) {
    const isNumber = typeof value === 'number';
    const isString = typeof value === 'string';
    if (!isNumber && !isString) return 15000;
    if (isString && value.trim() === '') return 15000;
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return 15000;
    if (number === 0) return isString && value.trim() !== '0' ? 15000 : 0;
    return Math.max(1, Math.floor(number));
  }

  function normalizeReconcileInterval(value) {
    return typeof value === 'number' && Number.isFinite(value) && allowedIntervals.has(value) ? value : 5;
  }

  function normalizeCounter(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return 0;
    return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(number));
  }

  function normalizeAutomationSettings(value = {}) {
    const settings = asObject(value);
    const queueLimitJobs = normalizeQueueLimit(settings.queueLimitJobs);
    return {
      queueLimitJobs,
      reconcileIntervalMinutes: normalizeReconcileInterval(settings.reconcileIntervalMinutes),
      paused: settings.paused === true,
      pausedAt: settings.paused === true && Number.isFinite(Number(settings.pausedAt)) ? Number(settings.pausedAt) : null
    };
  }

  function countAutomaticQueueJobs(queueJobs) {
    return asArray(queueJobs).reduce((count, job) => count + (capacityStatuses.has(job?.status) ? 1 : 0), 0);
  }

  function planAtomicAdmissions(input = {}) {
    const value = asObject(input);
    const ordered = [...asArray(value.candidates)].sort((left, right) =>
      (Number(left?.mtimeMs) || 0) - (Number(right?.mtimeMs) || 0)
      || String(left?.path).localeCompare(String(right?.path))
    );
    const rawCurrentJobCount = Number(value.currentJobCount);
    const currentJobCount = Number.isFinite(rawCurrentJobCount) ? Math.max(0, Math.floor(rawCurrentJobCount)) : 0;
    const queueLimitJobs = normalizeQueueLimit(value.queueLimitJobs);
    let available = queueLimitJobs === 0 ? Number.POSITIVE_INFINITY : Math.max(0, queueLimitJobs - currentJobCount);
    const admittedPaths = [];
    const deferredPaths = [];
    let plannedJobs = 0;
    for (const candidate of ordered) {
      const required = Math.max(0, Math.floor(Number(candidate?.eligibleJobCount) || 0));
      if (required > 0 && required <= available) {
        admittedPaths.push(candidate?.path);
        available -= required;
        plannedJobs += required;
      } else if (required > 0) {
        deferredPaths.push(candidate?.path);
      }
    }
    return {
      admittedPaths,
      deferredPaths,
      currentJobCount,
      plannedJobs,
      availableSlots: Number.isFinite(available) ? available : null
    };
  }

  function localDateKey(nowMs) {
    const date = new Date(nowMs);
    return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
  }

  function emptyTelemetry(dateKey) {
    return {
      dateKey,
      detected: 0,
      queued: 0,
      skipped: 0,
      deferred: 0,
      lastDetectedName: '',
      lastDetectedAt: null,
      lastError: '',
      lastErrorAt: null
    };
  }

  function rollDailyTelemetry(value = {}, nowMs = Date.now()) {
    const telemetry = asObject(value);
    const dateKey = localDateKey(nowMs);
    if (telemetry.dateKey !== dateKey) return emptyTelemetry(dateKey);
    return {
      ...emptyTelemetry(dateKey),
      ...telemetry,
      dateKey,
      detected: normalizeCounter(telemetry.detected),
      queued: normalizeCounter(telemetry.queued),
      skipped: normalizeCounter(telemetry.skipped),
      deferred: normalizeCounter(telemetry.deferred)
    };
  }

  function applyTelemetryDelta(value, delta = {}, nowMs = Date.now()) {
    const changes = asObject(delta);
    const next = rollDailyTelemetry(value, nowMs);
    for (const key of ['detected', 'queued', 'skipped', 'deferred']) {
      next[key] = Math.min(Number.MAX_SAFE_INTEGER, next[key] + normalizeCounter(changes[key]));
    }
    if (changes.lastDetectedName) {
      next.lastDetectedName = String(changes.lastDetectedName);
      next.lastDetectedAt = nowMs;
    }
    if (Object.prototype.hasOwnProperty.call(changes, 'lastError')) {
      next.lastError = String(changes.lastError || '');
      next.lastErrorAt = next.lastError ? nowMs : null;
    }
    return next;
  }

  function deriveAutomationState(value = {}) {
    const state = asObject(value);
    if (state.paused === true) return 'paused';
    if (state.enabled !== true || !state.folderPath) return 'inactive';
    if (state.reachable === false) return 'disconnected';
    if (state.error) return 'error';
    if (state.queueLimited === true) return 'queue-limited';
    return 'active';
  }

  function normalizePath(value) {
    return String(value || '').replace(/\\/g, '/').toLowerCase();
  }

  function isPathWithinAutomationFolder(filePath, folderPath, recursive = true) {
    const file = normalizePath(filePath).replace(/\/+$/, '');
    const folder = normalizePath(folderPath).replace(/\/+$/, '');
    if (!file || !folder || !file.startsWith(`${folder}/`)) return false;
    const relative = file.slice(folder.length + 1);
    return Boolean(relative) && (recursive === true || !relative.includes('/'));
  }

  function baseName(value) {
    return String(value || '').split(/[\\/]/).pop().toLowerCase();
  }

  function normalizeAutomationCompletion(value) {
    const row = asObject(value);
    const path = String(row.path || '').trim();
    const hoster = String(row.hoster || '').trim().toLowerCase();
    const size = Number(row.size);
    const mtimeMs = Number(row.mtimeMs);
    const completedAt = Number(row.completedAt);
    if (!path || !hoster || !Number.isFinite(size) || size < 0 || !Number.isFinite(mtimeMs) || mtimeMs < 0) return null;
    return {
      path,
      size,
      mtimeMs: Math.trunc(mtimeMs),
      hoster,
      completedAt: Number.isFinite(completedAt) && completedAt >= 0 ? Math.trunc(completedAt) : 0
    };
  }

  function automationCompletionKey(value) {
    const row = normalizeAutomationCompletion(value);
    return row ? `${normalizePath(row.path)}\u0000${row.hoster}` : '';
  }

  function mergeAutomationCompletions(existing, incoming, maxEntries = 250000) {
    const merged = new Map();
    for (const source of [asArray(existing), asArray(incoming)]) {
      for (const value of source) {
        const row = normalizeAutomationCompletion(value);
        const key = automationCompletionKey(row);
        if (key) {
          merged.delete(key);
          merged.set(key, row);
        }
      }
    }
    const limit = Number.isFinite(Number(maxEntries)) ? Math.max(1, Math.floor(Number(maxEntries))) : 250000;
    if (merged.size > limit) throw new Error('Automatik-Abschlussdatei enthält zu viele Einträge');
    return [...merged.values()];
  }

  function removeAutomationCompletions(existing, removals) {
    const rules = asArray(removals).map(value => ({
      path: normalizePath(value?.path),
      hoster: String(value?.hoster || '').trim().toLowerCase()
    })).filter(value => value.path);
    if (rules.length === 0) return mergeAutomationCompletions(existing, []);
    return mergeAutomationCompletions(existing, []).filter(row => {
      const path = normalizePath(row.path);
      return !rules.some(rule => rule.path === path && (!rule.hoster || rule.hoster === row.hoster));
    });
  }

  function classifyAutomationCompletionLedger(input = {}) {
    const value = asObject(input);
    const rows = new Map();
    for (const entry of asArray(value.completionRows)) {
      const row = normalizeAutomationCompletion(entry);
      const key = automationCompletionKey(row);
      if (key) rows.set(key, row);
    }
    const processedPaths = [];
    const completedByPath = [];
    const remainingByPath = [];
    for (const candidate of asArray(value.candidates)) {
      const path = String(candidate?.path || '');
      const size = Number(candidate?.size);
      const mtimeMs = Number(candidate?.mtimeMs);
      const hosters = [...new Set(asArray(candidate?.eligibleHosters).map(hoster => String(hoster || '').trim().toLowerCase()).filter(Boolean))];
      const completed = [];
      const remaining = [];
      for (const hoster of hosters) {
        const row = rows.get(`${normalizePath(path)}\u0000${hoster}`);
        if (row && Number.isFinite(size) && size === row.size && Number.isFinite(mtimeMs) && Math.trunc(mtimeMs) === row.mtimeMs) completed.push(hoster);
        else remaining.push(hoster);
      }
      if (hosters.length > 0 && remaining.length === 0) processedPaths.push(path);
      completedByPath.push({ path, hosters: completed });
      remainingByPath.push({ path, hosters: remaining });
    }
    return { processedPaths, completedByPath, remainingByPath };
  }

  function createAutomationCompletionWriter(options = {}) {
    const settings = asObject(options);
    if (typeof settings.save !== 'function') throw new TypeError('save is required');
    const schedule = typeof settings.schedule === 'function' ? settings.schedule : queueMicrotask;
    const pending = new Map();
    let scheduled = false;
    let tail = Promise.resolve();
    const flush = () => {
      scheduled = false;
      if (pending.size === 0) return tail;
      const snapshot = [...pending.entries()];
      const rows = snapshot.map(([, row]) => row);
      const operation = tail.then(async () => {
        try {
          await settings.save(rows);
          for (const [key, row] of snapshot) {
            if (pending.get(key) === row) pending.delete(key);
          }
          try { settings.onPersisted?.(rows); } catch {}
        } catch (error) {
          try { settings.onError?.(error, rows); } catch {}
          throw error;
        }
      });
      tail = operation.catch(() => {});
      return operation;
    };
    return {
      add(value) {
        const row = normalizeAutomationCompletion(value);
        const key = automationCompletionKey(row);
        if (!key) return false;
        pending.set(key, row);
        if (!scheduled) {
          scheduled = true;
          schedule(() => { flush().catch(() => {}); });
        }
        return true;
      },
      flush,
      pendingCount: () => pending.size
    };
  }

  function classifyProcessedCandidates(input = {}) {
    const value = asObject(input);
    const candidates = asArray(value.candidates);
    const historyRows = asArray(value.historyRows);
    const uploadLogRows = asArray(value.uploadLogRows);
    const exactPaths = new Set(asArray(value.queuePaths).map(normalizePath).filter(Boolean));
    for (const row of historyRows) {
      const exact = normalizePath(row?.path || row?.file);
      if (exact) exactPaths.add(exact);
    }
    const evidenceNames = new Set();
    for (const row of [...historyRows, ...uploadLogRows]) {
      const name = baseName(row?.fileName || row?.filename || row?.name || row?.path || row?.file);
      if (name) evidenceNames.add(name);
    }
    const nameCounts = new Map();
    for (const candidate of candidates) {
      const name = baseName(candidate?.name || candidate?.path);
      nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
    }
    const processedPaths = [];
    const ambiguousPaths = [];
    const unprocessedPaths = [];
    for (const candidate of candidates) {
      const exact = normalizePath(candidate?.path);
      const name = baseName(candidate?.name || candidate?.path);
      if ((exact && exactPaths.has(exact)) || (evidenceNames.has(name) && nameCounts.get(name) === 1)) processedPaths.push(candidate?.path);
      else if (evidenceNames.has(name) && nameCounts.get(name) > 1) ambiguousPaths.push(candidate?.path);
      else unprocessedPaths.push(candidate?.path);
    }
    return { processedPaths, ambiguousPaths, unprocessedPaths };
  }

  return {
    normalizeAutomationSettings,
    countAutomaticQueueJobs,
    planAtomicAdmissions,
    rollDailyTelemetry,
    applyTelemetryDelta,
    deriveAutomationState,
    isPathWithinAutomationFolder,
    classifyProcessedCandidates,
    classifyAutomationCompletionLedger,
    automationCompletionKey,
    createAutomationCompletionWriter,
    normalizeAutomationCompletion,
    mergeAutomationCompletions,
    removeAutomationCompletions
  };
});
