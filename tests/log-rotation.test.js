const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { maybeRotateLogFile } = require('../lib/log-rotation');

let tmpDir;
let logFile;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mhu-log-rotation-'));
  logFile = path.join(tmpDir, 'fileuploader.log');
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

function writeBytes(p, n, fill = 'a') {
  fs.writeFileSync(p, fill.repeat(n), 'utf-8');
}

test('returns false and skips rotation when file does not exist', () => {
  const result = maybeRotateLogFile(logFile, 100);
  assert.equal(result, false);
  assert.equal(fs.existsSync(logFile), false);
});

test('returns false when file is below the size cap', () => {
  writeBytes(logFile, 50);
  const result = maybeRotateLogFile(logFile, 100);
  assert.equal(result, false);
  assert.equal(fs.statSync(logFile).size, 50, 'live file untouched');
  assert.equal(fs.existsSync(logFile + '.1'), false, 'no .1 created');
});

test('rotates live file to .1 when over cap', () => {
  writeBytes(logFile, 200, 'X');
  const result = maybeRotateLogFile(logFile, 100, 3);
  assert.equal(result, true);
  assert.equal(fs.existsSync(logFile), false, 'live file moved away');
  const expectedBackup = path.join(tmpDir, 'fileuploader.1.log');
  assert.equal(fs.existsSync(expectedBackup), true, '.1 backup exists');
  assert.equal(fs.statSync(expectedBackup).size, 200);
});

test('shifts existing backups up: .1 → .2, .2 → .3 on rotation', () => {
  writeBytes(path.join(tmpDir, 'fileuploader.2.log'), 10, 'B');
  writeBytes(path.join(tmpDir, 'fileuploader.1.log'), 20, 'A');
  writeBytes(logFile, 200, 'L');

  const result = maybeRotateLogFile(logFile, 100, 3);
  assert.equal(result, true);

  // Live file → .1 (latest live data)
  assert.equal(fs.statSync(path.join(tmpDir, 'fileuploader.1.log')).size, 200);
  // Old .1 → .2
  assert.equal(fs.statSync(path.join(tmpDir, 'fileuploader.2.log')).size, 20);
  // Old .2 → .3
  assert.equal(fs.statSync(path.join(tmpDir, 'fileuploader.3.log')).size, 10);
});

test('drops oldest backup when at maxBackups limit', () => {
  // Pre-populate all three backup slots.
  writeBytes(path.join(tmpDir, 'fileuploader.3.log'), 5, 'C');  // oldest, will be dropped
  writeBytes(path.join(tmpDir, 'fileuploader.2.log'), 10, 'B');
  writeBytes(path.join(tmpDir, 'fileuploader.1.log'), 20, 'A');
  writeBytes(logFile, 200, 'L');

  const result = maybeRotateLogFile(logFile, 100, 3);
  assert.equal(result, true);

  // Old .3 (5 bytes 'C') gone, replaced by old .2.
  const f3 = fs.statSync(path.join(tmpDir, 'fileuploader.3.log'));
  assert.equal(f3.size, 10, 'old .2 became new .3 (the C-file was dropped)');
  // .2 = old .1
  assert.equal(fs.statSync(path.join(tmpDir, 'fileuploader.2.log')).size, 20);
  // .1 = the live file we just rotated
  assert.equal(fs.statSync(path.join(tmpDir, 'fileuploader.1.log')).size, 200);
});

test('is idempotent — second call on still-large file rotates again', () => {
  writeBytes(logFile, 200, 'X');
  maybeRotateLogFile(logFile, 100, 3);
  // Simulate fresh writes after the first rotation
  writeBytes(logFile, 200, 'Y');
  const result = maybeRotateLogFile(logFile, 100, 3);
  assert.equal(result, true);
  // The .Y file is now .1, the .X file moved to .2
  assert.equal(fs.readFileSync(path.join(tmpDir, 'fileuploader.1.log'), 'utf-8')[0], 'Y');
  assert.equal(fs.readFileSync(path.join(tmpDir, 'fileuploader.2.log'), 'utf-8')[0], 'X');
});

test('maxBackups=1: only keeps a single .1 backup, never .2', () => {
  writeBytes(logFile, 200, 'L');
  maybeRotateLogFile(logFile, 100, 1);
  writeBytes(logFile, 200, 'M');
  maybeRotateLogFile(logFile, 100, 1);

  // .1 holds the latest rotated content (M)
  assert.equal(fs.readFileSync(path.join(tmpDir, 'fileuploader.1.log'), 'utf-8')[0], 'M');
  // .2 must NOT exist
  assert.equal(fs.existsSync(path.join(tmpDir, 'fileuploader.2.log')), false);
});

test('invalid maxBytes (0, negative, NaN) is a no-op', () => {
  writeBytes(logFile, 1000, 'X');
  for (const max of [0, -1, NaN]) {
    const r = maybeRotateLogFile(logFile, max);
    assert.equal(r, false, `maxBytes=${max} should be no-op`);
  }
  assert.equal(fs.existsSync(logFile), true);
  assert.equal(fs.existsSync(logFile + '.1'), false);
});

test('logs through provided debug callback on rotation', () => {
  writeBytes(logFile, 200, 'X');
  const messages = [];
  maybeRotateLogFile(logFile, 100, 3, (m) => messages.push(m));
  assert.ok(messages.length >= 1, 'at least one log message');
  assert.ok(messages.some(m => m.includes('rotated')), `expected "rotated" in: ${messages.join(' | ')}`);
});

test('handles file without extension correctly', () => {
  const noExtFile = path.join(tmpDir, 'plainlog');
  writeBytes(noExtFile, 200, 'P');
  const result = maybeRotateLogFile(noExtFile, 100, 3);
  assert.equal(result, true);
  // base = the full path, ext = '', so backup name is "plainlog.1"
  assert.equal(fs.existsSync(path.join(tmpDir, 'plainlog.1')), true);
  assert.equal(fs.existsSync(noExtFile), false);
});
