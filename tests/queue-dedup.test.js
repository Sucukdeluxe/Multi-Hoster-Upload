const { test } = require('node:test');
const assert = require('node:assert');
const { partitionRestoredJobsByLog, completedSelectionKeys } = require('../lib/queue-dedup');

function job(status, fileName, hoster) {
  return { status, fileName, hoster, file: `C:/dl/${fileName}` };
}

test('regression: pending preview jobs are NEVER dropped, even when all match the log', () => {
  // Exact shape of the reproduced bug: 4 preview jobs for one file across 4
  // hosters, every fileName|hoster present in the lifetime upload log.
  const jobs = [
    job('preview', 'Einfach mal die Fresse halten!!!.mp4', 'doodstream.com'),
    job('preview', 'Einfach mal die Fresse halten!!!.mp4', 'voe.sx'),
    job('preview', 'Einfach mal die Fresse halten!!!.mp4', 'vidmoly.me'),
    job('preview', 'Einfach mal die Fresse halten!!!.mp4', 'byse.sx')
  ];
  const log = [
    { fileName: 'Einfach mal die Fresse halten!!!.mp4', hoster: 'doodstream.com' },
    { fileName: 'Einfach mal die Fresse halten!!!.mp4', hoster: 'voe.sx' },
    { fileName: 'Einfach mal die Fresse halten!!!.mp4', hoster: 'vidmoly.me' },
    { fileName: 'Einfach mal die Fresse halten!!!.mp4', hoster: 'byse.sx' }
  ];
  const { kept, removed } = partitionRestoredJobsByLog(jobs, log);
  assert.equal(removed.length, 0, 'no pending job may be removed');
  assert.equal(kept.length, 4, 'all 4 pending jobs survive restart/update');
});

test('done jobs in the log are dropped (declutter); pending/error/aborted kept', () => {
  const jobs = [
    job('done', 'a.mkv', 'doodstream.com'),
    job('preview', 'a.mkv', 'voe.sx'),
    job('error', 'b.mkv', 'doodstream.com'),
    job('aborted', 'c.mkv', 'doodstream.com')
  ];
  const log = [
    { fileName: 'a.mkv', hoster: 'doodstream.com' },
    { fileName: 'a.mkv', hoster: 'voe.sx' },
    { fileName: 'b.mkv', hoster: 'doodstream.com' },
    { fileName: 'c.mkv', hoster: 'doodstream.com' }
  ];
  const { kept, removed } = partitionRestoredJobsByLog(jobs, log);
  assert.equal(removed.length, 1);
  assert.equal(removed[0].status, 'done');
  assert.equal(removed[0].hoster, 'doodstream.com');
  // The preview a.mkv|voe.sx, error b.mkv, aborted c.mkv all survive.
  assert.equal(kept.length, 3);
  assert.ok(kept.some(j => j.status === 'preview' && j.hoster === 'voe.sx'));
  assert.ok(kept.some(j => j.status === 'error'));
  assert.ok(kept.some(j => j.status === 'aborted'));
});

test('done job NOT in the log is kept (e.g. hoster had logToFile disabled)', () => {
  const jobs = [job('done', 'd.mkv', 'doodstream.com')];
  const { kept, removed } = partitionRestoredJobsByLog(jobs, []);
  assert.equal(removed.length, 0);
  assert.equal(kept.length, 1);
});

test('case-insensitive match on fileName and hoster', () => {
  const jobs = [job('done', 'Movie.MKV', 'DoodStream.com')];
  const log = [{ fileName: 'movie.mkv', hoster: 'doodstream.com' }];
  const { removed } = partitionRestoredJobsByLog(jobs, log);
  assert.equal(removed.length, 1);
});

test('empty/missing inputs do not throw', () => {
  assert.deepEqual(partitionRestoredJobsByLog([], []), { kept: [], removed: [] });
  assert.deepEqual(partitionRestoredJobsByLog(null, null), { kept: [], removed: [] });
  const jobs = [job('done', 'x.mkv', 'voe.sx')];
  assert.equal(partitionRestoredJobsByLog(jobs, undefined).kept.length, 1);
});

const T = (s) => Date.parse(s.replace(' ', 'T'));

