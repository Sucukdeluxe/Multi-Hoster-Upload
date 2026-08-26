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
    if (number === 0 && isString && value.trim() !== '0') return 15000;
    return Math.floor(number);
  }

  function normalizeAutomationSettings(value = {}) {
    const settings = asObject(value);
    const queueLimitJobs = normalizeQueueLimit(settings.queueLimitJobs);
    const rawInterval = Number(settings.reconcileIntervalMinutes);
    return {
      queueLimitJobs,
      reconcileIntervalMinutes: allowedIntervals.has(rawInterval) ? rawInterval : 5,
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
      detected: Math.max(0, Number(telemetry.detected) || 0),
      queued: Math.max(0, Number(telemetry.queued) || 0),
      skipped: Math.max(0, Number(telemetry.skipped) || 0),
      deferred: Math.max(0, Number(telemetry.deferred) || 0)
    };
  }

  function applyTelemetryDelta(value, delta = {}, nowMs = Date.now()) {
    const changes = asObject(delta);
    const next = rollDailyTelemetry(value, nowMs);
    for (const key of ['detected', 'queued', 'skipped', 'deferred']) {
      next[key] += Math.max(0, Number(changes[key]) || 0);
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

  function baseName(value) {
    return String(value || '').split(/[\\/]/).pop().toLowerCase();
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
    classifyProcessedCandidates
  };
});
