const { test } = require('node:test');
const assert = require('node:assert');
const { formatUploadLogLine, parseUploadLogLine } = require('../lib/upload-log');
const { partitionRestoredJobsByLog } = require('../lib/queue-dedup');

function makeJobs(n, hoster, status, offset = 0) {
  const jobs = [];
  for (let i = 0; i < n; i++) {
    const fileName = `clip_${String(i + offset).padStart(4, '0')}.mp4`;
    jobs.push({ id: `j-${hoster}-${i + offset}`, file: `D:/inbox/${fileName}`, fileName, hoster, status });
  }
  return jobs;
}

test('user report: 300 queued, ~200 finished mid-session before a hard kill — only the finished drop', () => {
  const hoster = 'byse.sx';
  const snapshot = new Date(2026, 5, 19, 22, 0, 0);
  const savedAt = snapshot.getTime();
  const restoredJobs = makeJobs(300, hoster, 'preview');

  const completionBase = new Date(2026, 5, 19, 22, 5, 0).getTime();
  const logEntries = [];
  for (let i = 0; i < 200; i++) {
    const d = new Date(completionBase + i * 1000);
    logEntries.push(parseUploadLogLine(
      formatUploadLogLine(d, hoster, `https://byse.sx/d/x${i}`, `clip_${String(i).padStart(4, '0')}.mp4`)
    ));
  }

  const { kept, removed } = partitionRestoredJobsByLog(restoredJobs, logEntries, savedAt);
  assert.equal(removed.length, 200, 'the 200 completed-after-snapshot files are dropped as ghosts');
  assert.equal(kept.length, 100, 'the 100 never-finished files stay queued');
  assert.ok(kept.every(j => Number(j.fileName.slice(5, 9)) >= 200), 'kept are exactly indices 200..299');
  const keptNames = new Set(kept.map(j => j.fileName));
  assert.ok(removed.every(j => !keptNames.has(j.fileName)));
});

test('multi-hoster batch: per-hoster completion is independent (a file done on voe but not byse keeps byse)', () => {
  const savedAt = new Date(2026, 5, 19, 22, 0, 0).getTime();
  const done = new Date(2026, 5, 19, 22, 3, 0);
  const jobs = [
    ...makeJobs(3, 'voe.sx', 'preview'),
    ...makeJobs(3, 'byse.sx', 'preview')
  ];
  const logEntries = [
    parseUploadLogLine(formatUploadLogLine(done, 'voe.sx', 'l', 'clip_0000.mp4')),
    parseUploadLogLine(formatUploadLogLine(done, 'voe.sx', 'l', 'clip_0001.mp4')),
    parseUploadLogLine(formatUploadLogLine(done, 'byse.sx', 'l', 'clip_0000.mp4'))
  ];
  const { kept, removed } = partitionRestoredJobsByLog(jobs, logEntries, savedAt);
  assert.equal(removed.length, 3);
  assert.ok(removed.some(j => j.hoster === 'voe.sx' && j.fileName === 'clip_0000.mp4'));
  assert.ok(removed.some(j => j.hoster === 'voe.sx' && j.fileName === 'clip_0001.mp4'));
  assert.ok(removed.some(j => j.hoster === 'byse.sx' && j.fileName === 'clip_0000.mp4'));
  assert.ok(kept.some(j => j.hoster === 'byse.sx' && j.fileName === 'clip_0001.mp4'), 'byse clip_0001 not logged -> kept');
});

test('clean idle close (snapshot AFTER completion) keeps an intentional re-queue of an old file', () => {
  const hoster = 'voe.sx';
  const yesterday = new Date(2026, 5, 18, 12, 0, 0);
  const logEntries = [parseUploadLogLine(formatUploadLogLine(yesterday, hoster, 'link', 'reupload_me.mp4'))];
  const savedAt = new Date(2026, 5, 19, 9, 0, 0).getTime();
  const jobs = [{ id: 'r1', file: 'D:/x/reupload_me.mp4', fileName: 'reupload_me.mp4', hoster, status: 'preview' }];
  const { kept, removed } = partitionRestoredJobsByLog(jobs, logEntries, savedAt);
  assert.equal(removed.length, 0, 'an upload older than the snapshot is a deliberate re-queue and survives');
  assert.equal(kept.length, 1);
});

test('legacy snapshot without savedAt (pre-v3.3.80 config) falls back to done-only dedup', () => {
  const hoster = 'voe.sx';
  const logEntries = [
    parseUploadLogLine(formatUploadLogLine(new Date(2026, 5, 19, 12, 0, 0), hoster, 'l', 'done.mp4')),
    parseUploadLogLine(formatUploadLogLine(new Date(2026, 5, 19, 12, 1, 0), hoster, 'l', 'preview.mp4'))
  ];
  const jobs = [
    { id: 'a', file: 'D:/x/done.mp4', fileName: 'done.mp4', hoster, status: 'done' },
    { id: 'b', file: 'D:/x/preview.mp4', fileName: 'preview.mp4', hoster, status: 'preview' }
  ];
  const { kept, removed } = partitionRestoredJobsByLog(jobs, logEntries);
  assert.equal(removed.length, 1, 'only the done job is decluttered when no savedAt is available');
  assert.equal(removed[0].id, 'a');
  assert.ok(kept.some(j => j.id === 'b'), 'the preview survives the legacy path');
});