test('history fallback keeps a serialized successful terminal result through log deduplication', () => {
  const result = {
    download_url: 'https://voe.sx/e/exact-link',
    embed_url: 'https://voe.sx/e/exact-embed',
    file_code: 'exact-code'
  };
  const restored = JSON.parse(JSON.stringify({
    savedAt: T('2026-08-13 12:00:00'),
    queueJobs: [{
      id: 'history-fallback-done',
      file: 'C:/dl/episode.mkv',
      fileName: 'episode.mkv',
      hoster: 'voe.sx',
      status: 'done',
      result
    }]
  }));
  const log = [{ fileName: 'episode.mkv', hoster: 'voe.sx', ts: T('2026-08-13 12:00:05') }];

  const { kept, removed } = partitionRestoredJobsByLog(restored.queueJobs, log, restored.savedAt);

  assert.deepEqual(removed, []);
  assert.deepEqual(kept, restored.queueJobs);
  assert.deepEqual(kept[0].result, result);
});

test('ts-gate: preview job uploaded AFTER the snapshot is dropped (the ghost bug)', () => {
  const jobs = [job('preview', 'a.mkv', 'voe.sx')];
  const log = [{ fileName: 'a.mkv', hoster: 'voe.sx', ts: T('2026-06-19 12:00:05') }];
  const savedAt = T('2026-06-19 12:00:00');
  const { kept, removed } = partitionRestoredJobsByLog(jobs, log, savedAt);
  assert.equal(removed.length, 1, 'completed-after-snapshot preview is a ghost → drop');
  assert.equal(kept.length, 0);
});

test('ts-gate: preview job whose only log entry PREDATES the snapshot is kept (intentional re-upload)', () => {
  const jobs = [job('preview', 'a.mkv', 'voe.sx')];
  const log = [{ fileName: 'a.mkv', hoster: 'voe.sx', ts: T('2026-06-19 11:00:00') }];
  const savedAt = T('2026-06-19 12:00:00');
  const { kept, removed } = partitionRestoredJobsByLog(jobs, log, savedAt);
  assert.equal(removed.length, 0, 'old upload + freshly-queued re-upload must survive');
  assert.equal(kept.length, 1);
});

test('ts-gate: same-second completion is dropped (savedAt floored to the second)', () => {
  const jobs = [job('preview', 'a.mkv', 'voe.sx')];
  const log = [{ fileName: 'a.mkv', hoster: 'voe.sx', ts: T('2026-06-19 12:00:00') }];
  const savedAt = T('2026-06-19 12:00:00') + 800;
  const { removed } = partitionRestoredJobsByLog(jobs, log, savedAt);
  assert.equal(removed.length, 1, 'log second-granularity must not let same-second ghosts slip through');
});

test('ts-gate: uses the MAX log ts per key (re-upload after a stale earlier entry)', () => {
  const jobs = [job('preview', 'a.mkv', 'voe.sx')];
  const log = [
    { fileName: 'a.mkv', hoster: 'voe.sx', ts: T('2026-06-19 11:00:00') },
    { fileName: 'a.mkv', hoster: 'voe.sx', ts: T('2026-06-19 12:00:05') }
  ];
  const savedAt = T('2026-06-19 12:00:00');
  const { removed } = partitionRestoredJobsByLog(jobs, log, savedAt);
  assert.equal(removed.length, 1, 'newest matching log entry decides');
});

test('ts-gate inactive without savedAt → legacy behavior (preview kept even if ts newer)', () => {
  const jobs = [job('preview', 'a.mkv', 'voe.sx')];
  const log = [{ fileName: 'a.mkv', hoster: 'voe.sx', ts: T('2026-06-19 12:00:05') }];
  const { kept, removed } = partitionRestoredJobsByLog(jobs, log);
  assert.equal(removed.length, 0);
  assert.equal(kept.length, 1);
});

test('ts-gate inactive when log entry lacks ts → legacy behavior', () => {
  const jobs = [job('preview', 'a.mkv', 'voe.sx')];
  const log = [{ fileName: 'a.mkv', hoster: 'voe.sx' }];
  const savedAt = T('2026-06-19 12:00:00');
  const { kept, removed } = partitionRestoredJobsByLog(jobs, log, savedAt);
  assert.equal(removed.length, 0);
  assert.equal(kept.length, 1);
});

