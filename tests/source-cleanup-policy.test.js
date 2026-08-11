const { test } = require('node:test');
const assert = require('node:assert/strict');

const policy = require('../lib/source-cleanup-policy');

function queueFixture() {
  return [
    {
      id: 'job-doodstream',
      file: 'C:\\Uploads\\Movie.MKV',
      hoster: 'doodstream.com',
      status: 'done'
    },
    {
      id: 'job-voe',
      file: 'C:\\Uploads\\Movie.MKV',
      hoster: 'voe.sx',
      status: 'done'
    },
    {
      id: 'job-vidmoly',
      file: 'C:\\Uploads\\Movie.MKV',
      hoster: 'vidmoly.me',
      status: 'error'
    },
    {
      id: 'job-byse',
      file: 'C:\\Uploads\\Movie.MKV',
      hoster: 'byse.sx',
      status: 'preview'
    }
  ];
}

test('prepareGroups creates one Windows manifest with a stable token and immutable hosters', () => {
  const queueJobs = queueFixture();
  let tokenCalls = 0;

  const prepared = policy.prepareGroups(queueJobs, [queueJobs[2]], () => {
    tokenCalls += 1;
    return 'cleanup-1';
  }, 'win32');

  assert.equal(tokenCalls, 1);
  assert.equal(prepared.groups.length, 1);
  assert.equal(prepared.touchedJobs.length, 4);
  assert.deepEqual(prepared.groups[0], {
    token: 'cleanup-1',
    file: 'C:\\Uploads\\Movie.MKV',
    requiredHosters: ['doodstream.com', 'voe.sx', 'vidmoly.me', 'byse.sx'],
    completedHosters: ['doodstream.com', 'voe.sx'],
    fingerprint: null,
    jobs: [
      { jobId: 'job-doodstream', hoster: 'doodstream.com', status: 'done' },
      { jobId: 'job-voe', hoster: 'voe.sx', status: 'done' },
      { jobId: 'job-vidmoly', hoster: 'vidmoly.me', status: 'error' },
      { jobId: 'job-byse', hoster: 'byse.sx', status: 'preview' }
    ]
  });
  assert.deepEqual(queueJobs.map((job) => job.sourceCleanupToken), [
    'cleanup-1',
    'cleanup-1',
    'cleanup-1',
    'cleanup-1'
  ]);
  for (const job of queueJobs) {
    assert.deepEqual(job.sourceCleanupRequiredHosters, [
      'doodstream.com',
      'voe.sx',
      'vidmoly.me',
      'byse.sx'
    ]);
  }
  assert.doesNotThrow(() => JSON.stringify(prepared.groups));
});

test('prepareGroups reuses persisted metadata across a partial retry', () => {
  const queueJobs = queueFixture();
  policy.prepareGroups(queueJobs, queueJobs, () => 'cleanup-1', 'win32');
  queueJobs[0].sourceCleanupCompletedHosters = ['doodstream.com', 'voe.sx'];
  queueJobs[1].sourceCleanupCompletedHosters = ['doodstream.com', 'voe.sx'];
  queueJobs[0].status = 'preview';
  queueJobs[1].status = 'preview';

  const prepared = policy.prepareGroups(queueJobs, [queueJobs[2]], () => {
    throw new Error('token must stay stable');
  }, 'win32');

  assert.equal(prepared.groups[0].token, 'cleanup-1');
  assert.deepEqual(prepared.groups[0].requiredHosters, [
    'doodstream.com',
    'voe.sx',
    'vidmoly.me',
    'byse.sx'
  ]);
  assert.deepEqual(prepared.groups[0].completedHosters, ['doodstream.com', 'voe.sx']);
  assert.equal(prepared.groups[0].jobs.find((job) => job.hoster === 'vidmoly.me').status, 'error');
});

test('prepareGroups extends an active manifest when a new hoster is added', () => {
  const queueJobs = queueFixture().slice(0, 2);
  policy.prepareGroups(queueJobs, queueJobs, () => 'cleanup-1', 'win32');
  queueJobs.push({ id: 'job-new', file: 'C:\\Uploads\\Movie.MKV', hoster: 'byse.sx', status: 'preview' });

  const prepared = policy.prepareGroups(queueJobs, [queueJobs[2]], () => 'cleanup-2', 'win32');

  assert.equal(prepared.groups[0].token, 'cleanup-1');
  assert.deepEqual(prepared.groups[0].requiredHosters, ['doodstream.com', 'voe.sx', 'byse.sx']);
});

