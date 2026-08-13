const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('catastrophic batch starts retain exact terminal outcomes for every job', () => {
  const { buildFailedUploadSummary, buildTerminalJobSnapshots } = require('../lib/upload-recovery');
  const summary = buildFailedUploadSummary([
    { jobId: 'job-a', file: 'C:\\one\\same.mkv', hoster: 'doodstream.com' },
    { jobId: 'job-b', file: 'D:\\two\\same.mkv', hoster: 'voe.sx' }
  ], 'Upload konnte nicht gestartet werden', Date.UTC(2026, 7, 13));
  assert.equal(summary.total, 2);
  assert.equal(summary.failed, 2);
  assert.deepEqual(buildTerminalJobSnapshots(summary).map(entry => [entry.jobId, entry.status]), [
    ['job-a', 'error'],
    ['job-b', 'error']
  ]);
});

test('terminal recovery snapshots retain exact job outcomes and canonical links', () => {
  const { buildTerminalJobSnapshots } = require('../lib/upload-recovery');
  const snapshots = buildTerminalJobSnapshots({
    files: [{
      name: 'episode.mkv',
      results: [
        { jobId: 'done-job', hoster: 'doodstream.com', status: 'done', download_url: 'https://doodstream.com/d/abc123', file_code: 'abc123' },
        { jobId: 'error-job', hoster: 'voe.sx', status: 'error', error: 'rejected', failureDetails: { kind: 'hoster' } },
        { hoster: 'byse.sx', status: 'done', download_url: 'https://byse.sx/d/no-id' }
      ]
    }]
  });

  assert.deepEqual(snapshots, [
    {
      jobId: 'done-job',
      status: 'done',
      error: null,
      failureDetails: null,
      result: { download_url: 'https://doodstream.com/d/abc123', embed_url: null, file_code: 'abc123' }
    },
    {
      jobId: 'error-job',
      status: 'error',
      error: 'rejected',
      failureDetails: { kind: 'hoster' },
      result: null
    }
  ]);
});

test('recovery markers affect only their exact job IDs and never restart terminal outcomes', () => {
  const { getRecoveryOutcome } = require('../lib/upload-recovery');
  const recovery = {
    jobIds: ['done-job', 'active-job'],
    terminalJobs: [{
      jobId: 'done-job',
      status: 'done',
      error: null,
      failureDetails: null,
      result: { download_url: 'https://doodstream.com/d/abc123', embed_url: null, file_code: 'abc123' }
    }]
  };

  assert.deepEqual(getRecoveryOutcome({ id: 'done-job', status: 'preview' }, recovery), {
    status: 'done',
    error: null,
    failureDetails: null,
    result: { download_url: 'https://doodstream.com/d/abc123', embed_url: null, file_code: 'abc123' },
    interrupted: false
  });
  assert.deepEqual(getRecoveryOutcome({ id: 'active-job', status: 'queued' }, recovery), { status: 'queued', interrupted: true });
  assert.deepEqual(getRecoveryOutcome({ id: 'foreign-job', status: 'queued' }, recovery), { status: 'queued', interrupted: false });
  assert.deepEqual(getRecoveryOutcome({ id: 'already-done', status: 'done' }, recovery), { status: 'done', interrupted: false });
});

test('main and renderer keep recovery evidence until final queue persistence succeeds', () => {
  const root = path.join(__dirname, '..');
  const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const rendererSource = fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8');
  const indexSource = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
  const batchDone = mainSource.slice(mainSource.indexOf("uploadManager.on('batch-done'"), mainSource.indexOf("ipcMain.handle('cancel-upload'"));
  const barrier = mainSource.slice(mainSource.indexOf('function createUploadFinalizationBarrier'), mainSource.indexOf('function requestUploadFinalization'));

  assert.match(mainSource, /buildTerminalSnapshots: buildTerminalJobSnapshots/);
  assert.ok(barrier.indexOf('appendHistory(summary)') < barrier.indexOf('saveRecovery(terminalRecovery)'));
  assert.ok(barrier.indexOf('saveRecovery(terminalRecovery)') < barrier.indexOf('requestFinalization(summary, historyPersisted)'));
  assert.match(barrier, /if \(queuePersisted && terminalRecoveryPersisted\)[\s\S]*saveRecovery\(null\)/);
  assert.match(batchDone, /uploadFinalizationBarrier\.finalize\(summary, recovery\)/);
  const startFailure = batchDone.slice(batchDone.indexOf('startBatch(tasks'));
  assert.match(startFailure, /buildFailedUploadSummary\(tasks/);
  assert.match(startFailure, /uploadFinalizationBarrier\.finalize\(errorSummary, recovery\)/);
  const startHandler = mainSource.slice(mainSource.indexOf("ipcMain.handle('start-upload'"), mainSource.indexOf("ipcMain.handle('cancel-upload'"));
  assert.match(startHandler, /await configStore\.saveUploadRecovery\(recovery\)/);
  assert.match(startHandler, /uploadFinalizationBarrier\.finalize\(skippedSummary/);
  assert.match(startHandler, /finalized: true/);
  assert.ok(startHandler.indexOf('sourceCleanup.registerGroups(sourceCleanupGroups)') < startHandler.indexOf('saveUploadRecovery(recovery)'));
  assert.match(startHandler, /catch \(error\)[\s\S]*return { error: 'Upload-Wiederherstellung konnte nicht gespeichert werden' }/);
  const addHandler = mainSource.slice(mainSource.indexOf("ipcMain.handle('add-jobs-to-batch'"), mainSource.indexOf("ipcMain.handle('finish-after-active'"));
  assert.match(addHandler, /await configStore\.saveUploadRecovery\(nextRecovery\)/);
  assert.ok(addHandler.indexOf('saveUploadRecovery(nextRecovery)') < addHandler.indexOf('batchManager.addJobs(tasks)'));
  assert.match(rendererSource, /window\.UploadRecovery\.getRecoveryOutcome/);
  assert.match(rendererSource, /data\.historyPersisted !== true/);
  assert.match(rendererSource, /deliveryId: data\.deliveryId/);
  assert.ok(indexSource.indexOf('../lib/upload-recovery.js') < indexSource.indexOf('app.js'));
});
