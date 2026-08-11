const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const FolderMonitor = require('../lib/folder-monitor');

function createHarness() {
  const calls = [];
  const watch = (folderPath, options) => {
    const watcher = new EventEmitter();
    watcher.close = async () => {};
    calls.push({ folderPath, options, watcher });
    return watcher;
  };
  return { calls, monitor: new FolderMonitor({ watch }) };
}

test('existing files are included only on the first start of the same watch scope', () => {
  const { calls, monitor } = createHarness();
  const settings = { folderPath: 'C:\\incoming', includeExisting: true, recursive: false };
  monitor.start(settings);
  monitor.start(settings);
  assert.equal(calls[0].options.ignoreInitial, false);
  assert.equal(calls[1].options.ignoreInitial, true);
});

test('existing files remain ignored unless the option is enabled', () => {
  const { calls, monitor } = createHarness();
  monitor.start({ folderPath: 'C:\\incoming', includeExisting: false, recursive: false });
  monitor.start({ folderPath: 'C:\\incoming', includeExisting: true, recursive: false });
  assert.equal(calls[0].options.ignoreInitial, true);
  assert.equal(calls[1].options.ignoreInitial, false);
});

test('a changed folder or filter creates a new initial scope', () => {
  const { calls, monitor } = createHarness();
  monitor.start({ folderPath: 'C:\\incoming', includeExisting: true, recursive: false, extensions: 'mp4' });
  monitor.start({ folderPath: 'D:\\incoming', includeExisting: true, recursive: false, extensions: 'mp4' });
  monitor.start({ folderPath: 'D:\\incoming', includeExisting: true, recursive: false, extensions: 'mkv' });
  assert.deepEqual(calls.map(call => call.options.ignoreInitial), [false, false, false]);
});

test('initial scan completion is exposed so the one-time option can be persisted as consumed', () => {
  const { calls, monitor } = createHarness();
  let completed = 0;
  monitor.on('initial-scan-complete', () => { completed++; });
  monitor.start({ folderPath: 'C:\\incoming', includeExisting: true, recursive: false });
  calls[0].watcher.emit('ready');
  calls[0].watcher.emit('ready');
  assert.equal(completed, 1);
});
