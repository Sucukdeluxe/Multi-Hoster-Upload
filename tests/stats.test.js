const test = require('node:test');
const assert = require('node:assert');
const {
  summarizePerHoster,
  summarizeHosterHealth,
  classifyErrorCategory,
  summarizeBatchErrors,
  isRetryableCategory,
  mergeSkippedIntoSummary
} = require('../lib/stats');

function makeBatch(timestamp, results) {
  return {
    id: 'b-' + timestamp,
    timestamp: new Date(timestamp).toISOString(),
    files: [{ name: 'foo.mp4', size: 1, results }]
  };
}

test('summarizePerHoster counts ok and fail per hoster across all batches', () => {
  const history = [
    makeBatch(1, [
      { hoster: 'voe.sx', status: 'done' },
      { hoster: 'byse.sx', status: 'error', error: 'Not video file format' }
    ]),
    makeBatch(2, [
      { hoster: 'voe.sx', status: 'done' },
      { hoster: 'voe.sx', status: 'error', error: 'CSRF' },
      { hoster: 'byse.sx', status: 'done' }
    ])
  ];
  const s = summarizePerHoster(history);
  assert.strictEqual(s['voe.sx'].ok, 2);
  assert.strictEqual(s['voe.sx'].fail, 1);
  assert.strictEqual(s['voe.sx'].total, 3);
  assert.strictEqual(Math.round(s['voe.sx'].rate * 100), 67);
  assert.strictEqual(s['byse.sx'].ok, 1);
  assert.strictEqual(s['byse.sx'].fail, 1);
  assert.strictEqual(s['byse.sx'].rate, 0.5);
});

test('summarizePerHoster honors sinceMs cutoff', () => {
  const history = [
    makeBatch(1000, [{ hoster: 'voe.sx', status: 'done' }]),
    makeBatch(5000, [{ hoster: 'voe.sx', status: 'error', error: 'x' }])
  ];
  const s = summarizePerHoster(history, { sinceMs: 3000 });
  assert.strictEqual(s['voe.sx'].ok, 0);
  assert.strictEqual(s['voe.sx'].fail, 1);
});

test('summarizePerHoster honors lastNBatches (newest first)', () => {
  const history = [
    makeBatch(1000, [{ hoster: 'voe.sx', status: 'done' }]),
    makeBatch(2000, [{ hoster: 'voe.sx', status: 'done' }]),
    makeBatch(3000, [{ hoster: 'voe.sx', status: 'error', error: 'x' }])
  ];
  const s = summarizePerHoster(history, { lastNBatches: 1 });
  assert.strictEqual(s['voe.sx'].ok, 0);
  assert.strictEqual(s['voe.sx'].fail, 1);
});

test('summarizePerHoster handles empty / malformed input', () => {
  assert.deepStrictEqual(summarizePerHoster(null), {});
  assert.deepStrictEqual(summarizePerHoster([]), {});
  assert.deepStrictEqual(summarizePerHoster([{ id: 'x', files: null }]), {});
});

test('summarizePerHoster reports skipped uploads without lowering the host success rate', () => {
  const history = [makeBatch(1, [
    { hoster: 'voe.sx', status: 'done' },
    { hoster: 'voe.sx', status: 'error', error: 'x' },
    { hoster: 'voe.sx', status: 'skipped', error: 'Datei zu groß' }
  ])];
  const summary = summarizePerHoster(history)['voe.sx'];
  assert.deepStrictEqual({ ok: summary.ok, fail: summary.fail, skipped: summary.skipped, total: summary.total }, { ok: 1, fail: 1, skipped: 1, total: 3 });
  assert.strictEqual(summary.rate, 0.5);
});

test('summarizeHosterHealth keeps skipped results outside the success rate and calculates effective historical throughput', () => {
  const now = new Date('2026-08-16T12:00:00.000Z');
  const history = [{
    timestamp: '2026-08-16T10:00:00.000Z',
    files: [
      { name: 'one.bin', size: 1024 * 1024, results: [{ hoster: 'voe.sx', status: 'done', durationSec: 2 }] },
      { name: 'two.bin', size: 2 * 1024 * 1024, results: [{ hoster: 'voe.sx', status: 'done', durationSec: 2 }] },
      { name: 'failed.bin', size: 8 * 1024 * 1024, results: [{ hoster: 'voe.sx', status: 'error', durationSec: 1 }] },
      { name: 'skipped.bin', size: 16 * 1024 * 1024, results: [{ hoster: 'voe.sx', status: 'skipped', durationSec: 1 }] }
    ]
  }];

  const summary = summarizeHosterHealth(history, { now })['voe.sx'];

  assert.deepStrictEqual({
    sampleSize: summary.sampleSize,
    successful: summary.successful,
    failed: summary.failed,
    skipped: summary.skipped,
    successRate: summary.successRate,
    effectiveBytes: summary.effectiveBytes,
    effectiveDurationSec: summary.effectiveDurationSec,
    effectiveBytesPerSecond: summary.effectiveBytesPerSecond
  }, {
    sampleSize: 4,
    successful: 2,
    failed: 1,
    skipped: 1,
    successRate: 2 / 3,
    effectiveBytes: 3 * 1024 * 1024,
    effectiveDurationSec: 4,
    effectiveBytesPerSecond: 786432
  });
});

