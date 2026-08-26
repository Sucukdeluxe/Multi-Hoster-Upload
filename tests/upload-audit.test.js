const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createInternalLogPathResolver,
  createInternalLogWriter,
  createBufferedInternalLogFlusher,
  createUploadAuditWriter,
  getLogOpenDirectory
} = require('../lib/upload-audit');

function createTempDirectory(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('internal audit and account rotation paths share the userData logs directory', (t) => {
  const directory = createTempDirectory(t, 'mhu-internal-log-paths-');
  const userDataPath = path.join(directory, 'user-data');
  const resolveInternalLogPath = createInternalLogPathResolver({ fs, path, userDataPath });

  assert.equal(resolveInternalLogPath('upload-audit.log'), path.join(userDataPath, 'logs', 'upload-audit.log'));
  assert.equal(resolveInternalLogPath('account-rotation.log'), path.join(userDataPath, 'logs', 'account-rotation.log'));
});

test('internal log paths fall back to another directory below userData without touching Desktop files', (t) => {
  const directory = createTempDirectory(t, 'mhu-internal-log-fallback-');
  const userDataPath = path.join(directory, 'user-data');
  const desktopPath = path.join(directory, 'Desktop');
  const desktopAuditPath = path.join(desktopPath, 'upload-audit.log');
  const desktopRotationPath = path.join(desktopPath, 'account-rotation.log');
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.mkdirSync(desktopPath, { recursive: true });
  fs.writeFileSync(path.join(userDataPath, 'logs'), 'blocked');
  fs.writeFileSync(desktopAuditPath, 'existing audit');
  fs.writeFileSync(desktopRotationPath, 'existing rotation');

  const resolveInternalLogPath = createInternalLogPathResolver({ fs, path, userDataPath });

  assert.equal(resolveInternalLogPath('upload-audit.log'), path.join(userDataPath, 'internal-logs', 'upload-audit.log'));
  assert.equal(resolveInternalLogPath('account-rotation.log'), path.join(userDataPath, 'internal-logs', 'account-rotation.log'));
  assert.equal(fs.readFileSync(desktopAuditPath, 'utf8'), 'existing audit');
  assert.equal(fs.readFileSync(desktopRotationPath, 'utf8'), 'existing rotation');
});

test('internal rotation writer retries inside userData and reports the file that accepted the write', async (t) => {
  const directory = createTempDirectory(t, 'mhu-internal-log-writer-');
  const userDataPath = path.join(directory, 'user-data');
  const primaryPath = path.join(userDataPath, 'logs', 'account-rotation.log');
  const fallbackPath = path.join(userDataPath, 'internal-logs', 'account-rotation.log');
  const appendTargets = [];
  const rotationTargets = [];
  const testFs = {
    mkdirSync: fs.mkdirSync,
    appendFileSync: fs.appendFileSync,
    promises: {
      appendFile: async (targetPath, ...args) => {
        appendTargets.push(targetPath);
        if (targetPath === primaryPath) throw Object.assign(new Error('blocked primary'), { code: 'EACCES' });
        return fs.promises.appendFile(targetPath, ...args);
      }
    }
  };
  const targets = [primaryPath, fallbackPath];
  const resolveInternalLogPath = (_fileName, excludedPaths = new Set()) => targets.find(targetPath => !excludedPaths.has(targetPath)) || null;
  const writer = createInternalLogWriter({
    fs: testFs,
    path,
    fileName: 'account-rotation.log',
    resolveInternalLogPath,
    rotateLogFile: targetPath => rotationTargets.push(targetPath),
    reportError: () => {},
    retryDelays: [0, 0]
  });

  assert.equal(await writer.append('[rotation]\n', 'rot-log'), true);
  assert.deepEqual(appendTargets, [primaryPath, fallbackPath]);
  assert.deepEqual(rotationTargets, [primaryPath, fallbackPath]);
  assert.equal(writer.getActivePath(), fallbackPath);
  assert.equal(fs.readFileSync(fallbackPath, 'utf8'), '[rotation]\n');
});

test('synchronous rotation flush falls back completely and retains buffered lines when every target fails', (t) => {
  const directory = createTempDirectory(t, 'mhu-internal-log-sync-writer-');
  const userDataPath = path.join(directory, 'user-data');
  const primaryPath = path.join(userDataPath, 'logs', 'account-rotation.log');
  const fallbackPath = path.join(userDataPath, 'internal-logs', 'account-rotation.log');
  fs.mkdirSync(primaryPath, { recursive: true });
  const resolveInternalLogPath = createInternalLogPathResolver({ fs, path, userDataPath });
  const writer = createInternalLogWriter({
    fs,
    path,
    fileName: 'account-rotation.log',
    resolveInternalLogPath,
    rotateLogFile: () => {},
    reportError: () => {}
  });
  const buffer = ['[rotation 1]\n', '[rotation 2]\n'];

  assert.equal(writer.flushSync(buffer, 'rot-log'), true);
  assert.deepEqual(buffer, []);
  assert.equal(writer.getActivePath(), fallbackPath);
  assert.equal(fs.readFileSync(fallbackPath, 'utf8'), '[rotation 1]\n[rotation 2]\n');

  const failedUserDataPath = path.join(directory, 'failed-user-data');
  const failedPrimaryPath = path.join(failedUserDataPath, 'logs', 'account-rotation.log');
  const failedFallbackPath = path.join(failedUserDataPath, 'internal-logs', 'account-rotation.log');
  fs.mkdirSync(failedPrimaryPath, { recursive: true });
  fs.mkdirSync(failedFallbackPath, { recursive: true });
  const failedWriter = createInternalLogWriter({
    fs,
    path,
    fileName: 'account-rotation.log',
    resolveInternalLogPath: createInternalLogPathResolver({ fs, path, userDataPath: failedUserDataPath }),
    rotateLogFile: () => {},
    reportError: () => {}
  });
  const retainedBuffer = ['[retained 1]\n', '[retained 2]\n'];

  assert.equal(failedWriter.flushSync(retainedBuffer, 'rot-log'), false);
  assert.deepEqual(retainedBuffer, ['[retained 1]\n', '[retained 2]\n']);
  assert.equal(failedWriter.getActivePath(), null);
});

test('quit flush delegates the rotation buffer to the synchronous internal writer', () => {
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

  assert.match(mainSource, /_rotLogFlusher\.flushSync\('rot-log'\);/);
  assert.doesNotMatch(mainSource, /appendFileSync\(getRotLogPath\(\), _rotLogBuffer\.join\(''\)/);
});

test('asynchronous rotation flush restores a failed chunk ahead of newer lines without a retry loop', async () => {
  const buffer = ['first\n', 'second\n'];
  const scheduled = [];
  let resolveAppend;
  const appendCalls = [];
  const syncCalls = [];
  const writer = {
    append(value) {
      appendCalls.push(value);
      return new Promise(resolve => { resolveAppend = resolve; });
    },
    flushSync(lines) {
      syncCalls.push([...lines]);
      lines.length = 0;
      return true;
    }
  };
  const flusher = createBufferedInternalLogFlusher({
    buffer,
    writer,
    schedule: callback => scheduled.push(callback)
  });

  const failed = flusher.flush('rot-log');
  assert.deepEqual(buffer, []);
  buffer.push('third\n');
  resolveAppend(false);
  assert.equal(await failed, false);
  assert.deepEqual(buffer, ['first\n', 'second\n', 'third\n']);
  assert.deepEqual(appendCalls, ['first\nsecond\n']);
  assert.deepEqual(scheduled, []);
  assert.equal(flusher.flushSync('rot-log'), true);
  assert.deepEqual(syncCalls, [['first\n', 'second\n', 'third\n']]);
  assert.deepEqual(buffer, []);
});

test('upload audit writer leaves the configured fileuploader log contract unchanged', async (t) => {
  const directory = createTempDirectory(t, 'mhu-upload-log-contract-');
  const userDataPath = path.join(directory, 'user-data');
  const customUploadDirectory = path.join(directory, 'custom-upload-logs');
  const uploadLogPath = path.join(customUploadDirectory, '13-08-2026-mdu-session-14-20-123456.log');
  fs.mkdirSync(customUploadDirectory, { recursive: true });
  fs.writeFileSync(uploadLogPath, 'existing upload entry\n');
  const resolveInternalLogPath = () => path.join(userDataPath, 'logs', 'upload-audit.log');
  const writer = createUploadAuditWriter({
    fs,
    path,
    resolveInternalLogPath,
    rotateLogFile: () => {},
    reportError: () => {},
    retryDelays: [0]
  });

  assert.equal(await writer.append('# UPLOAD-PLAN {"plannedUploadCount":4}\r\n', 'upload-plan'), true);
  assert.equal(writer.getActivePath(), path.join(userDataPath, 'logs', 'upload-audit.log'));
  assert.equal(fs.readFileSync(uploadLogPath, 'utf8'), 'existing upload entry\n');
  assert.equal(fs.readFileSync(writer.getActivePath(), 'utf8'), '# UPLOAD-PLAN {"plannedUploadCount":4}\r\n');
});

test('log opening uses the reported internal file directory before the general fallback directory', () => {
  assert.equal(
    getLogOpenDirectory('C:\\AppData\\Multi-Hoster\\logs\\upload-audit.log', 'C:\\Program Files\\Multi-Hoster', path.win32),
    'C:\\AppData\\Multi-Hoster\\logs'
  );
  assert.equal(getLogOpenDirectory(null, 'C:\\Program Files\\Multi-Hoster', path.win32), 'C:\\Program Files\\Multi-Hoster');
});
