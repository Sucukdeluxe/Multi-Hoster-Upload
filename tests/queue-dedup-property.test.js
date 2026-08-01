const { test } = require('node:test');
const assert = require('node:assert');
const { partitionRestoredJobsByLog } = require('../lib/queue-dedup');

function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

function key(f, h) { return `${String(f).toLowerCase()}|${String(h).toLowerCase()}`; }

test('property: removed iff (done && key in log) OR (savedAt finite && key unambiguous && newest matching log ts >= floor(savedAt/1000)*1000)', () => {
  const rnd = lcg(0x9e3779b1);
  const statuses = ['preview', 'done', 'error', 'aborted', 'queued', 'skipped'];
  const hosters = ['voe.sx', 'byse.sx', 'doodstream.com'];
  const names = ['a.mkv', 'b.mp4', 'A.MKV', 'c.mov'];
  const folders = ['C:/A/', 'C:/B/', 'D:/down/'];
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

  for (let iter = 0; iter < 3000; iter++) {
    const useSavedAt = rnd() < 0.7;
    const savedAt = useSavedAt ? Math.floor(rnd() * 2_000_000_000_000) : undefined;

    const jobs = [];
    const nJobs = 1 + Math.floor(rnd() * 6);
    for (let i = 0; i < nJobs; i++) {
      const name = pick(names);
      // Mix shared and distinct paths so ambiguous keys (same name+hoster,
      // different folder) actually occur and exercise the guard.
      jobs.push({ id: `j${i}`, fileName: name, hoster: pick(hosters), status: pick(statuses), file: `${pick(folders)}${name}` });
    }

    const log = [];
    const nLog = Math.floor(rnd() * 5);
    for (let i = 0; i < nLog; i++) {
      const hasTs = rnd() < 0.8;
      log.push({ fileName: pick(names), hoster: pick(hosters), ts: hasTs ? Math.floor(rnd() * 2_000_000_000_000) : undefined });
    }

    const logKeys = new Set();
    const maxTs = new Map();
    for (const e of log) {
      const k = key(e.fileName, e.hoster);
      logKeys.add(k);
      if (typeof e.ts === 'number' && isFinite(e.ts)) {
        const prev = maxTs.get(k);
        if (prev === undefined || e.ts > prev) maxTs.set(k, e.ts);
      }
    }
    const filesPerKey = new Map();
    for (const job of jobs) {
      const k = key(job.fileName, job.hoster);
      if (!filesPerKey.has(k)) filesPerKey.set(k, new Set());
      filesPerKey.get(k).add(job.file || '');
    }
    const floor = (typeof savedAt === 'number' && isFinite(savedAt)) ? Math.floor(savedAt / 1000) * 1000 : null;

    const { kept, removed } = partitionRestoredJobsByLog(jobs, log, savedAt);

    assert.equal(kept.length + removed.length, jobs.length, `iter ${iter}: partition must cover every job exactly once`);
    const keptIds = new Set(kept.map(j => j.id));
    const removedIds = new Set(removed.map(j => j.id));
    assert.equal(keptIds.size + removedIds.size, jobs.length, `iter ${iter}: no job in both partitions`);

    for (const job of jobs) {
      const k = key(job.fileName, job.hoster);
      const doneInLog = job.status === 'done' && logKeys.has(k);
      const unambiguous = filesPerKey.get(k).size <= 1;
      const afterSnap = floor !== null && unambiguous && maxTs.has(k) && maxTs.get(k) >= floor;
      const shouldRemove = doneInLog || afterSnap;
      assert.equal(removedIds.has(job.id), shouldRemove,
        `iter ${iter}: job ${job.id} (status=${job.status} key=${k} unambig=${unambiguous}) expected removed=${shouldRemove}`);
    }
  }
});

test('property: a genuinely-pending job is NEVER lost to a same-basename sibling completing after the snapshot', () => {
  const rnd = lcg(0x1234abcd);
  for (let iter = 0; iter < 500; iter++) {
    const savedAt = 1_000_000_000_000 + Math.floor(rnd() * 1_000_000);
    // X completed after the snapshot (logged); Y is a DIFFERENT file, same
    // basename + hoster, genuinely pending. Y must survive.
    const jobs = [
      { id: 'X', fileName: 'clip.mp4', hoster: 'voe.sx', status: 'preview', file: 'C:/A/clip.mp4' },
      { id: 'Y', fileName: 'clip.mp4', hoster: 'voe.sx', status: 'preview', file: 'C:/B/clip.mp4' }
    ];
    const log = [{ fileName: 'clip.mp4', hoster: 'voe.sx', ts: savedAt + 1000 + Math.floor(rnd() * 1000) }];
    const { kept } = partitionRestoredJobsByLog(jobs, log, savedAt);
    assert.ok(kept.some(j => j.id === 'Y'), `iter ${iter}: pending Y must never be silently dropped`);
  }
});

test('property: 2-arg legacy call NEVER removes a non-done job (the v3.3.80 canary, fuzzed)', () => {
  const rnd = lcg(0xdeadbeef);
  const statuses = ['preview', 'error', 'aborted', 'queued', 'skipped'];
  const hosters = ['voe.sx', 'byse.sx'];
  const names = ['a.mkv', 'b.mp4'];
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

  for (let iter = 0; iter < 1000; iter++) {
    const jobs = [];
    const nJobs = 1 + Math.floor(rnd() * 5);
    for (let i = 0; i < nJobs; i++) {
      jobs.push({ id: `j${i}`, fileName: pick(names), hoster: pick(hosters), status: pick(statuses), file: `C:/x/${i}` });
    }
    const log = [];
    const nLog = Math.floor(rnd() * 4);
    for (let i = 0; i < nLog; i++) {
      log.push({ fileName: pick(names), hoster: pick(hosters), ts: Math.floor(rnd() * 2_000_000_000_000) });
    }
    const { removed } = partitionRestoredJobsByLog(jobs, log);
    assert.ok(removed.every(j => j.status === 'done'), `iter ${iter}: legacy 2-arg call must never drop a non-done job`);
  }
});
