const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateQueueStats } = require('../renderer/queue-stats');

test('queue totals keep skipped and aborted jobs out of remaining work', () => {
  const stats = calculateQueueStats([
    { status: 'done', bytesTotal: 100, bytesUploaded: 100 },
    { status: 'error', bytesTotal: 100, bytesUploaded: 20 },
    { status: 'skipped', bytesTotal: 100, bytesUploaded: 0 },
    { status: 'aborted', bytesTotal: 100, bytesUploaded: 10 },
    { status: 'queued', bytesTotal: 100, bytesUploaded: 0 },
    { status: 'uploading', bytesTotal: 100, bytesUploaded: 40 }
  ]);
  assert.deepEqual({ total: stats.total, remaining: stats.remaining, done: stats.done, errors: stats.errors, skipped: stats.skipped, aborted: stats.aborted }, {
    total: 6,
    remaining: 2,
    done: 1,
    errors: 1,
    skipped: 1,
    aborted: 1
  });
  assert.equal(stats.remainingSize, 160);
});
