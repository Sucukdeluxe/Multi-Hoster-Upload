const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Semaphore = require('../lib/semaphore');

describe('Semaphore', () => {
  it('clamps limit to at least 1', () => {
    assert.equal(new Semaphore(0).limit, 1);
    assert.equal(new Semaphore(-5).limit, 1);
    assert.equal(new Semaphore(undefined).limit, 1);
    assert.equal(new Semaphore(3).limit, 3);
  });

  it('acquire resolves immediately when slots available', async () => {
    const sem = new Semaphore(2);
    await sem.acquire();
    await sem.acquire();
    assert.equal(sem.active, 2);
  });

  it('acquire blocks when all slots taken', async () => {
    const sem = new Semaphore(1);
    await sem.acquire();

    let resolved = false;
    const p = sem.acquire().then(() => { resolved = true; });

    // Give microtask a chance to resolve
    await new Promise(r => setTimeout(r, 10));
    assert.equal(resolved, false, 'should not resolve while slot is taken');
    assert.equal(sem.pending, 1);

    sem.release();
    await p;
    assert.equal(resolved, true);
  });

  it('FIFO ordering', async () => {
    const sem = new Semaphore(1);
    await sem.acquire(); // take the one slot

    const order = [];
    const p1 = sem.acquire().then(() => order.push(1));
    const p2 = sem.acquire().then(() => order.push(2));
    const p3 = sem.acquire().then(() => order.push(3));

    assert.equal(sem.pending, 3);

    sem.release(); await p1;
    sem.release(); await p2;
    sem.release(); await p3;

    assert.deepEqual(order, [1, 2, 3]);
  });

  it('release with no waiters decrements active', async () => {
    const sem = new Semaphore(2);
    await sem.acquire();
    assert.equal(sem.active, 1);
    sem.release();
    assert.equal(sem.active, 0);
  });

  it('release never goes below 0', () => {
    const sem = new Semaphore(2);
    sem.release();
    assert.equal(sem.active, 0);
    sem.release();
    assert.equal(sem.active, 0);
  });

  it('acquire rejects immediately if signal already aborted', async () => {
    const sem = new Semaphore(2);
    const ac = new AbortController();
    ac.abort();

    await assert.rejects(sem.acquire(ac.signal), /Aborted/);
    assert.equal(sem.active, 0, 'no slot should be acquired');
  });

  it('abort while waiting in queue removes entry and rejects', async () => {
    const sem = new Semaphore(1);
    await sem.acquire(); // take the slot

    const ac = new AbortController();
    const p = sem.acquire(ac.signal);

    assert.equal(sem.pending, 1);
    ac.abort();
    await assert.rejects(p, /Aborted/);
    assert.equal(sem.pending, 0, 'entry should be removed from queue');

    // Release original slot - should not cause issues
    sem.release();
    assert.equal(sem.active, 0);
  });

  it('abort listener is cleaned up when slot is granted via release', async () => {
    const sem = new Semaphore(1);
    await sem.acquire();

    const ac = new AbortController();
    let rejected = false;
    const p = sem.acquire(ac.signal).catch(() => { rejected = true; });

    sem.release(); // grants slot to the waiter
    await p;

    // Now abort after the slot was already granted
    ac.abort();
    await new Promise(r => setTimeout(r, 10));
    assert.equal(rejected, false, 'reject should not fire after slot was granted');
  });

  it('updateLimit wakes waiters', async () => {
    const sem = new Semaphore(1);
    await sem.acquire();

    const resolved = [];
    const p1 = sem.acquire().then(() => resolved.push(1));
    const p2 = sem.acquire().then(() => resolved.push(2));

    sem.updateLimit(3);
    await Promise.all([p1, p2]);
    assert.deepEqual(resolved, [1, 2]);
  });

  it('updateLimit to lower value does not kill active slots', async () => {
    const sem = new Semaphore(3);
    await sem.acquire();
    await sem.acquire();
    await sem.acquire();
    assert.equal(sem.active, 3);

    sem.updateLimit(1);
    assert.equal(sem.active, 3, 'existing active slots should not be evicted');

    sem.release();
    sem.release();
    sem.release();
    assert.equal(sem.active, 0);

    // Now only 1 slot should be available
    await sem.acquire();
    let blocked = false;
    const p = sem.acquire().then(() => { blocked = true; });
    await new Promise(r => setTimeout(r, 10));
    assert.equal(blocked, false, 'should block at limit 1');
    sem.release();
    await p;
  });

  it('pending getter tracks queue size', async () => {
    const sem = new Semaphore(1);
    assert.equal(sem.pending, 0);

    await sem.acquire();
    sem.acquire(); // blocked
    sem.acquire(); // blocked
    assert.equal(sem.pending, 2);

    sem.release();
    await new Promise(r => setTimeout(r, 5));
    assert.equal(sem.pending, 1);
  });

  it('release without acquire clamps active to 0', () => {
    const sem = new Semaphore(2);
    assert.equal(sem.active, 0);
    sem.release();
    assert.equal(sem.active, 0, 'should not go negative');
    sem.release();
    assert.equal(sem.active, 0, 'should still be 0');
  });
});
