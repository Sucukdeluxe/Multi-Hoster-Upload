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

test('remaining bytes decrease with progress and return when a failed job is queued again', () => {
  const jobs = [
    { status: 'queued', bytesTotal: 1024, bytesUploaded: 0 },
    { status: 'uploading', bytesTotal: 2048, bytesUploaded: 512 },
    { status: 'error', bytesTotal: 4096, bytesUploaded: 1024 }
  ];

  assert.equal(calculateQueueStats(jobs).bytesRemaining, 2560);
  jobs[1].bytesUploaded = 1536;
  assert.equal(calculateQueueStats(jobs).bytesRemaining, 1536);
  jobs[2].status = 'queued';
  jobs[2].bytesUploaded = 0;
  assert.equal(calculateQueueStats(jobs).bytesRemaining, 5632);
});
