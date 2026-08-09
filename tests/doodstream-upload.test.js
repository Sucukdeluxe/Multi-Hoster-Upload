const { test } = require('node:test');
const assert = require('node:assert');
const DoodstreamUploader = require('../lib/doodstream-upload');

// The CDN hands back an XFileSharing form. `fn` is the filecode, `st` is the
// status ("OK" on success, an error string when the backend refuses the file).
// These tests pin the parse/error behaviour of _parseUploadResponse without
// touching the network — _fetch is stubbed to return the upload_result page.
function cdnForm({ fn = '', st = 'OK' } = {}) {
  return `<HTML><BODY><Form name='F1' action='https://cdn.example/' method='POST'>` +
    `<textarea name="op">upload_result</textarea>` +
    `<textarea name="fn">${fn}</textarea>` +
    `<textarea name="st">${st}</textarea>` +
    `</Form></BODY></HTML>`;
}

const EMPTY_RESULT = '<textarea id="copy_dl" readonly class="form-control" rows="5"></textarea>';
const LINK_RESULT = (code) => `<textarea id="copy_dl" readonly class="form-control" rows="5">https://myvidplay.com/d/${code}</textarea>`;

function uploaderWithResult(resultHtml) {
  const up = new DoodstreamUploader();
  up._lastUploadUrl = 'https://cdn.example/upload/01';
  // Stub the second-step submit so no real request goes out.
  up._fetch = async () => ({ text: async () => resultHtml });
  return up;
}

test('rejected file: empty fn + non-OK st surfaces the real status', async () => {
  const up = uploaderWithResult(EMPTY_RESULT);
  await assert.rejects(
    () => up._parseUploadResponse(cdnForm({ fn: '', st: 'Error: file already exists' })),
    (err) => {
      assert.match(err.message, /lehnt Datei ab/);
      assert.match(err.message, /file already exists/);
      return true;
    }
  );
});

test('empty fn + st OK: generic error still reports st, fn-state and CDN node', async () => {
  const up = uploaderWithResult(EMPTY_RESULT);
  await assert.rejects(
    () => up._parseUploadResponse(cdnForm({ fn: '', st: 'OK' })),
    (err) => {
      assert.match(err.message, /kein Filecode/);
      assert.match(err.message, /st=OK/);
      assert.match(err.message, /fehlt\/leer/);
      assert.match(err.message, /cdn\.example/);
      return true;
    }
  );
});

test('valid fn but empty result page: still resolves via fn (no regression)', async () => {
  const up = uploaderWithResult(EMPTY_RESULT);
  const res = await up._parseUploadResponse(cdnForm({ fn: '7mnp8xna3123', st: 'OK' }));
  assert.equal(res.file_code, '7mnp8xna3123');
  assert.equal(res.download_url, 'https://doodstream.com/d/7mnp8xna3123');
});

test('happy path: link in result page wins', async () => {
  const up = uploaderWithResult(LINK_RESULT('jjsuhr931ds9'));
  const res = await up._parseUploadResponse(cdnForm({ fn: 'jjsuhr931ds9', st: 'OK' }));
  assert.equal(res.file_code, 'jjsuhr931ds9');
});

// --- _parseUploadFormFields: replicate the current upload form faithfully ---
test('_parseUploadFormFields extracts the real form fields and excludes the file input', () => {
  const up = new DoodstreamUploader();
  const html = `
    <form name="file" enctype="multipart/form-data" action="https://uxg.cloudatacdn.com/upload/01?TOK" method="post">
      <input type="hidden" name="sess_id" value="TOK">
      <input name="file" type="file" size="30" id="filepc">
      <input name="fakefilepc" class="d-none" type="text" id="fakefilepc">
      <input type="text" name="file_title" class="form-control">
      <button type="submit" name="submit_btn" class="btn">Upload</button>
    </form>`;
  const f = up._parseUploadFormFields(html);
  assert.equal(f.sess_id, 'TOK');
  assert.equal(f.fakefilepc, '');
  assert.equal(f.file_title, '');
  assert.ok('submit_btn' in f);
  assert.ok(!('file' in f), 'the file input must be excluded (streamed separately)');
});

test('_parseUploadFormFields returns {} for markup without a form', () => {
  const up = new DoodstreamUploader();
  assert.deepEqual(up._parseUploadFormFields('<div>no form here</div>'), {});
  assert.deepEqual(up._parseUploadFormFields(''), {});
});

