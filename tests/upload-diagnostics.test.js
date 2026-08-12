const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeFailureDetails } = require('../lib/upload-diagnostics');

test('normalisiert Fehlerdiagnosen ohne URLs oder lange Antworten zu speichern', () => {
  const result = normalizeFailureDetails({
    http: 503,
    contentType: 'text/html; charset=utf-8',
    payloadSnippet: 'https://private.example/upload?key=secret '.repeat(80),
    uploadUrl: 'https://private.example/upload?key=secret'
  });

  assert.equal(result.httpStatus, 503);
  assert.equal(result.contentType, 'text/html; charset=utf-8');
  assert.match(result.responseSnippet, /^private\.example\/upload/);
  assert.ok(result.responseSnippet.length <= 320);
});

test('ignoriert leere und ungültige Diagnosefelder', () => {
  assert.equal(normalizeFailureDetails({ http: 'x', contentType: '', payloadSnippet: '' }), null);
});

test('bereinigt Zugangsdaten und mehrere URLs aus Hosterantworten', () => {
  const result = normalizeFailureDetails({ payloadSnippet: 'token=secret https://one.example/a?key=one password: hunter2 https://two.example/b' });

  assert.equal(result.responseSnippet, 'token=[redacted] one.example/a password: [redacted] two.example/b');
});
