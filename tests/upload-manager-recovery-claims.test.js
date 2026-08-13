const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const hosters = require('../lib/hosters');
const originalUploadFile = hosters.uploadFile;
const originalPrefetchBaseline = hosters.prefetchBaseline;
let tempRoot;
let firstPath;
let secondPath;
let UploadManager;

before(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mhu-manager-recovery-'));
  const firstDir = path.join(tempRoot, 'first');
  const secondDir = path.join(tempRoot, 'second');
  fs.mkdirSync(firstDir);
  fs.mkdirSync(secondDir);
  firstPath = path.join(firstDir, 'Shared Episode.mkv');
  secondPath = path.join(secondDir, 'shared-episode.mp4');
  fs.writeFileSync(firstPath, Buffer.alloc(1024, 1));
  fs.writeFileSync(secondPath, Buffer.alloc(1024, 2));
});

after(() => {
  hosters.uploadFile = originalUploadFile;
  hosters.prefetchBaseline = originalPrefetchBaseline;
  delete require.cache[require.resolve('../lib/upload-manager')];
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function loadManager(uploadFile) {
  hosters.uploadFile = uploadFile;
  hosters.prefetchBaseline = async () => new Set();
  delete require.cache[require.resolve('../lib/upload-manager')];
  UploadManager = require('../lib/upload-manager');
}

function settings(parallelCount) {
  return {
    'byse.sx': {
      retries: 0,
      parallelCount,
      maxSpeedKbs: 0,
      restartBelowKbs: 0,
      timeIntervalSec: 0,
      maxSizeMb: 0
    }
  };
}

async function runBatch(manager, tasks) {
  let summary;
  manager.once('batch-done', value => {
    summary = value;
  });
  await manager.startBatch(tasks);
  return summary;
}

test('a batch shares recovery claims across normalized same-name jobs', async () => {
  let unsafeCalls = 0;
  loadManager(async (hoster, file, apiKey, onProgress, signal, throttle, options) => {
    const claim = options && options.recoveryClaim;
    if (claim && claim.reserve('SHARED_REMOTE_CODE')) {
      return {
        file_code: 'SHARED_REMOTE_CODE',
        download_url: 'https://byse.sx/d/SHARED_REMOTE_CODE'
      };
    }
    if (!claim) {
      unsafeCalls++;
      return {
        file_code: `UNSAFE_${unsafeCalls}`,
        download_url: `https://byse.sx/d/UNSAFE_${unsafeCalls}`
      };
    }
    const error = new Error('Remote recovery candidate already claimed');
    error.hosterTransient = true;
    throw error;
  });
  const manager = new UploadManager(settings(2));

  const summary = await runBatch(manager, [
    { jobId: 'same-name-a', file: firstPath, hoster: 'byse.sx', apiKey: 'ACCOUNT_KEY' },
    { jobId: 'same-name-b', file: secondPath, hoster: 'byse.sx', apiKey: 'ACCOUNT_KEY' }
  ]);

  assert.equal(summary.succeeded, 1);
  assert.equal(summary.failed, 1);
});

test('recovery claims stay isolated between accounts', async () => {
  loadManager(async (hoster, file, apiKey, onProgress, signal, throttle, options) => {
    if (!options || !options.recoveryClaim) {
      throw new Error('Missing recovery claim');
    }
    if (!options.recoveryClaim.reserve('SHARED_REMOTE_CODE')) {
      const error = new Error('Remote recovery candidate already claimed');
      error.hosterTransient = true;
      throw error;
    }
    return {
      file_code: 'SHARED_REMOTE_CODE',
      download_url: 'https://byse.sx/d/SHARED_REMOTE_CODE'
    };
  });
  const manager = new UploadManager(settings(2));

  const summary = await runBatch(manager, [
    { jobId: 'account-a', file: firstPath, hoster: 'byse.sx', apiKey: 'ACCOUNT_A' },
    { jobId: 'account-b', file: secondPath, hoster: 'byse.sx', apiKey: 'ACCOUNT_B' }
  ]);

  assert.equal(summary.succeeded, 2);
  assert.equal(summary.failed, 0);
});

test('normalized same-name recovery sections never overlap', async () => {
  let active = 0;
  let maximumActive = 0;
  let sequence = 0;
  loadManager(async () => {
    active++;
    maximumActive = Math.max(maximumActive, active);
    await new Promise(resolve => setTimeout(resolve, 20));
    active--;
    sequence++;
    return {
      file_code: `SERIAL_${sequence}`,
      download_url: `https://byse.sx/d/SERIAL_${sequence}`
    };
  });
  const manager = new UploadManager(settings(2));

  const summary = await runBatch(manager, [
    { jobId: 'serialized-a', file: firstPath, hoster: 'byse.sx', apiKey: 'ACCOUNT_KEY' },
    { jobId: 'serialized-b', file: secondPath, hoster: 'byse.sx', apiKey: 'ACCOUNT_KEY' }
  ]);

  assert.equal(summary.succeeded, 2);
  assert.equal(maximumActive, 1);
});
