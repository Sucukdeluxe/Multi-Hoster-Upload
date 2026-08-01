const { test } = require('node:test');
const assert = require('node:assert');
const { selectUploadAuth } = require('../lib/account-auth');

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
