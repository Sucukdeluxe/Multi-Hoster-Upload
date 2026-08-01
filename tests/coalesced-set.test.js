const { test } = require('node:test');
const assert = require('node:assert/strict');

const { makeCoalescedSet } = require('../lib/coalesced-set');

// Synchronous scheduler stand-in: collects callbacks instead of running
// them, so tests can drive the timing explicitly.
function makeManualScheduler() {
  const queue = [];
  const fn = (cb) => queue.push(cb);
  fn.flush = () => {
    while (queue.length) {
      const cb = queue.shift();
      cb();
    }
  };
  fn.queueLength = () => queue.length;
  return fn;
}

test('throws if apply callback missing', () => {
  assert.throws(() => makeCoalescedSet());
  assert.throws(() => makeCoalescedSet({}));
  assert.throws(() => makeCoalescedSet({ apply: 'not-a-fn' }));
});

test('multiple adds in one tick coalesce into one apply call', () => {
  const sched = makeManualScheduler();
  const calls = [];
  const cs = makeCoalescedSet({
    apply: (drop) => calls.push([...drop].sort()),
    scheduler: sched
  });

  cs.add('a'); cs.add('b'); cs.add('c');
  assert.equal(sched.queueLength(), 1, 'only one microtask scheduled');
  assert.equal(cs.pendingSize(), 3);

  sched.flush();
  assert.deepEqual(calls, [['a', 'b', 'c']]);
  assert.equal(cs.pendingSize(), 0);
});

test('duplicate adds are deduplicated', () => {
  const sched = makeManualScheduler();
  const calls = [];
  const cs = makeCoalescedSet({ apply: (d) => calls.push([...d]), scheduler: sched });
  cs.add('a'); cs.add('a'); cs.add('a');
  sched.flush();
  assert.deepEqual(calls, [['a']]);
});

test('two batches in series stay independent', () => {
  const sched = makeManualScheduler();
  const calls = [];
  const cs = makeCoalescedSet({ apply: (d) => calls.push([...d]), scheduler: sched });

  cs.add('x'); cs.add('y');
  sched.flush();
  cs.add('z');
  sched.flush();

  assert.deepEqual(calls, [['x', 'y'], ['z']]);
});

test('add after flush re-schedules a new microtask', () => {
  const sched = makeManualScheduler();
  const cs = makeCoalescedSet({ apply: () => {}, scheduler: sched });
  cs.add('a');
  assert.equal(sched.queueLength(), 1);
  sched.flush();
  assert.equal(sched.queueLength(), 0);
  assert.equal(cs.isScheduled(), false);
  cs.add('b');
  assert.equal(sched.queueLength(), 1, 'new add → new microtask');
});

test('drainSync flushes synchronously without waiting for scheduler', () => {
  const sched = makeManualScheduler();
  const calls = [];
  const cs = makeCoalescedSet({ apply: (d) => calls.push([...d]), scheduler: sched });
  cs.add('p'); cs.add('q');
  cs.drainSync();
  assert.deepEqual(calls, [['p', 'q']]);
  assert.equal(cs.pendingSize(), 0);

  // Pending microtask was for the same ids — when it runs, pending is empty
  // → apply NOT called twice.
  sched.flush();
  assert.equal(calls.length, 1, 'queued microtask is a no-op after drainSync');
});

test('drainSync on empty set is a no-op', () => {
  let called = 0;
  const cs = makeCoalescedSet({ apply: () => called++ });
  cs.drainSync();
  assert.equal(called, 0);
});

test('throwing apply does not lock out subsequent batches', () => {
  const sched = makeManualScheduler();
  let attempt = 0;
  const cs = makeCoalescedSet({
    apply: () => { attempt++; if (attempt === 1) throw new Error('boom'); },
    scheduler: sched
  });
  cs.add('a');
  // First flush throws inside apply but is swallowed; coalescer must still work.
  sched.flush();
  cs.add('b');
  sched.flush();
  assert.equal(attempt, 2, 'second batch still ran despite first throwing');
});

test('default scheduler is queueMicrotask (or Promise fallback) — runs eventually', async () => {
  const calls = [];
  const cs = makeCoalescedSet({ apply: (d) => calls.push([...d]) });
  cs.add('z');
  // Wait one microtask
  await Promise.resolve();
  assert.deepEqual(calls, [['z']]);
});

test('no-op tick: scheduler fires while pending is empty (e.g. drained)', () => {
  const sched = makeManualScheduler();
  let called = 0;
  const cs = makeCoalescedSet({ apply: () => called++, scheduler: sched });
  cs.add('a');
  cs.drainSync();
  assert.equal(called, 1);
  // Pending microtask still in queue → flush; pending is empty → apply NOT called again.
  sched.flush();
  assert.equal(called, 1);
});

test('large burst of 5000 adds coalesces to one apply call', () => {
  const sched = makeManualScheduler();
  const calls = [];
  const cs = makeCoalescedSet({ apply: (d) => calls.push(d.size), scheduler: sched });
  for (let i = 0; i < 5000; i++) cs.add('id-' + i);
  assert.equal(sched.queueLength(), 1);
  sched.flush();
  assert.deepEqual(calls, [5000]);
});
