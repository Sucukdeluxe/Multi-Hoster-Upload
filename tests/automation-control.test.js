const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeAutomationSettings,
  countAutomaticQueueJobs,
  planAtomicAdmissions,
  rollDailyTelemetry,
  applyTelemetryDelta,
  deriveAutomationState,
  classifyProcessedCandidates
} = require('../lib/automation-control');

test('automation defaults use 15000 jobs and a five minute reconciliation interval', () => {
  assert.deepEqual(normalizeAutomationSettings({}), {
    queueLimitJobs: 15000,
    reconcileIntervalMinutes: 5,
    paused: false,
    pausedAt: null
  });
});

test('automation settings normalize invalid limits intervals and pause timestamps', () => {
  assert.deepEqual(normalizeAutomationSettings({
    queueLimitJobs: -1,
    reconcileIntervalMinutes: 10,
    paused: true,
    pausedAt: '1700'
  }), {
    queueLimitJobs: 15000,
    reconcileIntervalMinutes: 5,
    paused: true,
    pausedAt: 1700
  });
  assert.deepEqual(normalizeAutomationSettings({
    queueLimitJobs: 42.9,
    reconcileIntervalMinutes: '15',
    pausedAt: 1700
  }), {
    queueLimitJobs: 42,
    reconcileIntervalMinutes: 5,
    paused: false,
    pausedAt: null
  });
  assert.deepEqual(normalizeAutomationSettings(null), {
    queueLimitJobs: 15000,
    reconcileIntervalMinutes: 5,
    paused: false,
    pausedAt: null
  });
  assert.equal(normalizeAutomationSettings({ reconcileIntervalMinutes: 15 }).reconcileIntervalMinutes, 15);
});

test('automation settings allow only numeric and trimmed string zero to disable the queue limit', () => {
  const invalidLimits = [null, '', '   ', false, true, {}, undefined, NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '0.0', '00', '+0', '-0'];
  assert.deepEqual(
    invalidLimits.map((queueLimitJobs) => normalizeAutomationSettings({ queueLimitJobs }).queueLimitJobs),
    invalidLimits.map(() => 15000)
  );
  assert.equal(normalizeAutomationSettings({ queueLimitJobs: 0 }).queueLimitJobs, 0);
  assert.equal(normalizeAutomationSettings({ queueLimitJobs: ' 0 ' }).queueLimitJobs, 0);
});

test('automation settings clamp positive queue limit fractions to one', () => {
  assert.deepEqual(
    [0.5, '0.5', 0.125].map((queueLimitJobs) => normalizeAutomationSettings({ queueLimitJobs }).queueLimitJobs),
    [1, 1, 1]
  );
});

test('capacity counts only executable and running queue jobs', () => {
  const statuses = ['preview', 'queued', 'getting-server', 'uploading', 'retrying', 'done', 'error', 'aborted', 'skipped'];
  assert.equal(countAutomaticQueueJobs(statuses.map((status, index) => ({ id: String(index), status }))), 5);
  assert.equal(countAutomaticQueueJobs(null), 0);
});

test('admission keeps every eligible host job for a file atomic', () => {
  const plan = planAtomicAdmissions({
    candidates: [
      { path: 'C:\\watch\\a.mkv', mtimeMs: 1000, eligibleJobCount: 4 },
      { path: 'C:\\watch\\b.mkv', mtimeMs: 2000, eligibleJobCount: 2 }
    ],
    currentJobCount: 14997,
    queueLimitJobs: 15000
  });
  assert.deepEqual(plan.admittedPaths, ['C:\\watch\\b.mkv']);
  assert.deepEqual(plan.deferredPaths, ['C:\\watch\\a.mkv']);
  assert.equal(plan.plannedJobs, 2);
  assert.equal(plan.availableSlots, 1);
});

test('admission uses stable mtime and path ordering without mutating candidates', () => {
  const candidates = [
    { path: 'b', mtimeMs: 10, eligibleJobCount: 1 },
    { path: 'c', mtimeMs: 5, eligibleJobCount: 1 },
    { path: 'a', mtimeMs: 10, eligibleJobCount: 1 }
  ];
  const snapshot = structuredClone(candidates);
  const plan = planAtomicAdmissions({ candidates, currentJobCount: 0, queueLimitJobs: 2 });
  assert.deepEqual(plan.admittedPaths, ['c', 'a']);
  assert.deepEqual(plan.deferredPaths, ['b']);
  assert.deepEqual(candidates, snapshot);
});

test('unlimited admission accepts all eligible files', () => {
  const plan = planAtomicAdmissions({
    candidates: [{ path: 'a', mtimeMs: 1, eligibleJobCount: 20000 }],
    currentJobCount: 50000,
    queueLimitJobs: 0
  });
  assert.deepEqual(plan.admittedPaths, ['a']);
  assert.deepEqual(plan.deferredPaths, []);
  assert.equal(plan.availableSlots, null);
});

