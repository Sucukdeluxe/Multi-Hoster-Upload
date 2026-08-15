const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { installHiddenElectronWindowHarness } = require('./support/hidden-electron-window');

test('every Electron UI smoke window stays offscreen without native reveal or focus paths', () => {
  const nativeCalls = [];
  class TestBrowserWindow {
    constructor(options) {
      this.options = options;
    }
    show() { nativeCalls.push('show'); }
    showInactive() { nativeCalls.push('showInactive'); }
    focus() { nativeCalls.push('focus'); }
    restore() { nativeCalls.push('restore'); }
    moveTop() { nativeCalls.push('moveTop'); }
    setAlwaysOnTop(value) { nativeCalls.push(`setAlwaysOnTop:${value}`); }
    setIgnoreMouseEvents(value) { this.ignoresMouse = value; }
    isVisible() { return false; }
    isFocused() { return false; }
  }

  const targetGlobal = {};
  const harness = installHiddenElectronWindowHarness({
    BrowserWindow: TestBrowserWindow,
    targetGlobal
  });
  const windows = [
    new targetGlobal.__mhuBrowserWindowConstructor({
      show: true,
      focusable: true,
      skipTaskbar: false,
      alwaysOnTop: true,
      webPreferences: { contextIsolation: true }
    }),
    new targetGlobal.__mhuBrowserWindowConstructor({ alwaysOnTop: true }),
    new targetGlobal.__mhuBrowserWindowConstructor({ show: true })
  ];

  windows[0].show();
  windows[1].showInactive();
  windows[2].focus();
  windows[0].restore();
  windows[1].moveTop();
  windows[2].setAlwaysOnTop(true);

  assert.deepEqual(windows[0].options, {
    show: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: false,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      contextIsolation: true,
      offscreen: true,
      backgroundThrottling: false
    }
  });
  assert.equal(windows.every(window => window.options.show === false && window.options.alwaysOnTop === false && window.ignoresMouse === true), true);
  assert.deepEqual(nativeCalls, []);
  assert.equal(harness.isAlwaysOnTopRequested(windows[2]), true);
  assert.equal(harness.isNativeSurfaceSuppressed({ isVisible: () => false, isFocused: () => false }), true);
  assert.equal(harness.areNativeSurfacesSuppressed(windows), true);
  assert.deepEqual(harness.getWindows(), windows);
});

test('Main routes every BrowserWindow construction through the hidden test constructor', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.doesNotMatch(source, /new BrowserWindow\s*\(/u);
  assert.equal((source.match(/RuntimeBrowserWindow/g) || []).length >= 4, true);
});

test('UI smoke never constructs an original BrowserWindow', () => {
  const source = fs.readFileSync(path.join(__dirname, 'ui-smoke.js'), 'utf8');
  assert.doesNotMatch(source, /new BrowserWindow\s*\(/u);
  assert.doesNotMatch(source, /BrowserWindow\.getAllWindows\(\)/u);
  assert.equal((source.match(/areNativeSurfacesSuppressed/g) || []).length >= 2, true);
});