test('ts-gate: done job uploaded after snapshot is dropped via either rule', () => {
  const jobs = [job('done', 'a.mkv', 'voe.sx')];
  const log = [{ fileName: 'a.mkv', hoster: 'voe.sx', ts: T('2026-06-19 12:00:05') }];
  const savedAt = T('2026-06-19 12:00:00');
  const { removed } = partitionRestoredJobsByLog(jobs, log, savedAt);
  assert.equal(removed.length, 1);
});

test('ts-gate ambiguity guard: a pending same-basename file in a DIFFERENT folder is NOT lost when a sibling completes after the snapshot', () => {
  // X (C:/A/clip.mp4) was uploaded after the snapshot and logged. Y is a
  // genuinely-different file (C:/B/clip.mp4), same basename + hoster, still
  // pending. The log records only basenames, so the ts-rule must not drop Y.
  const jobs = [
    { status: 'preview', fileName: 'clip.mp4', hoster: 'voe.sx', file: 'C:/A/clip.mp4' },
    { status: 'preview', fileName: 'clip.mp4', hoster: 'voe.sx', file: 'C:/B/clip.mp4' }
  ];
  const savedAt = T('2026-06-19 12:00:00');
  const log = [{ fileName: 'clip.mp4', hoster: 'voe.sx', ts: T('2026-06-19 12:00:05') }];
  const { kept, removed } = partitionRestoredJobsByLog(jobs, log, savedAt);
  assert.equal(removed.length, 0, 'ambiguous key -> ts-rule suppressed, no pending file lost');
  assert.equal(kept.length, 2);
});

test('ts-gate ambiguity guard: the done-in-log rule still applies on an ambiguous key', () => {
  // Even when the key is ambiguous, a job that is actually 'done' and in the log
  // is still decluttered (pre-existing rule, unchanged by the guard).
  const jobs = [
    { status: 'done', fileName: 'clip.mp4', hoster: 'voe.sx', file: 'C:/A/clip.mp4' },
    { status: 'preview', fileName: 'clip.mp4', hoster: 'voe.sx', file: 'C:/B/clip.mp4' }
  ];
  const log = [{ fileName: 'clip.mp4', hoster: 'voe.sx', ts: T('2026-06-19 12:00:05') }];
  const savedAt = T('2026-06-19 12:00:00');
  const { kept, removed } = partitionRestoredJobsByLog(jobs, log, savedAt);
  assert.equal(removed.length, 1);
  assert.equal(removed[0].status, 'done');
  assert.equal(removed[0].file, 'C:/A/clip.mp4');
  assert.ok(kept.some(j => j.file === 'C:/B/clip.mp4'), 'the distinct pending file survives');
});

test('ts-gate: a unique-path ghost still drops (guard does not weaken the common case)', () => {
  const jobs = [{ status: 'preview', fileName: 'clip.mp4', hoster: 'voe.sx', file: 'C:/A/clip.mp4' }];
  const log = [{ fileName: 'clip.mp4', hoster: 'voe.sx', ts: T('2026-06-19 12:00:05') }];
  const savedAt = T('2026-06-19 12:00:00');
  const { removed } = partitionRestoredJobsByLog(jobs, log, savedAt);
  assert.equal(removed.length, 1, 'single job for the key -> unambiguous -> ghost dropped as before');
});

test('ts-gate: multi-hoster partial completion — the reported bug shape (drop only the completed hosters)', () => {
  // One file queued to 4 hosters; close mid-upload. After the snapshot, 2 hosters
  // completed (logged), 2 never started. On restart all 4 restore as 'preview'.
  // Must drop EXACTLY the 2 that completed and keep the 2 still-pending. This also
  // pins per-hoster keying: a fileName-only gate would wrongly drop all 4.
  const f = 'Einfach mal die Fresse halten!!!.mp4';
  const jobs = [
    job('preview', f, 'doodstream.com'),
    job('preview', f, 'voe.sx'),
    job('preview', f, 'vidmoly.me'),
    job('preview', f, 'byse.sx')
  ];
  const savedAt = T('2026-06-19 12:00:00');
  const log = [
    { fileName: f, hoster: 'doodstream.com', ts: T('2026-06-19 12:00:08') },
    { fileName: f, hoster: 'voe.sx', ts: T('2026-06-19 12:00:11') }
  ];
  const { kept, removed } = partitionRestoredJobsByLog(jobs, log, savedAt);
  assert.equal(removed.length, 2, 'only the 2 completed-after-snapshot hosters drop');
  assert.ok(removed.every(j => j.hoster === 'doodstream.com' || j.hoster === 'voe.sx'));
  assert.equal(kept.length, 2, 'the 2 never-started hosters survive');
  assert.ok(kept.some(j => j.hoster === 'vidmoly.me'));
  assert.ok(kept.some(j => j.hoster === 'byse.sx'));
});

