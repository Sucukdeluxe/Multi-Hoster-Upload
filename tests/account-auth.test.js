const { test } = require('node:test');
const assert = require('node:assert');
const { createDoodstreamOtpCoordinator, selectUploadAuth } = require('../lib/account-auth');

test('doodstream prefers the API key even when username/password are also set', () => {
  const auth = selectUploadAuth('doodstream.com', {
    apiKey: 'KEY123', username: 'u', password: 'p'
  });
  assert.deepEqual(auth, { apiKey: 'KEY123' }); // API path — no username leaks through
});

test('doodstream with only username/password uses web login (keyless fallback)', () => {
  const auth = selectUploadAuth('doodstream.com', { username: 'u', password: 'p' });
  assert.deepEqual(auth, { username: 'u', password: 'p' });
});

test('doodstream with empty apiKey + creds falls back to web login (no false API route)', () => {
  const auth = selectUploadAuth('doodstream.com', { apiKey: '', username: 'u', password: 'p' });
  assert.deepEqual(auth, { username: 'u', password: 'p' });
});

test('doodstream with nothing usable returns empty', () => {
  assert.deepEqual(selectUploadAuth('doodstream.com', { apiKey: '', username: '', password: '' }), {});
});

test('voe.sx is unaffected by the doodstream special-case: username/password wins', () => {
  // voe also supports both, but the empty-form bug is doodstream-specific; do
  // not change voe routing.
  const auth = selectUploadAuth('voe.sx', { apiKey: 'VKEY', username: 'u', password: 'p' });
  assert.deepEqual(auth, { username: 'u', password: 'p' });
});

test('authType=api forces the API key for any hoster', () => {
  assert.deepEqual(selectUploadAuth('voe.sx', { authType: 'api', apiKey: 'K', username: 'u', password: 'p' }), { apiKey: 'K' });
});

test('api-key-only account (no creds) uses the key', () => {
  assert.deepEqual(selectUploadAuth('byse.sx', { apiKey: 'BKEY' }), { apiKey: 'BKEY' });
});

test('null / non-object account does not throw', () => {
  assert.deepEqual(selectUploadAuth('doodstream.com', null), {});
  assert.deepEqual(selectUploadAuth('doodstream.com', undefined), {});
});

function otpRequired(message = 'OTP erforderlich') {
  const error = new Error(message);
  error.otpRequired = true;
  return error;
}

test('concurrent and repeated Doodstream checks request only one OTP', async () => {
  let loginCalls = 0;
  let releaseLogin;
  const coordinator = createDoodstreamOtpCoordinator({
    createUploader: () => ({
      login: () => new Promise((resolve, reject) => {
        loginCalls++;
        releaseLogin = () => reject(otpRequired('OTP gesendet'));
      })
    })
  });
  const first = coordinator.check({ username: 'user', password: 'secret' });
  const second = coordinator.check({ username: 'user', password: 'secret' });
  assert.equal(loginCalls, 1);
  releaseLogin();
  assert.deepEqual(await first, { status: 'otp_required', message: 'OTP gesendet' });
  assert.deepEqual(await second, { status: 'otp_required', message: 'OTP gesendet' });
  assert.deepEqual(await coordinator.check({ username: 'user', password: 'secret' }), { status: 'otp_required', message: 'OTP gesendet' });
  assert.equal(loginCalls, 1);
});

test('Doodstream OTP verification reuses the challenged uploader session', async () => {
  let created = 0;
  const calls = [];
  const coordinator = createDoodstreamOtpCoordinator({
    createUploader: () => {
      created++;
      return {
        async login(_username, _password, otp) {
          calls.push(otp || '');
          if (!otp) throw otpRequired('OTP gesendet');
        }
      };
    }
  });
  assert.equal((await coordinator.check({ username: 'user', password: 'secret' })).status, 'otp_required');
  assert.deepEqual(await coordinator.check({ username: 'user', password: 'secret', otp: '123456' }), {
    status: 'ok',
    message: 'Login ok, Upload-Seite bereit'
  });
  assert.equal(created, 1);
  assert.deepEqual(calls, ['', '123456']);
});

test('a rejected OTP remains pending without requesting another code', async () => {
  let created = 0;
  let calls = 0;
  const coordinator = createDoodstreamOtpCoordinator({
    createUploader: () => {
      created++;
      return {
        async login(_username, _password, otp) {
          calls++;
          if (!otp) throw otpRequired('OTP gesendet');
          throw new Error('Code ungültig');
        }
      };
    }
  });
  await coordinator.check({ username: 'user', password: 'secret' });
  assert.deepEqual(await coordinator.check({ username: 'user', password: 'secret', otp: '000000' }), {
    status: 'otp_required',
    message: 'Code ungültig'
  });
  assert.deepEqual(await coordinator.check({ username: 'user', password: 'secret' }), {
    status: 'otp_required',
    message: 'Code ungültig'
  });
  assert.equal(created, 1);
  assert.equal(calls, 2);
});

test('explicit OTP resend is rate-limited and starts one fresh session', async () => {
  let currentTime = 1000;
  let created = 0;
  const coordinator = createDoodstreamOtpCoordinator({
    now: () => currentTime,
    resendCooldownMs: 60000,
    createUploader: () => {
      created++;
      return { login: async () => { throw otpRequired('OTP gesendet'); } };
    }
  });
  await coordinator.check({ username: 'user', password: 'secret' });
  await coordinator.check({ username: 'user', password: 'secret', requestNewChallenge: true });
  assert.equal(created, 1);
  currentTime += 60000;
  await coordinator.check({ username: 'user', password: 'secret', requestNewChallenge: true });
  assert.equal(created, 2);
});

test('expired OTP submission cannot create a replacement challenge implicitly', async () => {
  let currentTime = 1000;
  let created = 0;
  const coordinator = createDoodstreamOtpCoordinator({
    now: () => currentTime,
    challengeTtlMs: 1000,
    createUploader: () => {
      created++;
      return { login: async () => { throw otpRequired('OTP gesendet'); } };
    }
  });
  await coordinator.check({ username: 'user', password: 'secret' });
  currentTime += 1001;
  assert.deepEqual(await coordinator.check({ username: 'user', password: 'secret', otp: '123456' }), {
    status: 'otp_required',
    message: 'OTP-Anfrage ist abgelaufen. Bitte einen neuen Code anfordern.'
  });
  assert.equal(created, 1);
});