test('summarizeHosterHealth reports the newest successful batch and failures in the current seven-day window', () => {
  const now = new Date('2026-08-16T12:00:00.000Z');
  const history = [
    makeBatch(Date.parse('2026-08-09T11:59:59.999Z'), [{ hoster: 'byse.sx', status: 'error' }]),
    makeBatch(Date.parse('2026-08-09T12:00:00.000Z'), [{ hoster: 'byse.sx', status: 'error' }]),
    makeBatch(Date.parse('2026-08-15T09:00:00.000Z'), [{ hoster: 'byse.sx', status: 'done', durationSec: 4 }]),
    makeBatch(Date.parse('2026-08-16T11:00:00.000Z'), [{ hoster: 'byse.sx', status: 'error' }]),
    makeBatch(Date.parse('2026-08-16T13:00:00.000Z'), [{ hoster: 'byse.sx', status: 'error' }])
  ];

  const summary = summarizeHosterHealth(history, { now })['byse.sx'];

  assert.strictEqual(summary.lastSuccessAt, '2026-08-15T09:00:00.000Z');
  assert.strictEqual(summary.failuresLast7Days, 2);
});

test('summarizeHosterHealth uses only the 50 chronologically newest batches', () => {
  const history = [makeBatch(1, [{ hoster: 'doodstream.com', status: 'done', durationSec: 1 }])];
  for (let timestamp = 2; timestamp <= 51; timestamp++) {
    history.push(makeBatch(timestamp, [{ hoster: 'doodstream.com', status: 'error' }]));
  }
  history.reverse();

  const summary = summarizeHosterHealth(history, { now: new Date(100000) })['doodstream.com'];

  assert.deepStrictEqual({
    sampleSize: summary.sampleSize,
    successful: summary.successful,
    failed: summary.failed,
    lastSuccessAt: summary.lastSuccessAt
  }, {
    sampleSize: 50,
    successful: 0,
    failed: 50,
    lastSuccessAt: null
  });
});

test('summarizeHosterHealth combines configured accounts, current statuses, and session failures without double counting', () => {
  const hosters = {
    'voe.sx': [
      { id: 'ready', enabled: true, authType: 'login', username: 'ready@example.invalid', password: 'secret' },
      { id: 'failed', enabled: true, authType: 'login', username: 'failed@example.invalid', password: 'secret' },
      { id: 'unchecked', enabled: true, authType: 'login', username: 'unchecked@example.invalid', password: 'secret' },
      { id: 'disabled', enabled: false, authType: 'login', username: 'disabled@example.invalid', password: 'secret' },
      { id: 'session', enabled: true, authType: 'login', username: 'session@example.invalid', password: 'secret' }
    ],
    'clouddrop.cc': []
  };
  const accountStatuses = {
    ready: { status: 'ok' },
    failed: { status: 'error' },
    unchecked: { status: 'unchecked' },
    disabled: { status: 'error' },
    session: { status: 'ok' }
  };

  const summary = summarizeHosterHealth([], {
    now: new Date('2026-08-16T12:00:00.000Z'),
    hosters,
    accountStatuses,
    sessionFailedKeys: new Set(['voe.sx:failed', 'voe.sx:session'])
  });

  assert.deepStrictEqual({
    configuredAccounts: summary['voe.sx'].configuredAccounts,
    accountProblems: summary['voe.sx'].accountProblems,
    uncheckedAccounts: summary['voe.sx'].uncheckedAccounts,
    checkingAccounts: summary['voe.sx'].checkingAccounts
  }, {
    configuredAccounts: 5,
    accountProblems: 3,
    uncheckedAccounts: 1,
    checkingAccounts: 0
  });
  assert.deepStrictEqual({
    sampleSize: summary['clouddrop.cc'].sampleSize,
    configuredAccounts: summary['clouddrop.cc'].configuredAccounts,
    successRate: summary['clouddrop.cc'].successRate
  }, {
    sampleSize: 0,
    configuredAccounts: 0,
    successRate: null
  });
});

test('classifyErrorCategory: file-rejected phrases', () => {
  assert.strictEqual(classifyErrorCategory('Byse lehnte Datei ab: Not video file format'), 'file-rejected');
  assert.strictEqual(classifyErrorCategory('Duplicate file already exists'), 'file-rejected');
  assert.strictEqual(classifyErrorCategory('Datei zu groß (Max: 5 GB)'), 'file-rejected');
});

