const { test } = require('node:test');
const assert = require('node:assert');
const { normalizeLogMode, resolveLogFileName, formatDateStamp, formatSessionStamp, isManagedUploadLogFileName } = require('../lib/log-mode');

// --- normalizeLogMode ---

test('normalizeLogMode: default for empty/null/undefined is "single"', () => {
  assert.equal(normalizeLogMode(), 'single');
  assert.equal(normalizeLogMode(null), 'single');
  assert.equal(normalizeLogMode({}), 'single');
});

test('normalizeLogMode: explicit logMode wins for all three valid values', () => {
  assert.equal(normalizeLogMode({ logMode: 'single' }), 'single');
  assert.equal(normalizeLogMode({ logMode: 'daily' }), 'daily');
  assert.equal(normalizeLogMode({ logMode: 'session' }), 'session');
});

test('regression: legacy sessionLog:true maps to "daily", NOT "session"', () => {
  // The legacy boolean field was named after a misnomer — it actually toggled
  // per-day logging. Mapping it to "session" would silently flip every existing
  // per-day user onto per-session, which is exactly the bug the migration trap
  // exists to prevent.
  assert.equal(normalizeLogMode({ sessionLog: true }), 'daily');
});

test('normalizeLogMode: sessionLog:false / missing maps to "single"', () => {
  assert.equal(normalizeLogMode({ sessionLog: false }), 'single');
});

test('normalizeLogMode: explicit logMode beats the legacy sessionLog field', () => {
  // Once a user picks a mode in 3.3.35+, the legacy boolean must NOT override.
  assert.equal(normalizeLogMode({ logMode: 'session', sessionLog: true }), 'session');
  assert.equal(normalizeLogMode({ logMode: 'single', sessionLog: true }), 'single');
});

test('normalizeLogMode: invalid logMode strings fall through to single (or legacy if present)', () => {
  assert.equal(normalizeLogMode({ logMode: 'lolnope' }), 'single');
  assert.equal(normalizeLogMode({ logMode: '' }), 'single');
  assert.equal(normalizeLogMode({ logMode: 'lolnope', sessionLog: true }), 'daily');
});

// --- resolveLogFileName ---

test('resolveLogFileName: single mode → bare basename + ext', () => {
  assert.equal(
    resolveLogFileName({ baseName: 'fileuploader', ext: '.log', mode: 'single' }),
    'fileuploader.log'
  );
});

test('resolveLogFileName: daily mode → fileuploader-YYYY-MM-DD.log', () => {
  const d = new Date(2026, 4, 28); // May 28, 2026 — month is 0-indexed
  assert.equal(
    resolveLogFileName({ baseName: 'fileuploader', ext: '.log', mode: 'daily', date: d }),
    'fileuploader-2026-05-28.log'
  );
});

test('resolveLogFileName: session mode → <sessionId>.log (baseName ignored)', () => {
  assert.equal(
    resolveLogFileName({ baseName: 'fileuploader', ext: '.log', mode: 'session', sessionId: '26-05-2026-mdu-session-22-44' }),
    '26-05-2026-mdu-session-22-44.log'
  );
});

test('formatSessionStamp: DD-MM-YYYY-mdu-session-HH-MM', () => {
  const { formatSessionStamp } = require('../lib/log-mode');
  assert.equal(formatSessionStamp(new Date(2026, 5, 26, 6, 2, 36)), '26-06-2026-mdu-session-06-02');
});

test('formatSessionStamp: appends a 6-digit suffix when a rand is supplied', () => {
  assert.equal(formatSessionStamp(new Date(2026, 5, 26, 6, 2, 36), '847581'), '26-06-2026-mdu-session-06-02-847581');
  assert.equal(formatSessionStamp(new Date(2026, 5, 26, 6, 2, 36), 847581), '26-06-2026-mdu-session-06-02-847581');
});

test('resolveLogFileName: session mode with missing sessionId falls back to single (never emits malformed name)', () => {
  assert.equal(
    resolveLogFileName({ baseName: 'fileuploader', ext: '.log', mode: 'session' }),
    'fileuploader.log'
  );
});

test('resolveLogFileName: unknown mode is treated as single', () => {
  assert.equal(
    resolveLogFileName({ baseName: 'fileuploader', ext: '.log', mode: 'lolnope' }),
    'fileuploader.log'
  );
});

