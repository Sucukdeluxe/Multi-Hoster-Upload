const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Module = require('node:module');
const originalLoad = Module._load;
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(`test-protected:${value}`),
  decryptString: value => value.toString().replace(/^test-protected:/, '')
};
Module._load = function load(request, parent, isMain) {
  if (request === 'electron') return { safeStorage };
  return originalLoad.call(this, request, parent, isMain);
};
const ConfigStore = require('../lib/config-store');
require('../lib/secret-store').encryptField('test-initialization');
Module._load = originalLoad;

let tmpDir;
let store;

function createStore() {
  const fakeApp = {
    isPackaged: false,
    getPath: () => tmpDir
  };
  // ConfigStore uses path.join(__dirname, '..') for non-packaged
  // We override by setting filePath directly
  store = new ConfigStore(fakeApp);
  store.filePath = path.join(tmpDir, 'electron-config.json');
  store.historyPath = path.join(tmpDir, 'electron-history.json');
  return store;
}

function createStoreAt(filePath) {
  const configuredStore = new ConfigStore({
    isPackaged: false,
    getPath: () => path.dirname(filePath)
  });
  configuredStore.filePath = filePath;
  configuredStore.historyPath = path.join(path.dirname(filePath), 'electron-history.json');
  return configuredStore;
}