test('classifyErrorCategory: account-error phrases', () => {
  assert.strictEqual(classifyErrorCategory('Quota exceeded'), 'account-error');
  assert.strictEqual(classifyErrorCategory('account banned'), 'account-error');
  assert.strictEqual(classifyErrorCategory('not enough disk space'), 'account-error');
});

test('classifyErrorCategory: hoster-transient phrases', () => {
  assert.strictEqual(classifyErrorCategory('CSRF-Token nicht gefunden'), 'hoster-transient');
  assert.strictEqual(classifyErrorCategory('Kein Upload-Server erhalten: server busy'), 'hoster-transient');
  assert.strictEqual(classifyErrorCategory('Kein Filecode'), 'hoster-transient');
});

test('classifyErrorCategory: network phrases', () => {
  assert.strictEqual(classifyErrorCategory('socket hang up'), 'network');
  assert.strictEqual(classifyErrorCategory('fetch failed'), 'network');
  assert.strictEqual(classifyErrorCategory('Timeout while reading'), 'network');
});

test('classifyErrorCategory: aborted is its own bucket (not retryable)', () => {
  assert.strictEqual(classifyErrorCategory('Abgebrochen'), 'aborted');
  assert.strictEqual(isRetryableCategory('aborted'), false);
});

test('classifyErrorCategory: unknown for everything else', () => {
  assert.strictEqual(classifyErrorCategory(''), 'unknown');
  assert.strictEqual(classifyErrorCategory(null), 'unknown');
  assert.strictEqual(classifyErrorCategory('Some weird thing'), 'unknown');
});

test('summarizeBatchErrors buckets results by category', () => {
  const summary = {
    files: [
      { name: 'a.mp4', results: [
        { hoster: 'voe.sx', status: 'done' },
        { hoster: 'byse.sx', status: 'error', error: 'Not video file format' }
      ] },
      { name: 'b.mp4', results: [
        { hoster: 'voe.sx', status: 'error', error: 'CSRF' },
        { hoster: 'doodstream.com', status: 'error', error: 'socket hang up' }
      ] }
    ]
  };
  const buckets = summarizeBatchErrors(summary);
  assert.strictEqual(buckets['file-rejected'].length, 1);
  assert.strictEqual(buckets['file-rejected'][0].hoster, 'byse.sx');
  assert.strictEqual(buckets['hoster-transient'].length, 1);
  assert.strictEqual(buckets['hoster-transient'][0].hoster, 'voe.sx');
  assert.strictEqual(buckets['network'].length, 1);
  assert.strictEqual(buckets['network'][0].hoster, 'doodstream.com');
  assert.strictEqual(buckets['account-error'].length, 0);
});

test('summarizeBatchErrors excludes skipped results from error and retry buckets', () => {
  const buckets = summarizeBatchErrors({
    files: [{ name: 'a.mp4', results: [{ hoster: 'voe.sx', status: 'skipped', error: 'Kein gültiger Account' }] }]
  });
  assert.strictEqual(Object.values(buckets).flat().length, 0);
});

test('mergeSkippedIntoSummary adds skipped jobs to totals and history files', () => {
  const summary = {
    id: 'batch-1',
    timestamp: '2026-08-11T12:00:00.000Z',
    total: 1,
    succeeded: 1,
    failed: 0,
    skipped: 0,
    files: [{ name: 'ok.mp4', size: 5, results: [{ jobId: 'ok', hoster: 'voe.sx', status: 'done' }] }]
  };
  const merged = mergeSkippedIntoSummary(summary, [{
    jobId: 'skip',
    file: 'C:\\incoming\\skip.mp4',
    fileName: 'skip.mp4',
    hoster: 'byse.sx',
    reason: 'Kein gültiger Account'
  }]);
  assert.strictEqual(merged.total, 2);
  assert.strictEqual(merged.succeeded, 1);
  assert.strictEqual(merged.failed, 0);
  assert.strictEqual(merged.skipped, 1);
  assert.deepStrictEqual(merged.files[1], {
    name: 'skip.mp4',
    size: 0,
    results: [{ jobId: 'skip', hoster: 'byse.sx', status: 'skipped', error: 'Kein gültiger Account' }]
  });
});

test('isRetryableCategory: only transient + network + unknown retry-worthy', () => {
  assert.strictEqual(isRetryableCategory('hoster-transient'), true);
  assert.strictEqual(isRetryableCategory('network'), true);
  assert.strictEqual(isRetryableCategory('unknown'), true);
  assert.strictEqual(isRetryableCategory('file-rejected'), false);
  assert.strictEqual(isRetryableCategory('account-error'), false);
  assert.strictEqual(isRetryableCategory('aborted'), false);
});
