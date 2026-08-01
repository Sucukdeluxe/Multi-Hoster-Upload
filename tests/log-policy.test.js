const { test } = require('node:test');
const assert = require('node:assert/strict');

const { hosterLogToFileEnabled } = require('../lib/log-policy');

test('enabled by default when settings missing entirely', () => {
  assert.equal(hosterLogToFileEnabled(null, 'voe.sx'), true);
  assert.equal(hosterLogToFileEnabled(undefined, 'voe.sx'), true);
  assert.equal(hosterLogToFileEnabled('not-an-object', 'voe.sx'), true);
});

test('enabled when hoster has no settings entry', () => {
  assert.equal(hosterLogToFileEnabled({}, 'voe.sx'), true);
  assert.equal(hosterLogToFileEnabled({ 'byse.sx': { logToFile: false } }, 'voe.sx'), true);
});

test('enabled when hoster entry has no logToFile key (back-compat with old configs)', () => {
  assert.equal(hosterLogToFileEnabled({ 'voe.sx': { retries: 3 } }, 'voe.sx'), true);
});

test('enabled when logToFile is explicitly true', () => {
  assert.equal(hosterLogToFileEnabled({ 'voe.sx': { logToFile: true } }, 'voe.sx'), true);
});

test('DISABLED only when logToFile is explicitly false', () => {
  assert.equal(hosterLogToFileEnabled({ 'voe.sx': { logToFile: false } }, 'voe.sx'), false);
});

test('truthy-but-not-true values do not accidentally disable', () => {
  // Only the strict boolean false disables — guards against e.g. a stored 0/""
  assert.equal(hosterLogToFileEnabled({ 'voe.sx': { logToFile: 0 } }, 'voe.sx'), true);
  assert.equal(hosterLogToFileEnabled({ 'voe.sx': { logToFile: '' } }, 'voe.sx'), true);
  assert.equal(hosterLogToFileEnabled({ 'voe.sx': { logToFile: null } }, 'voe.sx'), true);
  assert.equal(hosterLogToFileEnabled({ 'voe.sx': { logToFile: undefined } }, 'voe.sx'), true);
});

test('per-hoster independence: one off, others on', () => {
  const settings = {
    'voe.sx': { logToFile: false },
    'byse.sx': { logToFile: true },
    'doodstream.com': { retries: 3 }
  };
  assert.equal(hosterLogToFileEnabled(settings, 'voe.sx'), false);
  assert.equal(hosterLogToFileEnabled(settings, 'byse.sx'), true);
  assert.equal(hosterLogToFileEnabled(settings, 'doodstream.com'), true);
  assert.equal(hosterLogToFileEnabled(settings, 'clouddrop.cc'), true); // not present → on
});

test('malformed hoster entry (string/number) defaults to on', () => {
  assert.equal(hosterLogToFileEnabled({ 'voe.sx': 'broken' }, 'voe.sx'), true);
  assert.equal(hosterLogToFileEnabled({ 'voe.sx': 42 }, 'voe.sx'), true);
});
