const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createBatchMutationGate } = require('../lib/batch-mutation-gate');

it('drains main-process batch mutations before source cleanup finalization', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const batchDoneStart = source.indexOf("uploadManager.on('batch-done'");
  const sealAndDrain = source.indexOf('batchMutationGate.sealAndDrain()', batchDoneStart);
  const cleanupFinish = source.indexOf('sourceCleanup.finishBatch', batchDoneStart);
  assert.ok(batchDoneStart >= 0);
  assert.ok(sealAndDrain > batchDoneStart);
  assert.ok(cleanupFinish > sealAndDrain);
  assert.match(source.slice(sealAndDrain, cleanupFinish + 300), /!hadActiveBatchMutation/);
  assert.match(source, /batchMutationGate\.acquire\(\)/);
  assert.match(source, /finally\s*{\s*batchMutationLease\.finish\(\)/);
});

describe('batch mutation gate', () => {
  it('keeps a seal pending until every lease active at seal has finished', async () => {
    const gate = createBatchMutationGate();
    const first = gate.acquire();
    const second = gate.acquire();

    const drain = gate.sealAndDrain();
    let drained = false;
    drain.then(() => {
      drained = true;
    });

    assert.equal(gate.acquire(), null);
    assert.equal(first.isOpen(), true);
    assert.equal(second.isOpen(), true);

    first.finish();
    await Promise.resolve();
    assert.equal(drained, false);

    second.finish();
    assert.equal(await drain, true);
    assert.equal(drained, true);
  });

  it('reports no active mutation when sealing an idle gate', async () => {
    const gate = createBatchMutationGate();

    assert.equal(await gate.sealAndDrain(), false);
    assert.equal(gate.acquire(), null);
  });

  it('returns the same drain promise and preserves the first seal snapshot', async () => {
    const gate = createBatchMutationGate();
    const lease = gate.acquire();

    const firstDrain = gate.sealAndDrain();
    lease.finish();
    const secondDrain = gate.sealAndDrain();

    assert.equal(secondDrain, firstDrain);
    assert.equal(await firstDrain, true);
    assert.equal(await gate.sealAndDrain(), true);
  });

  it('makes lease completion idempotent without affecting other leases', async () => {
    const gate = createBatchMutationGate();
    const first = gate.acquire();
    const second = gate.acquire();
    const drain = gate.sealAndDrain();

    assert.equal(first.finish(), true);
    assert.equal(first.finish(), false);
    assert.equal(first.isOpen(), false);
    assert.equal(second.isOpen(), true);

    let drained = false;
    drain.then(() => {
      drained = true;
    });
    await Promise.resolve();
    assert.equal(drained, false);

    assert.equal(second.finish(), true);
    assert.equal(await drain, true);
  });

  it('does not let a rejected caller block drain when the lease finishes in finally', async () => {
    const gate = createBatchMutationGate();
    const lease = gate.acquire();
    const caller = (async () => {
      try {
        await Promise.reject(new Error('audit failed'));
      } finally {
        lease.finish();
      }
    })();
    const drain = gate.sealAndDrain();

    await assert.rejects(caller, /audit failed/);
    assert.equal(await drain, true);
    assert.equal(lease.isOpen(), false);
  });

  it('does not count a lease finished before sealing as active at seal', async () => {
    const gate = createBatchMutationGate();
    const lease = gate.acquire();

    lease.finish();

    assert.equal(await gate.sealAndDrain(), false);
  });
});
