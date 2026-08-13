const { test } = require('node:test');
const assert = require('node:assert');
const {
  formatUploadLogLine,
  parseUploadLogLine,
  summarizeBatchPlan,
  formatUploadPlanLogLine
} = require('../lib/upload-log');
const { partitionRestoredJobsByLog } = require('../lib/queue-dedup');

function previewJob(fileName, hoster) {
  return { status: 'preview', fileName, hoster, file: `C:/dl/${fileName}` };
}

test('writer -> reader round trip: parsed ts is the same epoch frame as the source Date getTime', () => {
  const d = new Date(2026, 5, 19, 12, 0, 30);
  const line = formatUploadLogLine(d, 'voe.sx', 'https://voe.sx/x', 'a.mkv');
  const parsed = parseUploadLogLine(line);
  assert.equal(parsed.hoster, 'voe.sx');
  assert.equal(parsed.fileName, 'a.mkv');
  assert.equal(parsed.ts, d.getTime(), 'parser ts must equal the writer Date epoch (no tz shift)');
});

test('batch plan records unique sources, destinations, and requested upload count without file paths', () => {
  const jobs = [];
  for (const file of ['C:/private/a.mkv', 'C:/private/b.mkv', 'C:/private/c.mkv']) {
    for (const hoster of ['doodstream.com', 'voe.sx', 'vidmoly.me', 'byse.sx']) {
      jobs.push({ file, hoster });
    }
  }

  const plan = summarizeBatchPlan({ jobs });
  const line = formatUploadPlanLogLine(new Date('2026-08-13T12:00:00.000Z'), plan, 'start');

  assert.deepEqual(plan, {
    fileCount: 3,
    destinationCount: 4,
    plannedUploadCount: 12
  });
  assert.equal(line.startsWith('# UPLOAD-PLAN '), true);
  assert.equal(line.includes('C:/private'), false);
  assert.equal(line.includes('a.mkv'), false);
  assert.equal(line.includes('doodstream.com'), false);
  assert.deepEqual(JSON.parse(line.slice('# UPLOAD-PLAN '.length)), {
    timestamp: '2026-08-13T12:00:00.000Z',
    mode: 'start',
    fileCount: 3,
    destinationCount: 4,
    plannedUploadCount: 12
  });
  assert.equal(parseUploadLogLine(line), null);
});

test('batch plan supports the legacy files and hosters payload', () => {
  assert.deepEqual(summarizeBatchPlan({
    files: ['C:/private/a.mkv', 'C:/private/b.mkv'],
    hosters: ['voe.sx', 'doodstream.com']
  }), {
    fileCount: 2,
    destinationCount: 2,
    plannedUploadCount: 4
  });
});

test('batch plan preserves a sparse requested job count instead of multiplying dimensions', () => {
  assert.deepEqual(summarizeBatchPlan({ jobs: [
    { file: 'C:/private/a.mkv', hoster: 'voe.sx' },
    { file: 'C:/private/a.mkv', hoster: 'byse.sx' },
    { file: 'C:/private/b.mkv', hoster: 'voe.sx' }
  ] }), {
    fileCount: 2,
    destinationCount: 2,
    plannedUploadCount: 3
  });
});

test('SEAM: a real appendUploadLog-format line drops a preview ghost vs a savedAt taken BEFORE completion', () => {
  const completion = new Date(2026, 5, 19, 12, 0, 30);
  const line = formatUploadLogLine(completion, 'voe.sx', 'link', 'a.mkv');
  const parsed = parseUploadLogLine(line);
  const savedAt = completion.getTime() - 5000;
  const { removed, kept } = partitionRestoredJobsByLog([previewJob('a.mkv', 'voe.sx')], [parsed], savedAt);
  assert.equal(removed.length, 1, 'a file logged after the snapshot is a ghost and must drop');
  assert.equal(kept.length, 0);
});

test('SEAM: the same real line is KEPT vs a savedAt taken AFTER completion (intentional re-upload)', () => {
  const completion = new Date(2026, 5, 19, 12, 0, 30);
  const parsed = parseUploadLogLine(formatUploadLogLine(completion, 'voe.sx', 'link', 'a.mkv'));
  const savedAt = completion.getTime() + 5000;
  const { removed, kept } = partitionRestoredJobsByLog([previewJob('a.mkv', 'voe.sx')], [parsed], savedAt);
  assert.equal(removed.length, 0, 'an older upload than the snapshot is a deliberate re-queue and must survive');
  assert.equal(kept.length, 1);
});

test('parseUploadLogLine skips comments, blanks and malformed lines', () => {
  assert.equal(parseUploadLogLine('# fileuploader log'), null);
  assert.equal(parseUploadLogLine(''), null);
  assert.equal(parseUploadLogLine('   '), null);
  assert.equal(parseUploadLogLine('only|three|parts|here'), null);
  assert.equal(parseUploadLogLine(null), null);
  assert.equal(parseUploadLogLine(42), null);
});

test('parseUploadLogLine: missing/garbage timestamp yields ts=undefined (legacy lines still match by name)', () => {
  const parsed = parseUploadLogLine('|voe.sx|link||a.mkv|');
  assert.equal(parsed.hoster, 'voe.sx');
  assert.equal(parsed.fileName, 'a.mkv');
  assert.equal(parsed.ts, undefined);
});

test('parseUploadLogLine: a pipe in the link does NOT shift the filename field (entry not lost)', () => {
  const line = formatUploadLogLine(new Date(2026, 5, 19, 12, 0, 0), 'byse.sx', 'https://h.io/a|b', 'movie.mkv');
  const parsed = parseUploadLogLine(line);
  assert.equal(parsed.hoster, 'byse.sx');
  assert.equal(parsed.fileName, 'movie.mkv', 'filename is taken as the last non-empty field, robust to link pipes');
});

test('parseUploadLogLine: two pipes in the link still parse the correct filename', () => {
  const line = formatUploadLogLine(new Date(2026, 5, 19, 12, 0, 0), 'byse.sx', 'https://h.io/a|b|c', 'movie.mkv');
  const parsed = parseUploadLogLine(line);
  assert.equal(parsed.fileName, 'movie.mkv');
});

test('parseUploadLogLine: a leading-space filename is preserved (matches the untrimmed queue-job key)', () => {
  const line = formatUploadLogLine(new Date(2026, 5, 19, 12, 0, 0), 'voe.sx', 'https://h.io/a', ' movie.mkv');
  const parsed = parseUploadLogLine(line);
  assert.equal(parsed.fileName, ' movie.mkv', 'filename is NOT trimmed, so it matches the OS basename verbatim');
});

test('SEAM: a leading-space filename round-trips and the gate still drops its ghost', () => {
  const completion = new Date(2026, 5, 19, 12, 0, 30);
  const parsed = parseUploadLogLine(formatUploadLogLine(completion, 'voe.sx', 'l', ' spaced.mp4'));
  const savedAt = completion.getTime() - 5000;
  const job = { status: 'preview', fileName: ' spaced.mp4', hoster: 'voe.sx', file: 'C:/dl/ spaced.mp4' };
  const { removed } = partitionRestoredJobsByLog([job], [parsed], savedAt);
  assert.equal(removed.length, 1, 'leading-space filename now matches end-to-end (was a mismatch before)');
});
