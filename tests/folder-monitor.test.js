const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const FolderMonitor = require('../lib/folder-monitor');

function createWatcherHarness() {
  const calls = [];
  const timers = createManualTimers();
  const watch = (folderPath, options) => {
    const watcher = new EventEmitter();
    watcher.close = async () => {};
    calls.push({ folderPath, options, watcher });
    return watcher;
  };
  return { calls, monitor: new FolderMonitor({ watch, ...timers }) };
}

function createManualTimers() {
  const intervals = new Set();
  const timeouts = new Set();
  return {
    setIntervalFn(callback) {
      intervals.add(callback);
      return callback;
    },
    clearIntervalFn(callback) {
      intervals.delete(callback);
    },
    setTimeoutFn(callback) {
      timeouts.add(callback);
      return callback;
    },
    clearTimeoutFn(callback) {
      timeouts.delete(callback);
    },
    async runInterval() {
      for (const callback of [...intervals]) await callback();
    }
  };
}

function createSilentWatch() {
  return () => {
    const watcher = new EventEmitter();
    watcher.close = async () => {};
    return watcher;
  };
}

function createScanHarness({ files = [] } = {}) {
  const events = { newFiles: [], statuses: [] };
  const timers = createManualTimers();
  const stats = new Map(files.map((file) => [file.path, { mtimeMs: file.mtimeMs }]));
  const monitor = new FolderMonitor({
    watch: createSilentWatch(),
    walkFolder: async () => files.map(({ path: filePath, name, size }) => ({ path: filePath, name, size })),
    access: async () => {},
    stat: async (filePath) => stats.get(filePath),
    now: () => 1234,
    ...timers
  });
  monitor.on('new-files', (paths) => events.newFiles.push(paths));
  monitor.on('status', (status) => events.statuses.push(status));
  return { monitor, events, runInterval: timers.runInterval };
}

function createDeferredScanHarness() {
  let calls = 0;
  let releaseFirstScan;
  const timers = createManualTimers();
  const firstScan = new Promise((resolve) => { releaseFirstScan = resolve; });
  const monitor = new FolderMonitor({
    watch: createSilentWatch(),
    access: async () => {},
    stat: async () => ({ mtimeMs: 1 }),
    walkFolder: async () => {
      calls++;
      if (calls === 1) await firstScan;
      return [];
    },
    ...timers
  });
  monitor.start({ folderPath: 'C:\\incoming', reconcileIntervalMinutes: 5 });
  return { monitor, releaseFirstScan, scanCalls: () => calls };
}

function createReachabilityHarness(initiallyReachable) {
  let reachable = initiallyReachable;
  let calls = 0;
  const statusEvents = [];
  const timers = createManualTimers();
  const monitor = new FolderMonitor({
    watch: createSilentWatch(),
    access: async () => {
      if (!reachable) throw new Error('unreachable');
    },
    walkFolder: async () => {
      calls++;
      return [];
    },
    stat: async () => ({ mtimeMs: 1 }),
    ...timers
  });
  monitor.on('status', (status) => statusEvents.push(status));
  return {
    monitor,
    setReachable(value) { reachable = value; },
    statusEvents,
    scanCalls: () => calls,
    runInterval: timers.runInterval
  };
}

test('existing files are included only on the first start of the same watch scope', () => {
  const { calls, monitor } = createWatcherHarness();
  const settings = { folderPath: 'C:\\incoming', includeExisting: true, recursive: false };
  monitor.start(settings);
  monitor.start(settings);
  assert.equal(calls[0].options.ignoreInitial, false);
  assert.equal(calls[1].options.ignoreInitial, true);
});

test('existing files remain ignored unless the option is enabled', () => {
  const { calls, monitor } = createWatcherHarness();
  monitor.start({ folderPath: 'C:\\incoming', includeExisting: false, recursive: false });
  monitor.start({ folderPath: 'C:\\incoming', includeExisting: true, recursive: false });
  assert.equal(calls[0].options.ignoreInitial, true);
  assert.equal(calls[1].options.ignoreInitial, false);
});

test('a changed folder or filter creates a new initial scope', () => {
  const { calls, monitor } = createWatcherHarness();
  monitor.start({ folderPath: 'C:\\incoming', includeExisting: true, recursive: false, extensions: 'mp4' });
  monitor.start({ folderPath: 'D:\\incoming', includeExisting: true, recursive: false, extensions: 'mp4' });
  monitor.start({ folderPath: 'D:\\incoming', includeExisting: true, recursive: false, extensions: 'mkv' });
  assert.deepEqual(calls.map(call => call.options.ignoreInitial), [false, false, false]);
});

test('initial scan completion is exposed so the one-time option can be persisted as consumed', () => {
  const { calls, monitor } = createWatcherHarness();
  let completed = 0;
  monitor.on('initial-scan-complete', () => { completed++; });
  monitor.start({ folderPath: 'C:\\incoming', includeExisting: true, recursive: false });
  calls[0].watcher.emit('ready');
  calls[0].watcher.emit('ready');
  assert.equal(completed, 1);
});

