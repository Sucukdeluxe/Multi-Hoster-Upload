const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');

describe('suspect-reject alternate accounts', () => {
  let UploadManager;
  let mockUploadFile;
  let mockProbe;

  function suspectErr() {
    const e = new Error('Byse lehnte Datei ab: Not video file format');
    e.fileRejected = true;
    e.suspectReject = true;
    return e;
  }

  beforeEach(() => {
    delete require.cache[require.resolve('../lib/upload-manager')];

    const hosters = require('../lib/hosters');
    mockUploadFile = mock.fn(async () => ({ download_url: 'https://byse.sx/d/ok', embed_url: null, file_code: 'ok' }));
    hosters.uploadFile = (...a) => mockUploadFile(...a);
    hosters.prefetchBaseline = async () => null;

    const fileProbe = require('../lib/file-probe');
    mockProbe = mock.fn(async () => ({ ok: true, kind: 'matroska', isVideoLike: true, headHex: '1a45dfa3' }));
    fileProbe.probeFileHead = (...a) => mockProbe(...a);

    const fs = require('fs');
    const fakeSize = (p) => {
      const m = /-(\d+)gb/i.exec(p);
      return { size: (m ? parseInt(m[1], 10) : 3) * 1024 * 1024 * 1024 };
    };
    const origStatSync = fs.statSync;
    fs.statSync = function (p) {
      if (typeof p === 'string' && p.startsWith('/test/')) return fakeSize(p);
      return origStatSync.call(this, p);
    };
    const origStat = fs.promises.stat;
    fs.promises.stat = async function (p) {
      if (typeof p === 'string' && p.startsWith('/test/')) return fakeSize(p);
      return origStat.call(this, p);
    };

    UploadManager = require('../lib/upload-manager');
  });

  function poolMgr(pool, settings) {
    return new UploadManager({ 'byse.sx': { retries: 0, ...(settings || {}) } }, {}, { 'byse.sx': pool });
  }

  it('tries the file on the next pool account after a suspect rejection and succeeds without blacklisting', async () => {
    const mgr = poolMgr([
      { id: 'acc1', apiKey: 'key1' },
      { id: 'acc2', apiKey: 'key2' }
    ]);
    mockUploadFile.mock.mockImplementation(async (hoster, file, apiKey) => {
      if (apiKey === 'key1') throw suspectErr();
      return { download_url: 'https://byse.sx/d/alt', embed_url: null, file_code: 'alt' };
    });
    const rotEvents = [];
    mgr.on('rot-log', (e) => rotEvents.push(e.event));
    let summary = null;
    mgr.on('batch-done', (s) => { summary = s; });

    await mgr.startBatch([{ file: '/test/big.mkv', hoster: 'byse.sx', apiKey: 'key1', accountId: 'acc1' }]);

    assert.equal(summary.succeeded, 1);
    assert.equal(summary.failed, 0);
    const keys = mockUploadFile.mock.calls.map(c => c.arguments[2]);
    assert.deepEqual(keys, ['key1', 'key2']);
    assert.ok(rotEvents.includes('suspect-reject-alt'));
    assert.equal(mgr.getFailedAccountKeys().length, 0, 'suspect rejection must not blacklist any account');
  });

  it('fails the file when every pool account gives the suspect rejection — each tried exactly once, none blacklisted', async () => {
    const mgr = poolMgr([
      { id: 'acc1', apiKey: 'key1' },
      { id: 'acc2', apiKey: 'key2' },
      { id: 'acc3', apiKey: 'key3' }
    ]);
    mockUploadFile.mock.mockImplementation(async () => { throw suspectErr(); });
    const rotEvents = [];
    mgr.on('rot-log', (e) => rotEvents.push(e.event));
    let summary = null;
    mgr.on('batch-done', (s) => { summary = s; });

    await mgr.startBatch([{ file: '/test/big.mkv', hoster: 'byse.sx', apiKey: 'key1', accountId: 'acc1' }]);

    assert.equal(summary.failed, 1);
    const keys = mockUploadFile.mock.calls.map(c => c.arguments[2]);
    assert.deepEqual(keys, ['key1', 'key2', 'key3']);
    assert.ok(rotEvents.includes('suspect-reject-exhausted'));
    assert.equal(mgr.getFailedAccountKeys().length, 0);
  });

  it('skips pool accounts already marked failed and lands on the last one', async () => {
    const mgr = poolMgr([
      { id: 'acc1', apiKey: 'key1' },
      { id: 'acc2', apiKey: 'key2' },
      { id: 'acc3', apiKey: 'key3' },
      { id: 'acc4', apiKey: 'key4' }
    ]);
    mockUploadFile.mock.mockImplementation(async (hoster, file, apiKey) => {
      if (apiKey === 'key3') throw suspectErr();
      return { download_url: 'https://byse.sx/d/four', embed_url: null, file_code: 'four' };
    });
    let summary = null;
    mgr.on('batch-done', (s) => { summary = s; });

    await mgr.startBatch(
      [{ file: '/test/big.mkv', hoster: 'byse.sx', apiKey: 'key3', accountId: 'acc3' }],
      { primeFailedAccounts: ['byse.sx:acc1', 'byse.sx:acc2'] }
    );

    assert.equal(summary.succeeded, 1);
    const keys = mockUploadFile.mock.calls.map(c => c.arguments[2]);
    assert.deepEqual(keys, ['key3', 'key4'], 'failed acc1/acc2 skipped, fourth account finally gets the file');
  });

  it('does NOT try alternates when the probe says the file is not a video', async () => {
    mockProbe.mock.mockImplementation(async () => ({ ok: true, kind: 'rar', isVideoLike: false, headHex: '52617221' }));
    const mgr = poolMgr([
      { id: 'acc1', apiKey: 'key1' },
      { id: 'acc2', apiKey: 'key2' }
    ]);
    mockUploadFile.mock.mockImplementation(async () => { throw suspectErr(); });
    const rotEvents = [];
    mgr.on('rot-log', (e) => rotEvents.push(e.event));
    let summary = null;
    mgr.on('batch-done', (s) => { summary = s; });

    await mgr.startBatch([{ file: '/test/archive.rar', hoster: 'byse.sx', apiKey: 'key1', accountId: 'acc1' }]);

    assert.equal(summary.failed, 1);
    assert.equal(mockUploadFile.mock.calls.length, 1, 'genuine non-video rejection must not burn uploads on other accounts');
    assert.ok(rotEvents.includes('skip-rotation-file-rejected'));
  });

  it('records a user cancel during the alternates walk as aborted, not error', async () => {
    const mgr = poolMgr([
      { id: 'acc1', apiKey: 'key1' },
      { id: 'acc2', apiKey: 'key2' }
    ]);
    mockUploadFile.mock.mockImplementation(async (hoster, file, apiKey) => {
      if (apiKey === 'key1') throw suspectErr();
      mgr.cancel();
      const e = new Error('This operation was aborted');
      throw e;
    });
    let summary = null;
    mgr.on('batch-done', (s) => { summary = s; });

    await mgr.startBatch([{ file: '/test/big.mkv', hoster: 'byse.sx', apiKey: 'key1', accountId: 'acc1' }]);

    assert.equal(summary.files[0].results[0].status, 'aborted');
  });

  it('marks an alternate failed on a genuine account error so later suspect files skip it', async () => {
    const mgr = poolMgr([
      { id: 'acc1', apiKey: 'key1' },
      { id: 'acc2', apiKey: 'key2' },
      { id: 'acc3', apiKey: 'key3' }
    ], { parallelCount: 1 });
    mockUploadFile.mock.mockImplementation(async (hoster, file, apiKey) => {
      if (apiKey === 'key1') throw suspectErr();
      if (apiKey === 'key2') {
        const e = new Error('Byse lehnte Datei ab: 0:0:0:not enough disk space on your account');
        e.accountError = true;
        throw e;
      }
      return { download_url: 'https://byse.sx/d/three', embed_url: null, file_code: 'three' };
    });
    let summary = null;
    mgr.on('batch-done', (s) => { summary = s; });

    await mgr.startBatch([
      { file: '/test/big1.mkv', hoster: 'byse.sx', apiKey: 'key1', accountId: 'acc1' },
      { file: '/test/big2.mkv', hoster: 'byse.sx', apiKey: 'key1', accountId: 'acc1' }
    ]);

    assert.equal(summary.succeeded, 2);
    assert.ok(mgr.getFailedAccountKeys().includes('byse.sx:acc2'), 'dead alternate must be remembered');
    const keys = mockUploadFile.mock.calls.map(c => c.arguments[2]);
    assert.deepEqual(keys, ['key1', 'key2', 'key3', 'key1', 'key3'], 'second same-size file still gets one real attempt on the primary (memo arms only on the 2nd rejection), then skips the dead alternate and lands on the good account');
  });

  it('size memo short-circuits a later LARGER file once the account has two confirmed rejections', async () => {
    const mgr = poolMgr([
      { id: 'acc1', apiKey: 'key1' },
      { id: 'acc2', apiKey: 'key2' },
      { id: 'acc3', apiKey: 'key3' }
    ], { parallelCount: 1 });
    mockUploadFile.mock.mockImplementation(async (hoster, file, apiKey) => {
      if (apiKey === 'key1' || apiKey === 'key2') throw suspectErr();
      return { download_url: 'https://byse.sx/d/three', embed_url: null, file_code: 'three' };
    });
    const rotEvents = [];
    mgr.on('rot-log', (e) => rotEvents.push(e.event));
    let summary = null;
    mgr.on('batch-done', (s) => { summary = s; });

    await mgr.startBatch([
      { file: '/test/a-1gb.mkv', hoster: 'byse.sx', apiKey: 'key1', accountId: 'acc1' },
      { file: '/test/b-1gb.mkv', hoster: 'byse.sx', apiKey: 'key1', accountId: 'acc1' },
      { file: '/test/c-2gb.mkv', hoster: 'byse.sx', apiKey: 'key1', accountId: 'acc1' }
    ]);

    assert.equal(summary.succeeded, 3);
    const keys = mockUploadFile.mock.calls.map(c => c.arguments[2]);
    assert.deepEqual(keys, ['key1', 'key2', 'key3', 'key1', 'key3', 'key3'], 'files 1+2 each get a real attempt on the 1GB-rejecting primary (arming the memo at count 2); the larger 3rd file then short-circuits the primary straight to the good account');
    assert.ok(rotEvents.includes('suspect-memo-skip'), 'the larger third file must skip its primary via the armed size memo');
  });

  it('sizeMemoEnabled:false disables the pre-skip — the larger third file still gets a real attempt on its primary', async () => {
    const mgr = poolMgr([
      { id: 'acc1', apiKey: 'key1' },
      { id: 'acc2', apiKey: 'key2' },
      { id: 'acc3', apiKey: 'key3' }
    ], { parallelCount: 1, sizeMemoEnabled: false });
    mockUploadFile.mock.mockImplementation(async (hoster, file, apiKey) => {
      if (apiKey === 'key1' || apiKey === 'key2') throw suspectErr();
      return { download_url: 'https://byse.sx/d/three', embed_url: null, file_code: 'three' };
    });
    const rotEvents = [];
    mgr.on('rot-log', (e) => rotEvents.push(e.event));
    let summary = null;
    mgr.on('batch-done', (s) => { summary = s; });

    await mgr.startBatch([
      { file: '/test/a-1gb.mkv', hoster: 'byse.sx', apiKey: 'key1', accountId: 'acc1' },
      { file: '/test/b-1gb.mkv', hoster: 'byse.sx', apiKey: 'key1', accountId: 'acc1' },
      { file: '/test/c-2gb.mkv', hoster: 'byse.sx', apiKey: 'key1', accountId: 'acc1' }
    ]);

    assert.equal(summary.succeeded, 3);
    const keys = mockUploadFile.mock.calls.map(c => c.arguments[2]);
    assert.equal(keys.filter(k => k === 'key1').length, 3, 'with the memo off every file gets a real attempt on the primary — including the larger third');
    assert.ok(!rotEvents.includes('suspect-memo-skip'), 'the disabled memo must never short-circuit a primary');
  });

  it('plain fileRejected without suspect flag keeps the old fast-fail behavior', async () => {
    const mgr = poolMgr([
      { id: 'acc1', apiKey: 'key1' },
      { id: 'acc2', apiKey: 'key2' }
    ]);
    mockUploadFile.mock.mockImplementation(async () => {
      const e = new Error('Byse lehnte Datei ab: Duplicate');
      e.fileRejected = true;
      throw e;
    });
    let summary = null;
    mgr.on('batch-done', (s) => { summary = s; });

    await mgr.startBatch([{ file: '/test/big.mkv', hoster: 'byse.sx', apiKey: 'key1', accountId: 'acc1' }]);

    assert.equal(summary.failed, 1);
    assert.equal(mockUploadFile.mock.calls.length, 1);
  });

  it('a transient 5xx (byse 502) retries the SAME account and fails clean — no blacklist, no failover cascade', async () => {
    const mgr = poolMgr([
      { id: 'acc1', apiKey: 'key1' },
      { id: 'acc2', apiKey: 'key2' },
      { id: 'acc3', apiKey: 'key3' }
    ], { retries: 2 });
    mgr._sleep = async () => {};
    mockUploadFile.mock.mockImplementation(async () => {
      const e = new Error('Upload-Antwort von byse.sx war kein JSON (HTTP 502): <!doctype html>');
      e.transientNetwork = true;
      throw e;
    });
    let accountFailed = 0;
    mgr.on('account-failed', () => { accountFailed++; });
    let summary = null;
    mgr.on('batch-done', (s) => { summary = s; });

    await mgr.startBatch([{ file: '/test/big.mkv', hoster: 'byse.sx', apiKey: 'key1', accountId: 'acc1' }]);

    assert.equal(summary.failed, 1);
    assert.equal(accountFailed, 0, 'a transient 502 must never emit account-failed');
    assert.equal(mgr.getFailedAccountKeys().length, 0, 'no account blacklisted on a transient 502');
    const keys = mockUploadFile.mock.calls.map(c => c.arguments[2]);
    assert.ok(keys.length >= 2, 'the 502 is retried on the same account');
    assert.ok(keys.every(k => k === 'key1'), 'every attempt stays on the primary — no cascade to key2/key3');
  });
});
