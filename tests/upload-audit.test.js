const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('internal audit records never contaminate the MDU session link log', async () => {
  let createUploadAuditWriter;
  let createUploadAuditEvents;
  try {
    ({ createUploadAuditWriter, createUploadAuditEvents } = require('../lib/upload-audit'));
  } catch {}
  assert.equal(typeof createUploadAuditWriter, 'function');
  assert.equal(typeof createUploadAuditEvents, 'function');

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mhu-upload-audit-'));
  const sessionLog = path.join(directory, '13-08-2026-mdu-session-14-20-123456.log');
  const debugLog = path.join(directory, 'upload-debug.log');
  fs.writeFileSync(debugLog, 'debug-before\r\n');
  const writer = createUploadAuditWriter({
    fs,
    path,
    resolveUploadLogTarget: () => ({ path: sessionLog, isFallback: false }),
    rotateLogFile: () => {},
    invalidateUploadLogTarget: () => {},
    reportError: () => {},
    retryDelays: [0]
  });
  const events = createUploadAuditEvents(writer, () => new Date('2026-08-13T12:00:00.000Z'));

  await events.appendSourceCleanup({ outcome: 'deleted' });
  await events.appendUploadPlan({ fileCount: 2, destinationCount: 2, plannedUploadCount: 4 }, 'start');

  const auditLog = path.join(directory, 'upload-audit.log');
  assert.equal(fs.existsSync(sessionLog), false);
  assert.equal(fs.readFileSync(debugLog, 'utf8'), 'debug-before\r\n');
  assert.equal(fs.readFileSync(auditLog, 'utf8'), '# SOURCE-CLEANUP {"outcome":"deleted"}\r\n# UPLOAD-PLAN {"timestamp":"2026-08-13T12:00:00.000Z","mode":"start","fileCount":2,"destinationCount":2,"plannedUploadCount":4}\r\n');
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
    persistFallbackLogPath: async targetPath => { persistedFallbacks.push(targetPath); return true; },
    reportError: () => {},
    retryDelays: [0, 0]
  });

  assert.equal(await writer.append('# UPLOAD-PLAN {}\r\n', 'upload-plan'), true);
  assert.equal(writer.getActivePath(), path.join(fallbackDirectory, 'upload-audit.log'));
  assert.deepEqual(persistedFallbacks, [path.join(fallbackDirectory, 'fileuploader.log')]);
  assert.equal(fs.readFileSync(writer.getActivePath(), 'utf8'), '# UPLOAD-PLAN {}\r\n');
  fs.rmSync(directory, { recursive: true, force: true });
});

test('audit writer retries a safe target after sync or close durability failures', async (t) => {
  const { createUploadAuditWriter } = require('../lib/upload-audit');
  for (const failedStage of ['sync', 'close']) {
    await t.test(failedStage, async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), `mhu-upload-audit-${failedStage}-`));
      const primaryLog = path.join(directory, 'primary', 'fileuploader.log');
      const fallbackLog = path.join(directory, 'fallback', 'fileuploader.log');
      const primaryAudit = path.join(directory, 'primary', 'upload-audit.log');
      const fallbackAudit = path.join(directory, 'fallback', 'upload-audit.log');
      const syncCalls = [];
      const closeCalls = [];
      const reports = [];
      const durabilityFs = {
        ...fs,
        promises: {
          ...fs.promises,
          open: async (targetPath, flags) => {
            const handle = await fs.promises.open(targetPath, flags);
            return {
              appendFile: handle.appendFile.bind(handle),
              sync: async () => {
                syncCalls.push(targetPath);
                if (targetPath === primaryAudit && failedStage === 'sync') throw new Error('controlled sync failure');
                return handle.sync();
              },
              close: async () => {
                closeCalls.push(targetPath);
                await handle.close();
                if (targetPath === primaryAudit && failedStage === 'close') throw new Error('controlled close failure');
              }
            };
          }
        }
      };
      const writer = createUploadAuditWriter({
        fs: durabilityFs,
        path,
        resolveUploadLogTarget: excluded => {
          if (!excluded.has(primaryLog)) return { path: primaryLog, isFallback: false };
          if (!excluded.has(fallbackLog)) return { path: fallbackLog, isFallback: true };
          return null;
        },
        rotateLogFile: () => {},
        invalidateUploadLogTarget: () => {},
        persistFallbackLogPath: async () => true,
        reportError: (label, error) => reports.push({ label, message: error.message }),
        retryDelays: [0, 0]
      });

      assert.equal(await writer.append('# UPLOAD-PLAN {}\r\n', 'upload-plan'), true);
      assert.equal(writer.getActivePath(), fallbackAudit);
      assert.deepEqual(syncCalls, [primaryAudit, fallbackAudit]);
      assert.deepEqual(closeCalls, [primaryAudit, fallbackAudit]);
      assert.equal(fs.readFileSync(fallbackAudit, 'utf8'), '# UPLOAD-PLAN {}\r\n');
      assert.equal(reports.some(report => report.label === 'upload-plan' && report.message.includes(failedStage)), true);
      fs.rmSync(directory, { recursive: true, force: true });
    });
  }
});

