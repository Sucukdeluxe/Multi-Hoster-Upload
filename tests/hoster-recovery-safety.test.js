const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let requestRouter = async () => ({ statusCode: 200, headers: {}, body: { text: async () => '{}' } });
const undici = require('undici');
const originalRequest = undici.request;
undici.request = (...args) => requestRouter(...args);
delete require.cache[require.resolve('../lib/hosters')];
const hosters = require('../lib/hosters');

let tempRoot;
let uploadPath;
let originalFetch;

before(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mhu-recovery-safety-'));
  uploadPath = path.join(tempRoot, 'Shared Episode.mkv');
  fs.writeFileSync(uploadPath, Buffer.alloc(2048, 7));
  originalFetch = global.fetch;
  hosters.__test.DOODSTREAM_POLL.attempts = 1;
  hosters.__test.DOODSTREAM_POLL.delayMs = 0;
});

after(() => {
  global.fetch = originalFetch;
  undici.request = originalRequest;
  delete require.cache[require.resolve('../lib/hosters')];
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function stubUploadServer() {
  global.fetch = async () => ({
    status: 200,
    text: async () => JSON.stringify({ status: 200, result: 'https://node1.cloudatacdn.com/upload/01' })
  });
}

function response(body, statusCode = 200) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: { text: async () => typeof body === 'string' ? body : JSON.stringify(body) }
  };
}

async function drain(body) {
  if (!body || typeof body[Symbol.asyncIterator] !== 'function') return;
  for await (const chunk of body) {
    if (chunk && chunk.length === -1) break;
  }
}

function createClaim() {
  const codes = new Set();
  return {
    has: (code) => codes.has(String(code)),
    reserve(code) {
      const normalized = String(code || '').trim();
      if (!normalized || codes.has(normalized)) return false;
      codes.add(normalized);
      return true;
    }
  };
}

test('parallel same-name recovery cannot reuse a directly confirmed remote file', async () => {
  stubUploadServer();
  const recoveryClaim = createClaim();
  let uploadCalls = 0;
  requestRouter = async (url, options) => {
    if (/\/api\/file\/list/.test(String(url))) {
      return response({
        status: 200,
        result: { files: [{ file_code: 'SHARED_REMOTE_CODE', title: path.basename(uploadPath) }] }
      });
    }
    await drain(options && options.body);
    uploadCalls++;
    if (uploadCalls === 1) {
      return response({
        status: 200,
        result: [{ filecode: 'SHARED_REMOTE_CODE', download_url: 'https://doodstream.com/d/SHARED_REMOTE_CODE' }]
      });
    }
    return response({ status: 200, msg: 'OK' });
  };

  const results = await Promise.allSettled([
    hosters.uploadFile('doodstream.com', uploadPath, 'VALIDKEY', null, null, null, {
      doodBaseline: new Set(),
      recoveryClaim
    }),
    hosters.uploadFile('doodstream.com', uploadPath, 'VALIDKEY', null, null, null, {
      doodBaseline: new Set(),
      recoveryClaim
    })
  ]);

  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal(results.find(result => result.status === 'fulfilled').value.file_code, 'SHARED_REMOTE_CODE');
  assert.equal(results.find(result => result.status === 'rejected').reason.hosterTransient, true);
});

test('a direct response rejects a remote code already reserved in its recovery scope', async () => {
  stubUploadServer();
  const recoveryClaim = createClaim();
  recoveryClaim.reserve('ALREADY_RESERVED_CODE');
  requestRouter = async (url, options) => {
    if (/\/api\/file\/list/.test(String(url))) {
      return response({ status: 200, result: { files: [] } });
    }
    await drain(options && options.body);
    return response({
      status: 200,
      result: [{
        filecode: 'ALREADY_RESERVED_CODE',
        download_url: 'https://doodstream.com/d/ALREADY_RESERVED_CODE'
      }]
    });
  };

  await assert.rejects(
    () => hosters.uploadFile('doodstream.com', uploadPath, 'VALIDKEY', null, null, null, {
      doodBaseline: new Set(),
      recoveryClaim
    }),
    error => {
      assert.equal(error.hosterTransient, true);
      assert.equal(error.diagnostic.phase, 'upload-result');
      assert.equal(error.diagnostic.http, 200);
      assert.doesNotMatch(error.message, /ALREADY_RESERVED_CODE/);
      return true;
    }
  );
});

for (const fixture of [
  { name: 'semantic error payload', payload: { status: 'error', msg: 'invalid key' } },
  { name: 'missing files list', payload: { status: 200, result: {} } }
]) {
  test(`doodstream rejects a ${fixture.name} as a recovery baseline`, async () => {
    stubUploadServer();
    let listCalls = 0;
    requestRouter = async (url, options) => {
      if (/\/api\/file\/list/.test(String(url))) {
        listCalls++;
        return response(fixture.payload);
      }
      await drain(options && options.body);
      return response({ status: 200, msg: 'OK' });
    };

    await assert.rejects(
      () => hosters.uploadFile('doodstream.com', uploadPath, 'VALIDKEY', null, null, null),
      error => {
        assert.equal(error.diagnostic.phase, 'recovery-baseline');
        assert.equal(error.diagnostic.http, 200);
        assert.equal(error.hosterTransient, true);
        assert.doesNotMatch(error.message, /invalid key/i);
        return true;
      }
    );
    assert.equal(listCalls, 1);
  });
}

test('byse rejects a missing files list as a recovery baseline', async () => {
  global.fetch = async () => ({
    status: 200,
    text: async () => JSON.stringify({ status: 200, result: 'https://byse-upload.invalid/upload/01' })
  });
  let listCalls = 0;
  requestRouter = async (url, options) => {
    if (/\/file\/list/.test(String(url))) {
      listCalls++;
      return response({ status: 200, result: {} });
    }
    await drain(options && options.body);
    return response({ status: 200, msg: 'OK' });
  };

  await assert.rejects(
    () => hosters.uploadFile('byse.sx', uploadPath, 'VALIDKEY', null, null, null),
    error => {
      assert.equal(error.diagnostic.phase, 'recovery-baseline');
      assert.equal(error.diagnostic.http, 200);
      assert.equal(error.hosterTransient, true);
      return true;
    }
  );
  assert.equal(listCalls, 1);
});

test('a cancelled recovery lock waiter exits before the active lease finishes', async () => {
  const registry = hosters.createRecoveryClaimRegistry();
  const claim = registry.forUpload('doodstream.com', 'ACCOUNT_KEY', 'Shared Episode.mkv');
  let releaseFirst;
  const firstBlocked = new Promise(resolve => {
    releaseFirst = resolve;
  });
  let markFirstEntered;
  const firstEntered = new Promise(resolve => {
    markFirstEntered = resolve;
  });
  const first = claim.runExclusive(async () => {
    markFirstEntered();
    await firstBlocked;
  });
  await firstEntered;
  const abortController = new AbortController();
  const second = claim.runExclusive(async () => 'unexpected', abortController.signal);
  abortController.abort();

  try {
    const outcome = await Promise.race([
      second.then(value => ({ status: 'fulfilled', value }), error => ({ status: 'rejected', error })),
      new Promise(resolve => setTimeout(() => resolve({ status: 'timeout' }), 100))
    ]);
    assert.equal(outcome.status, 'rejected');
    assert.equal(outcome.error.name, 'AbortError');
  } finally {
    releaseFirst();
    await first;
    await second.catch(() => {});
  }
});
