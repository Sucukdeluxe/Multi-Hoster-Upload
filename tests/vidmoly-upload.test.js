const test = require('node:test');
const assert = require('node:assert/strict');
const VidmolyUploader = require('../lib/vidmoly-upload');

function response(status, payload) {
  return { status, text: async () => typeof payload === 'string' ? payload : JSON.stringify(payload) };
}

function loginFixture({ loginStatus = 200, login = {}, session = 'test-session', probeStatus = 200, probe = { user: { usr_id: 1 } } } = {}) {
  const uploader = new VidmolyUploader();
  const calls = [];
  uploader._fetch = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/api/auth/login')) {
      if (session !== null) uploader.cookies.set('vidmoly_session', session);
      return response(loginStatus, login);
    }
    if (url.endsWith('/api/auth/me')) return response(probeStatus, probe);
    assert.equal(url, 'https://vidmoly.me');
    return response(200, '');
  };
  return { uploader, calls };
}

test('Vidmoly verifies the website session independently of upload availability', async () => {
  const { uploader, calls } = loginFixture({ probe: { user: { usr_id: 1 }, upload: { allowed: false, reason: 'disk_full' } } });
  await uploader.login('test-user', 'test-password');
  assert.deepEqual(calls.map(call => call.url), [
    'https://vidmoly.me', 'https://vidmoly.me/api/auth/login', 'https://vidmoly.me/api/auth/me'
  ]);
  assert.deepEqual(JSON.parse(calls[1].options.body), { login: 'test-user', password: 'test-password' });
});

test('Vidmoly does not interpret arbitrary successful response text as a password error', async () => {
  await loginFixture({ login: { login: 'wrong-example' } }).uploader.login('test-user', 'test-password');
});

test('Vidmoly stops after an OTP challenge without probing or repeating login', async () => {
  const { uploader, calls } = loginFixture({ login: { otp_required: 1 }, session: null });
  await assert.rejects(uploader.login('test-user', 'test-password'), /OTP erforderlich/);
  assert.equal(calls.length, 2);
});

test('Vidmoly rejects missing sessions, invalid users and failed session probes', async () => {
  for (const options of [{ session: null }, { session: '' }, { probe: {} }, { probe: { user: {} } }, { probe: { user: [] } }, { probe: '<html>Login</html>' }, { probeStatus: 401 }, { probeStatus: 503 }]) {
    await assert.rejects(loginFixture(options).uploader.login('test-user', 'test-password'), /Vidmoly Login fehlgeschlagen/);
  }
  await assert.rejects(loginFixture({ loginStatus: 401 }).uploader.login('test-user', 'test-password'), /Falscher Username/);
  await assert.rejects(loginFixture({ loginStatus: 403 }).uploader.login('test-user', 'test-password'), /HTTP 403/);
});

test('Vidmoly preserves upload denial causes without exposing response data', async () => {
  for (const [code, expected] of [
    ['DISK_FULL', /disk full/],
    ['UPLOAD_IP_BLACKLIST', /IP-Adresse gesperrt/],
    ['UPLOAD_DISABLED', /Account deaktiviert/]
  ]) {
    for (const status of [200, 403]) {
      const uploader = new VidmolyUploader();
      uploader._fetch = async () => response(status, { message: `${code}: private-data` });
      await assert.rejects(uploader.getUploadParams(), error => expected.test(error.message) && !error.message.includes('private-data'));
    }
  }
});

test('Vidmoly validates config responses before streaming a file', async () => {
  for (const [status, payload, expected] of [
    [401, {}, /HTTP 401/],
    [503, '<html>Unavailable</html>', /HTTP 503/],
    [200, '<html>Login</html>', /kein JSON/],
    [200, {}, /unvollständig/],
    [200, { sess_id: {}, upload_url: 'https://upload.example/' }, /unvollständig/],
    [200, { sess_id: 'test', upload_url: 'file:///private' }, /Ungültige/],
    [200, { sess_id: 'test', upload_url: 'https://user:password@upload.example/' }, /Ungültige/]
  ]) {
    const uploader = new VidmolyUploader();
    uploader._fetch = async () => response(status, payload);
    await assert.rejects(uploader.getUploadParams(), expected);
  }
});

test('Vidmoly uses the current website upload fields without an API key', async () => {
  const uploader = new VidmolyUploader();
  uploader._fetch = async url => {
    assert.equal(url, 'https://vidmoly.me/api/upload/config');
    return response(200, { sess_id: 'test-session', upload_url: 'https://upload.example/upload' });
  };
  assert.deepEqual(await uploader.getUploadParams(), {
    uploadUrl: 'https://upload.example/upload',
    params: { sess_id: 'test-session', tos: '1', to_json: '1', fld_id: '0' },
    fileFieldName: 'file'
  });
});