// --- deriveApiKey: pull + validate the account API key from the web session ---
test('_extractApiKeyCandidates finds the key in an input value and ranks api-context first', () => {
  const up = new DoodstreamUploader();
  const html = `
    <input type="text" name="csrf" value="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">
    <div class="panel">API Key <input readonly value="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"></div>
  `;
  const cands = up._extractApiKeyCandidates(html);
  // The token whose preceding context mentions "API" must rank first.
  assert.equal(cands[0], 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  assert.ok(cands.includes('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'));
});

test('_extractApiKeyCandidates handles textarea + api_key: "x" shapes and empty input', () => {
  const up = new DoodstreamUploader();
  assert.deepEqual(up._extractApiKeyCandidates(''), []);
  const ta = up._extractApiKeyCandidates('<textarea id="k">cccccccccccccccccccccccccccccccc</textarea>');
  assert.ok(ta.includes('cccccccccccccccccccccccccccccccc'));
  const js = up._extractApiKeyCandidates('var x = {"api_key":"dddddddddddddddddddddddddddddddd"};');
  assert.ok(js.includes('dddddddddddddddddddddddddddddddd'));
});

test('deriveApiKey returns the candidate that validates against the API', async () => {
  const up = new DoodstreamUploader();
  up._fetch = async () => ({ text: async () => '<div>API Key <input value="REALKEY1234567890abcdefGHIJK"></div><input value="notthekey000000000000000000">' });
  up._validateApiKey = async (key) => key === 'REALKEY1234567890abcdefGHIJK';
  const key = await up.deriveApiKey();
  assert.equal(key, 'REALKEY1234567890abcdefGHIJK');
  assert.equal(up.apiKey, 'REALKEY1234567890abcdefGHIJK'); // cached on the instance
});

test('deriveApiKey returns null when no candidate validates (→ caller uses web fallback)', async () => {
  const up = new DoodstreamUploader();
  up._fetch = async () => ({ text: async () => '<input value="bogustoken0000000000000000000">' });
  up._validateApiKey = async () => false;
  assert.equal(await up.deriveApiKey(), null);
  assert.equal(up.apiKey, '');
});

test('deriveApiKey short-circuits when a key is already set', async () => {
  const up = new DoodstreamUploader();
  up.apiKey = 'PRESET';
  let fetched = false;
  up._fetch = async () => { fetched = true; return { text: async () => '' }; };
  assert.equal(await up.deriveApiKey(), 'PRESET');
  assert.equal(fetched, false);
});

// --- _fetch: transient network blips on the small requests self-heal ---
test('_fetch retries a transient network failure then succeeds', async () => {
  const up = new DoodstreamUploader();
  const origFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) throw new TypeError('fetch failed');
    return { status: 200, headers: { getSetCookie: () => [], get: () => null }, text: async () => 'ok' };
  };
  try {
    const res = await up._fetch('https://example.test/x');
    assert.equal(calls, 2); // failed once, retried, succeeded
    assert.equal(await res.text(), 'ok');
  } finally {
    globalThis.fetch = origFetch;
  }
});

// --- _getUploadServer: discovery must never fall back to a hardcoded node ---
function fakeRes(body, { status = 200, ctype = 'text/html' } = {}) {
  return { status, headers: { get: (h) => (h.toLowerCase() === 'content-type' ? ctype : null) }, text: async () => body };
}

test('getUploadServer: returns JSON result when present', async () => {
  const up = new DoodstreamUploader();
  up._fetch = async (url) => {
    assert.match(url, /op=upload_server/);
    return fakeRes(JSON.stringify({ result: 'https://node42.cloudatacdn.com/upload/01' }), { ctype: 'application/json' });
  };
  assert.equal(await up._getUploadServer(), 'https://node42.cloudatacdn.com/upload/01');
});

test('getUploadServer: falls back to srv_url in upload-page HTML', async () => {
  const up = new DoodstreamUploader();
  up._fetch = async (url) => {
    if (/op=upload_server/.test(url)) return fakeRes('<html>not json</html>');
    return fakeRes('<script>var srv_url: "https://node7.cloudatacdn.com/upload/01";</script>');
  };
  assert.equal(await up._getUploadServer(), 'https://node7.cloudatacdn.com/upload/01');
});

test('getUploadServer: parses current form-action node and refreshes sess_id from the same page', async () => {
  const up = new DoodstreamUploader();
  up.sessId = 'stale-from-login';
  up._fetch = async (url) => {
    if (/op=upload_server/.test(url)) return fakeRes('<html>not json</html>');
    return fakeRes('<form name="file" enctype="multipart/form-data" action="https://n9.cloudatacdn.com/upload/01?FRESH123" method="post"><input type="hidden" name="sess_id" value="FRESH123"></form>');
  };
  const url = await up._getUploadServer();
  assert.equal(url, 'https://n9.cloudatacdn.com/upload/01?FRESH123');
  assert.equal(up.sessId, 'FRESH123'); // critical: form-field token must match the node URL token
});

test('getUploadServer: un-escapes &amp; in the form-action query string', async () => {
  const up = new DoodstreamUploader();
  up._fetch = async (url) => {
    if (/op=upload_server/.test(url)) return fakeRes('<html>not json</html>');
    return fakeRes('<form name="file" enctype="multipart/form-data" action="https://n9.cloudatacdn.com/upload/01?a=1&amp;b=2" method="post"></form>');
  };
  assert.equal(await up._getUploadServer(), 'https://n9.cloudatacdn.com/upload/01?a=1&b=2');
});

test('getUploadServer: throws (no silent dead fallback) when discovery fails', async () => {
  const up = new DoodstreamUploader();
  up._fetch = async () => fakeRes('<html><body>login required</body></html>', { status: 200 });
  await assert.rejects(
    () => up._getUploadServer(),
    (err) => {
      assert.match(err.message, /konnte Upload-Server nicht ermitteln/);
      assert.doesNotMatch(err.message, /tr1128ve\.cloudatacdn\.com/); // never the hardcoded node
      return true;
    }
  );
});
