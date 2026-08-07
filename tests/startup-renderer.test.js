const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { configureStartupRenderer, createStartupWindow } = require('../lib/startup-renderer');

class TestBrowserWindow extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.showCalls = 0;
    this.startupEvents = [];
    this.loadError = new Error('renderer load failed');
  }

  once(eventName, listener) {
    this.startupEvents.push(`listen:${eventName}`);
    return super.once(eventName, listener);
  }

  show() {
    this.showCalls++;
  }

  loadFile(target) {
    this.startupEvents.push(`load:${target}`);
    return Promise.reject(this.loadError);
  }
}

test('configureStartupRenderer disables hardware acceleration', () => {
  let calls = 0;
  configureStartupRenderer({ disableHardwareAcceleration() { calls++; } });
  assert.equal(calls, 1);
});

test('createStartupWindow forces the main window to start hidden', () => {
  const startup = createStartupWindow(TestBrowserWindow, { width: 1100, show: true });

  assert.equal(startup.window.options.width, 1100);
  assert.equal(startup.window.options.show, false);
});

test('startup load registers visibility before navigation and shows only once', async () => {
  const startup = createStartupWindow(TestBrowserWindow, {});
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
