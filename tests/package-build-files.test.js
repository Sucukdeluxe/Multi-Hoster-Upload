const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const packageJson = require('../package.json');

const projectRoot = path.join(__dirname, '..');

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitForCondition(predicate) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.fail('condition did not become true');
}

function createAutomationLifecycleHarness(mainSource) {
  const currentMarker = 'let suppressAutomationStatusEvents = false;';
  const queuedMarker = 'const automationLifecycleQueue = [];';
  const blockStart = Math.max(mainSource.indexOf(currentMarker), mainSource.indexOf(queuedMarker));
  const blockEnd = mainSource.indexOf('\n// --- Remote Control ---', blockStart);
  assert.notEqual(blockStart, -1, 'automation lifecycle block missing');
  assert.notEqual(blockEnd, -1, 'automation lifecycle block boundary missing');
  const handlers = new Map();
  const order = [];
  const sent = [];
  const saves = [];
  const pauseDeferred = createDeferred();
  const resumeDeferred = createDeferred();
  const configuredSettings = [];
  const startedSettings = [];
  let publishStatus = () => {};
  let state = {
    globalSettings: {
      folderMonitor: {
        enabled: true,
        folderPath: 'C:\\watch',
        paused: true,
        pausedAt: 1,
        queueLimitJobs: 15000,
        reconcileIntervalMinutes: 5
      }
    }
  };
  const folderMonitor = new (require('node:events').EventEmitter)();
  folderMonitor.running = false;
  folderMonitor.status = () => ({ running: folderMonitor.running, reachable: true, startedAt: 100, nextReconcileAt: 200 });
  folderMonitor.stop = () => { folderMonitor.running = false; order.push('stop'); };
  folderMonitor.configure = settings => {
    configuredSettings.push(structuredClone(settings));
    folderMonitor.running = false;
    order.push('configure');
    publishStatus();
    return { includesExisting: false, paused: true };
  };
  folderMonitor.start = settings => {
    startedSettings.push(structuredClone(settings));
    folderMonitor.running = true;
    order.push('start');
    publishStatus();
    return {};
  };
  folderMonitor.pause = () => {
    order.push('pause');
    publishStatus();
    return pauseDeferred.promise.then(() => {
      folderMonitor.running = false;
      publishStatus();
    });
  };
  folderMonitor.resume = () => {
    order.push('resume');
    publishStatus();
    return resumeDeferred.promise.then(() => {
      folderMonitor.running = true;
      publishStatus();
      return { reachable: true };
    });
  };
  folderMonitor.scan = async options => {
    order.push(`scan:${options.trigger}:${options.emitFiles}`);
    return { reachable: true, trigger: options.trigger };
  };
  const configStore = {
    load: () => structuredClone(state),
    save: config => {
      const deferred = createDeferred();
      const snapshot = structuredClone(config);
      saves.push({ paused: snapshot.globalSettings.folderMonitor.paused, deferred });
      order.push(`save:${snapshot.globalSettings.folderMonitor.paused}`);
      return deferred.promise.then(() => { state = snapshot; });
    }
  };
  const uploadManager = {
    finishAfterActive: () => order.push('finish'),
    startBatch: () => order.push('startBatch')
  };
  const context = {
    configStore,
    debugLog: () => {},
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    folderMonitor,
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    normalizeAutomationSettings: require('../lib/automation-control').normalizeAutomationSettings,
    path,
    safeSend: (channel, snapshot) => { sent.push([channel, snapshot]); return true; },
    uploadManager
  };
  vm.runInNewContext(mainSource.slice(blockStart, blockEnd), context);
  publishStatus = () => context.publishAutomationStatus();
  return {
    handlers,
    configuredSettings,
    context,
    order,
    pauseDeferred,
    resumeDeferred,
    saves,
    sent,
    setFolderMonitorState(value) {
      state.globalSettings.folderMonitor = { ...state.globalSettings.folderMonitor, ...value };
    },
    startedSettings,
    state: () => structuredClone(state),
    publishStatus
  };
}

test('packages every Electron preload referenced by the main process', () => {
  assert.ok(packageJson.build.files.includes('preload.js'));
  assert.ok(packageJson.build.files.includes('preload-drop-target.js'));
  assert.ok(packageJson.build.files.includes('lib/**/*'));
  assert.equal(packageJson.build.win.signAndEditExecutable, false);
});

