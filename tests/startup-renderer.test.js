const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const {
  configureStartupRenderer,
  createStartupFailureDocument,
  createStartupRecoveryCoordinator,
  createStartupRendererHandlers,
  createStartupWindow,
  resolveStartupLanguage
} = require('../lib/startup-renderer');

test('startup failure document is a localized visible application surface', () => {
  const english = createStartupFailureDocument('en');
  const german = createStartupFailureDocument('de');

  assert.match(english, /Multi Hoster Uploader/);
  assert.match(english, /could not load/);
  assert.match(english, /Close/);
  assert.match(german, /konnte nicht geladen werden/);
  assert.match(german, /Schließen/);
  assert.doesNotMatch(english, /Electron/);
});

test('main process wires bounded startup recovery into real load and crash paths', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(source, /createStartupRecoveryCoordinator/);
  assert.match(source, /startupRecoveryCoordinator\.loadInitial/);
  assert.match(source, /startupRecoveryCoordinator\.rendererCrashed/);
  assert.match(source, /createStartupRendererHandlers/);
  assert.match(source, /startupRendererHandlers\.documentLoadStarted/);
  assert.match(source, /startupRendererHandlers\.documentLoaded/);
  assert.match(source, /startupRendererHandlers\.rendererInitializationFailed/);
  assert.match(source, /startupRendererHandlers\.rendererReady/);
  assert.match(source, /createStartupFailureDocument/);
});

class TestBrowserWindow extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.showCalls = 0;
    this.startupEvents = [];
    this.loadError = new Error('renderer load failed');
    this.loadOptions = null;
  }

  once(eventName, listener) {
    this.startupEvents.push(`listen:${eventName}`);
    return super.once(eventName, listener);
  }

  show() {
    this.showCalls++;
  }

  loadFile(target, options) {
    this.startupEvents.push(`load:${target}`);
    this.loadOptions = options;
    return this.loadError ? Promise.reject(this.loadError) : Promise.resolve('loaded');
  }
}

function createManualScheduler() {
  let nextId = 1;
  const pending = new Map();

  return {
    schedule(callback, delay) {
      const handle = { id: nextId++, unref() {} };
      pending.set(handle, { callback, delay });
      return handle;
    },
    cancel(handle) {
      pending.delete(handle);
    },
    count() {
      return pending.size;
    },
    delays() {
      return Array.from(pending.values(), entry => entry.delay);
    },
    async fireNext() {
      const entry = pending.entries().next().value;
      assert.ok(entry);
      const [handle, timer] = entry;
      pending.delete(handle);
      await timer.callback();
    }
  };
}

test('configureStartupRenderer leaves hardware acceleration enabled for a local Windows session', () => {
  let calls = 0;
  configureStartupRenderer({ disableHardwareAcceleration() { calls++; } }, { SESSIONNAME: 'Console' }, 'win32');
  assert.equal(calls, 0);
});

test('configureStartupRenderer disables hardware acceleration for a Windows Remote Desktop session', () => {
  let calls = 0;
  configureStartupRenderer({ disableHardwareAcceleration() { calls++; } }, { SESSIONNAME: 'RDP-Tcp#12' }, 'win32');
  assert.equal(calls, 1);
});

test('resolveStartupLanguage accepts only the supported persisted language', () => {
  assert.equal(resolveStartupLanguage({ globalSettings: { language: 'de' } }), 'de');
  assert.equal(resolveStartupLanguage({ globalSettings: { language: 'en' } }), 'en');
  assert.equal(resolveStartupLanguage({ globalSettings: { language: 'fr' } }), 'en');
  assert.equal(resolveStartupLanguage(null), 'en');
});

test('createStartupWindow forces the main window to start hidden', () => {
  const startup = createStartupWindow(TestBrowserWindow, { width: 1100, show: true });

  assert.equal(startup.window.options.width, 1100);
  assert.equal(startup.window.options.show, false);
});

