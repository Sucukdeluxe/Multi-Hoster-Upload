const { describe, it, mock, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('path');
const { EventEmitter } = require('events');
const { createSourceFileCleanup } = require('../lib/source-file-cleanup');

// We need to mock fs.statSync and the hoster upload functions before requiring upload-manager
// Use node:test mock.module (available in Node 22+)

describe('UploadManager', () => {
  let UploadManager;
  let mockUploadFile;
  let fakeFileSize;

  beforeEach(() => {
    fakeFileSize = 1024 * 1024; // 1 MB default

    // Clear module cache for fresh mocks each test
    delete require.cache[require.resolve('../lib/upload-manager')];

    // Mock the hosters module
    mockUploadFile = mock.fn(async (hoster, filePath, apiKey, onProgress, signal, throttle) => {
      // Simulate upload progress
      if (onProgress) {
        onProgress(fakeFileSize / 2, fakeFileSize);
        onProgress(fakeFileSize, fakeFileSize);
      }
      return { download_url: `https://${hoster}/test123`, embed_url: null, file_code: 'test123' };
    });

    // Override require for hosters
    const origRequire = module.constructor.prototype.require;
    const hosters = require('../lib/hosters');
    hosters.uploadFile = mockUploadFile;
    hosters.prefetchBaseline = async () => null;

    // Mock fs.statSync + fs.promises.stat for test file paths
    const fs = require('fs');
    const origStatSync = fs.statSync;
    fs.statSync = function(p) {
      if (typeof p === 'string' && p.startsWith('/test/')) {
        return { size: fakeFileSize };
      }
      return origStatSync.call(this, p);
    };
    const origStat = fs.promises.stat;
    fs.promises.stat = async function(p) {
      if (typeof p === 'string' && p.startsWith('/test/')) {
        return { size: fakeFileSize };
      }
      return origStat.call(this, p);
    };

    UploadManager = require('../lib/upload-manager');
  });

  it('emits progress events for each task', async () => {
    const mgr = new UploadManager({});
    const events = [];
    mgr.on('progress', (data) => events.push(data));

    await mgr.startBatch([
      { file: '/test/video1.mp4', hoster: 'doodstream.com', apiKey: 'key1' }
    ]);

    const statuses = events.map(e => e.status);
    assert.ok(statuses.includes('done'), 'should have done status');
    assert.ok(events.length > 0, 'should emit at least one progress event');
  });

  it('emits job-settled after releasing job resources', async () => {
    const mgr = new UploadManager({});
    let settled;
    mgr.on('job-settled', (event) => {
      settled = {
        ...event,
        activeJobs: mgr.activeJobs.size,
        abortControllers: mgr.jobAbortControllers.size
      };
    });

    await mgr.startBatch([{
      file: '/test/settled.mp4',
      hoster: 'doodstream.com',
      apiKey: 'key1',
      jobId: 'job-settled-1',
      sourceCleanupToken: 'cleanup-1'
    }]);

    assert.deepEqual(settled, {
      jobId: 'job-settled-1',
      sourceCleanupToken: 'cleanup-1',
      file: '/test/settled.mp4',
      hoster: 'doodstream.com',
      status: 'done',
      activeJobs: 0,
      abortControllers: 0
    });
  });

  it('records an unconfirmed host response as an error instead of done', async () => {
    mockUploadFile.mock.mockImplementation(async () => ({}));
    const mgr = new UploadManager({ 'doodstream.com': { retries: 0, parallelCount: 1, maxSpeedKbs: 0, restartBelowKbs: 0, timeIntervalSec: 0, maxSizeMb: 0 } });
    const statuses = [];
    let settled;
    mgr.on('progress', data => statuses.push(data.status));
    mgr.on('job-settled', event => { settled = event; });

    await mgr.startBatch([{
      file: '/test/unconfirmed.mp4',
      hoster: 'doodstream.com',
      apiKey: 'key1',
      jobId: 'job-unconfirmed',
      sourceCleanupToken: 'cleanup-unconfirmed'
    }]);

    assert.equal(statuses.includes('done'), false);
    assert.equal(statuses.at(-1), 'error');
    assert.equal(settled.status, 'error');
  });

  it('replaces account pools and clears cached account state after an import', () => {
    const mgr = new UploadManager({}, {}, {
      'byse.sx': [{ id: 'old', apiKey: 'old-key' }]
    });
    mgr.switchAccount('byse.sx', { id: 'fallback', apiKey: 'fallback-key' });
    mgr._failedAccounts.set('byse.sx:old', true);
    mgr._suspectSizeMemo.set('byse.sx:old', { size: 1, count: 2 });
    mgr._suspectGoodAccounts.set('byse.sx', 'old');
    mgr._doodApiKeyCache.set('old', 'cached-key');
    mgr._baselineCache.set('byse.sx:old-key', Promise.resolve(new Set()));

    mgr.replaceAccountPools({
      'byse.sx': [{ id: 'new', apiKey: 'new-key' }]
    });

    assert.deepEqual(mgr.accountPools['byse.sx'], [{ id: 'new', apiKey: 'new-key' }]);
    assert.equal(mgr.getFailedAccountKeys().length, 0);
    assert.equal(mgr.getOverride('byse.sx'), null);
    assert.equal(mgr._suspectSizeMemo.size, 0);
    assert.equal(mgr._suspectGoodAccounts.size, 0);
    assert.equal(mgr._doodApiKeyCache.size, 0);
    assert.equal(mgr._baselineCache.size, 0);
  });

  it('emits batch-done with correct summary', async () => {
    const mgr = new UploadManager({});
    let summary = null;
    mgr.on('batch-done', (s) => { summary = s; });

    await mgr.startBatch([
      { file: '/test/video1.mp4', hoster: 'doodstream.com', apiKey: 'key1' },
      { file: '/test/video2.mp4', hoster: 'doodstream.com', apiKey: 'key1' }
    ]);

    assert.ok(summary);
    assert.equal(summary.total, 2);
    assert.equal(summary.succeeded, 2);
    assert.equal(summary.failed, 0);
    assert.equal(summary.files.length, 2);
    assert.ok(summary.files.flatMap(file => file.results).every(result => typeof result.jobId === 'string' && result.jobId.length > 0));
  });

  it('emits a final idle stats snapshot after a normal batch', async () => {
    const mgr = new UploadManager({});
    const states = [];
    mgr.on('stats', (stats) => states.push(stats.state));

    await mgr.startBatch([
      { file: '/test/video.mp4', hoster: 'doodstream.com', apiKey: 'key1' }
    ]);

    assert.equal(states.at(-1), 'idle');
    assert.equal(mgr.statsInterval, null);
  });

  it('retries on failure then succeeds', async () => {
    let callCount = 0;
    mockUploadFile.mock.mockImplementation(async (hoster, filePath, apiKey, onProgress) => {
      callCount++;
      if (callCount <= 2) throw new Error('network error');
      if (onProgress) onProgress(fakeFileSize, fakeFileSize);
      return { download_url: `https://${hoster}/d/ok123`, embed_url: null, file_code: 'ok123' };
    });

    const mgr = new UploadManager({ 'doodstream.com': { retries: 3, parallelCount: 1, maxSpeedKbs: 0, restartBelowKbs: 0, timeIntervalSec: 0, maxSizeMb: 0 } });
    const statuses = [];
    mgr.on('progress', (d) => statuses.push(d.status));

    await mgr.startBatch([
      { file: '/test/video.mp4', hoster: 'doodstream.com', apiKey: 'key1' }
    ]);

    assert.ok(statuses.includes('retrying'), 'should show retrying status');
    assert.ok(statuses.includes('done'), 'should eventually succeed');
    assert.equal(callCount, 3);
  });

  it('exhausted retries result in error', async () => {
    mockUploadFile.mock.mockImplementation(async () => {
      throw new Error('permanent failure');
    });

    const mgr = new UploadManager({ 'doodstream.com': { retries: 1, parallelCount: 1, maxSpeedKbs: 0, restartBelowKbs: 0, timeIntervalSec: 0, maxSizeMb: 0 } });
    let summary = null;
    mgr.on('batch-done', (s) => { summary = s; });

    await mgr.startBatch([
      { file: '/test/video.mp4', hoster: 'doodstream.com', apiKey: 'key1' }
    ]);

    assert.ok(summary);
    assert.equal(summary.failed, 1);
    assert.equal(summary.succeeded, 0);
  });

  it('stores only sanitized hoster diagnostics in rotation logs', async () => {
    const error = new Error('Upload rejected');
    error.fileRejected = true;
    error.diagnostic = {
      http: 403,
      contentType: 'application/json',
      payloadSnippet: 'token=very-secret https://cdn.example.test/upload?apiKey=also-secret'
    };
    mockUploadFile.mock.mockImplementation(async () => { throw error; });

    const mgr = new UploadManager({ 'doodstream.com': { retries: 0, parallelCount: 1, maxSpeedKbs: 0, restartBelowKbs: 0, timeIntervalSec: 0, maxSizeMb: 0 } });
    const logs = [];
    mgr.on('rot-log', (entry) => logs.push(entry));

    await mgr.startBatch([{ file: '/test/diagnostic.mp4', hoster: 'doodstream.com', apiKey: 'key1' }]);

    const failure = logs.find(entry => entry.event === 'upload-failure');
    assert.equal(failure.payloadSnippet, 'token=[redacted] cdn.example.test/upload');
  });

  it('cancel aborts running uploads', async () => {
    mockUploadFile.mock.mockImplementation(async (hoster, filePath, apiKey, onProgress, signal) => {
      // Simulate a slow upload
      await new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ download_url: 'https://doodstream.com/d/ok123', embed_url: null, file_code: 'ok123' }), 10000);
        if (signal) signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('Aborted')); });
      });
    });

    const mgr = new UploadManager({});
    let batchDone = false;
    const snapshots = [];
    mgr.on('batch-done', () => { batchDone = true; });
    mgr.on('stats', (stats) => snapshots.push({ ...stats }));

    const batchPromise = mgr.startBatch([
      { file: '/test/video.mp4', hoster: 'doodstream.com', apiKey: 'key1' }
    ]);

    // Wait a bit then cancel
    await new Promise(r => setTimeout(r, 100));
    mgr.cancel();
    const cancellingSnapshot = snapshots.at(-1);

    await batchPromise;
    assert.equal(mgr.running, false);
    assert.ok(batchDone, 'batch-done should be emitted even after cancel');
    assert.equal(cancellingSnapshot.state, 'stopping');
    assert.ok(cancellingSnapshot.activeJobs > 0);
    assert.equal(snapshots.at(-1).state, 'idle');
    assert.equal(snapshots.at(-1).activeJobs, 0);
    assert.equal(mgr.statsInterval, null);
  });

  it('does not emit one aborted progress event per job when cancelling a whole batch', async () => {
    mockUploadFile.mock.mockImplementation(async (hoster, filePath, apiKey, onProgress, signal) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 10000);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('Aborted'));
        }, { once: true });
      });
      return { download_url: `https://${hoster}/d/ok123`, embed_url: null, file_code: 'ok123' };
    });

    const mgr = new UploadManager({
      'doodstream.com': { retries: 0, parallelCount: 1, maxSpeedKbs: 0, restartBelowKbs: 0, timeIntervalSec: 0, maxSizeMb: 0 }
    });
    const statuses = [];
    mgr.on('progress', (data) => statuses.push(data.status));

    const tasks = Array.from({ length: 60 }, (_, index) => ({
      jobId: `cancel-${index}`,
      file: `/test/cancel-${index}.mp4`,
      hoster: 'doodstream.com',
      apiKey: 'key1'
    }));
    const batchPromise = mgr.startBatch(tasks);

    await new Promise((resolve) => setTimeout(resolve, 50));
    mgr.cancel();
    await batchPromise;

    assert.equal(statuses.filter((status) => status === 'aborted').length, 0);
  });

  it('cancels one selected job followed by all 100 active uploads without retaining resources', async () => {
    let active = 0;
    let started = 0;
    mockUploadFile.mock.mockImplementation(async (hoster, filePath, apiKey, onProgress, signal) => {
      started++;
      active++;
      await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          active--;
          reject(new Error('Aborted'));
        }, { once: true });
      });
    });

    const mgr = new UploadManager({
      'doodstream.com': { retries: 0, parallelCount: 100, maxSpeedKbs: 0, restartBelowKbs: 0, timeIntervalSec: 0, maxSizeMb: 0 }
    }, { parallelUploadCount: 100 });
    const tasks = Array.from({ length: 100 }, (_, index) => ({
      jobId: `active-cancel-${index}`,
      file: `/test/active-cancel-${index}.mp4`,
      hoster: 'doodstream.com',
      apiKey: 'key1'
    }));
    const batchPromise = mgr.startBatch(tasks);

    for (let attempt = 0; attempt < 200 && started < 100; attempt++) {
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(started, 100);
    assert.equal(active, 100);

    const cancelStartedAt = performance.now();
    mgr.cancelJobs(['active-cancel-0']);
    mgr.cancel();
    await batchPromise;
    const cancelDuration = performance.now() - cancelStartedAt;

    assert.ok(cancelDuration < 1000, `cancel took ${cancelDuration.toFixed(1)}ms`);
    assert.equal(active, 0);
    assert.equal(mgr.running, false);
    assert.equal(mgr.jobAbortControllers.size, 0);
    assert.equal(mgr.statsInterval, null);
  });

  it('maxSizeMb filter skips oversized files', async () => {
    fakeFileSize = 5 * 1024 * 1024; // 5 MB

    const mgr = new UploadManager({ 'doodstream.com': { retries: 0, parallelCount: 1, maxSpeedKbs: 0, restartBelowKbs: 0, timeIntervalSec: 0, maxSizeMb: 1 } });
    const statuses = [];
    mgr.on('progress', (d) => statuses.push(d.status));

    await mgr.startBatch([
      { file: '/test/big.mp4', hoster: 'doodstream.com', apiKey: 'key1' }
    ]);

    assert.ok(statuses.includes('skipped'), 'oversized file should be skipped');
    assert.ok(!statuses.includes('uploading'), 'should not attempt upload');
  });

  it('per-hoster semaphore limits concurrency', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    mockUploadFile.mock.mockImplementation(async (hoster, filePath, apiKey, onProgress, signal) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise(r => setTimeout(r, 50));
      concurrent--;
      if (onProgress) onProgress(fakeFileSize, fakeFileSize);
      return { download_url: `https://${hoster}/d/ok123`, embed_url: null, file_code: 'ok123' };
    });

    const mgr = new UploadManager({ 'doodstream.com': { retries: 0, parallelCount: 1, maxSpeedKbs: 0, restartBelowKbs: 0, timeIntervalSec: 0, maxSizeMb: 0 } });

    await mgr.startBatch([
      { file: '/test/a.mp4', hoster: 'doodstream.com', apiKey: 'k' },
      { file: '/test/b.mp4', hoster: 'doodstream.com', apiKey: 'k' },
      { file: '/test/c.mp4', hoster: 'doodstream.com', apiKey: 'k' }
    ]);

    assert.equal(maxConcurrent, 1, 'should only run 1 upload at a time');
  });

  it('global parallel limit caps concurrency across hosters', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    mockUploadFile.mock.mockImplementation(async (hoster, filePath, apiKey, onProgress) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 40));
      concurrent--;
      if (onProgress) onProgress(fakeFileSize, fakeFileSize);
      return { download_url: `https://${hoster}/d/ok123`, embed_url: null, file_code: 'ok123' };
    });

    const mgr = new UploadManager({
      'doodstream.com': { retries: 0, parallelCount: 5, maxSpeedKbs: 0, restartBelowKbs: 0, timeIntervalSec: 0, maxSizeMb: 0 },
      'voe.sx': { retries: 0, parallelCount: 5, maxSpeedKbs: 0, restartBelowKbs: 0, timeIntervalSec: 0, maxSizeMb: 0 },
      'vidmoly.me': { retries: 0, parallelCount: 5, maxSpeedKbs: 0, restartBelowKbs: 0, timeIntervalSec: 0, maxSizeMb: 0 }
    }, {
      parallelUploadCount: 2,
      scaleParallelUploads: true
    });

    await mgr.startBatch([
      { jobId: 'job-1', file: '/test/a.mp4', hoster: 'doodstream.com', apiKey: 'k' },
      { jobId: 'job-2', file: '/test/b.mp4', hoster: 'voe.sx', apiKey: 'k' },
      { jobId: 'job-3', file: '/test/c.mp4', hoster: 'vidmoly.me', apiKey: 'k' }
    ]);

    assert.equal(maxConcurrent, 2, 'should only run 2 uploads globally at once');
  });

  it('cancelJobs aborts a selected running upload', async () => {
    mockUploadFile.mock.mockImplementation(async (hoster, filePath, apiKey, onProgress, signal) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(), 250);
        if (signal) {
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('Aborted'));
          }, { once: true });
        }
      });
      if (onProgress) onProgress(fakeFileSize, fakeFileSize);
      return { download_url: `https://${hoster}/d/ok123`, embed_url: null, file_code: 'ok123' };
    });

    const mgr = new UploadManager({});
    const statuses = [];
    mgr.on('progress', (data) => statuses.push({ jobId: data.jobId, status: data.status }));

    const batchPromise = mgr.startBatch([
      { jobId: 'selected-job', file: '/test/video.mp4', hoster: 'doodstream.com', apiKey: 'key1' }
    ]);

    await new Promise((resolve) => setTimeout(resolve, 50));
    mgr.cancelJobs(['selected-job']);

    await batchPromise;
    assert.ok(statuses.some((entry) => entry.jobId === 'selected-job' && entry.status === 'aborted'));
  });

  it('cancelJobs prevents a not-yet-spawned job from starting', async () => {
    const mgr = new UploadManager({
      'doodstream.com': { retries: 0, parallelCount: 1, maxSpeedKbs: 0, restartBelowKbs: 0, timeIntervalSec: 0, maxSizeMb: 0 }
    });
    const settled = new Map();
    mgr.on('job-settled', (event) => settled.set(event.jobId, event.status));
    const tasks = Array.from({ length: 101 }, (_, index) => ({
      jobId: index === 100 ? 'late-cancelled-job' : `early-job-${index}`,
      file: `/test/chunk-${index}.mp4`,
      hoster: 'doodstream.com',
      apiKey: 'key1',
      sourceCleanupToken: `cleanup-${index}`
    }));

    const batchPromise = mgr.startBatch(tasks);
    mgr.cancelJobs(['late-cancelled-job']);
    await batchPromise;

    const lateCalls = mockUploadFile.mock.calls.filter((call) => call.arguments[1] === '/test/chunk-100.mp4');
    assert.equal(lateCalls.length, 0);
    assert.equal(settled.get('late-cancelled-job'), 'aborted');
  });

  it('cancel before startBatch prevents the reserved batch from uploading', async () => {
    const mgr = new UploadManager({});
    let summary = null;
    mgr.on('batch-done', (value) => { summary = value; });

    mgr.cancel();
    await mgr.startBatch([{
      jobId: 'prestart-cancelled-job',
      file: '/test/prestart-cancelled.mp4',
      hoster: 'doodstream.com',
      apiKey: 'key1',
      sourceCleanupToken: 'cleanup-prestart'
    }]);

    assert.equal(mockUploadFile.mock.calls.length, 0);
    assert.equal(summary.succeeded, 0);
  });

  it('cancelJobs before startBatch prevents the reserved job from uploading', async () => {
    const mgr = new UploadManager({});
    let summary = null;
    const settled = [];
    mgr.on('batch-done', (value) => { summary = value; });
    mgr.on('job-settled', (value) => settled.push(value));

    mgr.cancelJobs(['prestart-selected-job']);
    await mgr.startBatch([{
      jobId: 'prestart-selected-job',
      file: '/test/prestart-selected.mp4',
      hoster: 'doodstream.com',
      apiKey: 'key1',
      sourceCleanupToken: 'cleanup-prestart-selected'
    }]);

    assert.equal(mockUploadFile.mock.calls.length, 0);
    assert.equal(summary.succeeded, 0);
    assert.equal(settled.at(-1).status, 'aborted');
  });

  it('cancelJobs rejects a late success from an uploader that ignores abort', async () => {
    let releaseUpload;
    mockUploadFile.mock.mockImplementation(async () => new Promise((resolve) => {
      releaseUpload = () => resolve({ download_url: 'https://doodstream.com/d/late', embed_url: null, file_code: 'late' });
    }));
    const mgr = new UploadManager({});
    const settled = [];
    const progress = [];
    let summary = null;
    mgr.on('job-settled', (event) => settled.push(event));
    mgr.on('progress', (event) => progress.push(event));
    mgr.on('batch-done', (value) => { summary = value; });
    const batchPromise = mgr.startBatch([{
      jobId: 'late-success-job',
      file: '/test/late-success.mp4',
      hoster: 'doodstream.com',
      apiKey: 'key1',
      sourceCleanupToken: 'cleanup-late-success'
    }]);

    for (let index = 0; index < 50 && !releaseUpload; index++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    mgr.cancelJobs(['late-success-job']);
    releaseUpload();
    await batchPromise;

    assert.equal(settled.at(-1).status, 'aborted');
    assert.equal(progress.some(event => event.status === 'done'), false);
    assert.equal(summary.succeeded, 0);
  });

  it('late success after cancellation stays blocked by the real source cleanup gate', async (t) => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mhu-manager-cleanup-'));
    const file = path.join(directory, 'source.bin');
    await fs.promises.writeFile(file, Buffer.from('source-data'));
    t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));

    let releaseUpload;
    mockUploadFile.mock.mockImplementation(async () => new Promise((resolve) => {
      releaseUpload = () => resolve({ download_url: 'https://doodstream.com/d/late-cleanup', embed_url: null, file_code: 'late-cleanup' });
    }));

    const audits = [];
    const cleanup = createSourceFileCleanup({
      fs,
      path,
      platform: process.platform,
      isEnabled: () => true,
      audit: (event) => audits.push(event),
      journal: { plan: async () => {}, clear: async () => {} }
    });
    await cleanup.registerGroups([{
      token: 'cleanup-late-seam',
      file,
      requiredHosters: ['doodstream.com'],
      completedHosters: [],
      jobs: [{ jobId: 'late-cleanup-job', file, hoster: 'doodstream.com', status: 'pending' }]
    }]);

    const mgr = new UploadManager({});
    let settleChain = Promise.resolve();
    let summary = null;
    mgr.on('job-settled', (event) => {
      settleChain = settleChain.then(() => cleanup.settle(event));
    });
    mgr.on('batch-done', (value) => { summary = value; });

    const batchPromise = mgr.startBatch([{
      jobId: 'late-cleanup-job',
      file,
      hoster: 'doodstream.com',
      apiKey: 'key1',
      sourceCleanupToken: 'cleanup-late-seam'
    }]);
    for (let index = 0; index < 50 && !releaseUpload; index++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    mgr.cancelJobs(['late-cleanup-job']);
    releaseUpload();
    await batchPromise;
    await settleChain;
    const outcomes = await cleanup.finishBatch({ historyPersisted: true, queuePersisted: true });

    assert.equal(summary.succeeded, 0);
    assert.deepEqual(outcomes, ['blocked']);
    assert.equal(audits.at(-1).outcome, 'blocked');
    await fs.promises.access(file);
  });

  it('addJobs returns duplicate info and still runs newly queued jobs', async () => {
    let releaseFirst = null;

    mockUploadFile.mock.mockImplementation(async (hoster, filePath, apiKey, onProgress, signal) => {
      if (filePath.endsWith('/first.mp4')) {
        await new Promise((resolve, reject) => {
          releaseFirst = resolve;
          if (signal) {
            signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
          }
        });
      } else {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      if (onProgress) onProgress(fakeFileSize, fakeFileSize);
      return { download_url: `https://${hoster}/d/ok123`, embed_url: null, file_code: 'ok123' };
    });

    const mgr = new UploadManager({
      'doodstream.com': { retries: 0, parallelCount: 1, maxSpeedKbs: 0, restartBelowKbs: 0, timeIntervalSec: 0, maxSizeMb: 0 }
    });
    const statuses = [];
    mgr.on('progress', (data) => statuses.push({ jobId: data.jobId, status: data.status }));

    const batchPromise = mgr.startBatch([
      { jobId: 'job-first', file: '/test/first.mp4', hoster: 'doodstream.com', apiKey: 'key1' }
    ]);

    for (let i = 0; i < 50 && !releaseFirst; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(typeof releaseFirst, 'function', 'first job should be running before addJobs');

    const addResult = mgr.addJobs([
      { jobId: 'job-first', file: '/test/first.mp4', hoster: 'doodstream.com', apiKey: 'key1' },
      { jobId: 'job-second', file: '/test/second.mp4', hoster: 'doodstream.com', apiKey: 'key1' },
      { jobId: 'job-third', file: '/test/third.mp4', hoster: 'doodstream.com', apiKey: 'key1' }
    ]);

    assert.equal(addResult.added, 2);
    assert.deepEqual(addResult.alreadyInBatchJobIds, ['job-first']);

    releaseFirst();
    await batchPromise;

    assert.ok(statuses.some((entry) => entry.jobId === 'job-second' && entry.status === 'done'));
    assert.ok(statuses.some((entry) => entry.jobId === 'job-third' && entry.status === 'done'));
  });

  it('_combineSignals propagates abort from either source', () => {
    const mgr = new UploadManager({});
    const ac1 = new AbortController();
    const ac2 = new AbortController();

    const { signal, cleanup } = mgr._combineSignals(ac1.signal, ac2.signal);
    assert.equal(signal.aborted, false);

    ac2.abort();
    assert.equal(signal.aborted, true);
    cleanup();
  });

  it('_combineSignals returns aborted signal if input already aborted', () => {
    const mgr = new UploadManager({});
    const ac1 = new AbortController();
    ac1.abort();
    const ac2 = new AbortController();

    const { signal, cleanup } = mgr._combineSignals(ac1.signal, ac2.signal);
    assert.equal(signal.aborted, true);
    cleanup();
  });

  it('_sleep resolves after delay', async () => {
    const mgr = new UploadManager({});
    const start = Date.now();
    await mgr._sleep(100);
    assert.ok(Date.now() - start >= 90);
  });

  it('_sleep rejects on abort', async () => {
    const mgr = new UploadManager({});
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 10);
    await assert.rejects(mgr._sleep(5000, ac.signal), /Aborted/);
  });

  it('file not found produces descriptive error', async () => {
    // Override fs.promises.stat to throw ENOENT for a specific path
    const fs = require('fs');
    const origStat = fs.promises.stat;
    fs.promises.stat = async function(p) {
      if (p === '/test/deleted.mp4') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return origStat.call(this, p);
    };

    const mgr = new UploadManager({});
    const errors = [];
    let summary;
    mgr.on('progress', (d) => { if (d.error) errors.push(d.error); });
    mgr.on('batch-done', value => { summary = value; });

    await mgr.startBatch([
      { file: '/test/deleted.mp4', hoster: 'doodstream.com', apiKey: 'key1' }
    ]);

    fs.promises.stat = origStat;
    assert.ok(errors.some(e => e.includes('nicht gefunden')), `expected "nicht gefunden" error, got: ${errors.join(', ')}`);
    assert.equal(summary.files[0].results[0].status, 'skipped');
    assert.equal(summary.skipped, 1);
    assert.equal(summary.failed, 0);
  });

  it('zero-byte file produces descriptive error', async () => {
    fakeFileSize = 0;

    const mgr = new UploadManager({});
    const errors = [];
    mgr.on('progress', (d) => { if (d.error) errors.push(d.error); });

    await mgr.startBatch([
      { file: '/test/empty.mp4', hoster: 'doodstream.com', apiKey: 'key1' }
    ]);

    assert.ok(errors.some(e => e.includes('0 Bytes')), `expected "0 Bytes" error, got: ${errors.join(', ')}`);
  });

  it('empty batch completes immediately with zero counts', async () => {
    const mgr = new UploadManager({});
    let summary = null;
    mgr.on('batch-done', (s) => { summary = s; });

    const start = Date.now();
    await mgr.startBatch([]);
    const elapsed = Date.now() - start;

    assert.ok(summary, 'batch-done should be emitted');
    assert.equal(summary.total, 0);
    assert.equal(summary.succeeded, 0);
    assert.equal(summary.failed, 0);
    assert.ok(elapsed < 200, `empty batch should complete fast, took ${elapsed}ms`);
  });

  it('scaleParallelUploads limits per-hoster count to global limit', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    mockUploadFile.mock.mockImplementation(async (hoster, filePath, apiKey, onProgress) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise(r => setTimeout(r, 40));
      concurrent--;
      if (onProgress) onProgress(fakeFileSize, fakeFileSize);
      return { download_url: `https://${hoster}/d/ok123`, embed_url: null, file_code: 'ok123' };
    });

    const mgr = new UploadManager(
      { 'doodstream.com': { retries: 0, parallelCount: 10, maxSpeedKbs: 0, restartBelowKbs: 0, timeIntervalSec: 0, maxSizeMb: 0 } },
      { parallelUploadCount: 2, scaleParallelUploads: true }
    );

    await mgr.startBatch([
      { file: '/test/a.mp4', hoster: 'doodstream.com', apiKey: 'k' },
      { file: '/test/b.mp4', hoster: 'doodstream.com', apiKey: 'k' },
      { file: '/test/c.mp4', hoster: 'doodstream.com', apiKey: 'k' },
      { file: '/test/d.mp4', hoster: 'doodstream.com', apiKey: 'k' },
      { file: '/test/e.mp4', hoster: 'doodstream.com', apiKey: 'k' }
    ]);

    assert.ok(maxConcurrent <= 2, `scaleParallelUploads should cap at 2, was ${maxConcurrent}`);
  });

  it('addJobs injects new tasks into running batch', async () => {
    let started = 0;
    mockUploadFile.mock.mockImplementation(async (hoster, filePath, apiKey, onProgress) => {
      started++;
      await new Promise(r => setTimeout(r, 100));
      if (onProgress) onProgress(fakeFileSize, fakeFileSize);
      return { download_url: `https://${hoster}/d/ok123`, embed_url: null, file_code: 'ok123' };
    });

    const mgr = new UploadManager({});
    let summary = null;
    mgr.on('batch-done', (s) => { summary = s; });

    // Start batch with 2 tasks
    const batchPromise = mgr.startBatch([
      { jobId: 'job-1', file: '/test/a.mp4', hoster: 'doodstream.com', apiKey: 'k' },
      { jobId: 'job-2', file: '/test/b.mp4', hoster: 'doodstream.com', apiKey: 'k' }
    ]);

    // After 30ms (during upload), inject 2 more tasks
    await new Promise(r => setTimeout(r, 30));
    const result = mgr.addJobs([
      { jobId: 'job-3', file: '/test/c.mp4', hoster: 'doodstream.com', apiKey: 'k' },
      { jobId: 'job-4', file: '/test/d.mp4', hoster: 'doodstream.com', apiKey: 'k' }
    ]);
    assert.equal(result.added, 2, 'should add 2 new jobs');
    assert.equal(result.alreadyInBatchJobIds.length, 0);

    await batchPromise;
    assert.ok(summary);
    assert.equal(started, 4, 'all 4 jobs should have run');
  });

  it('addJobs rejects duplicates already in running batch', async () => {
    mockUploadFile.mock.mockImplementation(async (hoster, filePath, apiKey, onProgress, signal) => {
      // Slow upload so we can add jobs while it's running
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 200);
        if (signal) signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('Aborted')); });
      });
      if (onProgress) onProgress(fakeFileSize, fakeFileSize);
      return { download_url: `https://${hoster}/d/ok123`, embed_url: null, file_code: 'ok123' };
    });

    const mgr = new UploadManager({});
    const batchPromise = mgr.startBatch([
      { jobId: 'job-A', file: '/test/x.mp4', hoster: 'doodstream.com', apiKey: 'k' }
    ]);

    // Try to add the SAME jobId while it's running
    await new Promise(r => setTimeout(r, 50));
    const result = mgr.addJobs([
      { jobId: 'job-A', file: '/test/x.mp4', hoster: 'doodstream.com', apiKey: 'k' },
      { jobId: 'job-B', file: '/test/y.mp4', hoster: 'doodstream.com', apiKey: 'k' }
    ]);
    assert.equal(result.added, 1, 'should skip duplicate jobId, add only the new one');
    assert.deepEqual(result.alreadyInBatchJobIds, ['job-A']);

    await batchPromise;
  });

  it('addJobs returns added=0 when not running', () => {
    const mgr = new UploadManager({});
    const result = mgr.addJobs([
      { jobId: 'job-1', file: '/test/a.mp4', hoster: 'doodstream.com', apiKey: 'k' }
    ]);
    assert.equal(result.added, 0);
  });

  it('stats event contains expected fields', async () => {
    // Make upload take long enough for stats interval to fire
    mockUploadFile.mock.mockImplementation(async (hoster, filePath, apiKey, onProgress, signal) => {
      await new Promise(r => setTimeout(r, 1500));
      if (onProgress) onProgress(fakeFileSize, fakeFileSize);
      return { download_url: `https://${hoster}/d/ok123`, embed_url: null, file_code: 'ok123' };
    });

    const mgr = new UploadManager({});
    const statsEvents = [];
    mgr.on('stats', (d) => statsEvents.push(d));

    await mgr.startBatch([
      { file: '/test/video.mp4', hoster: 'doodstream.com', apiKey: 'key1' }
    ]);

    assert.ok(statsEvents.length > 0, 'should have received stats events');
    const stat = statsEvents[0];
    assert.ok('globalSpeedKbs' in stat);
    assert.ok('totalBytes' in stat);
    assert.ok('elapsed' in stat);
    assert.ok('activeJobs' in stat);
  });

  describe('error classification', () => {
    it('treats "not enough disk space" as account-level, not file-rejected', () => {
      const mgr = new UploadManager({});
      // Shape matches what lib/hosters.js attaches for byse account-storage-full
      const err = new Error('Byse lehnte Datei ab: 0:0:0:not enough disk space on your account');
      err.accountError = true;
      assert.equal(mgr._isFileRejectedError(err), false,
        'account-level error must NOT be classified as file-rejected');
      assert.equal(mgr._shouldSkipRetryOnAccountError(err), true,
        'account-storage-full must trigger account rotation');
    });

    it('classifies disk-space errors by message alone (safety net)', () => {
      const mgr = new UploadManager({});
      const err = new Error('Byse lehnte Datei ab: not enough disk space');
      // No flag set — regex alone must catch it.
      assert.equal(mgr._shouldSkipRetryOnAccountError(err), true);
      assert.equal(mgr._isFileRejectedError(err), false,
        'must not match generic "lehnte Datei ab" as file-rejected');
    });

    it('keeps true file rejections as file-rejected', () => {
      const mgr = new UploadManager({});
      const err = new Error('Byse lehnte Datei ab: Duplicate');
      err.fileRejected = true;
      assert.equal(mgr._isFileRejectedError(err), true);
      assert.equal(mgr._shouldSkipRetryOnAccountError(err), false);
    });

    it('file-rejected regex still matches known phrases without flag', () => {
      const mgr = new UploadManager({});
      for (const msg of [
        'Not video file format',
        'Duplicate',
        'Datei zu klein',
        'File too large',
        'Invalid file'
      ]) {
        assert.equal(mgr._isFileRejectedError(new Error(msg)), true, `should match: ${msg}`);
      }
    });

    it('accountError flag beats fileRejected if both set (defensive)', () => {
      const mgr = new UploadManager({});
      const err = new Error('weird');
      err.fileRejected = true;
      err.accountError = true;
      assert.equal(mgr._isFileRejectedError(err), false,
        'account-level always wins — rotation must happen');
      assert.equal(mgr._shouldSkipRetryOnAccountError(err), true);
    });
  });

  describe('session-level account memory', () => {
    // Scenario: user has 2 byse accounts. Account 1 is full ("not enough
    // disk space"). First job fails on acc1 → rotation to acc2. Second job
    // must NOT re-probe acc1; pre-job-swap has to kick in.
    it('after account is marked failed, next job swaps straight to override without retrying acc1', async () => {
      // Only acc1 throws disk-space; acc2 succeeds. Mock decides by apiKey.
      mockUploadFile.mock.mockImplementation(async (hoster, filePath, apiKey, onProgress) => {
        if (apiKey === 'acc1-key') {
          const err = new Error('Byse lehnte Datei ab: 0:0:0:not enough disk space on your account');
          err.accountError = true;
          throw err;
        }
        if (onProgress) onProgress(fakeFileSize, fakeFileSize);
        return { download_url: 'https://byse.sx/d/ok123', embed_url: null, file_code: 'ok123' };
      });

      const mgr = new UploadManager(
        { 'byse.sx': { retries: 3, parallelCount: 1, maxSpeedKbs: 0, restartBelowKbs: 0, timeIntervalSec: 0, maxSizeMb: 0 } }
      );

      // Simulate main.js: on account-failed, resolve fallback → switchAccount
      mgr.on('account-failed', ({ hoster, accountId }) => {
        mgr.switchAccount(hoster, { id: 'acc2', username: 'u2', password: 'p2', apiKey: 'acc2-key' });
      });

      const rotEvents = [];
      mgr.on('rot-log', (e) => rotEvents.push(e));
      const progress = [];
      mgr.on('progress', (d) => progress.push({ fileName: d.fileName, status: d.status, error: d.error }));

      await mgr.startBatch([
        { file: '/test/a.mp4', hoster: 'byse.sx', apiKey: 'acc1-key', accountId: 'acc1', username: 'u1', password: 'p1' },
        { file: '/test/b.mp4', hoster: 'byse.sx', apiKey: 'acc1-key', accountId: 'acc1', username: 'u1', password: 'p1' }
      ]);

      // Event sequence we expect:
      //  - job A: fast-fail on acc1 → mark-failed → switchAccount → rotate → upload with acc2 → done
      //  - job B: pre-job-swap from acc1 → acc2 (no attempts on acc1!) → done
      const events = rotEvents.map(e => e.event);
      assert.ok(events.includes('fast-fail'), `expected fast-fail, got: ${events.join(',')}`);
      assert.ok(events.includes('mark-failed'), `expected mark-failed, got: ${events.join(',')}`);
      assert.ok(events.includes('switchAccount'), `expected switchAccount, got: ${events.join(',')}`);
      assert.ok(events.includes('pre-job-swap'), `expected pre-job-swap for 2nd job, got: ${events.join(',')}`);

      // job B's pre-job-swap MUST predate any upload attempt for /test/b.mp4.
      // If acc1 was probed for B, the mock would have thrown and we'd see
      // another fast-fail or retrying event for b.mp4.
      const bProgressErrors = progress
        .filter(p => p.fileName && p.fileName.includes('b.mp4') && p.error)
        .map(p => p.error);
      assert.equal(bProgressErrors.length, 0,
        `job B should never have touched acc1; got errors: ${bProgressErrors.join(' | ')}`);

      // Both jobs should be done at the end.
      const doneFiles = progress.filter(p => p.status === 'done').map(p => p.fileName);
      assert.ok(doneFiles.some(f => f && f.includes('a.mp4')), 'a.mp4 should finish via rotation');
      assert.ok(doneFiles.some(f => f && f.includes('b.mp4')), 'b.mp4 should finish via pre-job-swap');

      // Sanity: mock was called with acc2-key more often than acc1-key.
      const byKey = { acc1: 0, acc2: 0 };
      for (const call of mockUploadFile.mock.calls) {
        if (call.arguments[2] === 'acc1-key') byKey.acc1++;
        else if (call.arguments[2] === 'acc2-key') byKey.acc2++;
      }
      assert.ok(byKey.acc1 <= 1, `acc1 should only be tried once (for job A); got ${byKey.acc1}`);
      assert.ok(byKey.acc2 >= 2, `acc2 should handle both jobs after rotation; got ${byKey.acc2}`);
    });

    it('on fresh UploadManager (simulates app restart), failed-account memory is gone', () => {
      const mgr1 = new UploadManager({});
      mgr1._failedAccounts.set('byse.sx:acc1', true);
      mgr1.switchAccount('byse.sx', { id: 'acc2' });
      assert.equal(mgr1._failedAccounts.size, 1);
      assert.equal(mgr1._accountOverrides.size, 1);

      const mgr2 = new UploadManager({});
      assert.equal(mgr2._failedAccounts.size, 0, 'new manager must start clean');
      assert.equal(mgr2._accountOverrides.size, 0, 'override map must be empty on fresh manager');
    });

    it('exposes failed-account introspection (for main.js mid-batch re-resolve)', () => {
      const mgr = new UploadManager({});
      assert.deepEqual(mgr.getFailedAccountKeys(), []);
      assert.equal(mgr.getOverride('byse.sx'), null);

      mgr._failedAccounts.set('byse.sx:acc1', true);
      mgr._failedAccounts.set('voe.sx:other', true);
      assert.deepEqual(mgr.getFailedAccountKeys().sort(), ['byse.sx:acc1', 'voe.sx:other']);
      assert.equal(mgr.getOverride('byse.sx'), null, 'no override yet');

      mgr.switchAccount('byse.sx', { id: 'acc2', apiKey: 'k2' });
      assert.equal(mgr.getOverride('byse.sx').id, 'acc2');
      assert.equal(mgr.getOverride('voe.sx'), null, 'unrelated hoster still has no override');
    });

    it('startBatch primes failed-accounts + overrides — retry after batch-done skips dead account', async () => {
      // acc1 fails with disk-space; acc2 succeeds.
      mockUploadFile.mock.mockImplementation(async (hoster, filePath, apiKey, onProgress) => {
        if (apiKey === 'acc1-key') {
          const err = new Error('Byse lehnte Datei ab: not enough disk space');
          err.accountError = true;
          throw err;
        }
        if (onProgress) onProgress(fakeFileSize, fakeFileSize);
        return { download_url: `https://${hoster}/d/ok123`, embed_url: null, file_code: 'ok123' };
      });

      const mgr = new UploadManager(
        { 'byse.sx': { retries: 3, parallelCount: 1, maxSpeedKbs: 0, restartBelowKbs: 0, timeIntervalSec: 0, maxSizeMb: 0 } }
      );
      const rotEvents = [];
      mgr.on('rot-log', (e) => rotEvents.push(e));

      // Simulate a retry-after-batch-done: main.js would pass the
      // session-cached failed-accounts + overrides from the previous batch.
      await mgr.startBatch([
        { file: '/test/a.mp4', hoster: 'byse.sx', apiKey: 'acc1-key', accountId: 'acc1', username: 'u1', password: 'p1' }
      ], {
        primeFailedAccounts: ['byse.sx:acc1'],
        primeOverrides: [['byse.sx', { id: 'acc2', username: 'u2', password: 'p2', apiKey: 'acc2-key' }]]
      });

      const events = rotEvents.map(e => e.event);
      // pre-job-swap should fire on the very first attempt — no fast-fail
      // because acc1 was never touched.
      assert.ok(events.includes('pre-job-swap'),
        `expected pre-job-swap from primed state; got: ${events.join(',')}`);
      assert.ok(!events.includes('fast-fail'),
        `must NOT burn a fast-fail on primed-dead acc1; got: ${events.join(',')}`);
      assert.ok(!events.includes('mark-failed'),
        `acc1 was already marked failed (primed); must not emit mark-failed again; got: ${events.join(',')}`);

      // acc1 must not be touched at all.
      const acc1Calls = mockUploadFile.mock.calls.filter(c => c.arguments[2] === 'acc1-key').length;
      assert.equal(acc1Calls, 0, 'primed-dead acc1 must not receive any upload attempts');
    });

    it('generic error + pre-resolved override: rotates after 1 attempt (no more 5x on primary)', async () => {
      // acc1 throws a generic non-transient, non-account-specific error.
      // acc2 succeeds. With a pre-resolved override (from main.js at batch
      // start), the retry loop must break after 1 attempt on acc1 and rotate.
      let acc1Calls = 0;
      let acc2Calls = 0;
      mockUploadFile.mock.mockImplementation(async (hoster, filePath, apiKey, onProgress) => {
        if (apiKey === 'acc1-key') {
          acc1Calls++;
          throw new Error('VOE Upload: irgendein generischer Fehler');
        }
        acc2Calls++;
        if (onProgress) onProgress(fakeFileSize, fakeFileSize);
        return { download_url: `https://${hoster}/d/ok123`, embed_url: null, file_code: 'ok123' };
      });

      const mgr = new UploadManager(
        { 'voe.sx': { retries: 5, parallelCount: 1, maxSpeedKbs: 0, restartBelowKbs: 0, timeIntervalSec: 0, maxSizeMb: 0 } }
      );
      const events = [];
      mgr.on('rot-log', (e) => events.push(e.event));

      await mgr.startBatch([
        { file: '/test/a.mp4', hoster: 'voe.sx', apiKey: 'acc1-key', accountId: 'acc1' }
      ], {
        // Main.js pre-resolves the fallback at batch start.
        primeOverrides: [['voe.sx', { id: 'acc2', apiKey: 'acc2-key' }]]
      });

      assert.equal(acc1Calls, 1, 'acc1 must get exactly 1 attempt before rotation kicks in');
      assert.ok(acc2Calls >= 1, 'acc2 must take over');
      assert.ok(events.includes('try-alternate-after-fail'),
        `expected try-alternate-after-fail; got: ${events.join(',')}`);
    });

    it('transient error + pre-resolved override: retries SAME acc (network, not acc, is the issue)', async () => {
      let acc1Calls = 0;
      let acc2Calls = 0;
      mockUploadFile.mock.mockImplementation(async (hoster, filePath, apiKey, onProgress) => {
        if (apiKey === 'acc1-key') {
          acc1Calls++;
          if (acc1Calls <= 2) throw new Error('connect ECONNRESET 1.2.3.4:443');
          if (onProgress) onProgress(fakeFileSize, fakeFileSize);
          return { download_url: 'https://voe.sx/ok123', embed_url: null, file_code: 'ok123' };
        }
        acc2Calls++;
        if (onProgress) onProgress(fakeFileSize, fakeFileSize);
        return { download_url: `https://${hoster}/d/ok123`, embed_url: null, file_code: 'ok123' };
      });

      const mgr = new UploadManager(
        { 'voe.sx': { retries: 5, parallelCount: 1, maxSpeedKbs: 0, restartBelowKbs: 0, timeIntervalSec: 0, maxSizeMb: 0 } }
      );
      const events = [];
      mgr.on('rot-log', (e) => events.push(e.event));

      await mgr.startBatch([
        { file: '/test/a.mp4', hoster: 'voe.sx', apiKey: 'acc1-key', accountId: 'acc1' }
      ], {
        primeOverrides: [['voe.sx', { id: 'acc2', apiKey: 'acc2-key' }]]
      });

      assert.equal(acc1Calls, 3, 'transient must retry same acc until success');
      assert.equal(acc2Calls, 0, 'must NOT rotate away on transient network errors');
      assert.ok(!events.includes('try-alternate-after-fail'),
        `transient should NOT trigger try-alternate-after-fail; got: ${events.join(',')}`);
    });

    it('generic error + NO override: falls back to classic retry on same account', async () => {
      let acc1Calls = 0;
      mockUploadFile.mock.mockImplementation(async (hoster, filePath, apiKey, onProgress) => {
        acc1Calls++;
        throw new Error('something generic');
      });

      const mgr = new UploadManager(
        { 'voe.sx': { retries: 3, parallelCount: 1, maxSpeedKbs: 0, restartBelowKbs: 0, timeIntervalSec: 0, maxSizeMb: 0 } }
      );

      await mgr.startBatch([
        { file: '/test/a.mp4', hoster: 'voe.sx', apiKey: 'acc1-key', accountId: 'acc1' }
      ]);

      // retries=3 → maxAttempts=4 (retries + 1). Without an override to rotate
      // to, must exhaust all 4 attempts on acc1.
      assert.equal(acc1Calls, 4, 'single-account hoster must retry N+1 times on same account');
    });

    it('startBatch without prime opts still clears state (back-compat)', async () => {
      const mgr = new UploadManager({});
      mgr._failedAccounts.set('byse.sx:acc1', true);
      mgr._accountOverrides.set('byse.sx', { id: 'leftover' });

      mockUploadFile.mock.mockImplementation(async (hoster, filePath, apiKey, onProgress) => {
        if (onProgress) onProgress(fakeFileSize, fakeFileSize);
        return { download_url: `https://${hoster}/d/ok123`, embed_url: null, file_code: 'ok123' };
      });

      await mgr.startBatch([
        { file: '/test/a.mp4', hoster: 'doodstream.com', apiKey: 'k' }
      ]);

      assert.equal(mgr._failedAccounts.size, 0, 'legacy callers still get a clean slate');
      assert.equal(mgr._accountOverrides.size, 0, 'legacy callers still get a clean slate for overrides');
    });

    it('transient network errors skip rotation (account stays fine)', () => {
      const mgr = new UploadManager({});
      const cases = [
        'getaddrinfo ENOTFOUND api.byse.sx',
        'connect ECONNRESET 104.18.10.10:443',
        'connect ETIMEDOUT 1.2.3.4:443',
        'socket hang up',
        'request to https://voe.sx failed, reason: getaddrinfo EAI_AGAIN',
        'fetch failed',
        'connect ECONNREFUSED 127.0.0.1:443',
        'network error'
      ];
      for (const msg of cases) {
        const err = new Error(msg);
        assert.equal(mgr._isTransientNetworkError(err), true, `should mark transient: ${msg}`);
        assert.equal(mgr._isFileRejectedError(err), false, `transient must NOT be file-rejected: ${msg}`);
        assert.equal(mgr._shouldSkipRetryOnAccountError(err), false, `transient must NOT be account-specific: ${msg}`);
      }
    });

    it('transient classification does not swallow real account failures', () => {
      const mgr = new UploadManager({});
      const notTransient = [
        'HTTP 429 Too Many Requests',
        'quota exceeded',
        'account suspended',
        'Byse lehnte Datei ab: Duplicate',
        'Falscher Passwort',
        'Session expired'
      ];
      for (const msg of notTransient) {
        const err = new Error(msg);
        assert.equal(mgr._isTransientNetworkError(err), false,
          `must NOT be transient: "${msg}"`);
      }
    });

    it('hoster-transient flag is recognised (primary path)', () => {
      const mgr = new UploadManager({});
      const err = new Error('whatever');
      err.hosterTransient = true;
      assert.equal(mgr._isHosterTransientError(err), true);
      // Must not be confused with other classes.
      assert.equal(mgr._isFileRejectedError(err), false);
      assert.equal(mgr._isTransientNetworkError(err), false);
      assert.equal(mgr._shouldSkipRetryOnAccountError(err), false);
    });

    it('transientNetwork flag is recognised even with an empty/absent message', () => {
      const mgr = new UploadManager({});
      const flagged = new Error('');
      flagged.transientNetwork = true;
      assert.equal(mgr._isTransientNetworkError(flagged), true, 'flag must win before the empty-message guard');
      assert.equal(mgr._isFileRejectedError(flagged), false);
      assert.equal(mgr._isHosterTransientError(flagged), false);
      assert.equal(mgr._shouldSkipRetryOnAccountError(flagged), false);

      const flaggedHtml = new Error('Upload-Antwort von byse.sx war kein JSON (HTTP 502): <!doctype html> forbidden duplicate');
      flaggedHtml.transientNetwork = true;
      assert.equal(mgr._isTransientNetworkError(flaggedHtml), true);
      assert.equal(mgr._shouldSkipRetryOnAccountError(flaggedHtml), false, 'flag overrides any account-keyword in the 502 HTML snippet');
      assert.equal(mgr._isFileRejectedError(flaggedHtml), false, 'flag overrides any rejection-keyword in the 502 HTML snippet');
    });

    it('5xx / gateway errors classify transient by message (defensive fallback), 4xx stay account-level', () => {
      const mgr = new UploadManager({});
      const transient = [
        'Upload-Antwort von byse.sx war kein JSON (HTTP 502): <!doctype html>',
        'Upload fehlgeschlagen (HTTP 503, text/html)',
        'HTTP 504 Gateway Time-out',
        'Bad Gateway',
        'Service Unavailable'
      ];
      for (const msg of transient) {
        assert.equal(mgr._isTransientNetworkError(new Error(msg)), true, `should be transient: ${msg}`);
      }
      const accountLevel = [
        'Upload fehlgeschlagen (HTTP 429, application/json)',
        'HTTP 403 Forbidden',
        'HTTP 401 Unauthorized'
      ];
      for (const msg of accountLevel) {
        assert.equal(mgr._isTransientNetworkError(new Error(msg)), false, `must NOT be transient: ${msg}`);
        assert.equal(mgr._shouldSkipRetryOnAccountError(new Error(msg)), true, `must stay account-level: ${msg}`);
      }
    });

    it('hoster-transient regex fallback catches wrapped doodstream empty-form errors', () => {
      const mgr = new UploadManager({});
      const cases = [
        'Doodstream Upload: kein Filecode — Server gab leeren Link zurueck (st=?, fn=fehlt/leer ...)',
        'wrapper: Server gab leeren Link zurueck while parsing'
      ];
      for (const msg of cases) {
        assert.equal(mgr._isHosterTransientError(new Error(msg)), true, `should match: ${msg}`);
      }
      // Plain network and account errors must NOT match the hoster-transient class.
      const negatives = [
        'fetch failed',
        'getaddrinfo ENOTFOUND',
        'HTTP 429',
        'quota exceeded',
        'Byse lehnte Datei ab: Duplicate'
      ];
      for (const msg of negatives) {
        assert.equal(mgr._isHosterTransientError(new Error(msg)), false, `must NOT match: ${msg}`);
      }
    });

    it('regression: hoster-transient does NOT blacklist the account (account stays usable across batches)', async () => {
      // Simulate doodstream-upload throwing the tagged empty-form error.
      mockUploadFile.mock.mockImplementation(async () => {
        const err = new Error('Doodstream Upload: kein Filecode — Server gab leeren Link zurueck (st=?, fn=fehlt/leer ...)');
        err.hosterTransient = true;
        throw err;
      });

      const mgr = new UploadManager(
        { 'doodstream.com': { retries: 3, parallelCount: 1, maxSpeedKbs: 0, restartBelowKbs: 0, timeIntervalSec: 0, maxSizeMb: 0 } }
      );
      const rotEvents = [];
      mgr.on('rot-log', (e) => rotEvents.push(e));

      // No username/password so the manager routes through the mocked
      // hosters.uploadFile (instead of DoodstreamUploader directly).
      await mgr.startBatch([
        { file: '/test/Arrested.Development.mkv', hoster: 'doodstream.com', apiKey: 'acc1-key', accountId: 'acc1' }
      ]);

      const events = rotEvents.map(e => e.event);
      // Must NOT poison the account — that's the entire point of this fix.
      assert.equal(mgr._failedAccounts.size, 0, `account must NOT be blacklisted; _failedAccounts=${JSON.stringify(mgr.getFailedAccountKeys())}`);
      assert.ok(!events.includes('mark-failed'), `must NOT mark-failed for hoster-transient; got: ${events.join(',')}`);
      // The in-loop fast-break and the post-loop classification must both fire.
      assert.ok(events.includes('hoster-transient'),
        `expected hoster-transient (in-loop break, no wasted retries); got: ${events.join(',')}`);
      assert.ok(events.includes('skip-rotation-hoster-transient'),
        `expected skip-rotation-hoster-transient (post-loop branch); got: ${events.join(',')}`);
      // And the retry loop must NOT burn the full retries=3 -> only 1 attempt on this account.
      assert.equal(mockUploadFile.mock.calls.length, 1,
        `must fail fast on hoster-transient, not re-upload the file 4× wasting bandwidth; got ${mockUploadFile.mock.calls.length} calls`);
    });

    it('late-resolved override is honored by subsequent jobs (simulates mid-batch config add)', async () => {
      // Only acc1 throws; acc2 succeeds.
      mockUploadFile.mock.mockImplementation(async (hoster, filePath, apiKey, onProgress) => {
        if (apiKey === 'acc1-key') {
          const err = new Error('Byse lehnte Datei ab: not enough disk space');
          err.accountError = true;
          throw err;
        }
        if (onProgress) onProgress(fakeFileSize, fakeFileSize);
        return { download_url: `https://${hoster}/d/ok123`, embed_url: null, file_code: 'ok123' };
      });

      const mgr = new UploadManager(
        { 'byse.sx': { retries: 1, parallelCount: 1, maxSpeedKbs: 0, restartBelowKbs: 0, timeIntervalSec: 0, maxSizeMb: 0 } }
      );

      // Scenario: initially config has ONLY acc1. No account-failed listener
      // resolves a fallback (because none exists in config yet). Job A fails
      // with rotation-end.
      const rotEvents = [];
      mgr.on('rot-log', (e) => rotEvents.push(e));

      await mgr.startBatch([
        { file: '/test/a.mp4', hoster: 'byse.sx', apiKey: 'acc1-key', accountId: 'acc1', username: 'u1', password: 'p1' }
      ]);

      // Job A should have ended with rotation-end (no fallback available).
      const eventsA = rotEvents.map(e => e.event);
      assert.ok(eventsA.includes('mark-failed'), 'acc1 must be marked failed');
      assert.ok(eventsA.includes('rotation-end'), 'expected rotation-end without a fallback');
      assert.equal(mgr.getFailedAccountKeys().length, 1);
      assert.equal(mgr.getOverride('byse.sx'), null, 'no override set during first batch');

      // --- Simulate: user adds acc2 in Settings → save-config handler finds
      // that byse.sx:acc1 is failed without an override → resolves + switches.
      mgr.switchAccount('byse.sx', { id: 'acc2', username: 'u2', password: 'p2', apiKey: 'acc2-key' });

      // Now a follow-up batch (same running session — in production, addJobs
      // or a new startBatch without clearing maps would reach this state).
      // We need to ALSO clear _failedAccounts manually here because startBatch
      // resets it — so we poke the inner state to emulate "still mid-batch
      // with late config". The switchAccount-after-fail path is what matters.
      rotEvents.length = 0;
      // Re-run just the _runJob path by manually setting up state and using
      // addJobs — simulates mid-batch job add after config change.
      mgr.running = true;
      mgr._batchResults = new Map();
      mgr._batchResults.set('/test/b.mp4', { name: 'b.mp4', size: fakeFileSize, results: [] });
      mgr._failedAccounts.set('byse.sx:acc1', true); // re-establish failed state
      mgr._additionalPromises = [];

      // Spawn a new job through addJobs() path (uses _runJob internally)
      const addResult = await mgr.addJobs([
        { file: '/test/b.mp4', hoster: 'byse.sx', apiKey: 'acc1-key', accountId: 'acc1', username: 'u1', password: 'p1', jobId: 'jb' }
      ]);
      assert.ok(addResult.added >= 1 || addResult.alreadyInBatch === 0,
        `addJobs should accept new job: ${JSON.stringify(addResult)}`);
      await Promise.allSettled(mgr._additionalPromises);

      const eventsB = rotEvents.map(e => e.event);
      assert.ok(eventsB.includes('pre-job-swap'),
        `job B should have pre-job-swap after late override was set; got: ${eventsB.join(',')}`);

      // Mock must have been called with acc2-key for the new job (not acc1-key again)
      const acc1ForB = mockUploadFile.mock.calls.filter(c =>
        c.arguments[1] === '/test/b.mp4' && c.arguments[2] === 'acc1-key').length;
      assert.equal(acc1ForB, 0, 'job B must never touch acc1-key after late fallback was set');
    });
  });
});