test('audit writer fails closed when no target can sync the appended bytes', async () => {
  const { createUploadAuditWriter } = require('../lib/upload-audit');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mhu-upload-audit-sync-exhausted-'));
  const targets = ['first', 'second'].map(name => path.join(directory, name, 'fileuploader.log'));
  const durabilityFs = {
    ...fs,
    promises: {
      ...fs.promises,
      open: async (targetPath, flags) => {
        const handle = await fs.promises.open(targetPath, flags);
        return {
          appendFile: handle.appendFile.bind(handle),
          sync: async () => { throw new Error(`controlled sync failure: ${targetPath}`); },
          close: handle.close.bind(handle)
        };
      }
    }
  };
  const writer = createUploadAuditWriter({
    fs: durabilityFs,
    path,
    resolveUploadLogTarget: excluded => {
      const targetPath = targets.find(candidate => !excluded.has(candidate));
      return targetPath ? { path: targetPath, isFallback: true } : null;
    },
    rotateLogFile: () => {},
    invalidateUploadLogTarget: () => {},
    persistFallbackLogPath: async () => true,
    reportError: () => {},
    retryDelays: [0, 0]
  });

  assert.equal(await writer.append('# UPLOAD-PLAN {}\r\n', 'upload-plan'), false);
  assert.equal(writer.getActivePath(), null);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('audit writer rejects false and thrown fallback persistence before trying the next safe target', async (t) => {
  const { createUploadAuditWriter } = require('../lib/upload-audit');
  for (const rejection of ['false', 'throw']) {
    await t.test(rejection, async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), `mhu-upload-audit-${rejection}-`));
      const first = path.join(directory, 'first', 'fileuploader.log');
      const second = path.join(directory, 'second', 'fileuploader.log');
      const targets = [first, second].map(targetPath => ({ path: targetPath, isFallback: true }));
      const persistedFallbacks = [];
      const writer = createUploadAuditWriter({
        fs,
        path,
        resolveUploadLogTarget: excluded => {
          const excludedPaths = excluded instanceof Set ? excluded : new Set(excluded ? [excluded] : []);
          return targets.find(target => !excludedPaths.has(target.path)) || null;
        },
        rotateLogFile: () => {},
        invalidateUploadLogTarget: () => {},
        persistFallbackLogPath: async targetPath => {
          persistedFallbacks.push(targetPath);
          if (targetPath === first) {
            if (rejection === 'throw') throw new Error('settings write failed');
            return false;
          }
          return true;
        },
        reportError: () => {},
        retryDelays: [0, 0, 0]
      });

      assert.equal(await writer.append('# UPLOAD-PLAN {}\r\n', 'upload-plan'), true);
      assert.equal(writer.getActivePath(), path.join(directory, 'second', 'upload-audit.log'));
      assert.deepEqual(persistedFallbacks, [first, second]);
      assert.equal(fs.existsSync(path.join(directory, 'first', 'upload-audit.log')), false);
      assert.equal(fs.readFileSync(writer.getActivePath(), 'utf8'), '# UPLOAD-PLAN {}\r\n');
      fs.rmSync(directory, { recursive: true, force: true });
    });
  }
});

