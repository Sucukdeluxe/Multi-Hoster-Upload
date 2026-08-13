const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { createRestartController, createWatchedPaths, formatChangeMessage } = require('../scripts/dev-runner.cjs');

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createHarness(stopChild) {
  const started = [];
  const stopped = [];
  const unexpectedExits = [];
  let nextPid = 1;
  const controller = createRestartController({
    startChild() {
      const child = new EventEmitter();
      child.pid = nextPid;
      nextPid += 1;
      started.push(child);
      return child;
    },
    stopChild(child) {
      stopped.push(child);
      return stopChild(child);
    },
    onUnexpectedExit(code, signal) {
      unexpectedExits.push({ code, signal });
    }
  });
  return { controller, started, stopped, unexpectedExits };
}

test('three changes during an open kill produce exactly one replacement Electron tree', async () => {
  const kill = createDeferred();
  const harness = createHarness(() => kill.promise);
  const original = harness.controller.start();
  const firstRestart = harness.controller.restart();

  const pendingChanges = [
    harness.controller.restart(),
    harness.controller.restart(),
    harness.controller.restart()
  ];

  assert.equal(harness.stopped.length, 1);
  assert.strictEqual(harness.stopped[0], original);
  assert.strictEqual(harness.controller.start(), original);
  assert.equal(harness.started.length, 1);

  kill.resolve();
  await Promise.all([firstRestart, ...pendingChanges]);

  assert.equal(harness.stopped.length, 1);
  assert.equal(harness.started.length, 2);
  assert.notStrictEqual(harness.started[1], original);
});

test('a failed kill cannot start Electron over the still-running tree', async () => {
  const harness = createHarness(async () => {
    throw new Error('taskkill failed');
  });
  const original = harness.controller.start();

  await assert.rejects(harness.controller.restart(), /taskkill failed/u);

  assert.equal(harness.stopped.length, 1);
  assert.equal(harness.started.length, 1);
  assert.strictEqual(harness.controller.start(), original);
});

test('shutdown during an open restart kill prevents its completion from starting Electron', async () => {
  const kill = createDeferred();
  const harness = createHarness(() => kill.promise);
  harness.controller.start();
  const restart = harness.controller.restart();
  const shutdown = harness.controller.shutdown();

  assert.equal(harness.stopped.length, 1);
  assert.equal(harness.started.length, 1);

  kill.resolve();
  await Promise.all([restart, shutdown]);

  assert.equal(harness.stopped.length, 1);
  assert.equal(harness.started.length, 1);
  assert.equal(harness.controller.start(), null);
});

test('an old child exit cannot clear the replacement Electron child', async () => {
  const harness = createHarness(async () => {});
  const original = harness.controller.start();

  await harness.controller.restart();
  const replacement = harness.started[1];
  original.emit('exit', 0, 'SIGTERM');

  assert.equal(harness.started.length, 2);
  assert.strictEqual(harness.controller.start(), replacement);
  assert.deepEqual(harness.unexpectedExits, []);
});

test('watch paths still cover main, preloads, lib and renderer', () => {
  const projectRoot = path.resolve('C:\\project');

  assert.deepEqual([...createWatchedPaths(projectRoot)], [
    path.join(projectRoot, 'main.js'),
    path.join(projectRoot, 'preload.js'),
    path.join(projectRoot, 'preload-drop-target.js'),
    path.join(projectRoot, 'lib'),
    path.join(projectRoot, 'renderer')
  ]);
});

test('change log identifies every watched file without calling it a renderer change', () => {
  assert.equal(formatChangeMessage('C:\\project\\lib\\hosters.js'), '[hotdev] change detected: C:\\project\\lib\\hosters.js\n');
});
