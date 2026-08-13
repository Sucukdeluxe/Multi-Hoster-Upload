const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

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
  tmpFile = path.join(os.tmpdir(), `byse-itest-${process.pid}.mkv`);
  fs.writeFileSync(tmpFile, Buffer.alloc(2048, 7));
  origFetch = global.fetch;
});
after(() => {
  global.fetch = origFetch;
  undici.request = _origUndiciRequest;
  delete require.cache[require.resolve('../lib/hosters')];
  try { fs.unlinkSync(tmpFile); } catch {}
});

function stubByseUploadServer() {
  global.fetch = async (url) => {
    if (/upload\/server/.test(String(url))) {
      return { status: 200, text: async () => JSON.stringify({ status: 200, result: 'https://node1.byse.sx/upload/01' }) };
    }
    return { status: 200, text: async () => '{"status":200}' };
  };
}

test('byse "Not video file format" (suspect) DOES poll recovery and claims the async-registered file', async () => {
  stubByseUploadServer();
  let listCalls = 0;
  requestRouter = async (url, opts) => {
    const u = String(url);
    if (/\/file\/list/.test(u)) {
      listCalls++;
      const body = listCalls === 1
        ? '{"status":200,"result":{"files":[]}}'
        : JSON.stringify({ status: 200, result: { files: [{ file_code: 'BIGMKV77', title: path.basename(tmpFile) }] } });
      return { statusCode: 200, headers: {}, body: { text: async () => body } };
    }
    if (opts && opts.body && typeof opts.body[Symbol.asyncIterator] === 'function') {
      for await (const chunk of opts.body) { if (chunk && chunk.length === -1) break; }
    }
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: { text: async () => JSON.stringify({ status: 200, msg: 'OK', files: [{ filecode: '', filename: 'x.mkv', status: 'Not video file format' }] }) }
    };
  };

  const res = await uploadFile('byse.sx', tmpFile, 'VALIDKEY', null, null, null);
  assert.strictEqual(res.file_code, 'BIGMKV77');
  assert.ok(listCalls >= 2, 'suspect rejection must still run the recovery poll (live 2026-06-09: >2.7GB MKVs got this status while registering fine)');
});

test('byse "Not video file format" with empty poll throws err.suspectReject so rotation can try other accounts', async () => {
  stubByseUploadServer();
  const abort = new AbortController();
  let listCalls = 0;
  requestRouter = async (url, opts) => {
    const u = String(url);
    if (/\/file\/list/.test(u)) {
      listCalls++;
      if (listCalls >= 2) abort.abort();
      return { statusCode: 200, headers: {}, body: { text: async () => '{"status":200,"result":{"files":[]}}' } };
    }
    if (opts && opts.body && typeof opts.body[Symbol.asyncIterator] === 'function') {
      for await (const chunk of opts.body) { if (chunk && chunk.length === -1) break; }
    }
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: { text: async () => JSON.stringify({ status: 200, msg: 'OK', files: [{ filecode: '', filename: 'x.mkv', status: 'Not video file format' }] }) }
    };
  };

  await assert.rejects(
    () => uploadFile('byse.sx', tmpFile, 'VALIDKEY', null, abort.signal, null),
    (err) => err.fileRejected === true && err.suspectReject === true && /Not video file format/i.test(err.message)
  );
  assert.ok(listCalls >= 2, 'poll must have started before giving up');
});

test('byse "Not video file format" with probe-confirmed NON-video skips the recovery poll (genuine rejection)', async () => {
  stubByseUploadServer();
  let listCalls = 0;
  requestRouter = async (url, opts) => {
    const u = String(url);
    if (/\/file\/list/.test(u)) {
      listCalls++;
      return { statusCode: 200, headers: {}, body: { text: async () => '{"status":200,"result":{"files":[]}}' } };
    }
    if (opts && opts.body && typeof opts.body[Symbol.asyncIterator] === 'function') {
      for await (const chunk of opts.body) { if (chunk && chunk.length === -1) break; }
    }
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: { text: async () => JSON.stringify({ status: 200, msg: 'OK', files: [{ filecode: '', filename: 'x.mkv', status: 'Not video file format' }] }) }
    };
  };

  await assert.rejects(
    () => uploadFile('byse.sx', tmpFile, 'VALIDKEY', null, null, null, { probeIsVideoLike: false }),
    (err) => err.fileRejected === true && /Not video file format/i.test(err.message)
  );

  assert.strictEqual(listCalls, 1, 'probe says non-video → the rejection is genuine, no 15-attempt poll');
});

test('byse explicit "Duplicate" rejection still throws fast WITHOUT recovery polling', async () => {
  stubByseUploadServer();
  let listCalls = 0;
  requestRouter = async (url, opts) => {
    const u = String(url);
    if (/\/file\/list/.test(u)) {
      listCalls++;
      return { statusCode: 200, headers: {}, body: { text: async () => '{"status":200,"result":{"files":[]}}' } };
    }
    if (opts && opts.body && typeof opts.body[Symbol.asyncIterator] === 'function') {
      for await (const chunk of opts.body) { if (chunk && chunk.length === -1) break; }
    }
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: { text: async () => JSON.stringify({ status: 200, msg: 'OK', files: [{ filecode: '', filename: 'x.mkv', status: 'Duplicate' }] }) }
    };
  };

  await assert.rejects(
    () => uploadFile('byse.sx', tmpFile, 'VALIDKEY', null, null, null),
    (err) => err.fileRejected === true && err.suspectReject !== true && /Duplicate/i.test(err.message)
  );

  assert.strictEqual(listCalls, 1, 'file/list should be hit ONCE (baseline only) — no 15-attempt recovery poll on a genuine rejection');
});

