const { test } = require('node:test');
const assert = require('node:assert');
const { makeThrottleTimer } = require('../lib/throttle-timer');

function fakeClock() {
  let t = 0;
  let timers = [];
  return {
    now: () => t,
    schedule: (cb, ms) => {
      const h = { at: t + ms, cb, dead: false };
      timers.push(h);
      return h;
    },
    clear: (h) => { if (h) h.dead = true; },
    advance: (ms) => {
      const target = t + ms;
      for (;;) {
        let next = null;
        for (const h of timers) {
          if (!h.dead && h.at <= target && (next === null || h.at < next.at)) next = h;
        }
        if (!next) break;
        t = next.at;
        next.dead = true;
        next.cb();
      }
      t = target;
      timers = timers.filter(h => !h.dead);
    }
  };
}

test('idle debounce: fires once after the delay window', () => {
  const c = fakeClock();
  const tt = makeThrottleTimer(c);
  let fired = 0;
  tt.request(() => fired++, 500);
  c.advance(499);
  assert.equal(fired, 0);
  c.advance(1);
  assert.equal(fired, 1);
});

test('idle debounce: rapid requests reset the timer (last wins)', () => {
  const c = fakeClock();
  const tt = makeThrottleTimer(c);
  let fired = 0;
  tt.request(() => fired++, 500);
  c.advance(200);
  tt.request(() => fired++, 500);
  c.advance(300);
  assert.equal(fired, 0, 'should not fire at original 500 — was reset');
  c.advance(200);
  assert.equal(fired, 1, 'fires 500ms after the second request');
});

test('STARVATION repro: continuous requests with no maxWait NEVER fire', () => {
  const c = fakeClock();
  const tt = makeThrottleTimer(c);
  let fired = 0;
  for (let i = 0; i < 30; i++) {
    tt.request(() => fired++, 500);
    c.advance(100);
  }
  assert.equal(fired, 0, 'this is exactly the bug the maxWait fix addresses');
});

test('maxWait: continuous requests still force a fire within the window', () => {
  const c = fakeClock();
  const tt = makeThrottleTimer(c);
  let fired = 0;
  const fireAtTimes = [];
  for (let i = 0; i < 30; i++) {
    tt.request(() => { fired++; fireAtTimes.push(c.now()); }, 500, 2000);
    c.advance(100);
  }
  assert.ok(fired >= 1, 'maxWait guarantees at least one fire under continuous load');
  assert.ok(fireAtTimes.every(t => t > 0), 'fires happened, not starved');
  assert.ok(fireAtTimes.some(t => t <= 2000), 'first fire no later than maxWait');
});

test('maxWait: after a forced fire a fresh burst starts (periodic fires)', () => {
  const c = fakeClock();
  const tt = makeThrottleTimer(c);
  let fired = 0;
  for (let i = 0; i < 60; i++) {
    tt.request(() => fired++, 500, 2000);
    c.advance(100);
  }
  assert.ok(fired >= 2, `~6000ms of continuous load with 2000ms maxWait should fire multiple times, got ${fired}`);
});

test('flushSync fires the pending fn immediately and clears it', () => {
  const c = fakeClock();
  const tt = makeThrottleTimer(c);
  let fired = 0;
  tt.request(() => fired++, 5000);
  assert.ok(tt.isPending());
  tt.flushSync();
  assert.equal(fired, 1);
  assert.ok(!tt.isPending());
  c.advance(10000);
  assert.equal(fired, 1, 'no double fire after flushSync');
});

test('cancel drops the pending fn — no fire', () => {
  const c = fakeClock();
  const tt = makeThrottleTimer(c);
  let fired = 0;
  tt.request(() => fired++, 500);
  tt.cancel();
  assert.ok(!tt.isPending());
  c.advance(10000);
  assert.equal(fired, 0);
});

test('last-write-wins: a later request with a DIFFERENT fn replaces the earlier one', () => {
  const c = fakeClock();
  const tt = makeThrottleTimer(c);
  const fired = [];
  tt.request(() => fired.push('persist'), 500, 20000);
  c.advance(100);
  tt.request(() => fired.push('clear'), 0);
  c.advance(100);
  assert.deepEqual(fired, ['clear'], 'only the latest fn fires; the persist was dropped');
});

test('flushSync with nothing pending is a no-op', () => {
  const c = fakeClock();
  const tt = makeThrottleTimer(c);
  assert.doesNotThrow(() => tt.flushSync());
});
