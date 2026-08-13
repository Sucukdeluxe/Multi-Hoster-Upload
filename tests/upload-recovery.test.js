const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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

  assert.match(batchDone, /buildTerminalJobSnapshots\(summary\)/);
  assert.match(batchDone, /if \(queuePersisted\)[\s\S]*saveUploadRecovery\(null\)/);
  assert.ok(batchDone.indexOf('saveUploadRecovery(recoveryWithTerminalJobs)') < batchDone.indexOf('requestUploadFinalization(summary, historyPersisted)'));
  assert.match(rendererSource, /window\.UploadRecovery\.getRecoveryOutcome/);
  assert.match(rendererSource, /data\.historyPersisted !== true/);
  assert.ok(indexSource.indexOf('../lib/upload-recovery.js') < indexSource.indexOf('app.js'));
});
