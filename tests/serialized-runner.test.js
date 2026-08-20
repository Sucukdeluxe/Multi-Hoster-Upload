const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('serialized runner', () => {
  it('flush waits for an already running save and later work stays ordered', async () => {
    const { createSerializedRunner } = require('../lib/serialized-runner');
    let releaseFirst;
    const calls = [];
    const runner = createSerializedRunner(async (value) => {
      calls.push(`start:${value}`);
      if (value === 'first') await new Promise((resolve) => { releaseFirst = resolve; });
      calls.push(`end:${value}`);
      return value;
    });

    const first = runner.run('first');
    await new Promise((resolve) => setImmediate(resolve));
    const second = runner.run('second');
    let flushed = false;
    const flush = runner.flush().then(() => { flushed = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(flushed, false);
    assert.deepEqual(calls, ['start:first']);

    releaseFirst();
    assert.equal(await first, 'first');
    assert.equal(await second, 'second');
    await flush;
    assert.equal(flushed, true);
    assert.deepEqual(calls, ['start:first', 'end:first', 'start:second', 'end:second']);
  });

  it('queues work before readiness and drains every task in arrival order', async () => {
    const { createReadySerializedRunner } = require('../lib/serialized-runner');
    const calls = [];
    const runner = createReadySerializedRunner(async (value) => {
      calls.push(value);
      return value;
    });

    const first = runner.run('first');
    const second = runner.run('second');
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(runner.isReady, false);
    assert.deepEqual(calls, []);
    assert.equal(runner.ready(), true);
    assert.equal(runner.ready(), false);
    assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
    assert.deepEqual(calls, ['first', 'second']);
    assert.equal(runner.isReady, true);
  });
});
