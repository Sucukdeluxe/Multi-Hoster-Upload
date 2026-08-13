const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const hosters = require('../lib/hosters');
const DoodstreamUploader = require('../lib/doodstream-upload');
const VoeUploader = require('../lib/voe-upload');
const VidmolyUploader = require('../lib/vidmoly-upload');
const originalUploadFile = hosters.uploadFile;
const originalPrefetchBaseline = hosters.prefetchBaseline;
let tempRoot;
let firstPath;
let secondPath;
let distinctPath;
let UploadManager;

before(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mhu-manager-recovery-'));
  const firstDir = path.join(tempRoot, 'first');
  const secondDir = path.join(tempRoot, 'second');
  fs.mkdirSync(firstDir);
  fs.mkdirSync(secondDir);
  firstPath = path.join(firstDir, 'Shared Episode.mkv');
  secondPath = path.join(secondDir, 'shared-episode.mp4');
  distinctPath = path.join(secondDir, 'different-title.mkv');
  fs.writeFileSync(firstPath, Buffer.alloc(1024, 1));
  fs.writeFileSync(secondPath, Buffer.alloc(1024, 2));
  fs.writeFileSync(distinctPath, Buffer.alloc(1024, 3));
});

after(() => {
  hosters.uploadFile = originalUploadFile;
  hosters.prefetchBaseline = originalPrefetchBaseline;
  delete require.cache[require.resolve('../lib/upload-manager')];
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function loadManager(uploadFile = originalUploadFile) {
  hosters.uploadFile = uploadFile;
  hosters.prefetchBaseline = async () => new Set();
  delete require.cache[require.resolve('../lib/upload-manager')];
  UploadManager = require('../lib/upload-manager');
}

function settings(hoster, parallelCount) {
  return {
    [hoster]: {
      retries: 0,
      parallelCount,
      maxSpeedKbs: 0,
      restartBelowKbs: 0,
      timeIntervalSec: 0,
      maxSizeMb: 0
    }
  };
}

async function runBatch(manager, tasks, options) {
  let summary;
  manager.once('batch-done', value => {
    summary = value;
  });
  await manager.startBatch(tasks, options);
  return summary;
}

async function withUploaderMethods(Uploader, upload, operation) {
  const originalLogin = Uploader.prototype.login;
  const originalUpload = Uploader.prototype.upload;
  Uploader.prototype.login = async function () {};
  Uploader.prototype.upload = upload;
  try {
    return await operation();
  } finally {
    Uploader.prototype.login = originalLogin;
    Uploader.prototype.upload = originalUpload;
  }
}

async function withDoodstreamMethods(methods, operation) {
  const originals = {};
  for (const [name, method] of Object.entries(methods)) {
    originals[name] = DoodstreamUploader.prototype[name];
    DoodstreamUploader.prototype[name] = method;
  }
  try {
    return await operation();
  } finally {
    for (const [name, method] of Object.entries(originals)) {
      DoodstreamUploader.prototype[name] = method;
    }
  }
}

function waitFor(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

async function assertTitleWaiterLeavesSlotAvailable(hosterParallel, globalSettings = {}) {
  let releaseFirst;
  let markFirstStarted;
  let markIndependentStarted;
  const firstGate = new Promise(resolve => {
    releaseFirst = resolve;
  });
  const firstStarted = new Promise(resolve => {
    markFirstStarted = resolve;
  });
  const independentStarted = new Promise(resolve => {
    markIndependentStarted = resolve;
  });
  let sequence = 0;
  loadManager(async (hoster, file) => {
    if (file === firstPath) {
      markFirstStarted();
      await firstGate;
    }
    if (file === distinctPath) markIndependentStarted();
    sequence++;
    return {
      file_code: `ADMISSION_${sequence}`,
      download_url: `https://byse.sx/d/ADMISSION_${sequence}`
    };
  });
  const manager = new UploadManager(settings('byse.sx', hosterParallel), globalSettings);
  const batch = runBatch(manager, [
    { jobId: 'admission-first', file: firstPath, hoster: 'byse.sx', apiKey: 'ACCOUNT_KEY' }
  ]);

  await waitFor(firstStarted, 500, 'First upload did not start');
  const added = manager.addJobs([
    { jobId: 'admission-waiter', file: secondPath, hoster: 'byse.sx', apiKey: 'ACCOUNT_KEY' },
    { jobId: 'admission-independent', file: distinctPath, hoster: 'byse.sx', apiKey: 'ACCOUNT_KEY' }
  ]);
  assert.equal(added.added, 2);
  let admissionError = null;
  try {
    await waitFor(independentStarted, 500, 'Independent title was blocked behind a title-lock waiter');
  } catch (err) {
    admissionError = err;
  } finally {
    releaseFirst();
  }
  const summary = await batch;
  if (admissionError) throw admissionError;
  assert.equal(summary.succeeded, 3);
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
  const manager = new UploadManager(settings('byse.sx', 2));

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
  const manager = new UploadManager(settings('byse.sx', 2));

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
  const manager = new UploadManager(settings('byse.sx', 2));

  const summary = await runBatch(manager, [
    { jobId: 'serialized-a', file: firstPath, hoster: 'byse.sx', apiKey: 'ACCOUNT_KEY' },
    { jobId: 'serialized-b', file: secondPath, hoster: 'byse.sx', apiKey: 'ACCOUNT_KEY' }
  ]);

  assert.equal(summary.succeeded, 2);
  assert.equal(maximumActive, 1);
});

test('a title-lock waiter does not consume a scarce upload slot', async () => {
  await assertTitleWaiterLeavesSlotAvailable(2);
});

test('a title-lock waiter does not consume a scarce global upload slot', async () => {
  await assertTitleWaiterLeavesSlotAvailable(3, { parallelUploadCount: 2 });
});

test('an uncertain remote commit blocks retries, account fallback, and later same-title success', async () => {
  const calls = [];
  let markFirstStarted;
  let releaseUncertain;
  const firstStarted = new Promise(resolve => {
    markFirstStarted = resolve;
  });
  const uncertainGate = new Promise(resolve => {
    releaseUncertain = resolve;
  });
  loadManager(async (hoster, file, apiKey) => {
    calls.push({ file, apiKey });
    if (file === firstPath) {
      markFirstStarted();
      await uncertainGate;
      const error = new Error('Remote commit could not be confirmed');
      error.remoteCommitUncertain = true;
      throw error;
    }
    return {
      file_code: 'LATE_REMOTE_CODE',
      download_url: 'https://byse.sx/d/LATE_REMOTE_CODE'
    };
  });
  const hosterSettings = settings('byse.sx', 2);
  hosterSettings['byse.sx'].retries = 2;
  const manager = new UploadManager(hosterSettings);
  const fallback = { id: 'ACCOUNT_B', apiKey: 'ACCOUNT_KEY_B' };

  const batch = runBatch(manager, [
    {
      jobId: 'uncertain-first',
      file: firstPath,
      hoster: 'byse.sx',
      accountId: 'ACCOUNT_A',
      apiKey: 'ACCOUNT_KEY_A'
    }
  ], { primeOverrides: [['byse.sx', fallback]] });
  await waitFor(firstStarted, 500, 'Uncertain predecessor did not start');
  const added = manager.addJobs([
    {
      jobId: 'uncertain-later',
      file: secondPath,
      hoster: 'byse.sx',
      accountId: 'ACCOUNT_A',
      apiKey: 'ACCOUNT_KEY_A'
    }
  ]);
  assert.equal(added.added, 1);
  releaseUncertain();
  const summary = await batch;

  assert.equal(summary.succeeded, 0);
  assert.equal(summary.failed, 2);
  assert.deepEqual(calls, [{ file: firstPath, apiKey: 'ACCOUNT_KEY_A' }]);
});

test('recovery claims do not leak into a later batch on the same manager', async () => {
  loadManager(async (hoster, file, apiKey, onProgress, signal, throttle, options) => {
    if (!options.recoveryClaim.reserve('REUSED_BATCH_CODE')) {
      const error = new Error('Remote recovery candidate already claimed');
      error.hosterTransient = true;
      throw error;
    }
    return {
      file_code: 'REUSED_BATCH_CODE',
      download_url: 'https://byse.sx/d/REUSED_BATCH_CODE'
    };
  });
  const manager = new UploadManager(settings('byse.sx', 1));
  const task = { jobId: 'batch-one', file: firstPath, hoster: 'byse.sx', apiKey: 'ACCOUNT_KEY' };

  const first = await runBatch(manager, [task]);
  const second = await runBatch(manager, [{ ...task, jobId: 'batch-two' }]);

  assert.equal(first.succeeded, 1);
  assert.equal(second.succeeded, 1);
});

test('VOE API and login auth paths share account-wide remote code claims', async () => {
  const sharedCode = 'VOEALLAUTH01';
  await withUploaderMethods(
    VoeUploader,
    async function () {
      await new Promise(resolve => setImmediate(resolve));
      return this._buildUrls(sharedCode);
    },
    async () => {
      loadManager(async (hoster, file, apiKey, onProgress, signal, throttle, options) => {
        const claim = options && options.recoveryClaim;
        if (claim && !claim.reserve(sharedCode)) {
          const error = new Error('Remote identity already claimed');
          error.hosterTransient = true;
          throw error;
        }
        return {
          file_code: sharedCode,
          download_url: `https://voe.sx/${sharedCode}`,
          embed_url: `https://voe.sx/e/${sharedCode}`
        };
      });
      const manager = new UploadManager(settings('voe.sx', 2));

      const summary = await runBatch(manager, [
        {
          jobId: 'voe-login-auth',
          file: firstPath,
          hoster: 'voe.sx',
          accountId: 'VOE_SHARED_ACCOUNT',
          username: 'account@example.test',
          password: 'password'
        },
        {
          jobId: 'voe-api-auth',
          file: distinctPath,
          hoster: 'voe.sx',
          accountId: 'VOE_SHARED_ACCOUNT',
          apiKey: 'VOE_API_KEY'
        }
      ]);

      assert.equal(summary.succeeded, 1);
      assert.equal(summary.failed, 1);
    }
  );
});

test('an uncertain VOE API upload blocks a later same-title login upload', async () => {
  let markApiStarted;
  let releaseApi;
  let loginUploads = 0;
  const apiStarted = new Promise(resolve => {
    markApiStarted = resolve;
  });
  const apiGate = new Promise(resolve => {
    releaseApi = resolve;
  });
  await withUploaderMethods(
    VoeUploader,
    async function () {
      loginUploads++;
      return this._buildUrls('UNSAFEVOELOGIN');
    },
    async () => {
      loadManager(async () => {
        markApiStarted();
        await apiGate;
        const error = new Error('VOE API result could not be confirmed');
        error.remoteCommitUncertain = true;
        throw error;
      });
      const manager = new UploadManager(settings('voe.sx', 2));
      const batch = runBatch(manager, [
        {
          jobId: 'voe-api-uncertain',
          file: firstPath,
          hoster: 'voe.sx',
          accountId: 'VOE_SHARED_ACCOUNT',
          apiKey: 'VOE_API_KEY'
        }
      ]);

      await waitFor(apiStarted, 500, 'VOE API upload did not start');
      const added = manager.addJobs([
        {
          jobId: 'voe-login-later',
          file: secondPath,
          hoster: 'voe.sx',
          accountId: 'VOE_SHARED_ACCOUNT',
          username: 'account@example.test',
          password: 'password'
        }
      ]);
      assert.equal(added.added, 1);
      releaseApi();
      const summary = await batch;

      assert.equal(summary.succeeded, 0);
      assert.equal(summary.failed, 2);
      assert.equal(loginUploads, 0);
    }
  );
});

test('a keyless Doodstream web ambiguity blocks a later same-title upload', async () => {
  let markUploadStarted;
  let releaseUpload;
  let uploadCalls = 0;
  const uploadStarted = new Promise(resolve => {
    markUploadStarted = resolve;
  });
  const uploadGate = new Promise(resolve => {
    releaseUpload = resolve;
  });
  await withDoodstreamMethods({
    login: async function () {},
    deriveApiKey: async function () {
      return null;
    },
    upload: async function () {
      uploadCalls++;
      if (uploadCalls === 1) {
        markUploadStarted();
        await uploadGate;
        const error = new Error('Doodstream returned an empty upload result');
        error.hosterTransient = true;
        error.diagnostic = { phase: 'upload-result' };
        throw error;
      }
      return {
        file_code: 'UNSAFE_DOOD_CODE',
        download_url: 'https://doodstream.com/d/UNSAFE_DOOD_CODE',
        embed_url: 'https://doodstream.com/e/UNSAFE_DOOD_CODE'
      };
    }
  }, async () => {
    loadManager();
    const manager = new UploadManager(settings('doodstream.com', 2));
    const batch = runBatch(manager, [
      {
        jobId: 'dood-web-uncertain',
        file: firstPath,
        hoster: 'doodstream.com',
        accountId: 'DOOD_SHARED_ACCOUNT',
        username: 'account@example.test',
        password: 'password'
      }
    ]);

    await waitFor(uploadStarted, 500, 'Doodstream web upload did not start');
    const added = manager.addJobs([
      {
        jobId: 'dood-web-later',
        file: secondPath,
        hoster: 'doodstream.com',
        accountId: 'DOOD_SHARED_ACCOUNT',
        username: 'account@example.test',
        password: 'password'
      }
    ]);
    assert.equal(added.added, 1);
    releaseUpload();
    const summary = await batch;

    assert.equal(summary.succeeded, 0);
    assert.equal(summary.failed, 2);
    assert.equal(uploadCalls, 1);
  });
});

test('Doodstream key resolution is singleflight per account', async () => {
  let releaseLogin;
  let loginCalls = 0;
  let deriveCalls = 0;
  const loginGate = new Promise(resolve => {
    releaseLogin = resolve;
  });
  await withDoodstreamMethods({
    login: async function () {
      loginCalls++;
      await loginGate;
    },
    deriveApiKey: async function () {
      deriveCalls++;
      return 'DERIVED_DOOD_KEY';
    }
  }, async () => {
    loadManager();
    const manager = new UploadManager(settings('doodstream.com', 12));
    const resolutions = Array.from({ length: 12 }, (_, index) => manager._resolveDoodstreamApiKey({
      accountId: 'DOOD_SHARED_ACCOUNT',
      username: `account-${index}@example.test`,
      password: 'password'
    }));
    const queuedLoginCalls = loginCalls;

    releaseLogin();
    const keys = await Promise.all(resolutions);

    assert.equal(queuedLoginCalls, 1);
    assert.equal(loginCalls, 1);
    assert.equal(deriveCalls, 1);
    assert.deepEqual(keys, Array(12).fill('DERIVED_DOOD_KEY'));
  });
});

test('Doodstream web and API auth paths use one canonical remote account identity across profile IDs', async () => {
  const sharedCode = 'DOODALLAUTH01';
  await withDoodstreamMethods({
    login: async function () {},
    deriveApiKey: async function () {
      return 'DOOD_API_KEY';
    },
    upload: async function () {
      await new Promise(resolve => setImmediate(resolve));
      return {
        file_code: sharedCode,
        download_url: `https://doodstream.com/d/${sharedCode}`,
        embed_url: `https://doodstream.com/e/${sharedCode}`
      };
    }
  }, async () => {
    loadManager(async (hoster, file, apiKey, onProgress, signal, throttle, options) => {
      if (!options.recoveryClaim.reserve(sharedCode)) {
        const error = new Error('Remote identity already claimed');
        error.hosterTransient = true;
        throw error;
      }
      return {
        file_code: sharedCode,
        download_url: `https://doodstream.com/d/${sharedCode}`,
        embed_url: `https://doodstream.com/e/${sharedCode}`
      };
    });
    const manager = new UploadManager(settings('doodstream.com', 2));

    const summary = await runBatch(manager, [
      {
        jobId: 'dood-web-auth',
        file: firstPath,
        hoster: 'doodstream.com',
        accountId: 'DOOD_WEB_PROFILE',
        username: 'account@example.test',
        password: 'password'
      },
      {
        jobId: 'dood-api-auth',
        file: distinctPath,
        hoster: 'doodstream.com',
        accountId: 'DOOD_API_PROFILE',
        apiKey: 'DOOD_API_KEY'
      }
    ]);

    assert.equal(summary.succeeded, 1);
    assert.equal(summary.failed, 1);
  });
});

test('Doodstream uncertainty blocks a same-title API profile with a different local ID', async () => {
  let markWebStarted;
  let releaseWeb;
  let uploadCalls = 0;
  const webStarted = new Promise(resolve => {
    markWebStarted = resolve;
  });
  const webGate = new Promise(resolve => {
    releaseWeb = resolve;
  });
  await withDoodstreamMethods({
    login: async function () {},
    deriveApiKey: async function () {
      return null;
    },
    upload: async function () {
      uploadCalls++;
      markWebStarted();
      await webGate;
      const error = new Error('Doodstream upload result could not be read');
      error.remoteCommitUncertain = true;
      throw error;
    }
  }, async () => {
    loadManager(async () => {
      uploadCalls++;
      return {
        file_code: 'UNSAFE_CROSS_AUTH',
        download_url: 'https://doodstream.com/d/UNSAFE_CROSS_AUTH',
        embed_url: 'https://doodstream.com/e/UNSAFE_CROSS_AUTH'
      };
    });
    const manager = new UploadManager(settings('doodstream.com', 2));
    const batch = runBatch(manager, [
      {
        jobId: 'dood-web-uncertain-profile',
        file: firstPath,
        hoster: 'doodstream.com',
        accountId: 'DOOD_WEB_PROFILE',
        username: 'account@example.test',
        password: 'password'
      }
    ]);
    await waitFor(webStarted, 500, 'Doodstream web upload did not start');
    const added = manager.addJobs([
      {
        jobId: 'dood-api-after-uncertain-profile',
        file: secondPath,
        hoster: 'doodstream.com',
        accountId: 'DOOD_API_PROFILE',
        apiKey: 'DOOD_API_KEY'
      }
    ]);
    assert.equal(added.added, 1);
    releaseWeb();
    const summary = await batch;

    assert.equal(summary.succeeded, 0);
    assert.equal(summary.failed, 2);
    assert.equal(uploadCalls, 1);
  });
});

test('VOE mixed auth profiles share a fail-closed recovery boundary', async () => {
  const sharedCode = 'VOECROSSAUTH1';
  await withUploaderMethods(
    VoeUploader,
    async function () {
      await new Promise(resolve => setImmediate(resolve));
      return this._buildUrls(sharedCode);
    },
    async () => {
      loadManager(async (hoster, file, apiKey, onProgress, signal, throttle, options) => {
        if (!options.recoveryClaim.reserve(sharedCode)) {
          const error = new Error('Remote identity already claimed');
          error.hosterTransient = true;
          throw error;
        }
        return {
          file_code: sharedCode,
          download_url: `https://voe.sx/${sharedCode}`,
          embed_url: `https://voe.sx/e/${sharedCode}`
        };
      });
      const manager = new UploadManager(settings('voe.sx', 2));
      const summary = await runBatch(manager, [
        {
          jobId: 'voe-web-auth-profile',
          file: firstPath,
          hoster: 'voe.sx',
          accountId: 'VOE_WEB_PROFILE',
          username: 'account@example.test',
          password: 'password'
        },
        {
          jobId: 'voe-api-auth-profile',
          file: secondPath,
          hoster: 'voe.sx',
          accountId: 'VOE_API_PROFILE',
          apiKey: 'VOE_API_KEY'
        }
      ]);

      assert.equal(summary.succeeded, 1);
      assert.equal(summary.failed, 1);
    }
  );
});

test('batch completion clears Doodstream key and baseline caches', async () => {
  await withDoodstreamMethods({
    login: async function () {},
    deriveApiKey: async function () {
      return 'DOOD_BATCH_KEY';
    }
  }, async () => {
    loadManager(async () => ({
      file_code: 'DOODBATCHDONE1',
      download_url: 'https://doodstream.com/d/DOODBATCHDONE1',
      embed_url: 'https://doodstream.com/e/DOODBATCHDONE1'
    }));
    const manager = new UploadManager(settings('doodstream.com', 1));
    const summary = await runBatch(manager, [{
      jobId: 'dood-cache-cleanup',
      file: firstPath,
      hoster: 'doodstream.com',
      accountId: 'DOOD_CACHE_PROFILE',
      username: 'account@example.test',
      password: 'password'
    }]);

    assert.equal(summary.succeeded, 1);
    assert.equal(manager._doodApiKeyCache.size, 0);
    assert.equal(manager._baselineCache.size, 0);
  });
});

test('upload interval is enforced at the admitted upload start', async () => {
  const events = [];
  let releaseFirst;
  let markFirstStarted;
  const firstGate = new Promise(resolve => {
    releaseFirst = resolve;
  });
  const firstStarted = new Promise(resolve => {
    markFirstStarted = resolve;
  });
  let uploadCount = 0;
  loadManager(async (hoster, file) => {
    uploadCount++;
    events.push(`start:${path.basename(file)}`);
    if (uploadCount === 1) {
      markFirstStarted();
      await firstGate;
    }
    return {
      file_code: `INTERVAL${events.length}`,
      download_url: `https://byse.sx/d/INTERVAL${events.length}`,
      embed_url: `https://byse.sx/e/INTERVAL${events.length}`
    };
  });
  const hosterSettings = settings('byse.sx', 1);
  hosterSettings['byse.sx'].timeIntervalSec = 1;
  const manager = new UploadManager(hosterSettings);
  manager._waitForInterval = async (hoster, intervalMs, signal, acquireSlots) => {
    events.push('interval');
    await acquireSlots();
  };
  const batch = runBatch(manager, [
    { jobId: 'interval-first', file: firstPath, hoster: 'byse.sx', accountId: 'BYSE_ACCOUNT', apiKey: 'BYSE_KEY' },
    { jobId: 'interval-second', file: secondPath, hoster: 'byse.sx', accountId: 'BYSE_ACCOUNT', apiKey: 'BYSE_KEY' },
    { jobId: 'interval-third', file: distinctPath, hoster: 'byse.sx', accountId: 'BYSE_ACCOUNT', apiKey: 'BYSE_KEY' }
  ]);

  await waitFor(firstStarted, 500, 'First admitted upload did not start');
  await new Promise(resolve => setImmediate(resolve));
  const intervalsBeforeRelease = events.filter(event => event === 'interval').length;
  releaseFirst();
  const summary = await batch;

  assert.equal(intervalsBeforeRelease, 1, JSON.stringify(events));
  assert.equal(summary.succeeded, 3);
  assert.deepEqual(events.filter(event => event === 'interval'), ['interval', 'interval', 'interval']);
});

test('an interval wait never occupies the global slot of another hoster', async () => {
  let markIntervalWaiting;
  let releaseInterval;
  let markOtherStarted;
  const intervalWaiting = new Promise(resolve => {
    markIntervalWaiting = resolve;
  });
  const intervalGate = new Promise(resolve => {
    releaseInterval = resolve;
  });
  const otherStarted = new Promise(resolve => {
    markOtherStarted = resolve;
  });
  loadManager(async (hoster) => {
    if (hoster === 'voe.sx') markOtherStarted();
    const code = hoster === 'voe.sx' ? 'VOEINTERVAL1' : 'BYSEINTERVAL1';
    return {
      file_code: code,
      download_url: hoster === 'voe.sx' ? `https://voe.sx/${code}` : `https://byse.sx/d/${code}`,
      embed_url: hoster === 'voe.sx' ? `https://voe.sx/e/${code}` : `https://byse.sx/e/${code}`
    };
  });
  const hosterSettings = {
    ...settings('byse.sx', 1),
    ...settings('voe.sx', 1)
  };
  hosterSettings['byse.sx'].timeIntervalSec = 1;
  const manager = new UploadManager(hosterSettings, { parallelUploadCount: 1 });
  const originalWait = manager._waitForInterval.bind(manager);
  manager._waitForInterval = async (hoster, intervalMs, signal, acquireSlots) => {
    if (hoster === 'byse.sx') {
      markIntervalWaiting();
      await intervalGate;
    }
    return originalWait(hoster, 0, signal, acquireSlots);
  };
  const batch = runBatch(manager, [
    { jobId: 'interval-waiting-hoster', file: firstPath, hoster: 'byse.sx', accountId: 'BYSE_ACCOUNT', apiKey: 'BYSE_KEY' },
    { jobId: 'interval-independent-hoster', file: distinctPath, hoster: 'voe.sx', accountId: 'VOE_ACCOUNT', apiKey: 'VOE_KEY' }
  ]);

  await waitFor(intervalWaiting, 500, 'Configured interval did not start waiting');
  let blockedError = null;
  try {
    await waitFor(otherStarted, 500, 'Interval wait occupied the global upload slot');
  } catch (error) {
    blockedError = error;
  } finally {
    releaseInterval();
  }
  const summary = await batch;
  if (blockedError) throw blockedError;
  assert.equal(summary.succeeded, 2);
});

for (const scenario of [
  {
    label: 'VOE',
    hoster: 'voe.sx',
    Uploader: VoeUploader,
    sharedCode: 'SHAREDVOE01',
    distinctCodes: ['VOEDISTINCT1', 'VOEDISTINCT2'],
    buildResult(uploader, code) {
      return uploader._buildUrls(code);
    }
  },
  {
    label: 'Vidmoly',
    hoster: 'vidmoly.me',
    Uploader: VidmolyUploader,
    sharedCode: 'SHAREDVID001',
    distinctCodes: ['VIDDISTINCT1', 'VIDDISTINCT2'],
    buildResult(uploader, code) {
      return uploader._buildUrlsFromCode(code);
    }
  }
]) {
  test(`${scenario.label} uploader instances reject a duplicate direct remote code for same-name sources`, async () => {
    await withUploaderMethods(
      scenario.Uploader,
      async function () {
        await new Promise(resolve => setImmediate(resolve));
        return scenario.buildResult(this, scenario.sharedCode);
      },
      async () => {
        loadManager();
        const manager = new UploadManager(settings(scenario.hoster, 2));
        const summary = await runBatch(manager, [
          {
            jobId: `${scenario.label}-same-name-a`,
            file: firstPath,
            hoster: scenario.hoster,
            accountId: 'LOGIN_ACCOUNT',
            username: 'account@example.test',
            password: 'password'
          },
          {
            jobId: `${scenario.label}-same-name-b`,
            file: secondPath,
            hoster: scenario.hoster,
            accountId: 'LOGIN_ACCOUNT',
            username: 'account@example.test',
            password: 'password'
          }
        ]);

        assert.equal(summary.succeeded, 1);
        assert.equal(summary.failed, 1);
      }
    );
  });

  test(`${scenario.label} uploader instances isolate direct remote code claims between accounts`, async () => {
    await withUploaderMethods(
      scenario.Uploader,
      async function () {
        return scenario.buildResult(this, scenario.sharedCode);
      },
      async () => {
        loadManager();
        const manager = new UploadManager(settings(scenario.hoster, 2));
        const summary = await runBatch(manager, [
          {
            jobId: `${scenario.label}-account-a`,
            file: firstPath,
            hoster: scenario.hoster,
            accountId: 'LOGIN_ACCOUNT_A',
            username: 'account-a@example.test',
            password: 'password'
          },
          {
            jobId: `${scenario.label}-account-b`,
            file: secondPath,
            hoster: scenario.hoster,
            accountId: 'LOGIN_ACCOUNT_B',
            username: 'account-b@example.test',
            password: 'password'
          }
        ]);

        assert.equal(summary.succeeded, 2);
        assert.equal(summary.failed, 0);
      }
    );
  });

  test(`${scenario.label} uploader instances reject one direct remote code across different titles`, async () => {
    await withUploaderMethods(
      scenario.Uploader,
      async function () {
        await new Promise(resolve => setImmediate(resolve));
        return scenario.buildResult(this, scenario.sharedCode);
      },
      async () => {
        loadManager();
        const manager = new UploadManager(settings(scenario.hoster, 2));
        const summary = await runBatch(manager, [
          {
            jobId: `${scenario.label}-different-title-a`,
            file: firstPath,
            hoster: scenario.hoster,
            accountId: 'LOGIN_ACCOUNT',
            username: 'account@example.test',
            password: 'password'
          },
          {
            jobId: `${scenario.label}-different-title-b`,
            file: distinctPath,
            hoster: scenario.hoster,
            accountId: 'LOGIN_ACCOUNT',
            username: 'account@example.test',
            password: 'password'
          }
        ]);

        assert.equal(summary.succeeded, 1);
        assert.equal(summary.failed, 1);
      }
    );
  });

  test(`${scenario.label} uploader instances preserve parallel success for distinct remote identities`, async () => {
    let active = 0;
    let maximumActive = 0;
    let started = 0;
    let releaseBoth;
    const bothStarted = new Promise(resolve => {
      releaseBoth = resolve;
    });
    await withUploaderMethods(
      scenario.Uploader,
      async function (filePath) {
        active++;
        started++;
        maximumActive = Math.max(maximumActive, active);
        if (started === 2) releaseBoth();
        try {
          await waitFor(bothStarted, 500, 'Distinct uploads did not overlap');
          const code = filePath === firstPath ? scenario.distinctCodes[0] : scenario.distinctCodes[1];
          return scenario.buildResult(this, code);
        } finally {
          active--;
        }
      },
      async () => {
        loadManager();
        const manager = new UploadManager(settings(scenario.hoster, 2));
        const summary = await runBatch(manager, [
          {
            jobId: `${scenario.label}-distinct-a`,
            file: firstPath,
            hoster: scenario.hoster,
            accountId: 'LOGIN_ACCOUNT',
            username: 'account@example.test',
            password: 'password'
          },
          {
            jobId: `${scenario.label}-distinct-b`,
            file: distinctPath,
            hoster: scenario.hoster,
            accountId: 'LOGIN_ACCOUNT',
            username: 'account@example.test',
            password: 'password'
          }
        ]);

        assert.equal(summary.succeeded, 2);
        assert.equal(summary.failed, 0);
        assert.equal(maximumActive, 2);
      }
    );
  });
}