test('completedSelectionKeys: a selectedFile that completed after the snapshot yields its full-path|hoster key', () => {
  const selectedFiles = [{ path: 'C:/dl/done.mp4', name: 'done.mp4' }, { path: 'C:/dl/pending.mp4', name: 'pending.mp4' }];
  const hosters = ['voe.sx'];
  const savedAt = T('2026-06-19 12:00:00');
  const log = [{ fileName: 'done.mp4', hoster: 'voe.sx', ts: T('2026-06-19 12:00:05') }];
  const keys = completedSelectionKeys(selectedFiles, hosters, log, savedAt);
  assert.deepEqual(keys, ['C:/dl/done.mp4|voe.sx'], 'only the completed file is seeded; pending is not');
});

test('completedSelectionKeys: per-hoster — a file done on voe but not byse only seeds the voe key', () => {
  const selectedFiles = [{ path: 'C:/dl/a.mp4', name: 'a.mp4' }];
  const hosters = ['voe.sx', 'byse.sx'];
  const savedAt = T('2026-06-19 12:00:00');
  const log = [{ fileName: 'a.mp4', hoster: 'voe.sx', ts: T('2026-06-19 12:00:05') }];
  const keys = completedSelectionKeys(selectedFiles, hosters, log, savedAt);
  assert.deepEqual(keys, ['C:/dl/a.mp4|voe.sx'], 'the still-pending byse upload is NOT seeded');
});

test('completedSelectionKeys: ambiguous basename across folders seeds NOTHING (no lost re-preview)', () => {
  const selectedFiles = [{ path: 'C:/A/clip.mp4', name: 'clip.mp4' }, { path: 'C:/B/clip.mp4', name: 'clip.mp4' }];
  const hosters = ['voe.sx'];
  const savedAt = T('2026-06-19 12:00:00');
  const log = [{ fileName: 'clip.mp4', hoster: 'voe.sx', ts: T('2026-06-19 12:00:05') }];
  const keys = completedSelectionKeys(selectedFiles, hosters, log, savedAt);
  assert.deepEqual(keys, [], 'ambiguous -> neither path is suppressed, both re-preview (safe direction)');
});

test('completedSelectionKeys: an OLDER completion (pre-snapshot re-queue) is NOT seeded', () => {
  const selectedFiles = [{ path: 'C:/dl/reup.mp4', name: 'reup.mp4' }];
  const hosters = ['voe.sx'];
  const savedAt = T('2026-06-19 12:00:00');
  const log = [{ fileName: 'reup.mp4', hoster: 'voe.sx', ts: T('2026-06-19 11:00:00') }];
  assert.deepEqual(completedSelectionKeys(selectedFiles, hosters, log, savedAt), []);
});

test('completedSelectionKeys: no savedAt / junk inputs -> empty (legacy + robustness)', () => {
  const sf = [{ path: 'C:/dl/a.mp4', name: 'a.mp4' }];
  const log = [{ fileName: 'a.mp4', hoster: 'voe.sx', ts: T('2026-06-19 12:00:05') }];
  assert.deepEqual(completedSelectionKeys(sf, ['voe.sx'], log, undefined), []);
  assert.deepEqual(completedSelectionKeys(null, ['voe.sx'], log, 1), []);
  assert.deepEqual(completedSelectionKeys(sf, null, log, 1), []);
  assert.deepEqual(completedSelectionKeys([], [], log, 1), []);
  assert.deepEqual(completedSelectionKeys([{ name: 'x' }], ['voe.sx'], log, 1), [], 'entry without path is skipped');
});

test('completedSelectionKeys: derives basename from path when name is missing', () => {
  const selectedFiles = [{ path: 'C:/dl/sub/movie.mp4' }];
  const hosters = ['voe.sx'];
  const savedAt = T('2026-06-19 12:00:00');
  const log = [{ fileName: 'movie.mp4', hoster: 'voe.sx', ts: T('2026-06-19 12:00:05') }];
  assert.deepEqual(completedSelectionKeys(selectedFiles, hosters, log, savedAt), ['C:/dl/sub/movie.mp4|voe.sx']);
});
