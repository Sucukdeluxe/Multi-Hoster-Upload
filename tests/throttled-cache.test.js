const { test } = require('node:test');
const assert = require('node:assert/strict');

const { makeThrottledCache } = require('../lib/throttled-cache');

function fakeClock(start = 0) {
  let t = start;
  const fn = () => t;
  fn.advance = (ms) => { t += ms; };
  fn.set = (ms) => { t = ms; };
  return fn;
}

test('returns undefined when empty', () => {
  const c = makeThrottledCache(100);
  assert.equal(c.get('any', {}), undefined);
});

test('returns the set value within the window', () => {
  const clock = fakeClock();
  const c = makeThrottledCache(100, clock);
  const input = [1, 2, 3];
  c.set('sig-a', input, 'value-1');
  assert.equal(c.get('sig-a', input), 'value-1');
  clock.advance(50);
  assert.equal(c.get('sig-a', input), 'value-1', 'still valid at 50/100 ms');
  clock.advance(49);
  assert.equal(c.get('sig-a', input), 'value-1', 'still valid at 99/100 ms');
});

test('expires exactly at refreshMs boundary', () => {
  const clock = fakeClock();
  const c = makeThrottledCache(100, clock);
  c.set('s', {}, 'v');
  clock.advance(100);
  assert.equal(c.get('s', {}), undefined, '>= refreshMs is a miss');
});

test('miss on different signature', () => {
  const c = makeThrottledCache(1000, fakeClock());
  const input = {};
  c.set('sig-a', input, 'v');
  assert.equal(c.get('sig-b', input), undefined);
});

test('miss on different input identity even with same signature', () => {
  const c = makeThrottledCache(1000, fakeClock());
  c.set('sig-a', { a: 1 }, 'v');
  // Different object identity — the cache compares by ===, not by contents
  assert.equal(c.get('sig-a', { a: 1 }), undefined);
});

test('overwrite by re-setting same signature', () => {
  const clock = fakeClock();
  const c = makeThrottledCache(100, clock);
  const input = [];
  c.set('s', input, 'old');
  clock.advance(50);
  c.set('s', input, 'new');
  // The new entry has a fresh timestamp → still valid for another 100 ms
  clock.advance(99);
  assert.equal(c.get('s', input), 'new');
});

test('clear empties the cache', () => {
  const c = makeThrottledCache(1000, fakeClock());
  c.set('s', {}, 'v');
  c.clear();
  assert.equal(c.get('s', {}), undefined);
  assert.equal(c.peek(), null);
});

test('peek reports age and signature', () => {
  const clock = fakeClock();
  const c = makeThrottledCache(1000, clock);
  c.set('mysig', {}, 'v');
  clock.advance(42);
  const p = c.peek();
  assert.equal(p.sig, 'mysig');
  assert.equal(p.age, 42);
  assert.equal(p.ts, 0);
});

test('throws on invalid refreshMs', () => {
  assert.throws(() => makeThrottledCache(-1));
  assert.throws(() => makeThrottledCache(NaN));
  assert.throws(() => makeThrottledCache('100'));
});

test('refreshMs=0 means every call misses', () => {
  const clock = fakeClock();
  const c = makeThrottledCache(0, clock);
  const input = {};
  c.set('s', input, 'v');
  // Same tick: 0 - 0 = 0 → not less than refreshMs (0) → miss
  assert.equal(c.get('s', input), undefined);
});

test('default clock is Date.now when none provided', () => {
  const c = makeThrottledCache(10000);
  const input = {}; // single ref — get and set must use the SAME identity
  c.set('x', input, 'v');
  assert.equal(c.get('x', input), 'v');
});

test('large input arrays are tracked by identity, not value', () => {
  const c = makeThrottledCache(1000, fakeClock());
  const arr1 = new Array(10000).fill(0);
  const arr2 = new Array(10000).fill(0);
  c.set('s', arr1, 'cached');
  assert.equal(c.get('s', arr1), 'cached');
  assert.equal(c.get('s', arr2), undefined, 'different array → miss');
});
