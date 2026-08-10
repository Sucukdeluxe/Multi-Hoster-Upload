const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
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
