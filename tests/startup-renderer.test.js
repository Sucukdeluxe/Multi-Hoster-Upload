const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const {
  configureStartupRenderer,
  createStartupCloseHandler,
  createStartupExternalRevealBindings,
  createStartupFailureDocument,
  createStartupNavigationLoader,
  createStartupRecoveryCoordinator,
  createStartupRevealGate,
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

function createRendererFrame(frameToken, url = `file:///renderer/index.html?startupDocument=${frameToken}`) {
  return {
    detached: false,
    frameToken,
    processId: 1,
    url,
    isDestroyed() {
      return false;
    }
  };
}

function createRevealWindow({ minimized = true, visible = false } = {}) {
  const events = [];
  return {
    events,
    webContents: {
      isDestroyed() {
        return false;
      }
    },
    isDestroyed() {
      return false;
    },
    isMinimized() {
      return minimized;
    },
    isVisible() {
      return visible;
    },
    restore() {
      events.push('restore');
      minimized = false;
    },
    show() {
      events.push('show');
      visible = true;
    },
    focus() {
      events.push('focus');
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

test('configureStartupRenderer forces full motion only for hot dev', () => {
  const devSwitches = [];
  const releaseSwitches = [];
  const createApp = switches => ({
    disableHardwareAcceleration() {},
    getPath(name) {
      assert.equal(name, 'userData');
      return 'C:\\ReleaseTest\\user-data';
    },
    commandLine: {
      appendSwitch(name, value) {
        switches.push({ name, value });
      }
    }
  });

  configureStartupRenderer(createApp(devSwitches), { SESSIONNAME: 'Console' }, 'win32', ['electron', '.', '--dev']);
  configureStartupRenderer(createApp(releaseSwitches), { SESSIONNAME: 'Console' }, 'win32', ['Multi-Hoster-Upload.exe']);

  assert.deepEqual(devSwitches, [
    { name: 'force-prefers-no-reduced-motion', value: undefined },
    { name: 'user-data-dir', value: 'C:\\ReleaseTest\\user-data' }
  ]);
  assert.deepEqual(releaseSwitches, []);
});

test('resolveStartupLanguage accepts only the supported persisted language', () => {
  assert.equal(resolveStartupLanguage({ globalSettings: { language: 'de' } }), 'de');
  assert.equal(resolveStartupLanguage({ globalSettings: { language: 'en' } }), 'en');
  assert.equal(resolveStartupLanguage({ globalSettings: { language: 'fr' } }), 'en');
  assert.equal(resolveStartupLanguage(null), 'en');
});

test('createStartupWindow forces the main window to start hidden', () => {
  const startup = createStartupWindow(TestBrowserWindow, {
    width: 1100,
    show: true,
    disableAutoHideCursor: false
  });

  assert.equal(startup.window.options.width, 1100);
  assert.equal(startup.window.options.show, false);
  assert.equal(startup.window.options.disableAutoHideCursor, true);
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

test('ready-to-show cannot reveal the main window before renderer Ready', async () => {
  const startup = createStartupWindow(TestBrowserWindow, {});
  startup.window.loadError = null;
  const loading = startup.load('renderer/index.html', () => {});

  assert.deepEqual(startup.window.startupEvents, [
    'load:renderer/index.html'
  ]);

  startup.window.emit('ready-to-show');
  await loading;

  assert.equal(startup.window.showCalls, 0);
});

test('all production external reveal paths wait for an authorized startup surface', () => {
  const paths = [
    ['second-instance', bindings => {
      const app = new EventEmitter();
      bindings.bindSecondInstance(app);
      app.emit('second-instance');
    }],
    ['tray click', bindings => {
      const tray = new EventEmitter();
      bindings.bindTrayClick(tray);
      tray.emit('click');
    }],
    ['tray menu', bindings => {
      bindings.createTrayMenuItem('Open').click();
    }],
    ['drop target files', bindings => {
      const ipcMain = new EventEmitter();
      bindings.bindDropTargetFiles(ipcMain);
      ipcMain.emit('drop-target:files', {}, ['queued.mkv']);
    }]
  ];

  for (const [name, invoke] of paths) {
    const window = createRevealWindow();
    const revealGate = createStartupRevealGate(window);
    const droppedFiles = [];
    const bindings = createStartupExternalRevealBindings({
      getWindow: () => window,
      getRevealGate: () => revealGate,
      sendDroppedFiles: paths => droppedFiles.push(paths)
    });

    invoke(bindings);

    assert.deepEqual(window.events, [], name);
    assert.deepEqual(droppedFiles, [], name);

    revealGate.reveal();

    assert.deepEqual(window.events, ['restore', 'show', 'focus'], name);
    assert.deepEqual(droppedFiles, [], name);

    bindings.rendererReady(window);

    assert.deepEqual(droppedFiles, name === 'drop target files' ? [['queued.mkv']] : [], name);
  }
});

test('drop payloads wait through recovery and a safe failure reveal until renderer Ready', () => {
  const window = createRevealWindow({ minimized: false, visible: true });
  const droppedFiles = [];
  let bindings;
  const revealGate = createStartupRevealGate(window, {
    onBlock() {
      bindings.rendererBlocked(window);
    }
  });
  bindings = createStartupExternalRevealBindings({
    getWindow: () => window,
    getRevealGate: () => revealGate,
    sendDroppedFiles: paths => droppedFiles.push(paths)
  });
  const ipcMain = new EventEmitter();
  bindings.bindDropTargetFiles(ipcMain);
  bindings.rendererReady(window);

  ipcMain.emit('drop-target:files', {}, ['ready.mkv']);
  revealGate.navigate(() => {});
  ipcMain.emit('drop-target:files', {}, ['recovering.mkv']);
  revealGate.reveal();

  assert.deepEqual(droppedFiles, [['ready.mkv']]);

  bindings.rendererReady(window);

  assert.deepEqual(droppedFiles, [['ready.mkv'], ['recovering.mkv']]);
});

test('multiple pending drop payloads flush once in order and ready drops stay immediate', () => {
  const window = createRevealWindow();
  const revealGate = createStartupRevealGate(window);
  const droppedFiles = [];
  const bindings = createStartupExternalRevealBindings({
    getWindow: () => window,
    getRevealGate: () => revealGate,
    sendDroppedFiles: paths => droppedFiles.push(paths)
  });
  const ipcMain = new EventEmitter();
  bindings.bindDropTargetFiles(ipcMain);

  ipcMain.emit('drop-target:files', {}, ['first.mkv']);
  ipcMain.emit('drop-target:files', {}, ['second.mkv']);
  ipcMain.emit('drop-target:files', {}, ['third.mkv']);

  assert.deepEqual(droppedFiles, []);

  revealGate.reveal();
  bindings.rendererReady(window);
  bindings.rendererReady(window);

  assert.deepEqual(droppedFiles, [
    ['first.mkv'],
    ['second.mkv'],
    ['third.mkv']
  ]);

  ipcMain.emit('drop-target:files', {}, ['fourth.mkv']);

  assert.deepEqual(droppedFiles, [
    ['first.mkv'],
    ['second.mkv'],
    ['third.mkv'],
    ['fourth.mkv']
  ]);
});

test('pending drop payloads stay bounded while retaining delivery order', () => {
  const window = createRevealWindow();
  const revealGate = createStartupRevealGate(window);
  const droppedFiles = [];
  const bindings = createStartupExternalRevealBindings({
    getWindow: () => window,
    getRevealGate: () => revealGate,
    sendDroppedFiles: paths => droppedFiles.push(paths),
    maxPendingDropPayloads: 2
  });
  const ipcMain = new EventEmitter();
  bindings.bindDropTargetFiles(ipcMain);

  ipcMain.emit('drop-target:files', {}, ['first.mkv']);
  ipcMain.emit('drop-target:files', {}, ['second.mkv']);
  ipcMain.emit('drop-target:files', {}, ['third.mkv']);
  bindings.rendererReady(window);

  assert.deepEqual(droppedFiles, [
    ['second.mkv'],
    ['third.mkv']
  ]);
});

test('pending drop payloads are cleared for destroyed and replaced windows', () => {
  const firstWindow = createRevealWindow();
  let activeWindow = firstWindow;
  const droppedFiles = [];
  const bindings = createStartupExternalRevealBindings({
    getWindow: () => activeWindow,
    getRevealGate: () => ({ request() {} }),
    sendDroppedFiles: paths => droppedFiles.push(paths)
  });
  const ipcMain = new EventEmitter();
  bindings.bindDropTargetFiles(ipcMain);

  ipcMain.emit('drop-target:files', {}, ['replaced.mkv']);
  activeWindow = createRevealWindow();
  bindings.rendererReady(firstWindow);
  bindings.rendererReady(activeWindow);

  assert.deepEqual(droppedFiles, []);

  ipcMain.emit('drop-target:files', {}, ['ready.mkv']);
  bindings.rendererBlocked(activeWindow);
  ipcMain.emit('drop-target:files', {}, ['destroyed.mkv']);
  activeWindow.isDestroyed = () => true;
  bindings.rendererReady(activeWindow);
  activeWindow = createRevealWindow();
  bindings.rendererReady(activeWindow);

  assert.deepEqual(droppedFiles, [['ready.mkv']]);
});

test('renderer Ready and the safe failure surface can authorize the gated window', async () => {
  const readyWindow = createRevealWindow({ minimized: false });
  const readyGate = createStartupRevealGate(readyWindow);
  const readyCoordinator = createStartupRecoveryCoordinator({
    load() {},
    reload() {},
    reveal: readyGate.reveal,
    close() {}
  });
  const generation = readyCoordinator.rendererLoadStarted();
  readyCoordinator.rendererLoaded(generation);

  readyCoordinator.rendererReady(generation);

  assert.deepEqual(readyWindow.events, ['show']);

  const failureWindow = createRevealWindow({ minimized: false });
  const failureGate = createStartupRevealGate(failureWindow);
  let failureSurfaceLoads = 0;
  const failureCoordinator = createStartupRecoveryCoordinator({
    async load() {
      throw new Error('navigation failed');
    },
    reload() {},
    reveal: failureGate.reveal,
    async showFailure() {
      failureSurfaceLoads++;
    },
    close() {}
  });

  await failureCoordinator.loadInitial();

  assert.equal(failureSurfaceLoads, 1);
  assert.deepEqual(failureWindow.events, ['show']);
});

test('failed recovery navigation leaves the safe failure surface directly closable', async () => {
  const window = createRevealWindow({ minimized: false });
  let closeHandshakeReady = true;
  const readinessDuringNavigation = [];
  const revealGate = createStartupRevealGate(window, {
    onBlock() {
      closeHandshakeReady = false;
    }
  });
  const coordinator = createStartupRecoveryCoordinator({
    load() {},
    reload() {
      return revealGate.navigate(() => {
        readinessDuringNavigation.push(closeHandshakeReady);
        throw new Error('recovery load rejected before navigation');
      });
    },
    reveal: revealGate.reveal,
    showFailure() {
      return revealGate.navigate(() => {
        readinessDuringNavigation.push(closeHandshakeReady);
      });
    },
    close() {}
  });

  await coordinator.rendererCrashed({ reason: 'crashed' });

  let closePreparationCalls = 0;
  let preventDefaultCalls = 0;
  const closeHandler = createStartupCloseHandler({
    window,
    shouldPrepareClose: () => closeHandshakeReady,
    requestClosePreparation() {
      closePreparationCalls++;
    }
  });
  const intercepted = closeHandler({
    preventDefault() {
      preventDefaultCalls++;
    }
  });

  assert.deepEqual(readinessDuringNavigation, [false, false]);
  assert.deepEqual(window.events, ['show']);
  assert.equal(intercepted, false);
  assert.equal(preventDefaultCalls, 0);
  assert.equal(closePreparationCalls, 0);
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

test('startup navigation gives every main document a distinct generation URL', async () => {
  const calls = [];
  const window = {
    loadFile(target, options) {
      calls.push([target, options]);
      return Promise.resolve('loaded');
    }
  };
  const loadDocument = createStartupNavigationLoader(window, 'renderer/index.html', {
    hash: 'uploads',
    query: { language: 'de' }
  });

  await loadDocument();
  await loadDocument();

  assert.deepEqual(calls, [
    ['renderer/index.html', {
      hash: 'uploads',
      query: { language: 'de', startupDocument: '1' }
    }],
    ['renderer/index.html', {
      hash: 'uploads',
      query: { language: 'de', startupDocument: '2' }
    }]
  ]);
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

test('a crash during initial load joins the serialized initial retry without a third navigation', async () => {
  let rejectFirstLoad;
  const firstLoad = new Promise((_, reject) => {
    rejectFirstLoad = reject;
  });
  let activeNavigations = 0;
  let maxConcurrentNavigations = 0;
  let loadCalls = 0;
  let reloadCalls = 0;
  const coordinator = createStartupRecoveryCoordinator({
    async load() {
      loadCalls++;
      activeNavigations++;
      maxConcurrentNavigations = Math.max(maxConcurrentNavigations, activeNavigations);
      try {
        if (loadCalls === 1) return await firstLoad;
        return 'loaded';
      } finally {
        activeNavigations--;
      }
    },
    async reload() {
      reloadCalls++;
      activeNavigations++;
      maxConcurrentNavigations = Math.max(maxConcurrentNavigations, activeNavigations);
      activeNavigations--;
      return 'reloaded';
    },
    reveal() {},
    close() {}
  });

  const initialLoading = coordinator.loadInitial('renderer/index.html');
  const crashRecovery = coordinator.rendererCrashed({ reason: 'crashed', exitCode: 17 });
  rejectFirstLoad(new Error('first navigation crashed'));

  await Promise.all([initialLoading, crashRecovery]);

  assert.equal(loadCalls, 2);
  assert.equal(reloadCalls, 0);
  assert.equal(maxConcurrentNavigations, 1);
});

test('the initial navigation retry consumes the single recovery navigation budget', async () => {
  const scheduler = createManualScheduler();
  const failures = [];
  let loadCalls = 0;
  let reloadCalls = 0;
  const coordinator = createStartupRecoveryCoordinator({
    async load() {
      loadCalls++;
      if (loadCalls === 1) throw new Error('first navigation failed');
    },
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

  await coordinator.loadInitial('renderer/index.html');
  const generation = coordinator.rendererLoadStarted();
  coordinator.rendererLoaded(generation);
  await scheduler.fireNext();

  assert.equal(loadCalls, 2);
  assert.equal(reloadCalls, 0);
  assert.deepEqual(failures, [{
    phase: 'renderer-ready-timeout',
    attempt: 2,
    details: { timeoutMs: 25 }
  }]);
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
  let revealCalls = 0;
  const reportedFailures = [];
  const ipcMain = new EventEmitter();
  const webContents = new EventEmitter();
  const firstFrame = createRendererFrame('initialization-1');
  const secondFrame = createRendererFrame('initialization-2');
  const coordinator = createStartupRecoveryCoordinator({
    load() {},
    async reload() {
      reloadCalls++;
      webContents.mainFrame = secondFrame;
      webContents.emit('did-start-navigation', {
        isMainFrame: true,
        isSameDocument: false,
        url: secondFrame.url,
        frame: secondFrame
      });
      webContents.emit('did-finish-load');
    },
    reveal() {
      revealCalls++;
    },
    async showFailure(failure) {
      failures.push(failure);
    },
    close() {}
  });
  const handlers = createStartupRendererHandlers({
    window: { isDestroyed: () => false, webContents },
    ipcMain,
    coordinator,
    onReady() {},
    onInitializationFailed(details) {
      reportedFailures.push(details);
    }
  });
  const firstDetails = { message: 'first top-level initialization failed' };
  const secondDetails = { message: 'second top-level initialization failed' };

  webContents.mainFrame = firstFrame;
  webContents.emit('did-start-navigation', {
    isMainFrame: true,
    isSameDocument: false,
    url: firstFrame.url,
    frame: firstFrame
  });
  ipcMain.emit('app:renderer-initialization-failed', {
    sender: webContents,
    senderFrame: firstFrame
  }, firstDetails);
  await new Promise(resolve => setImmediate(resolve));
  ipcMain.emit('app:renderer-initialization-failed', {
    sender: webContents,
    senderFrame: secondFrame
  }, secondDetails);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(reloadCalls, 1);
  assert.equal(revealCalls, 1);
  assert.deepEqual(reportedFailures, [firstDetails, secondDetails]);
  assert.deepEqual(failures, [{
    phase: 'renderer-initialization',
    attempt: 2,
    details: secondDetails
  }]);
  handlers.dispose();
});

test('production startup handlers enforce the Ready deadline after every main document load', async () => {
  const scheduler = createManualScheduler();
  const webContents = new EventEmitter();
  const firstFrame = createRendererFrame('timeout-1');
  const secondFrame = createRendererFrame('timeout-2');
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
    window: { isDestroyed: () => false, webContents },
    coordinator,
    onReady() {},
    onInitializationFailed() {}
  });

  webContents.mainFrame = firstFrame;
  webContents.emit('did-start-navigation', {
    isMainFrame: true,
    isSameDocument: false,
    url: firstFrame.url,
    frame: firstFrame
  });
  webContents.emit('did-finish-load');

  assert.deepEqual(scheduler.delays(), [25]);
  await scheduler.fireNext();
  assert.equal(reloadCalls, 1);

  webContents.mainFrame = secondFrame;
  webContents.emit('did-start-navigation', {
    isMainFrame: true,
    isSameDocument: false,
    url: secondFrame.url,
    frame: secondFrame
  });
  webContents.emit('did-finish-load');
  await scheduler.fireNext();

  assert.equal(reloadCalls, 1);
  assert.deepEqual(failures, [{
    phase: 'renderer-ready-timeout',
    attempt: 2,
    details: { timeoutMs: 25 }
  }]);
  handlers.dispose();
});

test('late Ready from an old renderer generation cannot clear the current deadline or recovery budget', async () => {
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

  const oldGeneration = coordinator.rendererLoadStarted();
  coordinator.rendererLoaded(oldGeneration);
  await scheduler.fireNext();

  const currentGeneration = coordinator.rendererLoadStarted();
  coordinator.rendererLoaded(currentGeneration);
  const accepted = coordinator.rendererReady(oldGeneration);

  assert.equal(accepted, false);
  assert.equal(scheduler.count(), 1);

  await scheduler.fireNext();

  assert.equal(reloadCalls, 1);
  assert.deepEqual(failures, [{
    phase: 'renderer-ready-timeout',
    attempt: 2,
    details: { timeoutMs: 25 }
  }]);
});

test('Ready without a renderer generation cannot clear the active deadline', () => {
  const scheduler = createManualScheduler();
  let revealCalls = 0;
  const coordinator = createStartupRecoveryCoordinator({
    load() {},
    reload() {},
    reveal() {
      revealCalls++;
    },
    close() {},
    readyTimeoutMs: 25,
    scheduleReadyDeadline: scheduler.schedule,
    cancelReadyDeadline: scheduler.cancel
  });

  const generation = coordinator.rendererLoadStarted();
  coordinator.rendererLoaded(generation);
  const accepted = coordinator.rendererReady();

  assert.equal(accepted, false);
  assert.equal(revealCalls, 0);
  assert.equal(scheduler.count(), 1);
});

test('production event wiring rejects an old document Ready and exposes the failsafe', async () => {
  const scheduler = createManualScheduler();
  const ipcMain = new EventEmitter();
  const webContents = new EventEmitter();
  const oldFrame = createRendererFrame('main-frame', 'file:///renderer/index.html?startupDocument=1');
  const currentFrame = createRendererFrame('main-frame', 'file:///renderer/index.html?startupDocument=2');
  const window = {
    webContents,
    isDestroyed() {
      return false;
    }
  };
  const failures = [];
  let reloadCalls = 0;
  let revealCalls = 0;
  let readyCalls = 0;
  const coordinator = createStartupRecoveryCoordinator({
    load() {},
    async reload() {
      reloadCalls++;
      webContents.mainFrame = currentFrame;
      webContents.emit('did-start-navigation', {
        isMainFrame: true,
        isSameDocument: false,
        url: currentFrame.url,
        frame: currentFrame
      });
      webContents.emit('did-finish-load');
    },
    reveal() {
      revealCalls++;
    },
    async showFailure(failure) {
      failures.push(failure);
    },
    close() {},
    readyTimeoutMs: 25,
    scheduleReadyDeadline: scheduler.schedule,
    cancelReadyDeadline: scheduler.cancel
  });
  const handlers = createStartupRendererHandlers({
    window,
    ipcMain,
    coordinator,
    onReady() {
      readyCalls++;
    },
    onInitializationFailed() {}
  });

  webContents.mainFrame = oldFrame;
  webContents.emit('did-start-navigation', {
    isMainFrame: true,
    isSameDocument: false,
    url: oldFrame.url,
    frame: oldFrame
  });
  webContents.emit('did-finish-load');

  assert.equal(scheduler.count(), 1);
  await scheduler.fireNext();
  assert.equal(reloadCalls, 1);
  assert.equal(scheduler.count(), 1);

  ipcMain.emit('app:close-handshake-ready', {
    sender: webContents,
    senderFrame: oldFrame
  });

  assert.equal(readyCalls, 0);
  assert.equal(scheduler.count(), 1);

  await scheduler.fireNext();

  assert.equal(reloadCalls, 1);
  assert.equal(revealCalls, 1);
  assert.deepEqual(failures, [{
    phase: 'renderer-ready-timeout',
    attempt: 2,
    details: { timeoutMs: 25 }
  }]);
  handlers.dispose();
});

test('production recovery wiring flushes pending drops only for the current document Ready', async () => {
  const ipcMain = new EventEmitter();
  const webContents = new EventEmitter();
  const initialFrame = createRendererFrame('drop-initial');
  const recoveryFrame = createRendererFrame('drop-recovery');
  const window = createRevealWindow({ minimized: false, visible: true });
  window.webContents = webContents;
  const droppedFiles = [];
  let bindings;
  const revealGate = createStartupRevealGate(window, {
    onBlock() {
      bindings.rendererBlocked(window);
    }
  });
  bindings = createStartupExternalRevealBindings({
    getWindow: () => window,
    getRevealGate: () => revealGate,
    sendDroppedFiles: paths => droppedFiles.push(paths)
  });
  bindings.bindDropTargetFiles(ipcMain);
  const coordinator = createStartupRecoveryCoordinator({
    load() {},
    async reload() {
      webContents.mainFrame = recoveryFrame;
      webContents.emit('did-start-navigation', {
        isMainFrame: true,
        isSameDocument: false,
        url: recoveryFrame.url,
        frame: recoveryFrame
      });
      webContents.emit('did-finish-load');
    },
    reveal: revealGate.reveal,
    close() {}
  });
  const handlers = createStartupRendererHandlers({
    window,
    ipcMain,
    coordinator,
    onDocumentLoadStarted: revealGate.block,
    onReady() {
      bindings.rendererReady(window);
    },
    onInitializationFailed() {}
  });

  webContents.mainFrame = initialFrame;
  webContents.emit('did-start-navigation', {
    isMainFrame: true,
    isSameDocument: false,
    url: initialFrame.url,
    frame: initialFrame
  });
  webContents.emit('did-finish-load');
  ipcMain.emit('app:close-handshake-ready', {
    sender: webContents,
    senderFrame: initialFrame
  });
  ipcMain.emit('drop-target:files', {}, ['ready.mkv']);
  webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  await new Promise(resolve => setImmediate(resolve));

  ipcMain.emit('drop-target:files', {}, ['first-recovery.mkv']);
  ipcMain.emit('drop-target:files', {}, ['second-recovery.mkv']);
  ipcMain.emit('app:close-handshake-ready', {
    sender: webContents,
    senderFrame: initialFrame
  });

  assert.deepEqual(droppedFiles, [['ready.mkv']]);

  ipcMain.emit('app:close-handshake-ready', {
    sender: webContents,
    senderFrame: recoveryFrame
  });
  ipcMain.emit('app:close-handshake-ready', {
    sender: webContents,
    senderFrame: recoveryFrame
  });

  assert.deepEqual(droppedFiles, [
    ['ready.mkv'],
    ['first-recovery.mkv'],
    ['second-recovery.mkv']
  ]);
  handlers.dispose();
});

test('production startup handlers cancel the Ready deadline after a valid Ready signal', async () => {
  const scheduler = createManualScheduler();
  let reloadCalls = 0;
  let readyCalls = 0;
  const frame = createRendererFrame('ready');
  const webContents = { mainFrame: frame };
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
  const ready = handlers.rendererReady({ sender: webContents, senderFrame: frame });

  assert.equal(ready, true);
  assert.equal(readyCalls, 1);
  assert.equal(scheduler.count(), 0);
  assert.equal(reloadCalls, 0);
});

test('Ready before did-finish-load is rejected and cannot suppress the current deadline', () => {
  const scheduler = createManualScheduler();
  const frame = createRendererFrame('not-finished');
  const webContents = { mainFrame: frame };
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
  const ready = handlers.rendererReady({ sender: webContents, senderFrame: frame });
  handlers.documentLoaded();

  assert.equal(ready, false);
  assert.equal(scheduler.count(), 1);
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
  const generation = coordinator.rendererLoadStarted();
  coordinator.rendererLoaded(generation);
  coordinator.rendererReady(generation);
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
