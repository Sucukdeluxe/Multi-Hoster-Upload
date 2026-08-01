const { test } = require('node:test');
const assert = require('node:assert/strict');

const { pruneOldestTerminalJobs, TERMINAL_STATUSES } = require('../lib/queue-prune');

const j = (id, status) => ({ id, status });

test('returns null on empty / non-array input', () => {
  assert.equal(pruneOldestTerminalJobs([], 5), null);
  assert.equal(pruneOldestTerminalJobs(null, 5), null);
  assert.equal(pruneOldestTerminalJobs(undefined, 5), null);
});

test('returns null when all jobs are non-terminal regardless of limit', () => {
  const jobs = [j('a', 'queued'), j('b', 'uploading'), j('c', 'preview')];
  assert.equal(pruneOldestTerminalJobs(jobs, 0), null);
  assert.equal(pruneOldestTerminalJobs(jobs, 100), null);
});

test('returns null when terminal count is at or under the limit', () => {
  const jobs = [j('a', 'done'), j('b', 'done'), j('c', 'queued')];
  assert.equal(pruneOldestTerminalJobs(jobs, 2), null, 'terminal=2, limit=2 → no-op');
  assert.equal(pruneOldestTerminalJobs(jobs, 3), null, 'terminal=2, limit=3 → no-op');
});

test('drops oldest terminal jobs when over the limit, keeps non-terminal', () => {
  const jobs = [
    j('t1', 'done'),     // oldest terminal — should be dropped
    j('t2', 'done'),     // should be dropped
    j('queued1', 'queued'),
    j('t3', 'error'),    // newest of the dropped block
    j('uploading1', 'uploading'),
    j('t4', 'done'),     // kept (within limit window)
    j('t5', 'skipped'),  // kept
    j('t6', 'aborted'),  // kept
  ];
  // 6 terminal, limit 3 → drop 3 oldest (t1, t2, t3)
  const result = pruneOldestTerminalJobs(jobs, 3);
  assert.notEqual(result, null);
  const droppedIds = result.dropped.map(x => x.id).sort();
  assert.deepEqual(droppedIds, ['t1', 't2', 't3']);
  // Non-terminal jobs always kept; surviving terminals are the newest 3
  const keptIds = result.kept.map(x => x.id);
  assert.deepEqual(keptIds, ['queued1', 'uploading1', 't4', 't5', 't6']);
});

test('respects insertion order (oldest by index, not by status)', () => {
  const jobs = [
    j('older-error', 'error'),
    j('newer-done', 'done'),
    j('newest-aborted', 'aborted'),
  ];
  const result = pruneOldestTerminalJobs(jobs, 1);
  assert.deepEqual(result.dropped.map(x => x.id), ['older-error', 'newer-done']);
  assert.deepEqual(result.kept.map(x => x.id), ['newest-aborted']);
});

test('drops everything terminal when limit is 0', () => {
  const jobs = [
    j('q', 'queued'),
    j('d1', 'done'),
    j('d2', 'done'),
    j('e1', 'error'),
  ];
  const result = pruneOldestTerminalJobs(jobs, 0);
  assert.deepEqual(result.dropped.map(x => x.id), ['d1', 'd2', 'e1']);
  assert.deepEqual(result.kept.map(x => x.id), ['q']);
});

test('rejects negative or non-finite limits', () => {
  const jobs = [j('a', 'done'), j('b', 'done')];
  assert.equal(pruneOldestTerminalJobs(jobs, -1), null);
  assert.equal(pruneOldestTerminalJobs(jobs, NaN), null);
  assert.equal(pruneOldestTerminalJobs(jobs, Infinity), null,
    'Infinity is technically not finite; safer to treat as no-op');
});

test('TERMINAL_STATUSES set covers all 4 terminal kinds', () => {
  assert.ok(TERMINAL_STATUSES.has('done'));
  assert.ok(TERMINAL_STATUSES.has('skipped'));
  assert.ok(TERMINAL_STATUSES.has('error'));
  assert.ok(TERMINAL_STATUSES.has('aborted'));
  assert.equal(TERMINAL_STATUSES.size, 4);
  // Non-terminal must not be in the set
  for (const s of ['queued', 'preview', 'uploading', 'retrying', 'getting-server']) {
    assert.equal(TERMINAL_STATUSES.has(s), false, `${s} must not be terminal`);
  }
});

test('handles malformed entries (null / missing status) without throwing', () => {
  const jobs = [
    null,
    j('a', 'done'),
    { id: 'no-status' }, // no status
    j('b', 'done'),
  ];
  // 2 terminal, limit 1 → drop oldest (a). null and no-status entries stay
  // because they aren't terminal. The function must not throw on them.
  const result = pruneOldestTerminalJobs(jobs, 1);
  assert.notEqual(result, null);
  assert.deepEqual(result.dropped.map(x => x && x.id), ['a']);
  assert.equal(result.kept.length, 3);
});

test('large queue: keeps the newest `limit` terminals', () => {
  const jobs = [];
  for (let i = 0; i < 5000; i++) jobs.push(j(`done-${i}`, 'done'));
  const result = pruneOldestTerminalJobs(jobs, 500);
  assert.notEqual(result, null);
  assert.equal(result.dropped.length, 4500);
  assert.equal(result.kept.length, 500);
  // First kept = done-4500 (the 4501st original entry)
  assert.equal(result.kept[0].id, 'done-4500');
  assert.equal(result.kept[result.kept.length - 1].id, 'done-4999');
});