test('admission tolerates malformed candidates and numeric inputs', () => {
  assert.deepEqual(planAtomicAdmissions({ candidates: null, currentJobCount: -4, queueLimitJobs: '3' }), {
    admittedPaths: [],
    deferredPaths: [],
    currentJobCount: 0,
    plannedJobs: 0,
    availableSlots: 3
  });
  assert.deepEqual(planAtomicAdmissions(null), {
    admittedPaths: [],
    deferredPaths: [],
    currentJobCount: 0,
    plannedJobs: 0,
    availableSlots: 15000
  });
});

test('admission allows only numeric and trimmed string zero to disable the queue limit', () => {
  const invalidLimits = [null, '', '   ', false, true, {}, undefined, NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '0.0', '00', '+0', '-0'];
  const candidate = { path: 'large.mkv', mtimeMs: 1, eligibleJobCount: 16000 };
  assert.deepEqual(
    invalidLimits.map((queueLimitJobs) => planAtomicAdmissions({ candidates: [candidate], queueLimitJobs })),
    invalidLimits.map(() => ({
      admittedPaths: [],
      deferredPaths: ['large.mkv'],
      currentJobCount: 0,
      plannedJobs: 0,
      availableSlots: 15000
    }))
  );
  assert.deepEqual(
    [0, ' 0 '].map((queueLimitJobs) => planAtomicAdmissions({ candidates: [candidate], queueLimitJobs })),
    [0, ' 0 '].map(() => ({
      admittedPaths: ['large.mkv'],
      deferredPaths: [],
      currentJobCount: 0,
      plannedJobs: 16000,
      availableSlots: null
    }))
  );
});

test('admission keeps positive queue limit fractions bounded to one job', () => {
  const candidate = { path: 'two-jobs.mkv', mtimeMs: 1, eligibleJobCount: 2 };
  assert.deepEqual(
    [0.5, '0.5', 0.125].map((queueLimitJobs) => planAtomicAdmissions({ candidates: [candidate], queueLimitJobs })),
    [0.5, '0.5', 0.125].map(() => ({
      admittedPaths: [],
      deferredPaths: ['two-jobs.mkv'],
      currentJobCount: 0,
      plannedJobs: 0,
      availableSlots: 1
    }))
  );
});

test('daily telemetry resets atomically on the local calendar day boundary', () => {
  const before = { dateKey: '2026-08-25', detected: 8, queued: 4, skipped: 2, deferred: 1 };
  const now = new Date(2026, 7, 26, 0, 0, 1).getTime();
  assert.deepEqual(rollDailyTelemetry(before, now), {
    dateKey: '2026-08-26',
    detected: 0,
    queued: 0,
    skipped: 0,
    deferred: 0,
    lastDetectedName: '',
    lastDetectedAt: null,
    lastError: '',
    lastErrorAt: null
  });
});

test('daily telemetry normalizes malformed same-day counters without mutating input', () => {
  const now = new Date(2026, 7, 26, 12, 0, 0).getTime();
  const telemetry = { dateKey: '2026-08-26', detected: -2, queued: '3', lastError: 'network' };
  const snapshot = structuredClone(telemetry);
  assert.deepEqual(rollDailyTelemetry(telemetry, now), {
    dateKey: '2026-08-26',
    detected: 0,
    queued: 3,
    skipped: 0,
    deferred: 0,
    lastDetectedName: '',
    lastDetectedAt: null,
    lastError: 'network',
    lastErrorAt: null
  });
  assert.deepEqual(telemetry, snapshot);
  assert.equal(rollDailyTelemetry(null, now).dateKey, '2026-08-26');
});

test('telemetry deltas increment counters and update event details immutably', () => {
  const now = new Date(2026, 7, 26, 13, 14, 15).getTime();
  const telemetry = {
    dateKey: '2026-08-26',
    detected: 1,
    queued: 2,
    skipped: 3,
    deferred: 4,
    lastDetectedName: '',
    lastDetectedAt: null,
    lastError: 'old',
    lastErrorAt: 10
  };
  const result = applyTelemetryDelta(telemetry, {
    detected: 2,
    queued: 3,
    skipped: -1,
    deferred: '2',
    lastDetectedName: 'episode.mkv',
    lastError: ''
  }, now);
  assert.deepEqual(result, {
    dateKey: '2026-08-26',
    detected: 3,
    queued: 5,
    skipped: 3,
    deferred: 6,
    lastDetectedName: 'episode.mkv',
    lastDetectedAt: now,
    lastError: '',
    lastErrorAt: null
  });
  assert.equal(telemetry.detected, 1);
  assert.equal(telemetry.lastError, 'old');
});