test('audit writer returns false only after every allowed fallback target is rejected', async () => {
  const { createUploadAuditWriter } = require('../lib/upload-audit');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mhu-upload-audit-exhausted-'));
  const targets = ['first', 'second'].map(name => ({ path: path.join(directory, name, 'fileuploader.log'), isFallback: true }));
  const persistedFallbacks = [];
  const writer = createUploadAuditWriter({
    fs,
    path,
    resolveUploadLogTarget: excluded => {
      const excludedPaths = excluded instanceof Set ? excluded : new Set(excluded ? [excluded] : []);
      return targets.find(target => !excludedPaths.has(target.path)) || null;
    },
    rotateLogFile: () => {},
    invalidateUploadLogTarget: () => {},
    persistFallbackLogPath: async targetPath => {
      persistedFallbacks.push(targetPath);
      if (persistedFallbacks.length === 2) throw new Error('settings write failed');
      return false;
    },
    reportError: () => {},
    retryDelays: [0, 0, 0]
  });

  assert.equal(await writer.append('# UPLOAD-PLAN {}\r\n', 'upload-plan'), false);
  assert.deepEqual(persistedFallbacks, targets.map(target => target.path));
  assert.equal(writer.getActivePath(), null);
  assert.equal(fs.existsSync(path.join(directory, 'first', 'upload-audit.log')), false);
  assert.equal(fs.existsSync(path.join(directory, 'second', 'upload-audit.log')), false);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('durable audit gate never creates a manager or adds jobs after a false or thrown audit', async () => {
  const { runAfterDurableAudit } = require('../lib/upload-audit');
  assert.equal(typeof runAfterDurableAudit, 'function');
  for (const actionName of ['manager', 'addJobs']) {
    for (const audit of [async () => false, async () => { throw new Error('audit failed'); }]) {
      let actions = 0;
      const result = await runAfterDurableAudit(audit, () => { actions += 1; return actionName; });
      assert.equal(result.ok, false);
      assert.equal(actions, 0);
    }
  }

  let actions = 0;
  const result = await runAfterDurableAudit(async () => true, () => { actions += 1; return 'started'; });
  assert.deepEqual(result, { ok: true, value: 'started' });
  assert.equal(actions, 1);
});

test('audit failure message is localized and tells the user how to retry', () => {
  const { getUploadAuditFailureMessage } = require('../lib/upload-audit');
  const german = getUploadAuditFailureMessage('de');
  const english = getUploadAuditFailureMessage('en');
  assert.match(german, /Log-Pfad/);
  assert.match(german, /erneut/);
  assert.match(english, /log path/i);
  assert.match(english, /try again/i);
  assert.notEqual(german, english);
});

test('main process audits batch plans before creating or mutating upload work', () => {
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const startHandler = mainSource.slice(
    mainSource.indexOf("ipcMain.handle('start-upload'"),
    mainSource.indexOf("ipcMain.handle('cancel-upload'")
  );
  const addHandler = mainSource.slice(
    mainSource.indexOf("ipcMain.handle('add-jobs-to-batch'"),
    mainSource.indexOf("ipcMain.handle('finish-after-active'")
  );

  assert.ok(startHandler.indexOf("appendUploadPlanAudit(batchPlan, 'start')") < startHandler.indexOf('new UploadManager('));
  assert.ok(startHandler.indexOf("appendUploadPlanAudit(batchPlan, 'start')") < startHandler.indexOf('persistRotation(pick)'));
  assert.ok(addHandler.indexOf("appendUploadPlanAudit(summarizeBatchPlan({ jobs }), 'add')") < addHandler.indexOf('persistRotation(pick)'));
  assert.ok(addHandler.indexOf("appendUploadPlanAudit(summarizeBatchPlan({ jobs }), 'add')") < addHandler.indexOf('registerGroups(sourceCleanupGroups)'));
  assert.ok(addHandler.indexOf("appendUploadPlanAudit(summarizeBatchPlan({ jobs }), 'add')") < addHandler.indexOf('batchManager.addJobs(tasks)'));
  assert.doesNotMatch(mainSource, /debugLog\(`source-cleanup:/);
  assert.doesNotMatch(mainSource, /debugLog\(`upload-plan:/);
});
