const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Mock the undici transport BEFORE requiring hosters so the destructured
// `request` picks up our stub. apiGet (getUploadServer) uses global fetch, which
// we override per-test. This exercises the FULL doodstream API upload + recovery
// orchestration against the doc-verified response shapes — the gap between the
// already-tested parseDoodstreamResult helper and the real uploadFile path.
// (mock.module needs an experimental flag npm test doesn't pass, so we reassign
// undici.request on the module object and refresh the hosters cache instead.)
let requestRouter = async () => ({ statusCode: 200, headers: {}, body: { text: async () => '{}' } });
const undici = require('undici');
const _origUndiciRequest = undici.request;
undici.request = (...a) => requestRouter(...a);
delete require.cache[require.resolve('../lib/hosters')];
const hostersMod = require('../lib/hosters');
const { uploadFile } = hostersMod;

let tmpFile;
let origFetch;
before(() => {
  tmpFile = path.join(os.tmpdir(), `dood-itest-${process.pid}.mkv`);
  fs.writeFileSync(tmpFile, Buffer.alloc(2048, 7));
  origFetch = global.fetch;
  // Keep the "never appears" recovery test fast (real default is 12 × 2.5 s).
  hostersMod.__test.DOODSTREAM_POLL.attempts = 3;
  hostersMod.__test.DOODSTREAM_POLL.delayMs = 5;
});
after(() => {
  global.fetch = origFetch;
  undici.request = _origUndiciRequest; // restore real transport for other test files
  delete require.cache[require.resolve('../lib/hosters')];
  try { fs.unlinkSync(tmpFile); } catch {}
});

// getUploadServer hits /api/upload/server via global fetch.
function stubUploadServer() {
  global.fetch = async (url) => {
    if (/upload\/server/.test(String(url))) {
      return { status: 200, text: async () => JSON.stringify({ status: 200, result: 'https://node1.cloudatacdn.com/upload/01' }) };
    }
    return { status: 200, text: async () => '{"status":200}' };
  };
}

// Build an undici-style router. uploadBody is the POST result; listBodies is a
// queue consumed by successive /api/file/list calls (baseline, then polls).
function routeWith(uploadBody, listBodies = []) {
  return async (url, opts) => {
    const u = String(url);
    if (/\/api\/file\/list/.test(u)) {
      const body = listBodies.length ? listBodies.shift() : '{"status":200,"result":{"files":[]}}';
      return { statusCode: 200, headers: {}, body: { text: async () => body } };
    }
    // Upload POST: drain the streamed body so the file handle closes.
    if (opts && opts.body && typeof opts.body[Symbol.asyncIterator] === 'function') {
      for await (const chunk of opts.body) { if (chunk && chunk.length === -1) break; }
    }
    return { statusCode: uploadBody.status, headers: { 'content-type': uploadBody.contentType || 'application/json' }, body: { text: async () => uploadBody.body } };
  };
}

test('doodstream API upload: filecode returned directly is used', async () => {
  stubUploadServer();
  requestRouter = routeWith({
    status: 200,
    body: JSON.stringify({ status: 200, result: [{ filecode: 'DOODCODE1234', download_url: 'https://doodstream.com/d/DOODCODE1234', protected_embed: 'https://doodstream.com/e/DOODCODE1234' }] })
  });
  const res = await uploadFile('doodstream.com', tmpFile, 'VALIDKEY', null, null, null);
  assert.equal(res.file_code, 'DOODCODE1234');
  assert.equal(res.download_url, 'https://doodstream.com/d/DOODCODE1234');
});

test('doodstream API upload: codeless result recovered via file-list name match', async () => {
  stubUploadServer();
  const fileName = path.basename(tmpFile).replace(/\.[^.]+$/, ''); // title doodstream stores
  requestRouter = routeWith(
    { status: 200, body: JSON.stringify({ status: 200, msg: 'OK' }) }, // codeless upload
    [
      '{"status":200,"result":{"files":[]}}',                                  // baseline (pre-upload)
      `{"status":200,"result":{"files":[{"file_code":"RECOVER9999","title":"${fileName}"}]}}` // poll finds it
    ]
  );
  const res = await uploadFile('doodstream.com', tmpFile, 'VALIDKEY', null, null, null);
  assert.equal(res.file_code, 'RECOVER9999');
  assert.equal(res.download_url, 'https://doodstream.com/d/RECOVER9999');
});