test('dry scan returns matching descriptors without emitting new files', async () => {
  const { monitor, events } = createScanHarness({
    files: [
      { path: 'C:\\incoming\\a.mkv', name: 'a.mkv', size: 10, mtimeMs: 1 },
      { path: 'C:\\incoming\\b.txt', name: 'b.txt', size: 10, mtimeMs: 2 }
    ]
  });
  monitor.start({ folderPath: 'C:\\incoming', extensions: 'mkv', filterMode: 'include', recursive: true, reconcileIntervalMinutes: 5 });
  const result = await monitor.scan({ emitFiles: false, trigger: 'test' });
  assert.deepEqual(result.files, [{ path: 'C:\\incoming\\a.mkv', name: 'a.mkv', size: 10, mtimeMs: 1 }]);
  assert.equal(events.newFiles.length, 0);
});

test('overlapping reconcile requests serialize and collapse to one follow-up scan', async () => {
  const { monitor, releaseFirstScan, scanCalls } = createDeferredScanHarness();
  const first = monitor.scan({ emitFiles: true, trigger: 'interval' });
  const second = monitor.scan({ emitFiles: true, trigger: 'reconnect' });
  const third = monitor.scan({ emitFiles: true, trigger: 'manual' });
  releaseFirstScan();
  await Promise.all([first, second, third]);
  assert.equal(scanCalls(), 2);
});

test('disconnect preserves configuration and reconnect performs one immediate scan', async () => {
  const { monitor, setReachable, statusEvents, scanCalls, runInterval } = createReachabilityHarness(false);
  monitor.start({ folderPath: 'Z:\\watch', reconcileIntervalMinutes: 5 });
  await runInterval();
  assert.equal(statusEvents.at(-1).reachable, false);
  assert.equal(monitor.status().folderPath, 'Z:\\watch');
  setReachable(true);
  await runInterval();
  assert.equal(statusEvents.at(-1).reachable, true);
  assert.equal(scanCalls(), 1);
});

test('reachable reconciliation intervals scan the configured folder', async () => {
  const { monitor, runInterval, scanCalls } = createReachabilityHarness(true);
  monitor.start({ folderPath: 'C:\\watch', reconcileIntervalMinutes: 5 });
  await runInterval();
  await runInterval();
  assert.equal(scanCalls(), 2);
});

test('pause stops watcher and reconciliation until explicit resume', async () => {
  const { monitor, runInterval, scanCalls } = createReachabilityHarness(true);
  monitor.start({ folderPath: 'C:\\watch', reconcileIntervalMinutes: 5 });
  await monitor.pause();
  await runInterval();
  assert.equal(scanCalls(), 0);
  assert.equal(monitor.status().paused, true);
  await monitor.resume({ folderPath: 'C:\\watch', reconcileIntervalMinutes: 5 });
  assert.equal(scanCalls(), 1);
  assert.equal(monitor.status().paused, false);
});

test('stop emits an immutable non-running status snapshot', () => {
  const { monitor } = createWatcherHarness();
  const statuses = [];
  monitor.on('status', (status) => statuses.push(status));
  monitor.start({ folderPath: 'C:\\watch', reconcileIntervalMinutes: 5 });
  const statusCount = statuses.length;
  monitor.stop();
  assert.equal(statuses.length, statusCount + 1);
  assert.equal(statuses.at(-1).running, false);
  assert.equal(Object.isFrozen(statuses.at(-1)), true);
});

test('real temporary folder scan survives disconnect and reconnect', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mhu-automation-folder-'));
  const detached = `${root}-detached`;
  try {
    fs.mkdirSync(path.join(root, 'nested'));
    fs.writeFileSync(path.join(root, 'a.mkv'), Buffer.from('a'));
    fs.writeFileSync(path.join(root, 'ignored.txt'), Buffer.from('b'));
    fs.writeFileSync(path.join(root, 'nested', 'c.mkv'), Buffer.from('c'));
    const monitor = new FolderMonitor();
    monitor.start({ folderPath: root, recursive: true, extensions: 'mkv', filterMode: 'include', reconcileIntervalMinutes: 5 });
    const first = await monitor.scan({ emitFiles: false, trigger: 'test' });
    assert.deepEqual(first.files.map((file) => file.name).sort(), ['a.mkv', 'c.mkv']);
    assert.equal(first.files.every((file) => Number.isFinite(file.mtimeMs)), true);
    fs.renameSync(root, detached);
    const disconnected = await monitor.scan({ emitFiles: false, trigger: 'interval' });
    assert.equal(disconnected.reachable, false);
    fs.renameSync(detached, root);
    const reconnected = await monitor.scan({ emitFiles: false, trigger: 'interval' });
    assert.equal(reconnected.reachable, true);
    assert.equal(reconnected.reconnected, true);
    await monitor.pause();
  } finally {
    if (fs.existsSync(detached)) fs.renameSync(detached, root);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
