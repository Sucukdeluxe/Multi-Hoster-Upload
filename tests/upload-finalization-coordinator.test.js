const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function loadMainFunction(name, nextName) {
  const start = mainSource.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const end = mainSource.indexOf(`\nfunction ${nextName}(`, start + name.length);
  assert.notEqual(end, -1, `${nextName} must follow ${name}`);
  const context = vm.createContext({});
  vm.runInContext(`${mainSource.slice(start, end)}\nthis.loaded = ${name};`, context);
  return context.loaded;
}

test('terminal finalization is delivered once per ready renderer generation and rejects stale acknowledgements', async () => {
  const createCoordinator = loadMainFunction('createUploadFinalizationCoordinator', 'createUploadFinalizationBarrier');
  const sent = [];
  const savedQueues = [];
  const scheduled = new Set();
  let deliverySequence = 0;
  const coordinator = createCoordinator({
    send: payload => {
      sent.push(JSON.parse(JSON.stringify(payload)));
      return true;
    },
    saveQueue: async pendingQueue => {
      savedQueues.push(JSON.parse(JSON.stringify(pendingQueue)));
    },
    schedule: callback => {
      const token = { callback };
      scheduled.add(token);
      return token;
    },
    cancelSchedule: token => scheduled.delete(token),
    createFinalizationId: () => 'finalization-1',
    createDeliveryId: () => `delivery-${++deliverySequence}`,
    timeoutMs: 15000
  });

  const completion = coordinator.request({ id: 'batch-1', files: [] }, true);
  let settled = false;
  completion.then(() => { settled = true; });

  assert.equal(sent.length, 0);
  assert.equal(coordinator.rendererReady(), 1);
  assert.equal(coordinator.rendererReady(), 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].finalizationId, 'finalization-1');
  assert.equal(sent[0].deliveryId, 'delivery-1');
  assert.equal(sent[0].historyPersisted, true);

  coordinator.rendererBlocked();
  assert.equal(coordinator.rendererReady(), 2);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].deliveryId, 'delivery-2');

  const stale = await coordinator.complete({
    finalizationId: 'finalization-1',
    deliveryId: 'delivery-1',
    pendingQueue: { queueJobs: [{ id: 'stale' }] }
  });
  await Promise.resolve();

  assert.equal(stale, false);
  assert.equal(settled, false);
  assert.equal(savedQueues.length, 0);

  const accepted = await coordinator.complete({
    finalizationId: 'finalization-1',
    deliveryId: 'delivery-2',
    pendingQueue: { queueJobs: [{ id: 'terminal' }] }
  });

  assert.equal(accepted, true);
  assert.equal(await completion, true);
  assert.deepEqual(savedQueues, [{ queueJobs: [{ id: 'terminal' }] }]);
  assert.equal(scheduled.size, 0);

  coordinator.rendererBlocked();
  coordinator.rendererReady();
  assert.equal(sent.length, 2);
});

test('history failure remains visible to the durable terminal finalization barrier', async () => {
  const createBarrier = loadMainFunction('createUploadFinalizationBarrier', 'requestUploadFinalization');
  const recoveries = [];
  const finalizationCalls = [];
  const errors = [];
  const barrier = createBarrier({
    appendHistory: async () => { throw new Error('history unavailable'); },
    saveRecovery: async value => { recoveries.push(value === null ? null : JSON.parse(JSON.stringify(value))); },
    requestFinalization: async (summary, historyPersisted) => {
      finalizationCalls.push({ summary: JSON.parse(JSON.stringify(summary)), historyPersisted });
      return false;
    },
    buildTerminalSnapshots: summary => summary.files[0].results.map(result => ({ jobId: result.jobId, status: result.status })),
    now: () => '2026-08-13T12:00:00.000Z',
    onError: (phase, error) => errors.push([phase, error.message])
  });
  const summary = {
    id: 'skipped-batch',
    files: [{ name: 'missing-account.bin', results: [{ jobId: 'skip-1', status: 'skipped' }] }]
  };

  const result = await barrier.finalize(summary, {
    id: 'recovery-skipped',
    startedAt: '2026-08-13T11:59:59.000Z',
    jobIds: ['skip-1']
  });

  assert.equal(result.historyPersisted, false);
  assert.equal(result.queuePersisted, false);
  assert.equal(result.terminalRecoveryPersisted, true);
  assert.deepEqual(finalizationCalls, [{ summary, historyPersisted: false }]);
  assert.deepEqual(recoveries, [{
    id: 'recovery-skipped',
    startedAt: '2026-08-13T11:59:59.000Z',
    jobIds: ['skip-1'],
    settledAt: '2026-08-13T12:00:00.000Z',
    terminalJobs: [{ jobId: 'skip-1', status: 'skipped' }]
  }]);
  assert.deepEqual(errors, [['history', 'history unavailable']]);
});

test('terminal recovery clears only after history-independent queue acknowledgement', async () => {
  const createBarrier = loadMainFunction('createUploadFinalizationBarrier', 'requestUploadFinalization');
  const recoveries = [];
  const barrier = createBarrier({
    appendHistory: async () => true,
    saveRecovery: async value => { recoveries.push(value === null ? null : JSON.parse(JSON.stringify(value))); },
    requestFinalization: async (_summary, historyPersisted) => historyPersisted,
    buildTerminalSnapshots: () => [{ jobId: 'done-1', status: 'done' }],
    now: () => '2026-08-13T12:01:00.000Z',
    onError: () => {}
  });

  const result = await barrier.finalize({ id: 'done-batch', files: [] }, {
    id: 'recovery-done',
    startedAt: '2026-08-13T12:00:00.000Z',
    jobIds: ['done-1']
  });

  assert.equal(result.historyPersisted, true);
  assert.equal(result.queuePersisted, true);
  assert.equal(result.terminalRecoveryPersisted, true);
  assert.equal(result.recoveryCleared, true);
  assert.equal(recoveries.length, 2);
  assert.equal(recoveries[1], null);
});
