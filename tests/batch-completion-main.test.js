const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');

test('publishes the authoritative batch report only after finalization and source cleanup', () => {
  const handler = mainSource.slice(mainSource.indexOf("uploadManager.on('batch-done'"), mainSource.indexOf('// Shutdown after finish'));
  const finalization = handler.indexOf('uploadFinalizationBarrier.finalize');
  const cleanup = handler.indexOf('sourceCleanup.finishBatch');
  const report = handler.indexOf('publishBatchCompletionReport');

  assert.ok(finalization >= 0);
  assert.ok(cleanup > finalization);
  assert.ok(report > cleanup);
});

test('keeps initial and live admission skips in the final batch summary', () => {
  assert.match(mainSource, /const uploadBatchAdmissionSkips = new WeakMap\(\)/);
  assert.match(mainSource, /uploadBatchAdmissionSkips\.set\(_thisManager, batchAdmissionSkippedJobs\)/);
  assert.match(mainSource, /uploadBatchAdmissionSkips\.get\(batchManager\).*push\(\.\.\.skippedJobs\)/s);
  assert.match(mainSource, /stats\.mergeSkippedIntoSummary\(summary, batchAdmissionSkippedJobs\)/);
  assert.match(mainSource, /fileName: j\.fileName \|\| path\.basename\(j\.file \|\| ''\)/);
  assert.match(mainSource, /fileKey: buildBatchFileKey\(j\.file\)/);
  assert.match(mainSource, /size: Number\(j\.bytesTotal\) \|\| 0/);
});

test('finalizes cleanup and reports skipped-only and rejected-start batches', () => {
  const skippedOnly = mainSource.slice(mainSource.indexOf('if (tasks.length === 0)'), mainSource.indexOf('uploadManager = new UploadManager'));
  const rejectedStart = mainSource.slice(mainSource.indexOf('}).catch(async (err) =>'), mainSource.indexOf('logMemorySnapshot(\'batch-start\')'));

  assert.match(skippedOnly, /sourceCleanup\.finishBatch/);
  assert.match(skippedOnly, /publishBatchCompletionReport/);
  assert.match(rejectedStart, /sourceCleanup\.finishBatch/);
  assert.match(rejectedStart, /publishBatchCompletionReport/);
});

test('preload exposes report recovery and report-bound exports', () => {
  assert.match(preloadSource, /onUploadBatchReport/);
  assert.match(preloadSource, /getLastBatchCompletionReport/);
  assert.match(preloadSource, /exportBatchCompletionReport/);
  assert.match(preloadSource, /removeAllListeners\('upload-batch-report'\)/);
  assert.match(mainSource, /shellText\('Der Batch-Bericht ist nicht mehr verfügbar', 'The batch report is no longer available'\)/);
  assert.match(mainSource, /shellText\('Ungültiges Exportformat', 'Invalid export format'\)/);
});

test('does not cache or publish a fully aborted batch report', () => {
  const publisher = mainSource.slice(
    mainSource.indexOf('function publishBatchCompletionReport'),
    mainSource.indexOf('function shouldLogHosterToFile')
  );

  assert.match(publisher, /if \(isAllAborted\(summary\)\) return null/);
  assert.ok(publisher.indexOf('isAllAborted(summary)') < publisher.indexOf('batchCompletionReports.set'));
  assert.ok(publisher.indexOf('isAllAborted(summary)') < publisher.indexOf("safeSend('upload-batch-report'"));
});