test('keeps case-distinct Windows paths in separate groups', () => {
  const queueJobs = [
    { id: 'upper', file: 'C:\\CaseSensitive\\Movie.mkv', hoster: 'voe.sx', status: 'preview' },
    { id: 'lower', file: 'C:\\CaseSensitive\\movie.mkv', hoster: 'byse.sx', status: 'preview' }
  ];

  const prepared = policy.prepareGroups(queueJobs, queueJobs, (file) => `token-${file}`, 'win32');

  assert.equal(prepared.groups.length, 2);
  assert.deepEqual(prepared.groups.map((group) => group.requiredHosters), [['voe.sx'], ['byse.sx']]);
});

test('removing a failed job never relaxes the stored requirements', () => {
  const queueJobs = queueFixture();
  policy.prepareGroups(queueJobs, queueJobs, () => 'cleanup-1', 'win32');
  const failedJob = queueJobs[2];
  const remainingJobs = queueJobs.filter((job) => job !== failedJob);

  policy.removeRequirement(remainingJobs, failedJob, 'win32');
  const prepared = policy.prepareGroups(remainingJobs, [remainingJobs[2]], () => {
    throw new Error('token must stay stable');
  }, 'win32');

  assert.deepEqual(prepared.groups[0].requiredHosters, [
    'doodstream.com',
    'voe.sx',
    'vidmoly.me',
    'byse.sx'
  ]);
  for (const job of remainingJobs) {
    assert.deepEqual(job.sourceCleanupRequiredHosters, [
      'doodstream.com',
      'voe.sx',
      'vidmoly.me',
      'byse.sx'
    ]);
  }
});

test('removeRequirement drops only an explicitly discarded unstarted hoster', () => {
  const queueJobs = queueFixture();
  policy.prepareGroups(queueJobs, queueJobs, () => 'cleanup-1', 'win32');

  const touchedJobs = policy.removeRequirement(queueJobs, queueJobs[3], 'win32');

  assert.equal(touchedJobs.length, 4);
  for (const job of queueJobs) {
    assert.deepEqual(job.sourceCleanupRequiredHosters, [
      'doodstream.com',
      'voe.sx',
      'vidmoly.me'
    ]);
  }
});

test('markCompleted preserves successful hosters for later retries', () => {
  const queueJobs = queueFixture();
  policy.prepareGroups(queueJobs, queueJobs, () => 'cleanup-1', 'win32');

  policy.markCompleted(queueJobs, queueJobs[2], 'win32');
  policy.markCompleted(queueJobs, queueJobs[2], 'win32');

  for (const job of queueJobs) {
    assert.deepEqual(job.sourceCleanupCompletedHosters, [
      'doodstream.com',
      'voe.sx',
      'vidmoly.me'
    ]);
  }
});

test('applyFingerprints attaches Main fingerprints by token and includes them in payloads', () => {
  const queueJobs = queueFixture();
  policy.prepareGroups(queueJobs, queueJobs, () => 'cleanup-1', 'win32');
  const fingerprint = {
    type: 'file',
    size: 1048576,
    mtimeMs: 1786467600000,
    birthtimeMs: 1786467500000,
    dev: 2114,
    ino: 9001
  };

  const touchedJobs = policy.applyFingerprints(queueJobs, { 'cleanup-1': fingerprint });
  const prepared = policy.prepareGroups(queueJobs, [queueJobs[3]], () => {
    throw new Error('token must stay stable');
  }, 'win32');

  assert.equal(touchedJobs.length, 4);
  assert.deepEqual(prepared.groups[0].fingerprint, fingerprint);
  for (const job of queueJobs) {
    assert.deepEqual(job.sourceCleanupFingerprint, fingerprint);
    assert.notEqual(job.sourceCleanupFingerprint, fingerprint);
  }
});
