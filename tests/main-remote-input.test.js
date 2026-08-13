const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadRemoteInputHandler(sendInputEvent, debugLog = () => {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const handlerStart = source.indexOf("ipcMain.on('remote:input-event'");
  const handlerEnd = source.indexOf('\nfunction buildModifiers', handlerStart);
  const modifiersEnd = source.indexOf('\n// IPC: Get capture source ID', handlerEnd);
  assert.notEqual(handlerStart, -1);
  assert.notEqual(handlerEnd, -1);
  assert.notEqual(modifiersEnd, -1);

  let inputHandler;
  const mainWindow = {
    isDestroyed: () => false,
    getBounds: () => ({ x: 0, y: 0, width: 1100, height: 750 }),
    getContentBounds: () => ({ x: 7, y: 30, width: 1086, height: 713 }),
    webContents: { sendInputEvent }
  };
  const context = vm.createContext({
    ipcMain: {
      on(channel, handler) {
        if (channel === 'remote:input-event') inputHandler = handler;
      }
    },
    mainWindow,
    configStore: {
      load: () => ({ globalSettings: { remote: { allowInput: true } } })
    },
    debugLog,
    process: { platform: 'win32' },
    isFinite
  });

  vm.runInContext(source.slice(handlerStart, handlerEnd) + source.slice(handlerEnd, modifiersEnd), context);
  assert.equal(typeof inputHandler, 'function');
  return inputHandler;
}

test('authenticated keyboard input without a string key is discarded without throwing', () => {
  const sent = [];
  const logs = [];
  const handler = loadRemoteInputHandler(event => sent.push(event), (...args) => logs.push(args));
  const invalidPayloads = [
    { role: 'admin', type: 'keydown' },
    { role: 'admin', type: 'keydown', key: null },
    { role: 'admin', type: 'keydown', key: 1 },
    { role: 'admin', type: 'keydown', key: '' },
    { role: 'admin', type: 'keyup' },
    { role: 'admin', type: 'keyup', key: {} }
  ];

  for (const payload of invalidPayloads) {
    assert.doesNotThrow(() => handler({}, payload));
  }

  assert.deepEqual(sent, []);
  assert.deepEqual(logs, []);
});

test('authenticated keyboard input with a string key keeps normal keydown and keyup behavior', () => {
  const sent = [];
  const handler = loadRemoteInputHandler(event => sent.push(event));

  handler({}, { role: 'admin', type: 'keydown', key: 'a', ctrl: true });
  handler({}, { role: 'admin', type: 'keyup', key: 'a', ctrl: true });

  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [
    { type: 'keyDown', keyCode: 'a', modifiers: ['control'] },
    { type: 'char', keyCode: 'a', modifiers: ['control'] },
    { type: 'keyUp', keyCode: 'a', modifiers: ['control'] }
  ]);
});
