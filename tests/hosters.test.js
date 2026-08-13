const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { __test } = require('../lib/hosters');

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