test('doodstream API upload: codeless + file never appears → throws hosterTransient (no account poison)', async () => {
  stubUploadServer();
  requestRouter = routeWith(
    { status: 200, body: JSON.stringify({ status: 200, msg: 'OK' }) },
    [] // every file/list returns empty
  );
  await assert.rejects(
    () => uploadFile('doodstream.com', tmpFile, 'VALIDKEY', null, null, null),
    (err) => {
      assert.equal(err.hosterTransient, true, 'codeless result must be tagged hosterTransient');
      return true;
    }
  );
});

test('doodstream API upload never recovers an old file after a failed baseline', async () => {
  stubUploadServer();
  const abort = new AbortController();
  const fileName = path.basename(tmpFile);
  let listCalls = 0;
  requestRouter = async (url, opts) => {
    if (/\/api\/file\/list/.test(String(url))) {
      listCalls++;
      if (listCalls === 1) {
        return {
          statusCode: 503,
          headers: { 'content-type': 'text/html' },
          body: { text: async () => '<html>baseline-token=SYNTHETIC_BASELINE_SECRET</html>' }
        };
      }
      abort.abort();
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: { text: async () => JSON.stringify({ status: 200, result: { files: [{ file_code: 'OLD_DOOD_123', title: fileName }] } }) }
      };
    }
    if (opts && opts.body && typeof opts.body[Symbol.asyncIterator] === 'function') {
      for await (const chunk of opts.body) { if (chunk && chunk.length === -1) break; }
    }
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: { text: async () => JSON.stringify({ status: 200, msg: 'OK' }) }
    };
  };

  await assert.rejects(
    () => uploadFile('doodstream.com', tmpFile, 'VALIDKEY', null, abort.signal, null),
    (err) => {
      assert.doesNotMatch(err.message, /SYNTHETIC_BASELINE_SECRET/);
      assert.equal(err.diagnostic.phase, 'recovery-baseline');
      assert.equal(err.diagnostic.http, 503);
      return true;
    }
  );
  assert.equal(listCalls, 1);
});

test('doodstream API recovery rejects ambiguous same-title candidates', async () => {
  stubUploadServer();
  const fileName = path.basename(tmpFile);
  requestRouter = routeWith(
    { status: 200, body: JSON.stringify({ status: 200, msg: 'OK' }) },
    [
      '{"status":200,"result":{"files":[]}}',
      JSON.stringify({
        status: 200,
        result: {
          files: [
            { file_code: 'PARALLEL_A', title: fileName },
            { file_code: 'PARALLEL_B', title: fileName }
          ]
        }
      })
    ]
  );

  await assert.rejects(
    () => uploadFile('doodstream.com', tmpFile, 'VALIDKEY', null, null, null),
    (err) => err.hosterTransient === true
  );
});

test('doodstream API upload errors expose safe structured diagnostics', async () => {
  stubUploadServer();
  requestRouter = routeWith({
    status: 502,
    contentType: 'text/html; charset=utf-8',
    body: '<html>upstream-token=SYNTHETIC_UPLOAD_SECRET https://node.invalid/upload?session=SYNTHETIC_SESSION</html>'
  });

  await assert.rejects(
    () => uploadFile('doodstream.com', tmpFile, 'VALIDKEY', null, null, null),
    (err) => {
      assert.equal(err.transientNetwork, true);
      assert.doesNotMatch(err.message, /SYNTHETIC_UPLOAD_SECRET|SYNTHETIC_SESSION|<html>/);
      assert.equal(err.diagnostic.phase, 'upload-response');
      assert.equal(err.diagnostic.http, 502);
      assert.equal(err.diagnostic.contentType, 'text/html; charset=utf-8');
      assert.equal(err.diagnostic.responseKind, 'html');
      assert.doesNotMatch(err.diagnostic.payloadSnippet, /SYNTHETIC_UPLOAD_SECRET|SYNTHETIC_SESSION/);
      return true;
    }
  );
});