test('managed upload-log discovery includes session logs and excludes unrelated logs', () => {
  assert.equal(typeof isManagedUploadLogFileName, 'function');
  const options = { baseName: 'fileuploader', ext: '.log' };
  assert.equal(isManagedUploadLogFileName('fileuploader.log', options), true);
  assert.equal(isManagedUploadLogFileName('fileuploader-2026-08-27.log', options), true);
  assert.equal(isManagedUploadLogFileName('fileuploader-session-2026-08-27_05-40-59-1234.log', options), true);
  assert.equal(isManagedUploadLogFileName('27-08-2026-mdu-session-05-40-599797.log', options), true);
  assert.equal(isManagedUploadLogFileName('FILEUPLOADER-2026-08-27.LOG', options), true);
  assert.equal(isManagedUploadLogFileName('27-08-2026-MDU-SESSION-05-40-599797.LOG', options), true);
  assert.equal(isManagedUploadLogFileName('upload-audit.log', options), false);
  assert.equal(isManagedUploadLogFileName('account-rotation.log', options), false);
  assert.equal(isManagedUploadLogFileName('upload-debug.log', options), false);
  assert.equal(isManagedUploadLogFileName('27-08-2026-mdu-session-05-40-599797.txt', options), false);
});

// --- stripModeStampFromFileName ---

const { stripModeStampFromFileName } = require('../lib/log-mode');

test('stripModeStampFromFileName: leaves bare names alone', () => {
  assert.equal(stripModeStampFromFileName('fileuploader.log'), 'fileuploader.log');
  assert.equal(stripModeStampFromFileName('fileuploader'), 'fileuploader');
});

test('stripModeStampFromFileName: strips a daily YYYY-MM-DD suffix', () => {
  assert.equal(stripModeStampFromFileName('fileuploader-2026-06-03.log'), 'fileuploader.log');
});

test('stripModeStampFromFileName: strips a session-stamp suffix (with and without pid)', () => {
  assert.equal(
    stripModeStampFromFileName('fileuploader-session-2026-06-03_18-16-20-8132.log'),
    'fileuploader.log'
  );
  assert.equal(
    stripModeStampFromFileName('fileuploader-session-2026-06-03_18-16-20.log'),
    'fileuploader.log'
  );
});

test('stripModeStampFromFileName: new DD-MM-YYYY-mdu-session-HH-MM resets to the default base', () => {
  assert.equal(stripModeStampFromFileName('26-06-2026-mdu-session-06-02.log'), 'fileuploader.log');
  assert.equal(stripModeStampFromFileName('26-06-2026-mdu-session-06-02-847581.log'), 'fileuploader.log');
});

test('regression: resolveLogFileName(stripModeStampFromFileName(...)) is idempotent — persisting then re-resolving never compounds stamps', () => {
  // This is the exact bug shape: persist the resolved path, then on next call
  // re-resolve from the saved base — must produce the same file, not a doubled
  // session-stamped one. The fix is the strip; this test guards against
  // regressing _persistFallbackLogPath into the 3.3.35 bug.
  const sessionId = '03-06-2026-mdu-session-18-16';
  const dailyDate = new Date(2026, 5, 3);
  for (const mode of ['daily', 'session']) {
    const date = mode === 'daily' ? dailyDate : new Date();
    const initial = resolveLogFileName({ baseName: 'fileuploader', ext: '.log', mode, date, sessionId });
    const stripped = stripModeStampFromFileName(initial);
    // After strip, the base should be back to the bare name.
    assert.equal(stripped, 'fileuploader.log', `${mode}: strip should produce bare base`);
    // Re-resolving from the bare base gives the same final filename — no doubling.
    const reBase = stripped.replace(/\.log$/, '');
    const second = resolveLogFileName({ baseName: reBase, ext: '.log', mode, date, sessionId });
    assert.equal(second, initial, `${mode}: round-trip must be idempotent`);
  }
});

// --- format helpers ---

test('formatDateStamp: zero-pads month and day', () => {
  assert.equal(formatDateStamp(new Date(2026, 0, 3)), '2026-01-03');
  assert.equal(formatDateStamp(new Date(2026, 11, 31)), '2026-12-31');
});

test('formatSessionStamp: DD-MM-YYYY-mdu-session-HH-MM (no seconds/pid)', () => {
  assert.equal(formatSessionStamp(new Date(2026, 4, 28, 7, 9, 5)), '28-05-2026-mdu-session-07-09');
  assert.equal(formatSessionStamp(new Date(2026, 4, 28, 22, 44, 52)), '28-05-2026-mdu-session-22-44');
});
