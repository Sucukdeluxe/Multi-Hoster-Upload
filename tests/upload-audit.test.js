const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('internal audit records never contaminate the MDU session link log', async () => {
  let createUploadAuditWriter;
  try {
    ({ createUploadAuditWriter } = require('../lib/upload-audit'));
  } catch {}
  assert.equal(typeof createUploadAuditWriter, 'function');

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mhu-upload-audit-'));
  const sessionLog = path.join(directory, '13-08-2026-mdu-session-14-20-123456.log');
  const writer = createUploadAuditWriter({
    fs,
    path,
    resolveUploadLogTarget: () => ({ path: sessionLog, isFallback: false }),
    rotateLogFile: () => {},
    invalidateUploadLogTarget: () => {},
    reportError: () => {},
    retryDelays: [0]
  });

  await writer.append('# SOURCE-CLEANUP {"outcome":"deleted"}\r\n', 'source-cleanup');
  await writer.append('# UPLOAD-PLAN {"plannedUploadCount":4}\r\n', 'upload-plan');

  const auditLog = path.join(directory, 'upload-audit.log');
  assert.equal(fs.existsSync(sessionLog), false);
  assert.equal(fs.readFileSync(auditLog, 'utf8'), '# SOURCE-CLEANUP {"outcome":"deleted"}\r\n# UPLOAD-PLAN {"plannedUploadCount":4}\r\n');
  fs.rmSync(directory, { recursive: true, force: true });
});

test('audit writer reports the actual fallback file after a failed primary write', async () => {
  const { createUploadAuditWriter } = require('../lib/upload-audit');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mhu-upload-audit-fallback-'));
  const blockedParent = path.join(directory, 'blocked');
  const fallbackDirectory = path.join(directory, 'fallback');
  fs.writeFileSync(blockedParent, 'not a directory');
  let attempts = 0;
  const persistedFallbacks = [];
  const writer = createUploadAuditWriter({
    fs,
    path,
    resolveUploadLogTarget: () => ({
      path: attempts++ === 0
        ? path.join(blockedParent, 'fileuploader.log')
        : path.join(fallbackDirectory, 'fileuploader.log'),
      isFallback: attempts > 1
    }),
    rotateLogFile: () => {},
    invalidateUploadLogTarget: () => {},
    persistFallbackLogPath: async targetPath => { persistedFallbacks.push(targetPath); },
    reportError: () => {},
    retryDelays: [0, 0]
  });

  assert.equal(await writer.append('# UPLOAD-PLAN {}\r\n', 'upload-plan'), true);
  assert.equal(writer.getActivePath(), path.join(fallbackDirectory, 'upload-audit.log'));
  assert.deepEqual(persistedFallbacks, [path.join(fallbackDirectory, 'fileuploader.log')]);
  assert.equal(fs.readFileSync(writer.getActivePath(), 'utf8'), '# UPLOAD-PLAN {}\r\n');
  fs.rmSync(directory, { recursive: true, force: true });
});