test('main window uses the branded application icon', () => {
  const projectRoot = path.join(__dirname, '..');
  const mainSource = fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8');
  const createWindowStart = mainSource.indexOf('function createWindow()');
  const createWindowEnd = mainSource.indexOf('\nfunction createTray()', createWindowStart);
  const createWindowSource = mainSource.slice(createWindowStart, createWindowEnd);

  assert.equal(fs.existsSync(path.join(projectRoot, 'assets', 'app_icon.ico')), true);
  assert.match(createWindowSource, /icon:\s*path\.join\(__dirname, ['"]assets['"], ['"]app_icon\.ico['"]\)/u);
});

test('startup load registers visibility before navigation and shows only once', async () => {
  const startup = createStartupWindow(TestBrowserWindow, {});
  startup.window.loadError = null;
  const loading = startup.load('renderer/index.html', () => {});

  assert.deepEqual(startup.window.startupEvents, [
    'listen:ready-to-show',
    'load:renderer/index.html'
  ]);

  startup.window.emit('ready-to-show');
  startup.window.emit('ready-to-show');
  await loading;

  assert.equal(startup.window.showCalls, 1);
});

test('startup load forwards a rejected navigation to the error handler', async () => {
  const startup = createStartupWindow(TestBrowserWindow, {});
  let handledError;

  await startup.load('renderer/index.html', (err) => {
    handledError = err;
  });

  assert.equal(handledError, startup.window.loadError);
});

test('startup load forwards navigation options before the renderer becomes visible', async () => {
  const startup = createStartupWindow(TestBrowserWindow, {});
  const options = { query: { language: 'de' } };

  await startup.load('renderer/index.html', () => {}, options);

  assert.deepEqual(startup.window.loadOptions, options);
});

test('startup recovery retries the initial load exactly once before succeeding', async () => {
  const attempts = [];
  const options = { query: { language: 'de' } };
  const coordinator = createStartupRecoveryCoordinator({
    async load(...args) {
      attempts.push(args);
      if (attempts.length === 1) throw new Error('first load failed');
      return 'loaded';
    },
    reload() {},
    reveal() {},
    close() {}
  });

  const result = await coordinator.loadInitial('renderer/index.html', options);

  assert.equal(result, 'loaded');
  assert.deepEqual(attempts, [
    ['renderer/index.html', options],
    ['renderer/index.html', options]
  ]);
});

test('startup recovery reveals a safe failure surface after both initial loads fail', async () => {
  const loadErrors = [new Error('first load failed'), new Error('second load failed')];
  const safeFailures = [];
  let loadCalls = 0;
  let revealCalls = 0;
  let closeCalls = 0;
  const coordinator = createStartupRecoveryCoordinator({
    async load() {
      throw loadErrors[loadCalls++];
    },
    reload() {},
    reveal() {
      revealCalls++;
    },
    async showFailure(failure) {
      safeFailures.push(failure);
    },
    close() {
      closeCalls++;
    }
  });

  await coordinator.loadInitial('renderer/index.html');

  assert.equal(loadCalls, 2);
  assert.deepEqual(safeFailures, [{
    phase: 'initial-load',
    attempt: 2,
    error: loadErrors[1]
  }]);
  assert.equal(revealCalls, 1);
  assert.equal(closeCalls, 0);
});

test('startup recovery closes when the safe failure surface cannot be shown', async () => {
  const loadError = new Error('renderer remains unavailable');
  const surfaceError = new Error('failure surface failed');
  const closeFailures = [];
  let revealCalls = 0;
  const coordinator = createStartupRecoveryCoordinator({
    async load() {
      throw loadError;
    },
    reload() {},
    reveal() {
      revealCalls++;
    },
    async showFailure() {
      throw surfaceError;
    },
    async close(failure) {
      closeFailures.push(failure);
    }
  });

  await coordinator.loadInitial('renderer/index.html');

  assert.equal(revealCalls, 0);
  assert.deepEqual(closeFailures, [{
    phase: 'initial-load',
    attempt: 2,
    error: loadError,
    surfaceError
  }]);
});

test('startup recovery uses a controlled close when no failure surface is configured', async () => {
  const loadError = new Error('renderer unavailable');
  const closeFailures = [];
  let revealCalls = 0;
  const coordinator = createStartupRecoveryCoordinator({
    async load() {
      throw loadError;
    },
    reload() {},
    reveal() {
      revealCalls++;
    },
    async close(failure) {
      closeFailures.push(failure);
    }
  });

  await coordinator.loadInitial('renderer/index.html');

  assert.equal(revealCalls, 0);
  assert.deepEqual(closeFailures, [{
    phase: 'initial-load',
    attempt: 2,
    error: loadError
  }]);
});

test('renderer crash recovery reloads once and cannot enter an infinite reload loop', async () => {
  const crashes = [
    { reason: 'crashed', exitCode: 11 },
    { reason: 'crashed', exitCode: 12 },
    { reason: 'crashed', exitCode: 13 }
  ];
  const safeFailures = [];
  let reloadCalls = 0;
  let revealCalls = 0;
  const coordinator = createStartupRecoveryCoordinator({
    load() {},
    async reload() {
      reloadCalls++;
    },
    reveal() {
      revealCalls++;
    },
    async showFailure(failure) {
      safeFailures.push(failure);
    },
    close() {}
  });

  await coordinator.rendererCrashed(crashes[0]);
  await coordinator.rendererCrashed(crashes[1]);
  await coordinator.rendererCrashed(crashes[2]);

  assert.equal(reloadCalls, 1);
  assert.deepEqual(safeFailures, [{
    phase: 'renderer-crash',
    attempt: 2,
    details: crashes[1]
  }]);
  assert.equal(revealCalls, 1);
});

test('renderer initialization failures share the bounded recovery path', async () => {
  const failures = [];
  let reloadCalls = 0;
  const coordinator = createStartupRecoveryCoordinator({
    load() {},
    async reload() {
      reloadCalls++;
    },
    reveal() {},
    async showFailure(failure) {
      failures.push(failure);
    },
    close() {}
  });

  await coordinator.rendererInitializationFailed({ message: 'first failure' });
  await coordinator.rendererInitializationFailed({ message: 'second failure' });

  assert.equal(reloadCalls, 1);
  assert.deepEqual(failures, [{
    phase: 'renderer-initialization',
    attempt: 2,
    details: { message: 'second failure' }
  }]);
});

test('production startup handlers route renderer initialization failure through bounded recovery', async () => {
  const failures = [];
  let reloadCalls = 0;
  let reportedFailure;
  const webContents = {};
  const coordinator = createStartupRecoveryCoordinator({
    load() {},
    async reload() {
      reloadCalls++;
    },
    reveal() {},
    async showFailure(failure) {
      failures.push(failure);
    },
    close() {}
  });
  const handlers = createStartupRendererHandlers({
    window: { isDestroyed: () => false, webContents },
    coordinator,
    onReady() {},
    onInitializationFailed(details) {
      reportedFailure = details;
    }
  });
  const details = { message: 'top-level initialization failed' };

  await handlers.rendererInitializationFailed({ sender: webContents }, details);
  await handlers.rendererInitializationFailed({ sender: webContents }, details);

  assert.equal(reloadCalls, 1);
  assert.equal(reportedFailure, details);
  assert.deepEqual(failures, [{
    phase: 'renderer-initialization',
    attempt: 2,
    details
  }]);
});

test('production startup handlers enforce the Ready deadline after every main document load', async () => {
  const scheduler = createManualScheduler();
  const failures = [];
  let reloadCalls = 0;
  const coordinator = createStartupRecoveryCoordinator({
    load() {},
    async reload() {
      reloadCalls++;
    },
    reveal() {},
    async showFailure(failure) {
      failures.push(failure);
    },
    close() {},
    readyTimeoutMs: 25,
    scheduleReadyDeadline: scheduler.schedule,
    cancelReadyDeadline: scheduler.cancel
  });
  const handlers = createStartupRendererHandlers({
    window: { isDestroyed: () => false, webContents: {} },
    coordinator,
    onReady() {},
    onInitializationFailed() {}
  });

  handlers.documentLoadStarted();
  handlers.documentLoaded();

  assert.deepEqual(scheduler.delays(), [25]);
  await scheduler.fireNext();
  assert.equal(reloadCalls, 1);

  handlers.documentLoadStarted();
  handlers.documentLoaded();
  await scheduler.fireNext();

  assert.equal(reloadCalls, 1);
  assert.deepEqual(failures, [{
    phase: 'renderer-ready-timeout',
    attempt: 2,
    details: { timeoutMs: 25 }
  }]);
});

test('production startup handlers cancel the Ready deadline after a valid Ready signal', async () => {
  const scheduler = createManualScheduler();
  let reloadCalls = 0;
  let readyCalls = 0;
  const webContents = {};
  const coordinator = createStartupRecoveryCoordinator({
    load() {},
    async reload() {
      reloadCalls++;
    },
    reveal() {},
    close() {},
    readyTimeoutMs: 25,
    scheduleReadyDeadline: scheduler.schedule,
    cancelReadyDeadline: scheduler.cancel
  });
  const handlers = createStartupRendererHandlers({
    window: { isDestroyed: () => false, webContents },
    coordinator,
    onReady() {
      readyCalls++;
    },
    onInitializationFailed() {}
  });

  handlers.documentLoadStarted();
  handlers.documentLoaded();
  const ready = handlers.rendererReady({ sender: webContents });

  assert.equal(ready, true);
  assert.equal(readyCalls, 1);
  assert.equal(scheduler.count(), 0);
  assert.equal(reloadCalls, 0);
});

test('Ready before did-finish-load prevents a stale deadline', () => {
  const scheduler = createManualScheduler();
  const webContents = {};
  const coordinator = createStartupRecoveryCoordinator({
    load() {},
    reload() {},
    reveal() {},
    close() {},
    readyTimeoutMs: 25,
    scheduleReadyDeadline: scheduler.schedule,
    cancelReadyDeadline: scheduler.cancel
  });
  const handlers = createStartupRendererHandlers({
    window: { isDestroyed: () => false, webContents },
    coordinator,
    onReady() {},
    onInitializationFailed() {}
  });

  handlers.documentLoadStarted();
  handlers.rendererReady({ sender: webContents });
  handlers.documentLoaded();

  assert.equal(scheduler.count(), 0);
});

test('disposing startup handlers cancels a pending Ready deadline', () => {
  const scheduler = createManualScheduler();
  const coordinator = createStartupRecoveryCoordinator({
    load() {},
    reload() {},
    reveal() {},
    close() {},
    readyTimeoutMs: 25,
    scheduleReadyDeadline: scheduler.schedule,
    cancelReadyDeadline: scheduler.cancel
  });
  const handlers = createStartupRendererHandlers({
    window: { isDestroyed: () => false, webContents: {} },
    coordinator,
    onReady() {},
    onInitializationFailed() {}
  });

  handlers.documentLoadStarted();
  handlers.documentLoaded();
  handlers.dispose();

  assert.equal(scheduler.count(), 0);
});

test('a successful renderer ready event reveals content and resets crash recovery', async () => {
  const crashes = [
    { reason: 'crashed', exitCode: 21 },
    { reason: 'crashed', exitCode: 22 }
  ];
  let reloadCalls = 0;
  let revealCalls = 0;
  let safeFailureCalls = 0;
  const coordinator = createStartupRecoveryCoordinator({
    load() {},
    async reload() {
      reloadCalls++;
    },
    reveal() {
      revealCalls++;
    },
    async showFailure() {
      safeFailureCalls++;
    },
    close() {}
  });

  await coordinator.rendererCrashed(crashes[0]);
  coordinator.rendererReady();
  await coordinator.rendererCrashed(crashes[1]);

  assert.equal(reloadCalls, 2);
  assert.equal(revealCalls, 1);
  assert.equal(safeFailureCalls, 0);
});

test('a failed crash reload enters the safe failure state without another reload', async () => {
  const crash = { reason: 'launch-failed', exitCode: 31 };
  const reloadError = new Error('reload failed');
  const safeFailures = [];
  let reloadCalls = 0;
  let revealCalls = 0;
  const coordinator = createStartupRecoveryCoordinator({
    load() {},
    async reload() {
      reloadCalls++;
      throw reloadError;
    },
    reveal() {
      revealCalls++;
    },
    async showFailure(failure) {
      safeFailures.push(failure);
    },
    close() {}
  });

  await coordinator.rendererCrashed(crash);
  await coordinator.rendererCrashed({ reason: 'crashed', exitCode: 32 });

  assert.equal(reloadCalls, 1);
  assert.deepEqual(safeFailures, [{
    phase: 'renderer-reload',
    attempt: 1,
    details: crash,
    error: reloadError
  }]);
  assert.equal(revealCalls, 1);
});

test('terminal recovery ignores late ready, load, and crash events', async () => {
  let loadCalls = 0;
  let reloadCalls = 0;
  let revealCalls = 0;
  let safeFailureCalls = 0;
  const coordinator = createStartupRecoveryCoordinator({
    async load() {
      loadCalls++;
    },
    async reload() {
      reloadCalls++;
    },
    reveal() {
      revealCalls++;
    },
    async showFailure() {
      safeFailureCalls++;
    },
    close() {}
  });

  await coordinator.rendererCrashed({ reason: 'crashed', exitCode: 41 });
  await coordinator.rendererCrashed({ reason: 'crashed', exitCode: 42 });
  const readyResult = coordinator.rendererReady();
  await coordinator.loadInitial('renderer/index.html');
  await coordinator.rendererCrashed({ reason: 'crashed', exitCode: 43 });

  assert.equal(readyResult, false);
  assert.equal(loadCalls, 0);
  assert.equal(reloadCalls, 1);
  assert.equal(revealCalls, 1);
  assert.equal(safeFailureCalls, 1);
});