test('byse empty filecode WITHOUT explicit rejection still polls recovery', async () => {
  stubByseUploadServer();
  let listCalls = 0;
  requestRouter = async (url, opts) => {
    const u = String(url);
    if (/\/file\/list/.test(u)) {
      listCalls++;
      const body = listCalls === 1
        ? '{"status":200,"result":{"files":[]}}'
        : JSON.stringify({ status: 200, result: { files: [{ file_code: 'RECOVERED99', title: path.basename(tmpFile) }] } });
      return { statusCode: 200, headers: {}, body: { text: async () => body } };
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

  const res = await uploadFile('byse.sx', tmpFile, 'VALIDKEY', null, null, null);
  assert.strictEqual(res.file_code, 'RECOVERED99');
  assert.ok(listCalls >= 2, 'recovery polling must run when there is no explicit rejection');
});

test('byse never recovers an old file after a failed baseline', async () => {
  stubByseUploadServer();
  const abort = new AbortController();
  const fileName = path.basename(tmpFile);
  let listCalls = 0;
  requestRouter = async (url, opts) => {
    if (/\/file\/list/.test(String(url))) {
      listCalls++;
      if (listCalls === 1) {
        return {
          statusCode: 503,
          headers: { 'content-type': 'text/html' },
          body: { text: async () => '<html>baseline-token=SYNTHETIC_BYSE_BASELINE</html>' }
        };
      }
      abort.abort();
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: { text: async () => JSON.stringify({ status: 200, result: { files: [{ file_code: 'OLD_BYSE_123', title: fileName }] } }) }
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
    () => uploadFile('byse.sx', tmpFile, 'VALIDKEY', null, abort.signal, null),
    (err) => {
      assert.doesNotMatch(err.message, /SYNTHETIC_BYSE_BASELINE/);
      assert.equal(err.diagnostic.phase, 'recovery-baseline');
      assert.equal(err.diagnostic.http, 503);
      return true;
    }
  );
  assert.equal(listCalls, 1);
});

test('byse recovery rejects ambiguous same-title candidates', async () => {
  stubByseUploadServer();
  const abort = new AbortController();
  const fileName = path.basename(tmpFile);
  let listCalls = 0;
  requestRouter = async (url, opts) => {
    if (/\/file\/list/.test(String(url))) {
      listCalls++;
      if (listCalls === 1) {
        return { statusCode: 200, headers: {}, body: { text: async () => '{"status":200,"result":{"files":[]}}' } };
      }
      abort.abort();
      return {
        statusCode: 200,
        headers: {},
        body: {
          text: async () => JSON.stringify({
            status: 200,
            result: {
              files: [
                { file_code: 'PARALLEL_A', title: fileName },
                { file_code: 'PARALLEL_B', title: fileName }
              ]
            }
          })
        }
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
    () => uploadFile('byse.sx', tmpFile, 'VALIDKEY', null, abort.signal, null),
    (err) => err.hosterTransient === true
  );
});

function stubBysePost(response) {
  requestRouter = async (url, opts) => {
    const u = String(url);
    if (/\/file\/list/.test(u)) {
      return { statusCode: 200, headers: {}, body: { text: async () => '{"status":200,"result":{"files":[]}}' } };
    }
    if (opts && opts.body && typeof opts.body[Symbol.asyncIterator] === 'function') {
      for await (const chunk of opts.body) { if (chunk && chunk.length === -1) break; }
    }
    return response();
  };
}

test('byse upload POST 502 (HTML gateway body) is tagged transientNetwork', async () => {
  stubByseUploadServer();
  stubBysePost(() => ({
    statusCode: 502,
    headers: { 'content-type': 'text/html' },
    body: { text: async () => '<!doctype html><html><head><title>502 Bad Gateway</title></head><body>502 Bad Gateway</body></html>' }
  }));
  await assert.rejects(
    () => uploadFile('byse.sx', tmpFile, 'VALIDKEY', null, null, null),
    (err) => err.transientNetwork === true && /kein JSON \(HTTP 502\)/.test(err.message)
  );
});

test('byse upload POST non-2xx JSON 503 is tagged transientNetwork', async () => {
  stubByseUploadServer();
  stubBysePost(() => ({
    statusCode: 503,
    headers: { 'content-type': 'application/json' },
    body: { text: async () => JSON.stringify({ status: 503, msg: 'Service Unavailable' }) }
  }));
  await assert.rejects(
    () => uploadFile('byse.sx', tmpFile, 'VALIDKEY', null, null, null),
    (err) => err.transientNetwork === true
  );
});

test('byse upload POST 2xx envelope {status:500} is transient; {status:403} stays account-level', async () => {
  stubByseUploadServer();
  stubBysePost(() => ({
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: { text: async () => JSON.stringify({ status: 500, msg: 'Internal Server Error' }) }
  }));
  await assert.rejects(
    () => uploadFile('byse.sx', tmpFile, 'VALIDKEY', null, null, null),
    (err) => err.transientNetwork === true
  );

  stubBysePost(() => ({
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: { text: async () => JSON.stringify({ status: 403, msg: 'Forbidden' }) }
  }));
  await assert.rejects(
    () => uploadFile('byse.sx', tmpFile, 'VALIDKEY', null, null, null),
    (err) => err.transientNetwork !== true
  );
});
