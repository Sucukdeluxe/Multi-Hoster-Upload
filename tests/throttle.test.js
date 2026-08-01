const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Throttle = require('../lib/throttle');

describe('Throttle', () => {
  it('unlimited mode (0) returns immediately', async () => {
    const t = new Throttle(0);
    const start = Date.now();
    await t.consume(10_000_000);
    assert.ok(Date.now() - start < 50, 'should be instant');
  });

  it('unlimited with falsy values', async () => {
    for (const val of [undefined, null, false, 0]) {
      const t = new Throttle(val);
      const start = Date.now();
      await t.consume(1_000_000);
      assert.ok(Date.now() - start < 50, `should be instant for ${val}`);
    }
  });

  it('small consume within initial token budget resolves immediately', async () => {
    const t = new Throttle(1024 * 1024); // 1 MB/s
    const start = Date.now();
    await t.consume(100); // 100 bytes, well within 1MB budget
    assert.ok(Date.now() - start < 50);
  });

  it('large consume exceeding tokens introduces delay', async () => {
    const t = new Throttle(1000); // 1000 bytes/sec
    // Drain initial tokens
    await t.consume(1000);

    const start = Date.now();
    await t.consume(500); // needs ~500ms of refill
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 400, `expected >=400ms, got ${elapsed}ms`);
    assert.ok(elapsed < 2000, `expected <2000ms, got ${elapsed}ms`);
  });

  it('aborted signal stops consumption early', async () => {
    const t = new Throttle(100); // 100 bytes/sec
    await t.consume(100); // drain budget

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);

    const start = Date.now();
    await t.consume(10000, ac.signal); // would take ~100s without abort
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 1000, `should abort quickly, took ${elapsed}ms`);
  });

  it('updateRate changes behavior', async () => {
    const t = new Throttle(100);
    await t.consume(100); // drain

    t.updateRate(0); // switch to unlimited
    const start = Date.now();
    await t.consume(999999);
    assert.ok(Date.now() - start < 50, 'should be instant after switching to unlimited');
  });

  it('_refill does not exceed maxBps', () => {
    const t = new Throttle(1000);
    t.tokens = 0;
    t.lastRefill = Date.now() - 60000; // simulate 60 seconds elapsed
    t._refill();
    assert.ok(t.tokens <= 1000, `tokens should not exceed maxBps, got ${t.tokens}`);
  });

  it('concurrent consume calls share the token pool', async () => {
    const t = new Throttle(2000); // 2000 bytes/sec, initial tokens = 2000

    // Two concurrent consumes of 1000 each - should both fit in initial budget
    const start = Date.now();
    await Promise.all([t.consume(1000), t.consume(1000)]);
    assert.ok(Date.now() - start < 100, 'both should resolve from initial budget');

    // Third consume should need to wait for refill
    const start2 = Date.now();
    await t.consume(500);
    const elapsed = Date.now() - start2;
    assert.ok(elapsed >= 150, `third consume should wait for refill, took ${elapsed}ms`);
  });

  it('consume(0) resolves immediately', async () => {
    const t = new Throttle(100);
    const start = Date.now();
    await t.consume(0);
    assert.ok(Date.now() - start < 50);
  });

  it('updateRate to unlimited (0) makes consume instant', async () => {
    const t = new Throttle(100); // very slow
    t.updateRate(0); // unlimited
    const start = Date.now();
    await t.consume(1_000_000);
    assert.ok(Date.now() - start < 50, 'unlimited rate should be instant');
  });
});
