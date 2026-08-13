const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { __test, createRecoveryClaimRegistry } = require('../lib/hosters');

describe('hosters helpers', () => {
  it('extracts VOE file_code from nested result payloads', () => {
    assert.deepEqual(__test.parseVoeResult({ result: { file: { file_code: 'abc123' } } }), {
      download_url: 'https://voe.sx/abc123',
      embed_url: 'https://voe.sx/e/abc123',
      file_code: 'abc123'
    });
  });

  it('extracts VOE file_code from flat fallback payloads', () => {
    assert.deepEqual(__test.parseVoeResult({ file_code: 'xyz789' }), {
      download_url: 'https://voe.sx/xyz789',
      embed_url: 'https://voe.sx/e/xyz789',
      file_code: 'xyz789'
    });
  });

  it('extracts upload server URLs from nested API responses', () => {
    const url = __test.extractUploadServerUrl({
      result: {
        server: {
          upload_url: 'https://delivery-hydra.voe-network.net/upload/01'
        }
      }
    }, 'https://voe.sx');

    assert.equal(url, 'https://delivery-hydra.voe-network.net/upload/01');
  });

  it('parseDoodstreamResult tolerates null/non-object payload without throwing', () => {
    // Direct callers may bypass uploadFile's normalisation. The parser must
    // never throw on bad input — empty fields are the contract.
    for (const bad of [null, undefined, 'string', 42, true]) {
      const r = __test.parseDoodstreamResult(bad);
      assert.equal(r.file_code, null);
      assert.equal(r.download_url, null);
      assert.equal(r.embed_url, null);
    }
  });

  it('parseDoodstreamResult handles result-as-array and result-as-object', () => {
    const arr = __test.parseDoodstreamResult({ result: [{ filecode: 'AB1', protected_dl: 'https://x/1', protected_embed: 'https://x/e/1' }] });
    assert.equal(arr.file_code, 'AB1');
    assert.equal(arr.download_url, 'https://doodstream.com/d/AB1');
    assert.equal(arr.embed_url, 'https://doodstream.com/e/AB1');

    const obj = __test.parseDoodstreamResult({ result: { filecode: 'OBJ1', download_url: 'https://x/2' } });
    assert.equal(obj.file_code, 'OBJ1');
    assert.equal(obj.download_url, 'https://doodstream.com/d/OBJ1');
    assert.equal(obj.embed_url, 'https://doodstream.com/e/OBJ1');
  });

  it('parseByseResult tolerates null/non-object payload without throwing', () => {
    for (const bad of [null, undefined, 'string', 42, []]) {
      const r = __test.parseByseResult(bad);
      assert.equal(r.file_code, null);
      assert.equal(r.download_url, null);
      assert.equal(r.embed_url, null);
    }
  });

  it('parseByseResult handles malformed files entries (null, missing fields)', () => {
    // Files array with a null first element (server returned [null])
    const a = __test.parseByseResult({ files: [null] });
    assert.equal(a.file_code, null);
    // Files array with object missing both filecode and status
    const b = __test.parseByseResult({ files: [{}] });
    assert.equal(b.file_code, null);
  });

  it('parseByseResult throws fileRejected for non-OK status with empty filecode', () => {
    assert.throws(
      () => __test.parseByseResult({ files: [{ status: 'Not video file format' }] }),
      (err) => err.fileRejected === true && /Not video file format/i.test(err.message)
    );
  });

  it('parseByseResult flips to accountError for storage-exhausted phrasing', () => {
    assert.throws(
      () => __test.parseByseResult({ files: [{ status: 'not enough disk space on your account' }] }),
      (err) => err.accountError === true
    );
  });

  it('parseByseResult succeeds with valid filecode in files[0]', () => {
    const r = __test.parseByseResult({ files: [{ filecode: 'GOOD123', status: 'OK' }] });
    assert.equal(r.file_code, 'GOOD123');
    assert.equal(r.download_url, 'https://byse.sx/d/GOOD123');
    assert.equal(r.embed_url, 'https://byse.sx/e/GOOD123');
  });
});

describe('recovery claim registry', () => {
  it('claims remote codes across every title of one normalized hoster account', () => {
    const registry = createRecoveryClaimRegistry();
    const first = registry.forUpload(' VOE.SX ', 'ＡＣＣＯＵＮＴ', 'First Episode.mkv');
    const differentTitle = registry.forUpload('voe.sx', 'ACCOUNT', 'Second Episode.mp4');
    const differentAccount = registry.forUpload('voe.sx', 'ACCOUNT-B', 'Second Episode.mp4');

    assert.equal(first.reserve('REMOTE-CODE'), true);
    assert.equal(differentTitle.reserve('REMOTE-CODE'), false);
    assert.equal(differentAccount.reserve('REMOTE-CODE'), true);
  });

  it('serializes canonically equivalent titles without blocking an independent title', async () => {
    const registry = createRecoveryClaimRegistry();
    const composed = registry.forUpload('voe.sx', 'ACCOUNT', 'Café.mkv');
    const decomposed = registry.forUpload('voe.sx', 'ACCOUNT', 'Cafe\u0301.mp4');
    const independent = registry.forUpload('voe.sx', 'ACCOUNT', 'Other Episode.mkv');
    const events = [];
    let releaseFirst;
    const firstGate = new Promise(resolve => {
      releaseFirst = resolve;
    });
    assert.equal(composed.reserve('UNICODE-CODE'), true);
    assert.equal(decomposed.reserve('UNICODE-CODE'), false);

    const first = composed.runExclusive(async () => {
      events.push('first-started');
      await firstGate;
      events.push('first-finished');
    });
    await new Promise(resolve => setImmediate(resolve));
    const equivalent = decomposed.runExclusive(async () => {
      events.push('equivalent-started');
    });
    const other = independent.runExclusive(async () => {
      events.push('independent-started');
    });
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(events, ['first-started', 'independent-started']);
    releaseFirst();
    await Promise.all([first, equivalent, other]);
    assert.deepEqual(events, ['first-started', 'independent-started', 'first-finished', 'equivalent-started']);
  });

  it('fails closed for later jobs after a title becomes uncertain', async () => {
    const registry = createRecoveryClaimRegistry();
    const first = registry.forUpload('vidmoly.me', 'ACCOUNT', 'Shared Episode.mkv');
    const later = registry.forUpload('vidmoly.me', 'ACCOUNT', 'shared-episode.mp4');
    const error = first.markUncertain(new Error('Remote commit could not be confirmed'));

    assert.equal(error.remoteCommitUncertain, true);
    assert.equal(error.hosterTransient, true);
    await assert.rejects(
      () => later.runExclusive(async () => 'unsafe-success'),
      err => err.remoteCommitUncertain === true && err.hosterTransient === true
    );
  });

  it('drops every claim when the registry is cleared', () => {
    const registry = createRecoveryClaimRegistry();
    const first = registry.forUpload('voe.sx', 'ACCOUNT', 'Episode.mkv');
    assert.equal(first.reserve('REMOTE-CODE'), true);

    registry.clear();

    const nextBatch = registry.forUpload('voe.sx', 'ACCOUNT', 'Episode.mkv');
    assert.equal(nextBatch.reserve('REMOTE-CODE'), true);
  });
});