test('telemetry and deltas normalize every counter to a finite nonnegative integer', () => {
  const now = new Date(2026, 7, 26, 13, 14, 15).getTime();
  const telemetry = rollDailyTelemetry({
    dateKey: '2026-08-26',
    detected: Number.POSITIVE_INFINITY,
    queued: Number.NaN,
    skipped: -4,
    deferred: 3.9
  }, now);
  assert.deepEqual({
    detected: telemetry.detected,
    queued: telemetry.queued,
    skipped: telemetry.skipped,
    deferred: telemetry.deferred
  }, { detected: 0, queued: 0, skipped: 0, deferred: 3 });

  const changed = applyTelemetryDelta(telemetry, {
    detected: Number.POSITIVE_INFINITY,
    queued: Number.NaN,
    skipped: -2,
    deferred: 2.8
  }, now);
  assert.deepEqual({
    detected: changed.detected,
    queued: changed.queued,
    skipped: changed.skipped,
    deferred: changed.deferred
  }, { detected: 0, queued: 0, skipped: 0, deferred: 5 });
  assert.equal(Object.values(changed).filter(value => typeof value === 'number').every(value => Number.isFinite(value)), true);
});

test('pause has higher display priority than disconnect error and queue limit', () => {
  assert.equal(deriveAutomationState({ paused: true, enabled: true, folderPath: 'C:\\watch', reachable: false, error: 'x', queueLimited: true }), 'paused');
});

test('automation state follows inactive disconnected error queue-limited and active priority', () => {
  assert.equal(deriveAutomationState({ enabled: false, folderPath: 'C:\\watch', reachable: false, error: 'x', queueLimited: true }), 'inactive');
  assert.equal(deriveAutomationState({ enabled: true, folderPath: '', reachable: false, error: 'x', queueLimited: true }), 'inactive');
  assert.equal(deriveAutomationState({ enabled: true, folderPath: 'C:\\watch', reachable: false, error: 'x', queueLimited: true }), 'disconnected');
  assert.equal(deriveAutomationState({ enabled: true, folderPath: 'C:\\watch', reachable: true, error: 'x', queueLimited: true }), 'error');
  assert.equal(deriveAutomationState({ enabled: true, folderPath: 'C:\\watch', reachable: true, queueLimited: true }), 'queue-limited');
  assert.equal(deriveAutomationState({ enabled: true, folderPath: 'C:\\watch', reachable: true }), 'active');
  assert.equal(deriveAutomationState(null), 'inactive');
});

test('exact queue and history paths mark candidates processed case-insensitively', () => {
  const result = classifyProcessedCandidates({
    candidates: [
      { path: 'C:\\Watch\\queue.mkv' },
      { path: 'C:\\Watch\\history.mkv' },
      { path: 'C:\\Watch\\new.mkv' }
    ],
    queuePaths: ['c:/watch/QUEUE.mkv'],
    historyRows: [{ file: 'c:/watch/HISTORY.mkv' }],
    uploadLogRows: []
  });
  assert.deepEqual(result, {
    processedPaths: ['C:\\Watch\\queue.mkv', 'C:\\Watch\\history.mkv'],
    ambiguousPaths: [],
    unprocessedPaths: ['C:\\Watch\\new.mkv']
  });
});

test('unique basename evidence marks one candidate processed', () => {
  const result = classifyProcessedCandidates({
    candidates: [{ path: 'C:\\watch\\unique.mkv' }, { path: 'C:\\watch\\other.mkv' }],
    uploadLogRows: [{ filename: 'UNIQUE.MKV' }]
  });
  assert.deepEqual(result.processedPaths, ['C:\\watch\\unique.mkv']);
  assert.deepEqual(result.unprocessedPaths, ['C:\\watch\\other.mkv']);
});

test('ambiguous same-name log evidence never marks a candidate processed', () => {
  const result = classifyProcessedCandidates({
    candidates: [
      { path: 'C:\\one\\episode.mkv', name: 'episode.mkv' },
      { path: 'D:\\two\\episode.mkv', name: 'episode.mkv' }
    ],
    queuePaths: [],
    historyRows: [],
    uploadLogRows: [{ fileName: 'episode.mkv', hoster: 'doodstream.com' }]
  });
  assert.deepEqual(result.processedPaths, []);
  assert.deepEqual(result.ambiguousPaths.sort(), ['C:\\one\\episode.mkv', 'D:\\two\\episode.mkv'].sort());
});

test('processed classification tolerates malformed collections and does not mutate candidates', () => {
  const candidates = [{ path: 'C:\\watch\\episode.mkv', name: 'episode.mkv' }];
  const snapshot = structuredClone(candidates);
  assert.deepEqual(classifyProcessedCandidates({
    candidates,
    queuePaths: null,
    historyRows: null,
    uploadLogRows: null
  }), {
    processedPaths: [],
    ambiguousPaths: [],
    unprocessedPaths: ['C:\\watch\\episode.mkv']
  });
  assert.deepEqual(candidates, snapshot);
  assert.deepEqual(classifyProcessedCandidates(null), {
    processedPaths: [],
    ambiguousPaths: [],
    unprocessedPaths: []
  });
});
