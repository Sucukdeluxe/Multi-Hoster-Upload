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
    },
    async runTimeouts() {
      for (const callback of [...timeouts]) {
        timeouts.delete(callback);
        await callback();
      }
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

test('pause invalidates a running scan before it can publish late state or files', async () => {
  let releaseWalk;
  let markWalkStarted;
  const walkPending = new Promise((resolve) => { releaseWalk = resolve; });
  const walkStarted = new Promise((resolve) => { markWalkStarted = resolve; });
  const timers = createManualTimers();
  const statuses = [];
  const newFiles = [];
  const monitor = new FolderMonitor({
    watch: createSilentWatch(),
    access: async () => {},
    walkFolder: async () => {
      markWalkStarted();
      await walkPending;
      return [{ path: 'C:\\watch\\late.mkv', name: 'late.mkv', size: 1 }];
    },
    stat: async () => ({ mtimeMs: 1 }),
    ...timers
  });
  monitor.on('status', (status) => statuses.push(status));
  monitor.on('new-files', (files) => newFiles.push(files));
  monitor.start({ folderPath: 'C:\\watch', extensions: 'mkv', skipDuplicates: true, reconcileIntervalMinutes: 5 });
  const scan = monitor.scan({ emitFiles: true, trigger: 'manual' });
  await walkStarted;
  await monitor.pause();
  const statusCountAfterPause = statuses.length;
  releaseWalk();
  const result = await scan;
  assert.equal(result.cancelled, true);
  assert.equal(statuses.length, statusCountAfterPause);
  assert.deepEqual(newFiles, []);
  assert.equal(monitor.status().scanning, false);
});

test('stop cancels a running scan and its pending follow-up', async () => {
  let releaseWalk;
  let markWalkStarted;
  let walkCalls = 0;
  const walkPending = new Promise((resolve) => { releaseWalk = resolve; });
  const walkStarted = new Promise((resolve) => { markWalkStarted = resolve; });
  const timers = createManualTimers();
  const statuses = [];
  const monitor = new FolderMonitor({
    watch: createSilentWatch(),
    access: async () => {},
    walkFolder: async () => {
      walkCalls++;
      if (walkCalls === 1) {
        markWalkStarted();
        await walkPending;
      }
      return [];
    },
    stat: async () => ({ mtimeMs: 1 }),
    ...timers
  });
  monitor.on('status', (status) => statuses.push(status));
  monitor.start({ folderPath: 'C:\\watch', reconcileIntervalMinutes: 5 });
  const first = monitor.scan({ emitFiles: true, trigger: 'interval' });
  await walkStarted;
  const followUp = monitor.scan({ emitFiles: true, trigger: 'manual' });
  monitor.stop();
  const statusCountAfterStop = statuses.length;
  releaseWalk();
  const results = await Promise.all([first, followUp]);
  assert.equal(walkCalls, 1);
  assert.equal(results.every((result) => result.cancelled === true), true);
  assert.equal(statuses.length, statusCountAfterStop);
});

test('late watcher add callbacks are ignored after pause', async () => {
  const timers = createManualTimers();
  const watchers = [];
  const newFiles = [];
  const monitor = new FolderMonitor({
    watch: () => {
      const watcher = new EventEmitter();
      watcher.close = async () => {};
      watchers.push(watcher);
      return watcher;
    },
    access: async () => {},
    walkFolder: async () => [],
    stat: async () => ({ mtimeMs: 1 }),
    ...timers
  });
  monitor.on('new-files', (files) => newFiles.push(files));
  monitor.start({ folderPath: 'C:\\watch', extensions: 'mkv', reconcileIntervalMinutes: 5 });
  await monitor.pause();
  watchers[0].emit('add', 'C:\\watch\\late.mkv');
  await timers.runTimeouts();
  assert.deepEqual(newFiles, []);
});

test('resume preserves session duplicate history', async () => {
  const timers = createManualTimers();
  const watchers = [];
  const newFiles = [];
  const monitor = new FolderMonitor({
    watch: () => {
      const watcher = new EventEmitter();
      watcher.close = async () => {};
      watchers.push(watcher);
      return watcher;
    },
    access: async () => {},
    walkFolder: async () => [{ path: 'C:\\watch\\same.mkv', name: 'same.mkv', size: 1 }],
    stat: async () => ({ mtimeMs: 1 }),
    ...timers
  });
  monitor.on('new-files', (files) => newFiles.push(files));
  const settings = { folderPath: 'C:\\watch', extensions: 'mkv', skipDuplicates: true, reconcileIntervalMinutes: 5 };
  monitor.start(settings);
  watchers[0].emit('add', 'C:\\watch\\same.mkv');
  await timers.runTimeouts();
  await monitor.pause();
  await monitor.resume(settings);
  watchers[1].emit('add', 'C:\\watch\\same.mkv');
  await timers.runTimeouts();
  assert.deepEqual(newFiles, [['C:\\watch\\same.mkv']]);
  assert.equal(monitor.status().seenCount, 1);
});

test('watcher add paused before batch timeout is emitted exactly once by resume scan', async () => {
  const timers = createManualTimers();
  const watchers = [];
  const newFiles = [];
  const filePath = 'C:\\watch\\pending.mkv';
  const monitor = new FolderMonitor({
    watch: () => {
      const watcher = new EventEmitter();
      watcher.close = async () => {};
      watchers.push(watcher);
      return watcher;
    },
    access: async () => {},
    walkFolder: async () => [{ path: filePath, name: 'pending.mkv', size: 1 }],
    stat: async () => ({ mtimeMs: 1 }),
    ...timers
  });
  monitor.on('new-files', (files) => newFiles.push(files));
  const settings = { folderPath: 'C:\\watch', extensions: 'mkv', skipDuplicates: true, reconcileIntervalMinutes: 5 };
  monitor.start(settings);
  watchers[0].emit('add', filePath);
  assert.deepEqual(newFiles, []);
  await monitor.pause();
  assert.deepEqual(newFiles, []);
  await monitor.resume(settings);
  assert.deepEqual(newFiles, [[filePath]]);
  assert.equal(monitor.status().seenCount, 1);
});

test('pause rollback never deletes historical seen state from a dedupe-off batch', async () => {
  const timers = createManualTimers();
  const watchers = [];
  const newFiles = [];
  const filePath = 'C:\\watch\\historical.mkv';
  let discoverExisting = false;
  const monitor = new FolderMonitor({
    watch: () => {
      const watcher = new EventEmitter();
      watcher.close = async () => {};
      watchers.push(watcher);
      return watcher;
    },
    access: async () => {},
    walkFolder: async () => discoverExisting ? [{ path: filePath, name: 'historical.mkv', size: 1 }] : [],
    stat: async () => ({ mtimeMs: 1 }),
    ...timers
  });
  monitor.on('new-files', (files) => newFiles.push(files));
  const dedupeOn = { folderPath: 'C:\\watch', extensions: 'mkv', skipDuplicates: true, reconcileIntervalMinutes: 5 };
  const dedupeOff = { ...dedupeOn, skipDuplicates: false };
  monitor.start(dedupeOn);
  watchers[0].emit('add', filePath);
  await timers.runTimeouts();
  assert.deepEqual(newFiles, [[filePath]]);
  await monitor.pause();
  await monitor.resume(dedupeOff);
  watchers[1].emit('add', filePath);
  assert.deepEqual(newFiles, [[filePath]]);
  await monitor.pause();
  discoverExisting = true;
  await monitor.resume(dedupeOn);
  assert.deepEqual(newFiles, [[filePath]]);
  assert.equal(monitor.status().seenCount, 1);
});

test('dry scan leaves the public status byte-identical and does not consume reconnect state', async () => {
  let reachable = false;
  const timers = createManualTimers();
  const statuses = [];
  const monitor = new FolderMonitor({
    watch: createSilentWatch(),
    access: async () => {
      if (!reachable) throw new Error('offline');
    },
    walkFolder: async () => [],
    stat: async () => ({ mtimeMs: 1 }),
    ...timers
  });
  monitor.on('status', (status) => statuses.push(status));
  monitor.start({ folderPath: 'Z:\\watch', reconcileIntervalMinutes: 5 });
  await monitor.scan({ emitFiles: true, trigger: 'interval' });
  reachable = true;
  const before = JSON.stringify(monitor.status());
  const statusCount = statuses.length;
  const dry = await monitor.scan({ emitFiles: false, trigger: 'test' });
  assert.equal(dry.reachable, true);
  assert.equal(JSON.stringify(monitor.status()), before);
  assert.equal(statuses.length, statusCount);
  const productive = await monitor.scan({ emitFiles: true, trigger: 'reconnect' });
  assert.equal(productive.reconnected, true);
});

test('walk failure clears scan state, sanitizes the error and preserves one follow-up', async () => {
  let releaseFailure;
  let walkCalls = 0;
  const failurePending = new Promise((resolve) => { releaseFailure = resolve; });
  const timers = createManualTimers();
  const statuses = [];
  const monitor = new FolderMonitor({
    watch: createSilentWatch(),
    access: async () => {},
    walkFolder: async () => {
      walkCalls++;
      if (walkCalls === 1) {
        await failurePending;
        throw new Error('token=secret-value at C:\\private\\file.mkv');
      }
      return [];
    },
    stat: async () => ({ mtimeMs: 1 }),
    ...timers
  });
  monitor.on('status', (status) => statuses.push(status));
  monitor.start({ folderPath: 'C:\\watch', reconcileIntervalMinutes: 5 });
  const first = monitor.scan({ emitFiles: true, trigger: 'interval' });
  const second = monitor.scan({ emitFiles: true, trigger: 'reconnect' });
  const third = monitor.scan({ emitFiles: true, trigger: 'manual' });
  releaseFailure();
  await Promise.all([first, second, third]);
  assert.equal(walkCalls, 2);
  assert.equal(statuses.some((status) => status.error === 'Ordnerscan fehlgeschlagen'), true);
  assert.equal(statuses.some((status) => status.error.includes('secret-value') || status.error.includes('C:\\private')), false);
  assert.equal(monitor.status().scanning, false);
});

test('new-files listener failure terminates the productive scan with a sanitized error', async () => {
  const { monitor } = createScanHarness({
    files: [{ path: 'C:\\watch\\a.mkv', name: 'a.mkv', size: 1, mtimeMs: 1 }]
  });
  monitor.on('new-files', () => {
    throw new Error('apiKey=listener-secret');
  });
  monitor.start({ folderPath: 'C:\\watch', extensions: 'mkv', reconcileIntervalMinutes: 5 });
  const result = await monitor.scan({ emitFiles: true, trigger: 'manual' });
  assert.equal(result.error, 'Ordnerscan fehlgeschlagen');
  assert.equal(monitor.status().error, 'Ordnerscan fehlgeschlagen');
  assert.equal(monitor.status().error.includes('listener-secret'), false);
  assert.equal(monitor.status().scanning, false);
});

test('interval callback contains unexpected scan rejection', async () => {
  const timers = createManualTimers();
  const statuses = [];
  const monitor = new FolderMonitor({
    watch: createSilentWatch(),
    access: async () => {},
    walkFolder: async () => [],
    stat: async () => ({ mtimeMs: 1 }),
    ...timers
  });
  monitor.on('status', (status) => statuses.push(status));
  monitor.start({ folderPath: 'C:\\watch', reconcileIntervalMinutes: 5 });
  monitor.scan = async () => { throw new Error('token=interval-secret'); };
  await assert.doesNotReject(() => timers.runInterval());
  assert.equal(statuses.at(-1).error, 'Ordnerscan fehlgeschlagen');
  assert.equal(statuses.at(-1).error.includes('interval-secret'), false);
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
    const disconnected = await monitor.scan({ emitFiles: true, trigger: 'interval' });
    assert.equal(disconnected.reachable, false);
    fs.renameSync(detached, root);
    const reconnected = await monitor.scan({ emitFiles: true, trigger: 'interval' });
    assert.equal(reconnected.reachable, true);
    assert.equal(reconnected.reconnected, true);
    await monitor.pause();
  } finally {
    if (fs.existsSync(detached)) fs.renameSync(detached, root);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
