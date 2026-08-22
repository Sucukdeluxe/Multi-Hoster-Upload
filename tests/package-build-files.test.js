const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const packageJson = require('../package.json');

const projectRoot = path.join(__dirname, '..');

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
