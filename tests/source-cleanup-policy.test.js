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
    confirmedHosters: [],
    fingerprint: null,
    jobs: [
      { jobId: 'job-doodstream', hoster: 'doodstream.com', status: 'done', currentRound: false },
      { jobId: 'job-voe', hoster: 'voe.sx', status: 'done', currentRound: false },
      { jobId: 'job-vidmoly', hoster: 'vidmoly.me', status: 'error', currentRound: true },
      { jobId: 'job-byse', hoster: 'byse.sx', status: 'preview', currentRound: false }
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

test('prepareGroups reuses confirmed metadata across a partial retry', () => {
  const queueJobs = queueFixture();
  policy.prepareGroups(queueJobs, queueJobs, () => 'cleanup-1', 'win32');
  for (const job of queueJobs) {
    job.sourceCleanupMetadataVersion = 2;
    job.sourceCleanupConfirmedHosters = ['doodstream.com', 'voe.sx'];
  }
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
  assert.deepEqual(prepared.groups[0].confirmedHosters, ['doodstream.com', 'voe.sx']);
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

test('markCompleted keeps successful hosters provisional for the current round', () => {
  const queueJobs = queueFixture();
  policy.prepareGroups(queueJobs, queueJobs, () => 'cleanup-1', 'win32');

  policy.markCompleted(queueJobs, queueJobs[2], 'win32');
  policy.markCompleted(queueJobs, queueJobs[2], 'win32');

  for (const job of queueJobs) {
    assert.deepEqual(job.sourceCleanupConfirmedHosters, []);
    assert.deepEqual(job.sourceCleanupProvisionalHosters, ['vidmoly.me']);
  }
});

test('removeRequirement never relaxes requirements for started or interrupted jobs', () => {
  for (const candidate of [
    { status: 'queued' },
    { status: 'getting-server' },
    { status: 'uploading' },
    { status: 'retrying' },
    { status: 'preview', interrupted: true }
  ]) {
    const queueJobs = [
      {
        id: 'job-complete',
        file: 'C:\\Uploads\\Protected.mkv',
        hoster: 'doodstream.com',
        status: 'done',
        sourceCleanupMetadataVersion: 2,
        sourceCleanupToken: 'cleanup-protected',
        sourceCleanupRequiredHosters: ['doodstream.com', 'voe.sx'],
        sourceCleanupConfirmedHosters: ['doodstream.com']
      },
      {
        id: 'job-candidate',
        file: 'C:\\Uploads\\Protected.mkv',
        hoster: 'voe.sx',
        sourceCleanupMetadataVersion: 2,
        sourceCleanupToken: 'cleanup-protected',
        sourceCleanupRequiredHosters: ['doodstream.com', 'voe.sx'],
        sourceCleanupConfirmedHosters: ['doodstream.com'],
        ...candidate
      }
    ];

    const touchedJobs = policy.removeRequirement(queueJobs, queueJobs[1], 'win32');

    assert.deepEqual(touchedJobs, []);
    assert.deepEqual(queueJobs.map(job => job.sourceCleanupRequiredHosters), [
      ['doodstream.com', 'voe.sx'],
      ['doodstream.com', 'voe.sx']
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

test('keeps round successes provisional until history and queue persistence succeed', async () => {
  const queueJobs = [
    { id: 'job-voe', file: 'C:\\Uploads\\Round.bin', hoster: 'voe.sx', status: 'preview' },
    { id: 'job-byse', file: 'C:\\Uploads\\Round.bin', hoster: 'byse.sx', status: 'error' }
  ];
  policy.prepareGroups(queueJobs, queueJobs, () => 'cleanup-round', 'win32');
  queueJobs[0].status = 'done';

  policy.markCompleted(queueJobs, queueJobs[0], 'win32');

  for (const job of queueJobs) {
    assert.deepEqual(job.sourceCleanupConfirmedHosters, []);
    assert.deepEqual(job.sourceCleanupProvisionalHosters, ['voe.sx']);
  }

  let persistedHosters = null;
  const queuePersisted = await policy.persistRoundCompletions(queueJobs, {
    historyPersisted: true,
    persist: async () => {
      persistedHosters = queueJobs.map((job) => [...job.sourceCleanupConfirmedHosters]);
      return true;
    }
  });

  assert.equal(queuePersisted, true);
  assert.deepEqual(persistedHosters, [['voe.sx'], ['voe.sx']]);
  for (const job of queueJobs) {
    assert.deepEqual(job.sourceCleanupConfirmedHosters, ['voe.sx']);
    assert.deepEqual(job.sourceCleanupProvisionalHosters, []);
  }
});

test('rolls back provisional promotion when the final queue save fails', async () => {
  const queueJobs = [
    {
      id: 'job-voe',
      file: 'C:\\Uploads\\Partial.bin',
      hoster: 'voe.sx',
      status: 'done',
      sourceCleanupMetadataVersion: 2,
      sourceCleanupToken: 'cleanup-partial',
      sourceCleanupRequiredHosters: ['voe.sx', 'byse.sx'],
      sourceCleanupConfirmedHosters: ['voe.sx']
    },
    {
      id: 'job-byse',
      file: 'C:\\Uploads\\Partial.bin',
      hoster: 'byse.sx',
      status: 'preview',
      sourceCleanupMetadataVersion: 2,
      sourceCleanupToken: 'cleanup-partial',
      sourceCleanupRequiredHosters: ['voe.sx', 'byse.sx'],
      sourceCleanupConfirmedHosters: ['voe.sx']
    }
  ];
  policy.prepareGroups(queueJobs, [queueJobs[1]], () => 'unused', 'win32');
  queueJobs[1].status = 'done';
  policy.markCompleted(queueJobs, queueJobs[1], 'win32');

  const queuePersisted = await policy.persistRoundCompletions(queueJobs, {
    historyPersisted: true,
    persist: async () => false
  });

  assert.equal(queuePersisted, false);
  for (const job of queueJobs) {
    assert.deepEqual(job.sourceCleanupConfirmedHosters, ['voe.sx']);
    assert.deepEqual(job.sourceCleanupProvisionalHosters, []);
  }
});

test('ignores legacy v2.1.19 completed markers when preparing a retry', () => {
  const queueJobs = [{
    id: 'job-voe',
    file: 'C:\\Uploads\\Legacy.bin',
    hoster: 'voe.sx',
    status: 'error',
    sourceCleanupToken: 'cleanup-legacy',
    sourceCleanupRequiredHosters: ['voe.sx'],
    sourceCleanupCompletedHosters: ['voe.sx']
  }];

  const prepared = policy.prepareGroups(queueJobs, queueJobs, () => 'unused', 'win32');

  assert.deepEqual(prepared.groups[0].confirmedHosters, []);
  assert.equal(queueJobs[0].sourceCleanupMetadataVersion, 2);
  assert.deepEqual(queueJobs[0].sourceCleanupConfirmedHosters, []);
  assert.equal(Object.prototype.hasOwnProperty.call(queueJobs[0], 'sourceCleanupCompletedHosters'), false);
});

test('selecting a confirmed hoster for retry revokes its durable completion', () => {
  const queueJobs = [
    {
      id: 'job-voe',
      file: 'C:\\Uploads\\Retry.bin',
      hoster: 'voe.sx',
      status: 'preview',
      sourceCleanupMetadataVersion: 2,
      sourceCleanupToken: 'cleanup-retry',
      sourceCleanupRequiredHosters: ['voe.sx', 'byse.sx'],
      sourceCleanupConfirmedHosters: ['voe.sx', 'byse.sx']
    },
    {
      id: 'job-byse',
      file: 'C:\\Uploads\\Retry.bin',
      hoster: 'byse.sx',
      status: 'done',
      sourceCleanupMetadataVersion: 2,
      sourceCleanupToken: 'cleanup-retry',
      sourceCleanupRequiredHosters: ['voe.sx', 'byse.sx'],
      sourceCleanupConfirmedHosters: ['voe.sx', 'byse.sx']
    }
  ];

  const prepared = policy.prepareGroups(queueJobs, [queueJobs[0]], () => 'unused', 'win32');

  assert.deepEqual(prepared.groups[0].confirmedHosters, ['byse.sx']);
  assert.equal(prepared.groups[0].jobs[0].currentRound, true);
  assert.equal(prepared.groups[0].jobs[1].currentRound, false);
  for (const job of queueJobs) {
    assert.deepEqual(job.sourceCleanupConfirmedHosters, ['byse.sx']);
  }
});