describe('ConfigStore', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-test-'));
    store = createStore();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('explicit user-data-dir isolates development config writes from the project', async () => {
    const isolatedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-user-data-'));
    const projectConfigPath = path.join(__dirname, '..', 'electron-config.json');
    const projectConfigExisted = fs.existsSync(projectConfigPath);
    const projectConfigBefore = projectConfigExisted ? fs.readFileSync(projectConfigPath) : null;
    const explicitStore = new ConfigStore({
      isPackaged: false,
      commandLine: {
        hasSwitch: (name) => name === 'user-data-dir'
      },
      getPath: (name) => {
        if (name === 'userData') return isolatedDir;
        if (name === 'exe') return path.join(isolatedDir, 'Multi-Hoster-Upload.exe');
        throw new Error(`Unexpected app path: ${name}`);
      }
    });

    try {
      assert.equal(explicitStore.filePath, path.join(isolatedDir, 'electron-config.json'));
      await explicitStore.save({ globalSettings: { alwaysOnTop: true } });
      assert.equal(fs.existsSync(path.join(isolatedDir, 'electron-config.json')), true);
      assert.equal(fs.existsSync(projectConfigPath), projectConfigExisted);
      if (projectConfigBefore) {
        assert.equal(fs.readFileSync(projectConfigPath).equals(projectConfigBefore), true);
      }
    } finally {
      fs.rmSync(isolatedDir, { recursive: true, force: true });
    }
  });

  it('load returns defaults when file does not exist', () => {
    const config = store.load();
    assert.ok(config.hosters);
    assert.ok(config.hosters['doodstream.com']);
    assert.ok(config.hosters['voe.sx']);
    assert.ok(config.hosters['vidmoly.me']);
    assert.ok(config.hosters['byse.sx']);
    assert.ok(config.hosterSettings);
    assert.equal(config.hosterSettings['doodstream.com'].retries, 3);
    assert.equal(config.hosterSettings['doodstream.com'].parallelCount, 2);
    assert.equal(config.globalSettings.alwaysOnTop, false);
    assert.equal(config.globalSettings.language, 'en');
    assert.equal(config.globalSettings.shutdownAfterFinish, 'nothing');
    assert.equal(config.globalSettings.logFilePath, '');
    assert.equal(config.globalSettings.resumeQueueOnLaunch, true);
    assert.equal(Object.hasOwn(config.globalSettings, 'allowPlaintextCredentialStorage'), false);
    assert.equal(config.globalSettings.parallelUploadCount, 0);
    assert.equal(config.globalSettings.scaleParallelUploads, false);
    assert.equal(config.globalSettings.lastBrowseDirectory, '');
    assert.equal(config.globalSettings.pendingQueue, null);
    assert.deepEqual(config.history, []);
  });

  it('automation defaults persist a 15000 job limit and five minute interval', () => {
    const settings = store.load().globalSettings.folderMonitor;

    assert.equal(settings.queueLimitJobs, 15000);
    assert.equal(settings.reconcileIntervalMinutes, 5);
    assert.equal(settings.paused, false);
    assert.equal(settings.pausedAt, null);
  });

  it('automation pause survives a save and reload', async () => {
    await store.save({ globalSettings: { folderMonitor: { paused: true, pausedAt: 1787712000000 } } });

    const reloaded = createStoreAt(store.filePath).load();

    assert.equal(reloaded.globalSettings.folderMonitor.paused, true);
    assert.equal(reloaded.globalSettings.folderMonitor.pausedAt, 1787712000000);
  });

  it('drops the retired plaintext credential setting from legacy configurations', () => {
    fs.writeFileSync(store.filePath, JSON.stringify({
      hosters: {},
      hosterSettings: {},
      globalSettings: { allowPlaintextCredentialStorage: true }
    }), 'utf-8');

    const config = store.load();

    assert.equal(Object.hasOwn(config.globalSettings, 'allowPlaintextCredentialStorage'), false);
  });

  it('never writes the retired plaintext credential setting back to disk', async () => {
    await store.save({
      globalSettings: { allowPlaintextCredentialStorage: true }
    });

    const saved = JSON.parse(fs.readFileSync(store.filePath, 'utf-8'));

    assert.equal(Object.hasOwn(saved.globalSettings, 'allowPlaintextCredentialStorage'), false);
  });

  it('keeps permanent source deletion disabled by default', () => {
    const config = store.load();
    assert.equal(config.globalSettings.deleteSourceAfterSuccessfulUpload, false);
  });

  it('save then load round-trips', async () => {
    await store.save({ hosters: { 'doodstream.com': [{ id: 'test-1', enabled: true, authType: 'api', apiKey: 'test-key-123' }] } });
    const config = store.load();
    assert.equal(config.hosters['doodstream.com'][0].apiKey, 'test-key-123');
  });

  it('default logMode is "single"', () => {
    const config = store.load();
    assert.equal(config.globalSettings.logMode, 'single');
  });

  it('persists pendingQueue incl. savedAt (number) and ts-bearing jobs across save/load', async () => {
    // The queue-persistence fix stamps pendingQueue.savedAt and restores it on launch.
    // This proves the persistence layer round-trips the new fields untouched (the
    // ts-gate is worthless if savedAt does not survive serialization).
    const pendingQueue = {
      savedAt: 1750000000123,
      selectedUploadHosters: ['voe.sx', 'byse.sx'],
      selectedFiles: [{ path: 'C:/dl/a.mkv', name: 'a.mkv', size: 4242 }],
      queueJobs: [
        { id: 'j1', file: 'C:/dl/a.mkv', fileName: 'a.mkv', hoster: 'voe.sx', status: 'preview', bytesTotal: 4242, maxAttempts: 0 },
        { id: 'j2', file: 'C:/dl/a.mkv', fileName: 'a.mkv', hoster: 'byse.sx', status: 'error', error: 'boom', maxAttempts: 3 }
      ]
    };
    const current = store.load();
    await store.save({ globalSettings: { ...current.globalSettings, pendingQueue } });
    const loaded = store.load();
    const pq = loaded.globalSettings.pendingQueue;
    assert.equal(pq.savedAt, 1750000000123, 'savedAt epoch survives JSON round-trip');
    assert.equal(typeof pq.savedAt, 'number');
    assert.equal(pq.queueJobs.length, 2);
    assert.equal(pq.queueJobs[0].fileName, 'a.mkv');
    assert.equal(pq.queueJobs[0].hoster, 'voe.sx');
    assert.equal(pq.queueJobs[1].status, 'error');
    assert.deepEqual(pq.selectedUploadHosters, ['voe.sx', 'byse.sx']);
    assert.equal(pq.selectedFiles[0].path, 'C:/dl/a.mkv');
  });

  it('pendingQueue can be cleared back to null (clearPersistedQueueStateSoon path)', async () => {
    const current = store.load();
    await store.save({ globalSettings: { ...current.globalSettings, pendingQueue: { savedAt: 1, queueJobs: [] } } });
    assert.ok(store.load().globalSettings.pendingQueue);
    const c2 = store.load();
    await store.save({ globalSettings: { ...c2.globalSettings, pendingQueue: null } });
    assert.equal(store.load().globalSettings.pendingQueue, null);
  });

  it('regression: legacy sessionLog:true on disk normalizes to logMode "daily" (NOT "session")', async () => {
    // Write a config with the legacy boolean only (what an existing user has).
    await store.save({ globalSettings: { sessionLog: true } });
    const config = store.load();
    // The misnamed legacy field MUST map to daily — mapping to "session" would
    // silently change every per-day user's behaviour on upgrade.
    assert.equal(config.globalSettings.logMode, 'daily');
  });

  it('logMode round-trips for all three values', async () => {
    for (const mode of ['single', 'daily', 'session']) {
      await store.save({ globalSettings: { logMode: mode } });
      const config = store.load();
      assert.equal(config.globalSettings.logMode, mode, `mode ${mode}`);
    }
  });

  it('load merges with defaults for missing hosters', () => {
    // Write partial config in old single-object format (triggers migration)
    fs.writeFileSync(store.filePath, JSON.stringify({
      hosters: { 'doodstream.com': { apiKey: 'abc' } }
    }), 'utf-8');

    const config = store.load();
    // Old format is migrated to array
    assert.ok(Array.isArray(config.hosters['doodstream.com']));
    assert.equal(config.hosters['doodstream.com'][0].apiKey, 'abc');
    // Other hosters should still have defaults (empty arrays)
    assert.ok(Array.isArray(config.hosters['voe.sx']));
    assert.equal(config.hosters['voe.sx'].length, 0);
  });

  it('hosterSettings merge fills gaps with defaults', () => {
    fs.writeFileSync(store.filePath, JSON.stringify({
      hosterSettings: { 'voe.sx': { retries: 5 } }
    }), 'utf-8');

    const config = store.load();
    assert.equal(config.hosterSettings['voe.sx'].retries, 5);
    assert.equal(config.hosterSettings['voe.sx'].parallelCount, 2); // default
    assert.equal(config.hosterSettings['voe.sx'].maxSpeedKbs, 0); // default
    assert.equal(config.hosterSettings['voe.sx'].logToFile, true); // default on
  });

  it('logToFile defaults to true for every hoster', () => {
    const config = store.load();
    for (const name of ['doodstream.com', 'voe.sx', 'vidmoly.me', 'byse.sx', 'clouddrop.cc']) {
      assert.equal(config.hosterSettings[name].logToFile, true, `${name} should default logToFile=true`);
    }
  });

  it('sizeMemoEnabled defaults to true for every hoster and persists when disabled', async () => {
    const fresh = store.load();
    for (const name of ['doodstream.com', 'voe.sx', 'vidmoly.me', 'byse.sx', 'clouddrop.cc']) {
      assert.equal(fresh.hosterSettings[name].sizeMemoEnabled, true, `${name} should default sizeMemoEnabled=true`);
    }
    await store.save({ hosterSettings: { 'byse.sx': { sizeMemoEnabled: false } } });
    const config = store.load();
    assert.equal(config.hosterSettings['byse.sx'].sizeMemoEnabled, false, 'explicit false preserved');
    assert.equal(config.hosterSettings['voe.sx'].sizeMemoEnabled, true, 'other hoster still defaults on');
  });

  it('logToFile=false persists and survives reload', async () => {
    await store.save({ hosterSettings: { 'voe.sx': { logToFile: false } } });
    const config = store.load();
    assert.equal(config.hosterSettings['voe.sx'].logToFile, false, 'explicit false preserved');
    assert.equal(config.hosterSettings['byse.sx'].logToFile, true, 'other hoster still defaults on');
  });

  it('save only updates provided sections', async () => {
    // Save hoster settings first
    await store.save({ hosterSettings: { 'doodstream.com': { retries: 10, maxSpeedKbs: 0, parallelCount: 2, restartBelowKbs: 0, timeIntervalSec: 0, maxSizeMb: 0 } } });
    // Save hosters credentials separately (array format)
    await store.save({ hosters: { 'doodstream.com': [{ id: 'test-1', enabled: true, authType: 'api', apiKey: 'key123' }] } });

    const config = store.load();
    assert.equal(config.hosters['doodstream.com'][0].apiKey, 'key123');
    assert.equal(config.hosterSettings['doodstream.com'].retries, 10); // preserved
  });

  it('appendHistory keeps complete history without truncation', async () => {
    for (let i = 0; i < 105; i++) {
      await store.appendHistory({ id: `batch-${i}`, timestamp: new Date().toISOString(), files: [] });
    }
    const history = store.loadHistory();
    assert.equal(history.length, 105);
    assert.equal(history[0].id, 'batch-0');
    assert.equal(history[104].id, 'batch-104');
  });

  it('clearHistory empties the array', async () => {
    await store.appendHistory({ id: 'test', files: [] });
    assert.equal(store.loadHistory().length, 1);
    await store.clearHistory();
    assert.equal(store.loadHistory().length, 0);
  });

  it('rotationCursors default to an empty object', () => {
    const config = store.load();
    assert.deepEqual(config.rotationCursors, {});
  });

  it('saveRotationCursors round-trips and survives reload', async () => {
    await store.saveRotationCursors({ 'byse.sx': 7, 'voe.sx': 2 });
    const config = store.load();
    assert.equal(config.rotationCursors['byse.sx'], 7);
    assert.equal(config.rotationCursors['voe.sx'], 2);
  });

  it('an unrelated save() does not clobber persisted rotationCursors', async () => {
    await store.saveRotationCursors({ 'byse.sx': 3 });
    await store.save({ globalSettings: { alwaysOnTop: true } });
    const config = store.load();
    assert.equal(config.rotationCursors['byse.sx'], 3, 'cursor preserved across a settings save');
    assert.equal(config.globalSettings.alwaysOnTop, true);
  });

  it('saveRotationCursors does not disturb credentials', async () => {
    await store.save({ hosters: { 'byse.sx': [{ id: 'k1', enabled: true, authType: 'api', apiKey: 'secret-key' }] } });
    await store.saveRotationCursors({ 'byse.sx': 1 });
    const config = store.load();
    assert.equal(config.hosters['byse.sx'][0].apiKey, 'secret-key');
    assert.equal(config.rotationCursors['byse.sx'], 1);
  });

  it('corrupted JSON falls back to defaults', () => {
    fs.writeFileSync(store.filePath, '{invalid json!!!', 'utf-8');
    const config = store.load();
    assert.ok(config.hosters);
    assert.ok(config.hosterSettings);
    assert.deepEqual(config.history, []);
  });

  it('globalSettings merge preserves partial values', () => {
    fs.writeFileSync(store.filePath, JSON.stringify({
      globalSettings: { alwaysOnTop: true }
    }), 'utf-8');

    const config = store.load();
    assert.equal(config.globalSettings.alwaysOnTop, true);
    assert.equal(config.globalSettings.shutdownAfterFinish, 'nothing'); // default
    assert.equal(config.globalSettings.resumeQueueOnLaunch, true);
    assert.equal(config.globalSettings.parallelUploadCount, 0);
    assert.equal(config.globalSettings.scaleParallelUploads, false);
    assert.equal(config.globalSettings.logFilePath, '');
  });

  it('concurrent saves preserve both sections', async () => {
    const save1 = store.save({ hosters: { 'doodstream.com': [{ id: 'c1', enabled: true, authType: 'api', apiKey: 'concurrent-key' }] } });
    const save2 = store.save({ globalSettings: { alwaysOnTop: true } });
    await Promise.all([save1, save2]);
    const config = store.load();
    assert.equal(config.hosters['doodstream.com'][0].apiKey, 'concurrent-key');
    assert.equal(config.globalSettings.alwaysOnTop, true);
  });

  it('savePendingQueue does not block the event loop on slow synchronous filesystem methods', async () => {
    await store.save({
      hosters: { 'byse.sx': [{ id: 'non-blocking-account', enabled: true, authType: 'api', apiKey: 'test-key' }] },
      globalSettings: { alwaysOnTop: true }
    });
    store.load();

    const syncMethods = ['openSync', 'writeSync', 'fsyncSync', 'readFileSync', 'writeFileSync', 'renameSync'];
    const originals = new Map(syncMethods.map(name => [name, fs[name]]));
    const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
    const stallMs = 35;
    let eventLoopDelayMs;

    for (const name of syncMethods) {
      fs[name] = (...args) => {
        Atomics.wait(waitBuffer, 0, 0, stallMs);
        return originals.get(name)(...args);
      };
    }

    try {
      const startedAt = performance.now();
      const eventLoopTick = new Promise(resolve => {
        setTimeout(() => {
          eventLoopDelayMs = performance.now() - startedAt;
          resolve();
        }, 0);
      });
      const save = store.savePendingQueue({ savedAt: 5, queueJobs: [{ id: 'non-blocking' }] });

      await eventLoopTick;
      await save;
    } finally {
      for (const [name, original] of originals) fs[name] = original;
    }

    assert.ok(
      eventLoopDelayMs < stallMs * 3,
      `queue save blocked the event loop for ${eventLoopDelayMs.toFixed(1)} ms`
    );
  });

  it('folder monitor runtime saves preserve a concurrently queued pending queue snapshot', async () => {
    const pendingQueue = {
      savedAt: 1787712000000,
      queueJobs: [{ id: 'paused-job', automationPaused: true }]
    };

    const queueSave = store.savePendingQueue(pendingQueue);
    const runtimeSave = store.saveFolderMonitorRuntimeState({ paused: false, pausedAt: null });
    await Promise.all([queueSave, runtimeSave]);

    const current = store.load().globalSettings;
    assert.deepEqual(current.pendingQueue, pendingQueue);
    assert.equal(current.folderMonitor.paused, false);
    assert.equal(current.folderMonitor.pausedAt, null);
  });

  it('folder monitor runtime saves cannot revert concurrently queued monitor settings', async () => {
    const stale = store.load().globalSettings.folderMonitor;
    const currentSettings = {
      ...stale,
      folderPath: 'D:\\new-watch',
      hosters: ['byse.sx'],
      filterMode: 'exclude',
      autoStart: false
    };

    const settingsSave = store.save({
      globalSettings: {
        ...store.load().globalSettings,
        folderMonitor: currentSettings
      }
    });
    const runtimeSave = store.saveFolderMonitorRuntimeState({
      ...stale,
      paused: true,
      pausedAt: 1787712000000
    });
    await Promise.all([settingsSave, runtimeSave]);

    const folderMonitor = store.load().globalSettings.folderMonitor;
    assert.equal(folderMonitor.folderPath, 'D:\\new-watch');
    assert.deepEqual(folderMonitor.hosters, ['byse.sx']);
    assert.equal(folderMonitor.filterMode, 'exclude');
    assert.equal(folderMonitor.autoStart, false);
    assert.equal(folderMonitor.paused, true);
    assert.equal(folderMonitor.pausedAt, 1787712000000);
  });

  it('drainWrites waits for config and history writes appended while draining', async () => {
    assert.equal(typeof store.drainWrites, 'function');
    await store.save({ globalSettings: { alwaysOnTop: false } });
    store._historyMigrated = true;
    fs.writeFileSync(store.historyPath, '[]', 'utf-8');

    const originalAtomicWrite = store._atomicWrite.bind(store);
    const originalHistoryWrite = store._writeHistoryFileAtomic.bind(store);
    const configReleases = [];
    const historyReleases = [];
    const block = (releases, operation) => new Promise((resolve, reject) => {
      releases.push(() => Promise.resolve().then(operation).then(resolve, reject));
    });
    store._atomicWrite = (data) => block(configReleases, () => originalAtomicWrite(data));
    store._writeHistoryFileAtomic = (history) => block(historyReleases, () => originalHistoryWrite(history));

    const configWrites = store.save({ globalSettings: { alwaysOnTop: true } })
      .then(() => store.save({ hosterSettings: { 'byse.sx': { retries: 8 } } }));
    const historyWrites = store.appendHistory({ id: 'first', files: [] })
      .then(() => store.appendHistory({ id: 'second', files: [] }));

    while (configReleases.length < 1 || historyReleases.length < 1) await new Promise(resolve => setImmediate(resolve));
    let drained = false;
    const draining = store.drainWrites().then(() => { drained = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(drained, false);

    configReleases.shift()();
    historyReleases.shift()();
    while (configReleases.length < 1 || historyReleases.length < 1) await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(drained, false);

    configReleases.shift()();
    historyReleases.shift()();
    await Promise.all([configWrites, historyWrites, draining]);
    assert.equal(store.load().globalSettings.alwaysOnTop, true);
    assert.equal(store.load().hosterSettings['byse.sx'].retries, 8);
    assert.deepEqual(store.loadHistory().map(entry => entry.id), ['first', 'second']);
  });

  it('drainWrites ignores caller-handled failures but propagates a write failing during the drain', async () => {
    const originalAtomicWrite = store._atomicWrite.bind(store);
    store._atomicWrite = () => Promise.reject(new Error('config write failed'));
    await assert.rejects(store.save({ globalSettings: { alwaysOnTop: true } }), /config write failed/);
    await store.drainWrites();

    store._atomicWrite = originalAtomicWrite;
    store._historyMigrated = true;
    fs.writeFileSync(store.historyPath, '[]', 'utf-8');
    let rejectHistoryWrite;
    store._writeHistoryFileAtomic = () => new Promise((_resolve, reject) => { rejectHistoryWrite = reject; });
    const pendingWrite = store.appendHistory({ id: 'failed', files: [] });
    pendingWrite.catch(() => {});
    while (!rejectHistoryWrite) await new Promise(resolve => setImmediate(resolve));
    const draining = store.drainWrites();
    rejectHistoryWrite(new Error('history write failed'));
    await assert.rejects(draining, /history write failed/);
    await assert.rejects(pendingWrite, /history write failed/);
    await store.drainWrites();
  });

  it('surfaces a failed queued write and keeps later writes usable', async () => {
    const originalAtomicWrite = store._atomicWrite.bind(store);
    let failNextWrite = true;
    store._atomicWrite = (data) => {
      if (failNextWrite) {
        failNextWrite = false;
        return Promise.reject(new Error('write failed'));
      }
      return originalAtomicWrite(data);
    };

    await assert.rejects(store.appendHistory({ id: 'failed', files: [] }), /write failed/);
    await store.appendHistory({ id: 'saved', files: [] });
    assert.deepEqual(store.loadHistory().map(entry => entry.id), ['saved']);
  });

  it('serializes a complete settings replacement with pending saves', async () => {
    const originalAtomicWrite = store._atomicWrite.bind(store);
    let activeWrites = 0;
    let maximumActiveWrites = 0;
    store._atomicWrite = async (data) => {
      activeWrites += 1;
      maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
      await new Promise((resolve) => setTimeout(resolve, 15));
      try {
        await originalAtomicWrite(data);
      } finally {
        activeWrites -= 1;
      }
    };

    const save = store.save({ globalSettings: { alwaysOnTop: true, pendingQueue: { savedAt: 123, queueJobs: [{ id: 'local' }] } } });
    const replace = store.replaceSettings({
      hosters: { 'byse.sx': [{ id: 'imported', enabled: true, authType: 'api', apiKey: 'imported-key' }] },
      hosterSettings: { 'byse.sx': { retries: 9 } },
      globalSettings: { alwaysOnTop: false, pendingQueue: null },
      history: [],
      rotationCursors: {}
    });

    await Promise.all([save, replace]);
    const config = store.load();
    assert.equal(maximumActiveWrites, 1);
    assert.equal(config.hosters['byse.sx'][0].apiKey, 'imported-key');
    assert.equal(config.hosterSettings['byse.sx'].retries, 9);
    assert.equal(config.globalSettings.alwaysOnTop, false);
    assert.deepEqual(config.globalSettings.pendingQueue, { savedAt: 123, queueJobs: [{ id: 'local' }] });
    assert.deepEqual(config.rotationCursors, {});
  });

  it('patches the pending queue after an import without reverting imported settings', async () => {
    await store.save({
      globalSettings: {
        alwaysOnTop: true,
        webhookUrl: 'https://before.invalid',
        pendingQueue: { savedAt: 1, queueJobs: [{ id: 'before' }] }
      }
    });

    const replace = store.replaceSettings({
      hosters: { 'byse.sx': [{ id: 'imported', enabled: true, authType: 'api', apiKey: 'imported-key' }] },
      hosterSettings: { 'byse.sx': { retries: 9 } },
      globalSettings: {
        alwaysOnTop: false,
        webhookUrl: 'https://imported.invalid',
        pendingQueue: null
      },
      history: [],
      rotationCursors: {}
    });
    const pendingQueue = {
      savedAt: 2,
      queueJobs: [{ id: 'live', status: 'done' }]
    };
    const saveQueue = store.savePendingQueue(pendingQueue);

    await Promise.all([replace, saveQueue]);
    const config = store.load();
    assert.equal(config.hosters['byse.sx'][0].id, 'imported');
    assert.equal(config.globalSettings.alwaysOnTop, false);
    assert.equal(config.globalSettings.webhookUrl, 'https://imported.invalid');
    assert.deepEqual(config.globalSettings.pendingQueue, pendingQueue);
  });

  it('preserves main-owned global state when saving a renderer snapshot', async () => {
    await store.save({
      globalSettings: {
        alwaysOnTop: false,
        pendingQueue: { savedAt: 3, queueJobs: [{ id: 'local' }] },
        diagnostics: { enabled: true, port: 7777 },
        historyRetention: '7d',
        remote: { enabled: true, port: 9100, token: 'main-token', allowInput: true }
      }
    });

    await store.saveRendererGlobalSettings({
      alwaysOnTop: true,
      pendingQueue: null,
      diagnostics: { enabled: false, port: 1 },
      historyRetention: 'all',
      remote: { enabled: true, port: 9200, token: '', allowInput: false }
    });

    const config = store.load();
    assert.equal(config.globalSettings.alwaysOnTop, true);
    assert.deepEqual(config.globalSettings.pendingQueue, { savedAt: 3, queueJobs: [{ id: 'local' }] });
    assert.equal(config.globalSettings.diagnostics.enabled, true);
    assert.equal(config.globalSettings.diagnostics.port, 7777);
    assert.equal(config.globalSettings.historyRetention, '7d');
    assert.deepEqual(config.globalSettings.remote, { enabled: true, port: 9200, token: 'main-token', allowInput: false });
  });

  it('renderer settings saves cannot clear the authoritative automation pause', async () => {
    const current = store.load();
    await store.save({
      globalSettings: {
        ...current.globalSettings,
        folderMonitor: {
          ...current.globalSettings.folderMonitor,
          enabled: true,
          folderPath: 'C:\\watch',
          paused: true,
          pausedAt: 1787712000000
        }
      }
    });

    await store.saveRendererGlobalSettings({
      alwaysOnTop: true,
      folderMonitor: { paused: false, pausedAt: null }
    });

    const saved = store.load().globalSettings.folderMonitor;
    assert.equal(saved.paused, true);
    assert.equal(saved.pausedAt, 1787712000000);
    assert.equal(saved.enabled, true);
    assert.equal(saved.folderPath, 'C:\\watch');
  });

  it('persists the last browse directory across stale renderer settings saves', async () => {
    const selectedDirectory = path.join(tmpDir, 'selected');

    await store.saveLastBrowseDirectory(selectedDirectory);
    await store.saveRendererGlobalSettings({
      alwaysOnTop: true,
      lastBrowseDirectory: ''
    });

    assert.equal(store.load().globalSettings.lastBrowseDirectory, selectedDirectory);
  });

  it('merges remote settings in the write queue and returns the canonical token', async () => {
    await store.save({
      globalSettings: {
        remote: { enabled: false, port: 9100, token: 'canonical-token', allowInput: true }
      }
    });

    const rendererSave = store.saveRendererGlobalSettings({
      alwaysOnTop: true,
      remote: { enabled: false, port: 9200, token: '', allowInput: false }
    });
    const remoteSave = store.saveRemoteSettings(
      { enabled: true, port: 9300, token: '', allowInput: false },
      () => 'generated-token'
    );

    const [, canonical] = await Promise.all([rendererSave, remoteSave]);
    assert.deepEqual(canonical, { enabled: true, port: 9300, token: 'canonical-token', allowInput: false });
    assert.deepEqual(store.load().globalSettings.remote, canonical);
  });

  it('rejects ordinary writes while quiesced and permits only the final pending queue snapshot', async () => {
    store.setWritesQuiesced(true);

    await assert.rejects(store.save({ globalSettings: { alwaysOnTop: true } }), /beendet/);
    await assert.rejects(store.appendHistory({ id: 'late-history', files: [] }), /beendet/);
    await store.savePendingQueue({ savedAt: 4, queueJobs: [{ id: 'final' }] }, { allowDuringQuiesce: true });

    assert.equal(store.load().globalSettings.alwaysOnTop, false);
    assert.deepEqual(store.load().globalSettings.pendingQueue, { savedAt: 4, queueJobs: [{ id: 'final' }] });
    store.setWritesQuiesced(false);
    await store.save({ globalSettings: { ...store.load().globalSettings, alwaysOnTop: true } });
    assert.equal(store.load().globalSettings.alwaysOnTop, true);
  });

  it('load() returns independent clones — mutating one result must not leak into the cache', () => {
    store.load(); // warm the cache
    const a = store.load();
    a.globalSettings.alwaysOnTop = true;
    a.hosters['voe.sx'].push({ id: 'mutant' });
    a.history.push({ id: 'ghost' });
    const b = store.load();
    assert.equal(b.globalSettings.alwaysOnTop, false, 'mutating a prior load() result must not corrupt the cache');
    assert.equal(b.hosters['voe.sx'].length, 0);
    assert.equal(b.history.length, 0);
  });

  it('load() reflects an external file change (mtime/size cache invalidation)', () => {
    store.load(); // warm cache on the no-file defaults
    fs.writeFileSync(store.filePath, JSON.stringify({ globalSettings: { alwaysOnTop: true } }), 'utf-8');
    assert.equal(store.load().globalSettings.alwaysOnTop, true, 'an external write must invalidate the cache');
    fs.writeFileSync(store.filePath, JSON.stringify({ globalSettings: { alwaysOnTop: false } }), 'utf-8');
    assert.equal(store.load().globalSettings.alwaysOnTop, false, 'a second external write must be seen too');
  });

  it('save() invalidates the cache so the next load() sees the new value', async () => {
    assert.equal(store.load().globalSettings.alwaysOnTop, false);
    await store.save({ globalSettings: { alwaysOnTop: true } });
    assert.equal(store.load().globalSettings.alwaysOnTop, true, 'load() after save() must reflect the write');
  });

  it('backup recovery when main file is corrupted', () => {
    // Write valid config first
    fs.writeFileSync(store.filePath, JSON.stringify({
      hosters: { 'doodstream.com': [{ id: 'bak-1', authType: 'api', apiKey: 'from-backup' }] },
      hosterSettings: {}, globalSettings: {}, history: []
    }), 'utf-8');
    // Copy to backup
    fs.copyFileSync(store.filePath, store.filePath + '.bak');
    // Corrupt main file
    fs.writeFileSync(store.filePath, 'CORRUPTED!!!', 'utf-8');
    const config = store.load();
    assert.equal(config.hosters['doodstream.com'][0].apiKey, 'from-backup');
  });

  it('wipe-guard: a settings-only save recovers accounts from .bak when the live config validly has none', async () => {
    // Post-wipe state: live config parses fine but has empty hosters; a backup still holds the accounts.
    fs.writeFileSync(store.filePath, JSON.stringify({ hosters: {}, hosterSettings: {}, globalSettings: {}, history: [] }), 'utf-8');
    fs.writeFileSync(store.filePath + '.bak', JSON.stringify({
      hosters: { 'voe.sx': [{ id: 'v1', authType: 'api', apiKey: 'survive-key' }] },
      hosterSettings: {}, globalSettings: {}, history: []
    }), 'utf-8');
    await store.save({ globalSettings: { alwaysOnTop: true } });
    const cfg = store.load();
    assert.ok(cfg.hosters['voe.sx'] && cfg.hosters['voe.sx'].length === 1, 'guard must restore accounts from .bak, not persist the wipe');
    assert.equal(cfg.hosters['voe.sx'][0].apiKey, 'survive-key');
    assert.equal(cfg.globalSettings.alwaysOnTop, true);
  });

  it('wipe-guard: an explicit save({hosters:{}}) (user deleted all) is NOT blocked', async () => {
    await store.save({ hosters: { 'doodstream.com': [{ id: 'd1', authType: 'api', apiKey: 'k' }] } });
    await store.save({ hosters: {} });
    const cfg = store.load();
    assert.equal((cfg.hosters['doodstream.com'] || []).length, 0, 'an intentional hosters write must be allowed to empty them');
  });
});

describe('ConfigStore history split (electron-history.json)', () => {
  let dir;
  let s;

  function makeStore() {
    const st = new ConfigStore({ isPackaged: false, getPath: () => dir });
    st.filePath = path.join(dir, 'electron-config.json');
    st.historyPath = path.join(dir, 'electron-history.json');
    return st;
  }

  function writeConfigWithHistory(n) {
    const history = [];
    for (let i = 0; i < n; i++) history.push({ id: `batch-${i}`, timestamp: 1750000000000 + i, total: 3, files: [{ name: `f${i}.mkv` }] });
    fs.writeFileSync(path.join(dir, 'electron-config.json'), JSON.stringify({
      hosters: { 'byse.sx': [{ id: 'a1', authType: 'api', apiKey: 'k' }] },
      hosterSettings: {}, globalSettings: { historyRetention: 'all' }, history
    }), 'utf-8');
  }

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-hist-')); s = makeStore(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('migration moves history into electron-history.json, preserving every entry', () => {
    writeConfigWithHistory(50);
    s._migrateHistory();
    assert.equal(s._historyMigrated, true);
    assert.ok(fs.existsSync(s.historyPath));
    const hist = JSON.parse(fs.readFileSync(s.historyPath, 'utf-8'));
    assert.equal(hist.length, 50);
    assert.equal(hist[0].id, 'batch-0');
    assert.equal(hist[49].id, 'batch-49');
    assert.ok(fs.existsSync(s.filePath + '.pre-history-split.bak'), 'a permanent pre-split backup is kept');
  });

  it('after migration load() excludes history (cheap hot path) but loadHistory() returns the real data', () => {
    writeConfigWithHistory(30);
    s._migrateHistory();
    assert.deepEqual(s.load().history, [], 'history is not carried in the always-loaded config');
    assert.equal(s.loadHistory().length, 30);
  });

  it('appendHistory writes to history.json; the next config write strips stale history from the config file', async () => {
    writeConfigWithHistory(10);
    s._migrateHistory();
    await s.appendHistory({ id: 'new-batch', timestamp: 1750000099999, total: 1, files: [{ name: 'x.mkv' }] });
    assert.equal(s.loadHistory().length, 11, 'append goes to history.json');
    await s.save({ globalSettings: { alwaysOnTop: true } });
    const onDisk = JSON.parse(fs.readFileSync(s.filePath, 'utf-8'));
    assert.ok(!onDisk.history || onDisk.history.length === 0, 'a config write strips stale history from the config file');
    assert.equal(s.loadHistory().length, 11, 'history.json is unaffected by the config write');
  });

  it('save({globalSettings}) after migration NEVER loses history (data-loss invariant)', async () => {
    writeConfigWithHistory(40);
    s._migrateHistory();
    await s.save({ globalSettings: { alwaysOnTop: true } });
    assert.equal(s.loadHistory().length, 40, 'a settings write must not touch history');
    assert.equal(s.load().globalSettings.alwaysOnTop, true);
  });

  it('clearHistory empties history.json only', async () => {
    writeConfigWithHistory(20);
    s._migrateHistory();
    await s.clearHistory();
    assert.equal(s.loadHistory().length, 0);
  });

  it('migration is idempotent — re-running with history.json present does not re-derive or clobber', () => {
    writeConfigWithHistory(15);
    s._migrateHistory();
    const after = makeStore();
    after._migrateHistory();
    assert.equal(after._historyMigrated, true);
    assert.equal(after.loadHistory().length, 15);
  });

  it('crash-window fallback: not migrated + no history.json → loadHistory reads config.history', () => {
    writeConfigWithHistory(7);
    assert.equal(s._historyMigrated, false);
    assert.equal(s.loadHistory().length, 7, 'legacy path still serves history if migration never ran');
  });

  it('migrated prune refuses to overwrite a corrupted history file', async () => {
    writeConfigWithHistory(12);
    s._migrateHistory();
    fs.writeFileSync(s.historyPath, '{broken-history', 'utf-8');
    const historyBefore = fs.readFileSync(s.historyPath, 'utf-8');

    await assert.rejects(s.pruneHistory('7d', { dryRun: false }), /Verlaufsdatei ist beschädigt/);

    assert.equal(fs.readFileSync(s.historyPath, 'utf-8'), historyBefore);
    assert.equal(JSON.parse(fs.readFileSync(s.filePath, 'utf-8')).globalSettings.historyRetention, 'all');
  });

  it('appendHistory rejects when the migrated history file is corrupted', async () => {
    writeConfigWithHistory(12);
    s._migrateHistory();
    fs.writeFileSync(s.historyPath, '{broken-history', 'utf-8');

    await assert.rejects(s.appendHistory({ id: 'unsafe-delete-barrier', files: [] }), /Verlaufsdatei ist beschädigt/);
  });

  it('pruneHistory trims history.json and persists the retention setting', async () => {
    writeConfigWithHistory(12);
    s._migrateHistory();
    const res = await s.pruneHistory('all', { dryRun: false });
    assert.equal(s.loadHistory().length, 12);
    assert.ok(res.keptBatches === 12);
  });

  it('migrated prune leaves history unchanged when the retention commit fails', async () => {
    writeConfigWithHistory(12);
    s._migrateHistory();
    const historyBefore = fs.readFileSync(s.historyPath, 'utf-8');
    s._atomicWrite = () => Promise.reject(new Error('retention commit failed'));

    await assert.rejects(s.pruneHistory('7d', { dryRun: false }), /retention commit failed/);

    assert.equal(fs.readFileSync(s.historyPath, 'utf-8'), historyBefore);
    assert.equal(JSON.parse(fs.readFileSync(s.filePath, 'utf-8')).globalSettings.historyRetention, 'all');
  });

  it('migrated prune restores the previous retention when the history write fails', async () => {
    writeConfigWithHistory(12);
    s._migrateHistory();
    const historyBefore = fs.readFileSync(s.historyPath, 'utf-8');
    const originalAtomicWrite = s._atomicWrite.bind(s);
    const retentionWrites = [];
    s._atomicWrite = (data) => {
      retentionWrites.push(JSON.parse(data).globalSettings.historyRetention);
      return originalAtomicWrite(data);
    };
    s._writeHistoryFileAtomic = () => Promise.reject(new Error('history prune failed'));

    await assert.rejects(s.pruneHistory('7d', { dryRun: false }), /history prune failed/);

    assert.deepEqual(retentionWrites, ['7d', 'all']);
    assert.equal(JSON.parse(fs.readFileSync(s.filePath, 'utf-8')).globalSettings.historyRetention, 'all');
    assert.equal(fs.readFileSync(s.historyPath, 'utf-8'), historyBefore);
  });

  it('migrated prune serializes surrounding global settings saves across an internal rollback', async () => {
    writeConfigWithHistory(12);
    s._migrateHistory();
    const historyBefore = fs.readFileSync(s.historyPath, 'utf-8');
    const originalAtomicWrite = s._atomicWrite.bind(s);
    const configWrites = [];
    let priorWriteStarted = false;
    let releasePriorWrite;
    s._atomicWrite = (data) => {
      const settings = JSON.parse(data).globalSettings;
      configWrites.push({ webhookUrl: settings.webhookUrl || '', alwaysOnTop: !!settings.alwaysOnTop, historyRetention: settings.historyRetention });
      if (!priorWriteStarted && settings.webhookUrl === 'https://prune-race.invalid/prior') {
        priorWriteStarted = true;
        return new Promise((resolve, reject) => {
          releasePriorWrite = () => originalAtomicWrite(data).then(resolve, reject);
        });
      }
      return originalAtomicWrite(data);
    };

    let rejectHistoryWrite;
    s._writeHistoryFileAtomic = () => new Promise((_resolve, reject) => { rejectHistoryWrite = reject; });
    const priorSettings = { ...s.load().globalSettings, alwaysOnTop: true, webhookUrl: 'https://prune-race.invalid/prior', historyRetention: 'all' };
    const priorSave = s.save({ globalSettings: priorSettings });
    while (!releasePriorWrite) await new Promise(resolve => setImmediate(resolve));

    let pruneError = null;
    const pruning = s.pruneHistory('7d', { dryRun: false }).catch(error => { pruneError = error; });
    releasePriorWrite();
    await priorSave;
    while (!rejectHistoryWrite) await new Promise(resolve => setImmediate(resolve));

    const laterSettings = { ...priorSettings, alwaysOnTop: false, webhookUrl: 'https://prune-race.invalid/later', historyRetention: 'all' };
    const laterSave = s.save({ globalSettings: laterSettings });
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    const laterCommittedBeforeRollback = configWrites.some(write => write.webhookUrl === 'https://prune-race.invalid/later');
    rejectHistoryWrite(new Error('history prune race failed'));
    await pruning;
    await laterSave;

    assert.match(pruneError?.message || '', /history prune race failed/);
    assert.equal(laterCommittedBeforeRollback, false);
    assert.deepEqual(configWrites.map(write => `${write.webhookUrl}:${write.historyRetention}`), [
      'https://prune-race.invalid/prior:all',
      'https://prune-race.invalid/prior:7d',
      'https://prune-race.invalid/prior:all',
      'https://prune-race.invalid/later:all'
    ]);
    const finalSettings = JSON.parse(fs.readFileSync(s.filePath, 'utf-8')).globalSettings;
    assert.equal(finalSettings.webhookUrl, 'https://prune-race.invalid/later');
    assert.equal(finalSettings.alwaysOnTop, false);
    assert.equal(finalSettings.historyRetention, 'all');
    assert.equal(fs.readFileSync(s.historyPath, 'utf-8'), historyBefore);
  });

  it('renderer snapshots cannot revert retention after a successful prune', async () => {
    writeConfigWithHistory(12);
    s._migrateHistory();
    const originalHistoryWrite = s._writeHistoryFileAtomic.bind(s);
    let releaseHistoryWrite;
    s._writeHistoryFileAtomic = (history) => new Promise((resolve, reject) => {
      releaseHistoryWrite = () => originalHistoryWrite(history).then(resolve, reject);
    });

    const pruning = s.pruneHistory('7d', { dryRun: false });
    while (!releaseHistoryWrite) await new Promise(resolve => setImmediate(resolve));
    const staleRendererSave = s.saveRendererGlobalSettings({
      ...s.load().globalSettings,
      alwaysOnTop: true,
      historyRetention: 'all'
    });
    releaseHistoryWrite();
    await Promise.all([pruning, staleRendererSave]);

    assert.equal(s.load().globalSettings.historyRetention, '7d');
    assert.equal(s.load().globalSettings.alwaysOnTop, true);
  });
});
