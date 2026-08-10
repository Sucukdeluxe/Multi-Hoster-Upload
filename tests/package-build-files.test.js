const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const packageJson = require('../package.json');

test('packages every Electron preload referenced by the main process', () => {
  assert.ok(packageJson.build.files.includes('preload.js'));
  assert.ok(packageJson.build.files.includes('preload-drop-target.js'));
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
