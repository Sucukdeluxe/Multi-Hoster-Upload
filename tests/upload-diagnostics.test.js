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

test('behält sichere Transportdetails für eine konkrete Fehleranalyse', () => {
  const result = normalizeFailureDetails({
    phase: 'web-upload-confirmation',
    http: 502,
    contentType: 'application/json',
    safeEndpointHost: 'upload.doodstream.com',
    responseKind: 'json',
    retryable: true,
    payloadSnippet: 'json response (148 bytes)'
  });

  assert.deepEqual(result, {
    phase: 'web-upload-confirmation',
    httpStatus: 502,
    contentType: 'application/json',
    endpointHost: 'upload.doodstream.com',
    responseKind: 'json',
    retryable: true,
    responseSnippet: 'json response (148 bytes)'
  });
});

test('verwirft unsichere Transportfelder und unbenannte lange Geheimnisse', () => {
  const secret = 'SYNTHETIC_UNNAMED_SECRET_1234567890';
  const result = normalizeFailureDetails({
    phase: `upload ${secret}`,
    safeEndpointHost: `evil.example/${secret}`,
    responseKind: `json-${secret}`,
    payloadSnippet: `Authorization: Bearer ${secret}`
  });

  assert.equal(result.phase, 'upload [redacted]');
  assert.equal(result.endpointHost, undefined);
  assert.equal(result.responseKind, undefined);
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_UNNAMED_SECRET/);
});