test('exposes managed online backup operations through narrow IPC boundaries', () => {
  const preloadSource = fs.readFileSync(path.join(projectRoot, 'preload.js'), 'utf8');
  const mainSource = fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8');

  assert.match(preloadSource, /listManagedOnlineBackups:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('online-backup:list-managed'\)/u);
  assert.match(preloadSource, /createManagedOnlineBackup:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('online-backup:create-managed'\)/u);
  assert.match(preloadSource, /copyManagedOnlineBackup:\s*\(id\)\s*=>\s*ipcRenderer\.invoke\('online-backup:copy-managed',\s*id\)/u);
  assert.match(preloadSource, /deleteManagedOnlineBackup:\s*\(id\)\s*=>\s*ipcRenderer\.invoke\('online-backup:delete-managed',\s*id\)/u);
  assert.match(preloadSource, /restoreOnlineBackup:\s*\(key\)\s*=>\s*ipcRenderer\.invoke\('online-backup:restore',\s*key\)/u);
  assert.deepEqual(
    [...preloadSource.matchAll(/^\s{2}(\w*OnlineBackups?):/gmu)].map((match) => match[1]),
    ['listManagedOnlineBackups', 'createManagedOnlineBackup', 'copyManagedOnlineBackup', 'deleteManagedOnlineBackup', 'restoreOnlineBackup']
  );
  assert.doesNotMatch(preloadSource, /^\s{2}createOnlineBackup:/mu);
  assert.doesNotMatch(preloadSource, /ipcRenderer\.invoke\('online-backup:create'\)/u);
  assert.match(mainSource, /path\.join\(app\.getPath\('userData'\),\s*'online-backup-keys\.json'\)/u);
  assert.match(mainSource, /Buffer\.from\(id,\s*'base64url'\)/u);
  assert.match(mainSource, /decoded\.toString\('base64url'\)\s*!==\s*id/u);
  assert.doesNotMatch(mainSource, /ipcMain\.handle\('online-backup:create'/u);
  assert.match(mainSource, /ipcMain\.handle\('online-backup:list-managed',[\s\S]*?onlineBackupManager\.listManaged\(\)/u);
  assert.match(mainSource, /ipcMain\.handle\('online-backup:create-managed',[\s\S]*?onlineBackupManager\.createManaged\(\)/u);
  assert.match(mainSource, /ipcMain\.handle\('online-backup:copy-managed',[\s\S]*?onlineBackupManager\.copyManaged\(/u);
  assert.match(mainSource, /ipcMain\.handle\('online-backup:delete-managed',[\s\S]*?onlineBackupManager\.deleteManaged\(/u);
});

test('managed online backup handlers reject every sender outside the local main frame', async () => {
  const mainSource = fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8');
  const boundaryStart = mainSource.indexOf('const ONLINE_BACKUP_RENDERER_URL');
  const boundaryEnd = mainSource.indexOf('\nfunction clearCloseFlushTimer', boundaryStart);
  const handlersStart = mainSource.indexOf("ipcMain.handle('online-backup:list-managed'");
  const handlersEnd = mainSource.indexOf("\nipcMain.handle('online-backup:restore'", handlersStart);
  assert.notEqual(boundaryStart, -1, 'central online backup sender boundary is missing');
  assert.notEqual(boundaryEnd, -1, 'central online backup sender boundary is incomplete');
  assert.notEqual(handlersStart, -1, 'managed online backup handlers are missing');
  assert.notEqual(handlersEnd, -1, 'managed online backup handler block is incomplete');

  const expectedUrl = `${pathToFileURL(path.join(projectRoot, 'renderer', 'index.html')).href}?language=de&version=2.1.31`;
  const state = {
    frameUrl: expectedUrl,
    currentUrl: expectedUrl,
    windowDestroyed: false,
    webContentsDestroyed: false
  };
  const mainFrame = {};
  Object.defineProperty(mainFrame, 'url', { get: () => state.frameUrl });
  const webContents = {
    mainFrame,
    getURL: () => state.currentUrl,
    isDestroyed: () => state.webContentsDestroyed
  };
  const mainWindow = {
    webContents,
    isDestroyed: () => state.windowDestroyed
  };
  const managerCalls = [];
  const onlineBackupManager = {
    listManaged: () => { managerCalls.push('list'); return { ok: true, entries: [] }; },
    createManaged: () => { managerCalls.push('create'); return { ok: true, entry: { id: 'AAAAAAAAAAAAAAAAAAAAAA' } }; },
    copyManaged: (id) => { managerCalls.push(`copy:${id}`); return { ok: true }; },
    deleteManaged: (id) => { managerCalls.push(`delete:${id}`); return { ok: true, removedId: id }; }
  };
  const handlers = new Map();
  const context = {
    Buffer,
    URL,
    __dirname: projectRoot,
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    mainWindow,
    onlineBackupManager,
    path,
    pathToFileURL
  };
  vm.runInNewContext(
    `${mainSource.slice(boundaryStart, boundaryEnd)}\n${mainSource.slice(handlersStart, handlersEnd)}`,
    context
  );

  const id = 'AAAAAAAAAAAAAAAAAAAAAA';
  const invokeAll = async (event) => Promise.all([
    handlers.get('online-backup:list-managed')(event),
    handlers.get('online-backup:create-managed')(event),
    handlers.get('online-backup:copy-managed')(event, id),
    handlers.get('online-backup:delete-managed')(event, id)
  ].map(result => Promise.resolve(result)));
  const legitimateEvent = { sender: webContents, senderFrame: mainFrame };
  const legitimateResults = await invokeAll(legitimateEvent);
  assert.deepEqual(managerCalls, ['list', 'create', `copy:${id}`, `delete:${id}`]);
  assert.equal(legitimateResults.every(result => result.ok === true), true);
  assert.equal(JSON.stringify(legitimateResults).includes('MHU2-'), false);

  const foreignSender = { mainFrame: { url: expectedUrl }, getURL: () => expectedUrl, isDestroyed: () => false };
  const cases = [
    ['foreign sender', { sender: foreignSender, senderFrame: foreignSender.mainFrame }, () => {}],
    ['destroyed main window', legitimateEvent, () => { state.windowDestroyed = true; }],
    ['destroyed sender', legitimateEvent, () => { state.webContentsDestroyed = true; }],
    ['subframe', { sender: webContents, senderFrame: { url: expectedUrl } }, () => {}],
    ['remote URL', legitimateEvent, () => { state.frameUrl = 'https://example.invalid/renderer/index.html'; state.currentUrl = state.frameUrl; }],
    ['different local file', legitimateEvent, () => { state.frameUrl = pathToFileURL(path.join(projectRoot, 'renderer', 'drop-target.html')).href; state.currentUrl = state.frameUrl; }]
  ];

  for (const [name, event, arrange] of cases) {
    state.frameUrl = expectedUrl;
    state.currentUrl = expectedUrl;
    state.windowDestroyed = false;
    state.webContentsDestroyed = false;
    managerCalls.length = 0;
    arrange();
    const results = await invokeAll(event);
    assert.equal(managerCalls.length, 0, `${name} reached the manager`);
    assert.equal(results.every(result => result.ok === false), true, `${name} was not rejected`);
    assert.equal(JSON.stringify(results).includes('MHU2-'), false, `${name} leaked a complete key`);
  }
});

test('afterPack brands the executable metadata shown by Windows', async () => {
  let editCall = null;
  const originalLoad = Module._load;
  const afterPackPath = require.resolve('../scripts/afterPack.cjs');
  delete require.cache[afterPackPath];
  Module._load = function (request, parent, isMain) {
    if (request === 'rcedit') {
      return async (exePath, options) => { editCall = { exePath, options }; };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const afterPack = require(afterPackPath);
    await afterPack({
      appOutDir: 'C:\\release',
      packager: { appInfo: { productFilename: 'Multi-Hoster-Upload', version: '9.8.7' } }
    });
  } finally {
    Module._load = originalLoad;
    delete require.cache[afterPackPath];
  }

  assert.equal(editCall.exePath, path.join('C:\\release', 'Multi-Hoster-Upload.exe'));
  assert.equal(editCall.options['file-version'], '9.8.7');
  assert.equal(editCall.options['product-version'], '9.8.7');
  assert.deepEqual(editCall.options['version-string'], {
    CompanyName: 'Sucukdeluxe',
    FileDescription: 'Multi Hoster Uploader',
    InternalName: 'Multi-Hoster-Upload',
    OriginalFilename: 'Multi-Hoster-Upload.exe',
    ProductName: 'Multi Hoster Uploader'
  });
});

test('close readiness is signaled only after the renderer explicitly finishes initialization', () => {
  const listeners = new Map();
  const sent = [];
  let exposedApi = null;
  const electronMock = {
    contextBridge: {
      exposeInMainWorld: (_name, api) => { exposedApi = api; }
    },
    ipcRenderer: {
      invoke: () => Promise.resolve(),
      on: (channel, listener) => { listeners.set(channel, listener); },
      send: (...args) => { sent.push(args); },
      removeAllListeners: () => {}
    },
    webUtils: {
      getPathForFile: () => ''
    }
  };
  const originalLoad = Module._load;
  const preloadPath = require.resolve('../preload');
  delete require.cache[preloadPath];
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronMock;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    require(preloadPath);
  } finally {
    Module._load = originalLoad;
  }

  let closeAttempt = null;
  exposedApi.onPrepareClose(attempt => { closeAttempt = attempt; });
  assert.deepEqual(sent, []);

  listeners.get('app:prepare-close')({}, 7);
  assert.equal(closeAttempt, 7);
  assert.deepEqual(sent, [['app:close-preparation-started', 7]]);

  exposedApi.signalCloseHandshakeReady();
  assert.deepEqual(sent, [
    ['app:close-preparation-started', 7],
    ['app:close-handshake-ready']
  ]);
});

test('folder monitor readiness is emitted once and only after the candidate listener exists', () => {
  const order = [];
  const listeners = new Map();
  let exposedApi = null;
  const electronMock = {
    contextBridge: {
      exposeInMainWorld: (_name, api) => { exposedApi = api; }
    },
    ipcRenderer: {
      invoke: () => Promise.resolve(),
      on: (channel, listener) => {
        listeners.set(channel, listener);
        order.push(`listen:${channel}`);
      },
      send: channel => { order.push(`send:${channel}`); },
      removeAllListeners: () => {}
    },
    webUtils: {
      getPathForFile: () => ''
    }
  };
  const originalLoad = Module._load;
  const preloadPath = require.resolve('../preload');
  delete require.cache[preloadPath];
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronMock;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    require(preloadPath);
  } finally {
    Module._load = originalLoad;
  }

  exposedApi.signalFolderMonitorReady();
  let received = null;
  exposedApi.onFolderMonitorNewFiles(files => { received = files; });
  exposedApi.signalFolderMonitorReady();
  exposedApi.signalFolderMonitorReady();
  listeners.get('folder-monitor:new-files')({}, [{ path: 'C:\\watch\\ready.mkv' }]);

  assert.deepEqual(order, [
    'listen:folder-monitor:new-files',
    'send:folder-monitor:renderer-ready'
  ]);
  assert.deepEqual(received, [{ path: 'C:\\watch\\ready.mkv' }]);
});

test('preload exposes account cooldown snapshots and removes their listener during cleanup', async () => {
  const listeners = new Map();
  const invocations = [];
  const removed = [];
  let exposedApi = null;
  const electronMock = {
    contextBridge: {
      exposeInMainWorld: (_name, api) => { exposedApi = api; }
    },
    ipcRenderer: {
      invoke: (...args) => { invocations.push(args); return Promise.resolve({ version: 2, accounts: [] }); },
      on: (channel, listener) => { listeners.set(channel, listener); },
      send: () => {},
      removeAllListeners: channel => { removed.push(channel); }
    },
    webUtils: {
      getPathForFile: () => ''
    }
  };
  const originalLoad = Module._load;
  const preloadPath = require.resolve('../preload');
  delete require.cache[preloadPath];
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronMock;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    require(preloadPath);
  } finally {
    Module._load = originalLoad;
  }

  const snapshot = await exposedApi.getSessionFailedAccountStates();
  let pushed = null;
  exposedApi.onSessionFailedAccountsChanged(value => { pushed = value; });
  listeners.get('session-failed-accounts-changed')({}, { version: 2, accounts: [{ accountId: 'a1' }] });
  exposedApi.removeAllListeners();

  assert.deepEqual(snapshot, { version: 2, accounts: [] });
  assert.deepEqual(invocations, [['get-session-failed-account-states']]);
  assert.deepEqual(pushed, { version: 2, accounts: [{ accountId: 'a1' }] });
  assert.equal(removed.includes('session-failed-accounts-changed'), true);
});

test('exposes persistent automation controls and status through narrow IPC boundaries', () => {
  const preloadSource = fs.readFileSync(path.join(projectRoot, 'preload.js'), 'utf8');
  const mainSource = fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8');

  assert.match(mainSource, /ipcMain\.handle\('automation:get-status'/u);
  assert.match(mainSource, /ipcMain\.handle\('automation:pause-after-active'/u);
  assert.match(mainSource, /ipcMain\.handle\('automation:resume'/u);
  assert.match(mainSource, /ipcMain\.handle\('folder-monitor:test-scan'/u);
  assert.match(mainSource, /ipcMain\.handle\('folder-monitor:reconcile'/u);
  assert.match(mainSource, /safeSend\('automation:status'/u);
  assert.match(preloadSource, /automationGetStatus:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('automation:get-status'\)/u);
  assert.match(preloadSource, /automationPauseAfterActive:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('automation:pause-after-active'\)/u);
  assert.match(preloadSource, /automationResume:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('automation:resume'\)/u);
  assert.match(preloadSource, /folderMonitorTestScan:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('folder-monitor:test-scan'\)/u);
  assert.match(preloadSource, /folderMonitorReconcile:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('folder-monitor:reconcile'\)/u);
  assert.match(preloadSource, /onAutomationStatus:\s*\(callback\)\s*=>\s*\{[\s\S]*?ipcRenderer\.on\('automation:status'/u);
  assert.match(preloadSource, /ipcRenderer\.removeAllListeners\('automation:status'\)/u);
});

test('every batch start and extension IPC fails closed before account and cleanup side effects', () => {
  const mainSource = fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8');
  const gate = /configStore\.load\(\)\.globalSettings\?\.folderMonitor\?\.paused\s*===\s*true/u;
  const cases = [
    ['debug-test-upload', "ipcMain.handle('debug-test-upload'", "ipcMain.handle('select-folder'", 'fs.writeFileSync'],
    ['start-upload', "ipcMain.handle('start-upload'", '\n// Logged at batch boundaries', 'makeAccountPicker'],
    ['add-jobs-to-batch', "ipcMain.handle('add-jobs-to-batch'", "ipcMain.handle('finish-after-active'", 'makeAccountPicker']
  ];

  for (const [channel, startMarker, endMarker, sideEffectMarker] of cases) {
    const start = mainSource.indexOf(startMarker);
    const end = mainSource.indexOf(endMarker, start);
    assert.notEqual(start, -1, `${channel} handler missing`);
    assert.notEqual(end, -1, `${channel} handler boundary missing`);
    const handler = mainSource.slice(start, end);
    const gateIndex = handler.search(gate);
    const sideEffectIndex = handler.indexOf(sideEffectMarker);
    assert.notEqual(gateIndex, -1, `${channel} pause gate missing`);
    assert.notEqual(sideEffectIndex, -1, `${channel} side-effect marker missing`);
    assert.ok(gateIndex < sideEffectIndex, `${channel} pause gate runs after side effects`);
  }
});

test('automation pause save commits before lifecycle effects and save failure is inert', async () => {
  const mainSource = fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8');
  const blockStart = Math.max(
    mainSource.indexOf('let suppressAutomationStatusEvents = false;'),
    mainSource.indexOf('const automationLifecycleQueue = [];')
  );
  const blockEnd = mainSource.indexOf('\n// --- Remote Control ---', blockStart);
  assert.notEqual(blockStart, -1, 'automation lifecycle block missing');
  assert.notEqual(blockEnd, -1, 'automation lifecycle block boundary missing');
  const handlers = new Map();
  const order = [];
  const sent = [];
  const folderMonitor = new (require('node:events').EventEmitter)();
  folderMonitor.running = true;
  folderMonitor.status = () => ({ running: folderMonitor.running, paused: !folderMonitor.running, reachable: true });
  folderMonitor.stop = () => { folderMonitor.running = false; order.push('stop'); };
  folderMonitor.configure = () => { folderMonitor.running = false; order.push('configure'); return { paused: true }; };
  folderMonitor.start = () => { folderMonitor.running = true; order.push('start'); folderMonitor.emit('status'); return {}; };
  folderMonitor.pause = async () => { folderMonitor.running = false; order.push('pause'); folderMonitor.emit('status'); };
  folderMonitor.resume = async () => { folderMonitor.running = true; order.push('resume'); folderMonitor.emit('status'); return { reachable: true }; };
  folderMonitor.scan = async options => { order.push(`scan:${options.trigger}:${options.emitFiles}`); return { reachable: true }; };
  let state = {
    globalSettings: {
      folderMonitor: {
        enabled: true,
        folderPath: 'C:\\watch',
        paused: false,
        pausedAt: null,
        queueLimitJobs: 15000,
        reconcileIntervalMinutes: 5
      }
    }
  };
  let rejectSave = false;
  const configStore = {
    load: () => structuredClone(state),
    save: async config => {
      const paused = config.globalSettings.folderMonitor.paused;
      order.push(`save:${paused}`);
      if (rejectSave) throw new Error('save failed');
      state = structuredClone(config);
    }
  };
  const uploadManager = {
    finishAfterActive: () => order.push('finish'),
    startBatch: () => order.push('startBatch')
  };
  vm.runInNewContext(mainSource.slice(blockStart, blockEnd), {
    configStore,
    debugLog: () => {},
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    folderMonitor,
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    normalizeAutomationSettings: require('../lib/automation-control').normalizeAutomationSettings,
    path,
    safeSend: (channel, snapshot) => { sent.push([channel, snapshot]); return true; },
    uploadManager
  });

  await handlers.get('automation:pause-after-active')();
  assert.deepEqual(order, ['save:true', 'pause', 'finish']);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], 'automation:status');
  assert.equal(sent[0][1].paused, true);

  order.length = 0;
  sent.length = 0;
  state.globalSettings.folderMonitor.paused = false;
  state.globalSettings.folderMonitor.pausedAt = null;
  folderMonitor.running = true;
  rejectSave = true;
  await assert.rejects(handlers.get('automation:pause-after-active')(), /save failed/u);
  assert.deepEqual(order, ['save:true']);
  assert.equal(folderMonitor.running, true);
  assert.equal(sent.length, 0);

  order.length = 0;
  rejectSave = false;
  state.globalSettings.folderMonitor.paused = true;
  state.globalSettings.folderMonitor.pausedAt = 1;
  folderMonitor.running = false;
  await handlers.get('automation:resume')();
  assert.deepEqual(order, ['resume', 'save:false', 'scan:resume:true']);
  assert.equal(order.includes('startBatch'), false);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][1].paused, false);
});

test('automation lifecycle serializes pause then resume so the newer intent wins', async () => {
  const mainSource = fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8');
  const harness = createAutomationLifecycleHarness(mainSource);

  const pause = harness.handlers.get('automation:pause-after-active')();
  const resume = harness.handlers.get('automation:resume')();

  assert.equal(harness.saves.length, 1);
  assert.equal(harness.saves[0].paused, true);
  harness.saves[0].deferred.resolve();
  await flushMicrotasks();
  harness.pauseDeferred.resolve();
  await waitForCondition(() => harness.order.includes('resume'));
  harness.resumeDeferred.resolve();
  await waitForCondition(() => harness.saves.length === 2);
  assert.equal(harness.saves.length, 2);
  assert.equal(harness.saves[1].paused, false);
  harness.saves[1].deferred.resolve();
  await Promise.all([pause, resume]);

  assert.deepEqual(harness.order, ['save:true', 'pause', 'finish', 'resume', 'save:false', 'scan:resume:true']);
  assert.equal(harness.state().globalSettings.folderMonitor.paused, false);
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0][1].paused, false);
});

test('automation lifecycle serializes resume then pause so the newer intent wins', async () => {
  const mainSource = fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8');
  const harness = createAutomationLifecycleHarness(mainSource);

  const resume = harness.handlers.get('automation:resume')();
  const pause = harness.handlers.get('automation:pause-after-active')();

  assert.equal(harness.saves.length, 0);
  assert.deepEqual(harness.order, ['resume']);
  harness.resumeDeferred.resolve();
  await waitForCondition(() => harness.saves.length === 1);
  assert.equal(harness.saves[0].paused, false);
  harness.saves[0].deferred.resolve();
  await waitForCondition(() => harness.saves.length === 2);
  assert.equal(harness.saves.length, 2);
  assert.equal(harness.saves[1].paused, true);
  harness.saves[1].deferred.resolve();
  await flushMicrotasks();
  harness.pauseDeferred.resolve();
  await Promise.all([resume, pause]);

  assert.deepEqual(harness.order, ['resume', 'save:false', 'scan:resume:true', 'save:true', 'pause', 'finish']);
  assert.equal(harness.state().globalSettings.folderMonitor.paused, true);
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0][1].paused, true);
});

test('automation status suppression remains active until the serialized operation ends', async () => {
  const mainSource = fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8');
  const harness = createAutomationLifecycleHarness(mainSource);

  const pause = harness.handlers.get('automation:pause-after-active')();
  const resume = harness.handlers.get('automation:resume')();
  harness.saves[0].deferred.resolve();
  await waitForCondition(() => harness.order.includes('pause'));
  harness.pauseDeferred.resolve();
  await waitForCondition(() => harness.order.includes('resume'));
  harness.publishStatus();

  assert.equal(harness.sent.length, 0);

  harness.resumeDeferred.resolve();
  await waitForCondition(() => harness.saves.length === 2);
  harness.saves[1].deferred.resolve();
  await Promise.all([pause, resume]);

  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0][1].paused, false);
});

test('automation pause rejection still finishes active uploads and returns a sanitized monitor error', async () => {
  const mainSource = fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8');
  const harness = createAutomationLifecycleHarness(mainSource);

  const pause = harness.handlers.get('automation:pause-after-active')();
  harness.saves[0].deferred.resolve();
  await flushMicrotasks();
  harness.pauseDeferred.reject(new Error('token=secret-value'));
  const result = await pause;

  assert.equal(result.paused, true);
  assert.equal(result.monitorError, 'Ordnerüberwachung konnte nicht pausiert werden');
  assert.equal(JSON.stringify(result).includes('secret-value'), false);
  assert.equal(harness.order.includes('finish'), true);
  assert.equal(harness.sent.length, 1);
  assert.equal(JSON.stringify(harness.sent[0][1]).includes('secret-value'), false);
});

test('every folder monitor start obeys current persisted pause and active activation reconciles exactly once', async () => {
  const mainSource = fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8');
  const harness = createAutomationLifecycleHarness(mainSource);
  const settings = { folderPath: 'C:\\watch', enabled: true, paused: false, reconcileIntervalMinutes: '1' };

  const pausedResult = await harness.handlers.get('folder-monitor:start')(null, settings);
  assert.deepEqual({ ...pausedResult }, { error: 'Automatik ist pausiert' });
  assert.deepEqual(harness.order, ['configure']);
  assert.equal(harness.configuredSettings[0].reconcileIntervalMinutes, 5);

  harness.order.length = 0;
  harness.setFolderMonitorState({ paused: false, pausedAt: null, reconcileIntervalMinutes: '1' });
  const activeResult = await harness.handlers.get('folder-monitor:start')(null, settings);
  assert.deepEqual({ ...activeResult }, { ok: true, includesExisting: false });
  assert.deepEqual(harness.order, ['start', 'scan:startup:true']);
  assert.equal(harness.startedSettings[0].reconcileIntervalMinutes, 5);
  const status = harness.handlers.get('automation:get-status')();
  assert.equal(status.reconcileIntervalMinutes, 5);
  assert.equal(status.startedAt, 100);
  assert.equal(status.nextReconcileAt, 200);
});

test('resume keeps pause authoritative until monitor success and restores the previous pause after rejection', async () => {
  const mainSource = fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8');
  const harness = createAutomationLifecycleHarness(mainSource);
  let settled = false;
  const resume = harness.handlers.get('automation:resume')();
  const outcome = resume.then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
  await flushMicrotasks();
  const pendingState = harness.state().globalSettings.folderMonitor;
  const savesBeforeResolution = harness.saves.length;
  const orderBeforeResolution = [...harness.order];
  if (harness.saves[0]) harness.saves[0].deferred.resolve();
  await waitForCondition(() => harness.order.includes('resume'));
  harness.resumeDeferred.reject(new Error('token=resume-secret'));
  for (let attempt = 0; attempt < 50 && !settled; attempt++) {
    for (const save of harness.saves) save.deferred.resolve();
    await Promise.resolve();
  }
  const result = await outcome;

  assert.equal(savesBeforeResolution, 0);
  assert.deepEqual(orderBeforeResolution, ['resume']);
  assert.equal(pendingState.paused, true);
  assert.equal(pendingState.pausedAt, 1);
  assert.equal(result.error, undefined);
  assert.equal(result.value.error, 'Automatik konnte nicht fortgesetzt werden');
  assert.equal(result.value.paused, true);
  assert.equal(result.value.pausedAt, 1);
  assert.deepEqual(harness.saves.map(save => save.paused), [true]);
  assert.deepEqual(harness.order, ['resume', 'stop', 'configure', 'save:true']);
  assert.equal(harness.state().globalSettings.folderMonitor.paused, true);
  assert.equal(harness.state().globalSettings.folderMonitor.pausedAt, 1);
  assert.equal(JSON.stringify(result.value).includes('resume-secret'), false);
});

test('prepared upload start waits for the final tick and clears recovery when pause wins', async () => {
  const mainSource = fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8');
  const blockStart = mainSource.indexOf('async function rejectPreparedUploadStart');
  const blockEnd = mainSource.indexOf("\nipcMain.handle('start-upload'", blockStart);
  assert.notEqual(blockStart, -1, 'prepared upload start block missing');
  assert.notEqual(blockEnd, -1, 'prepared upload start block boundary missing');
  const ticks = [];
  const recoverySave = createDeferred();
  const writes = [];
  let paused = false;
  let cancelled = 0;
  let finished = 0;
  let started = 0;
  const manager = {
    cancel: () => { cancelled++; },
    startBatch: () => { started++; return new Promise(() => {}); }
  };
  const context = {
    _accountCooldowns: { activeKeys: () => [], releaseExpired: () => {} },
    _sessionAccountOverrides: new Map(),
    closeFlushRequested: false,
    configStore: {
      load: () => ({ globalSettings: { folderMonitor: { paused } } }),
      saveUploadRecovery: value => {
        writes.push(value);
        return value === null ? Promise.resolve() : recoverySave.promise;
      }
    },
    debugLog: () => {},
    globalThis: {},
    isAllAborted: () => false,
    logMemorySnapshot: () => {},
    queueMicrotask,
    safeSend: () => {},
    sendBatchWebhook: () => {},
    setImmediate: callback => { ticks.push(callback); },
    uploadManager: manager
  };
  vm.runInNewContext(mainSource.slice(blockStart, blockEnd), context);
  const producerTracker = { finish: () => { finished++; } };
  const start = context.startPreparedUploadBatch({
    manager,
    tasks: [{ jobId: 'job-1' }],
    producerTracker,
    recovery: { id: 'recovery-1' },
    isAutoRetry: false
  });
  let settled = false;
  start.then(() => { settled = true; });

  assert.equal(settled, false);
  assert.equal(ticks.length, 1);
  ticks.shift()();
  await flushMicrotasks();
  assert.deepEqual(writes, [{ id: 'recovery-1' }]);
  paused = true;
  recoverySave.resolve();
  const result = await start;

  assert.equal(result.error, 'Automatik ist pausiert');
  assert.equal(Object.hasOwn(result, 'started'), false);
  assert.deepEqual(writes, [{ id: 'recovery-1' }, null]);
  assert.equal(cancelled, 1);
  assert.equal(finished, 1);
  assert.equal(started, 0);
  assert.equal(context.uploadManager, null);
});

test('prepared upload start returns success only after synchronous acceptance and cleans immediate rejection', async () => {
  const mainSource = fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8');
  const blockStart = mainSource.indexOf('async function rejectPreparedUploadStart');
  const blockEnd = mainSource.indexOf("\nipcMain.handle('start-upload'", blockStart);
  assert.notEqual(blockStart, -1, 'prepared upload start block missing');
  assert.notEqual(blockEnd, -1, 'prepared upload start block boundary missing');

  async function run(mode) {
    const ticks = [];
    const writes = [];
    let cancelled = 0;
    let finished = 0;
    const manager = { cancel: () => { cancelled++; } };
    const context = {
      _accountCooldowns: { activeKeys: () => [], releaseExpired: () => {} },
      _sessionAccountOverrides: new Map(),
      closeFlushRequested: false,
      configStore: {
        load: () => ({ globalSettings: { folderMonitor: { paused: false } } }),
        saveUploadRecovery: value => { writes.push(value); return Promise.resolve(); }
      },
      debugLog: () => {},
      globalThis: {},
      isAllAborted: () => false,
      logMemorySnapshot: () => {},
      queueMicrotask,
      safeSend: () => {},
      sendBatchWebhook: () => {},
      setImmediate: callback => { ticks.push(callback); },
      uploadManager: manager
    };
    vm.runInNewContext(mainSource.slice(blockStart, blockEnd), context);
    vm.runInNewContext(
      mode === 'rejected'
        ? "uploadManager.startBatch = () => Promise.reject(new Error('apiKey=secret-value'));"
        : 'uploadManager.startBatch = () => new Promise(() => {});',
      context
    );
    const promise = context.startPreparedUploadBatch({
      manager,
      tasks: [{ jobId: 'job-1' }],
      producerTracker: { finish: () => { finished++; } },
      recovery: { id: 'recovery-1' },
      isAutoRetry: false
    });
    ticks.shift()();
    const result = await promise;
    return { cancelled, context, finished, result, writes };
  }

  const accepted = await run('pending');
  assert.equal(accepted.result.started, true);
  assert.equal(Object.hasOwn(accepted.result, 'error'), false);
  assert.deepEqual(accepted.writes, [{ id: 'recovery-1' }]);
  assert.equal(accepted.cancelled, 0);
  assert.equal(accepted.finished, 0);

  const rejected = await run('rejected');
  assert.equal(rejected.result.error, 'Upload konnte nicht gestartet werden');
  assert.equal(Object.hasOwn(rejected.result, 'started'), false);
  assert.deepEqual(rejected.writes, [{ id: 'recovery-1' }, null]);
  assert.equal(rejected.cancelled, 1);
  assert.equal(rejected.finished, 1);
  assert.equal(rejected.context.uploadManager, null);
  assert.equal(JSON.stringify(rejected.result).includes('secret-value'), false);
});

test('startup keeps a missing configured folder disconnected without disabling automation', () => {
  const mainSource = fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8');
  const startupStart = mainSource.indexOf('app.whenReady().then(async () => {');
  const startupEnd = mainSource.indexOf("\napp.on('window-all-closed'", startupStart);
  assert.notEqual(startupStart, -1);
  assert.notEqual(startupEnd, -1);
  const startup = mainSource.slice(startupStart, startupEnd);

  assert.match(startup, /fm\s*&&\s*fm\.enabled\s*&&\s*fm\.folderPath[\s\S]*?await startFolderMonitor\(fm,\s*\{\s*deferStartupReconcile:\s*true\s*\}\)/u);
  assert.doesNotMatch(startup, /fm\.paused\s*!==\s*true/u);
  assert.doesNotMatch(startup, /folderMonitor\.scan\(\{\s*emitFiles:\s*true,\s*trigger:\s*'startup'\s*\}\)/u);
  assert.doesNotMatch(startup, /folderMonitor:\s*\{\s*\.\.\.fm,\s*enabled:\s*false\s*\}/u);
});
