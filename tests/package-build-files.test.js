const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const packageJson = require('../package.json');

test('packages every Electron preload referenced by the main process', () => {
  assert.ok(packageJson.build.files.includes('preload.js'));
  assert.ok(packageJson.build.files.includes('preload-drop-target.js'));
  assert.equal(packageJson.build.win.signAndEditExecutable, false);
});

test('packaged identity is exact while public artifact routing remains stable', () => {
  assert.equal(packageJson.build.productName, 'Multi Hoster Uploader');
  assert.equal(packageJson.build.win.executableName, 'Multi Hoster Uploader');
  assert.equal(packageJson.build.nsis.artifactName, 'Multi-Hoster-Upload Setup ${version}.${ext}');
  assert.equal(packageJson.build.portable.artifactName, 'Multi-Hoster-Upload ${version}.${ext}');

  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(source, /app\.setPath\('userData', path\.join\(app\.getPath\('appData'\), 'multi-hoster-uploader'\)\)/);
  assert.match(source, /app\.setName\('Multi Hoster Uploader'\)/);
  assert.match(source, /app\.setAppUserModelId\('com\.multihoster\.uploader'\)/);
  assert.doesNotMatch(source, /updateTrayTooltip\('Multi-Hoster-Upload'\)/);
});

test('floating drop target resolves native paths through Electron webUtils', () => {
  let exposedApi = null;
  const nativeFile = { name: 'fixture.mkv' };
  const electronMock = {
    contextBridge: {
      exposeInMainWorld: (_name, api) => { exposedApi = api; }
    },
    ipcRenderer: {
      send: () => {}
    },
    webUtils: {
      getPathForFile: file => file === nativeFile ? 'C:\\fixtures\\fixture.mkv' : ''
    }
  };
  const originalLoad = Module._load;
  const preloadPath = require.resolve('../preload-drop-target');
  delete require.cache[preloadPath];
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronMock;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    require(preloadPath);
  } finally {
    Module._load = originalLoad;
    delete require.cache[preloadPath];
  }

  assert.equal(typeof exposedApi.getPathForFile, 'function');
  assert.equal(exposedApi.getPathForFile(nativeFile), 'C:\\fixtures\\fixture.mkv');
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
      packager: { appInfo: { productFilename: 'Multi Hoster Uploader', version: '9.8.7' } }
    });
  } finally {
    Module._load = originalLoad;
    delete require.cache[afterPackPath];
  }

  assert.equal(editCall.exePath, path.join('C:\\release', 'Multi Hoster Uploader.exe'));
  assert.equal(editCall.options['file-version'], '9.8.7');
  assert.equal(editCall.options['product-version'], '9.8.7');
  assert.deepEqual(editCall.options['version-string'], {
    CompanyName: 'Sucukdeluxe',
    FileDescription: 'Multi Hoster Uploader',
    InternalName: 'Multi Hoster Uploader',
    OriginalFilename: 'Multi Hoster Uploader.exe',
    ProductName: 'Multi Hoster Uploader'
  });
});

test('afterPack fails the build when executable branding fails', async () => {
  const originalLoad = Module._load;
  const afterPackPath = require.resolve('../scripts/afterPack.cjs');
  delete require.cache[afterPackPath];
  Module._load = function (request, parent, isMain) {
    if (request === 'rcedit') return async () => { throw new Error('branding failed'); };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const afterPack = require(afterPackPath);
    await assert.rejects(afterPack({
      appOutDir: 'C:\\release',
      packager: { appInfo: { productFilename: 'Multi Hoster Uploader', version: '9.8.7' } }
    }), /branding failed/);
  } finally {
    Module._load = originalLoad;
    delete require.cache[afterPackPath];
  }
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
  exposedApi.signalRendererInitializationFailed({ message: 'init failed' });
  assert.deepEqual(sent, [
    ['app:close-preparation-started', 7],
    ['app:close-handshake-ready'],
    ['app:renderer-initialization-failed', { message: 'init failed' }]
  ]);
});
