const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSourceFileCleanup } = require('../lib/source-file-cleanup');

async function makeSource(t, name = 'source.bin') {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mhu-source-cleanup-'));
  const file = path.join(directory, name);
  await fs.promises.writeFile(file, Buffer.from('original source data'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  return { directory, file };
}

function group(file, overrides = {}) {
  return {
    token: 'cleanup-1',
    file,
    requiredHosters: ['voe.sx', 'byse.sx'],
    confirmedHosters: [],
    jobs: [
      { jobId: 'job-voe', file, hoster: 'voe.sx', status: 'pending' },
      { jobId: 'job-byse', file, hoster: 'byse.sx', status: 'pending' }
    ],
    ...overrides
  };
}

function makeCleanup(overrides = {}) {
  const audits = [];
  const waits = [];
  const cleanup = createSourceFileCleanup({
    fs,
    path,
    platform: process.platform,
    isEnabled: () => true,
    audit: (event) => audits.push(event),
    journal: { plan: async () => {}, clear: async () => {} },
    wait: async (milliseconds) => waits.push(milliseconds),
    ...overrides
  });
  return { cleanup, audits, waits };
}

async function settleDone(cleanup, manifest) {
  for (const job of manifest.jobs) {
    await cleanup.settle({
      token: manifest.token,
      jobId: job.jobId,
      file: manifest.file,
      hoster: job.hoster,
      status: 'done'
    });
  }
}

async function exists(file) {
  try {
    await fs.promises.lstat(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

test('fingerprints a regular file and keeps the registered manifest immutable', async (t) => {
  const { file } = await makeSource(t);
  const { cleanup, audits } = makeCleanup();
  const manifest = group(file);

  const fingerprints = await cleanup.registerGroups([manifest]);

  assert.equal(fingerprints['cleanup-1'].type, 'file');
  assert.equal(fingerprints['cleanup-1'].size, Buffer.byteLength('original source data'));
  assert.equal(typeof fingerprints['cleanup-1'].mtimeMs, 'number');
  assert.equal(typeof fingerprints['cleanup-1'].birthtimeMs, 'number');
  assert.equal(typeof fingerprints['cleanup-1'].dev, 'number');
  assert.equal(typeof fingerprints['cleanup-1'].ino, 'number');

  manifest.requiredHosters.splice(1, 1);
  manifest.confirmedHosters.push('byse.sx');
  manifest.jobs[1].hoster = 'voe.sx';
  await cleanup.settle({
    token: 'cleanup-1',
    jobId: 'job-voe',
    file,
    hoster: 'voe.sx',
    status: 'done'
  });
  await cleanup.finishBatch({ historyPersisted: true, queuePersisted: true });

  assert.equal(await exists(file), true);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].outcome, 'blocked');
  assert.deepEqual(audits[0].blockingStatuses, [{ hoster: 'byse.sx', status: 'pending' }]);
});

test('extends a registered group before finalization', async (t) => {
  const { file } = await makeSource(t);
  const { cleanup, audits } = makeCleanup();
  await cleanup.registerGroups([group(file, {
    requiredHosters: ['voe.sx'],
    jobs: [{ jobId: 'job-voe', file, hoster: 'voe.sx', status: 'pending' }]
  })]);
  await cleanup.registerGroups([group(file)]);
  await cleanup.settle({ token: 'cleanup-1', jobId: 'job-voe', file, hoster: 'voe.sx', status: 'done' });

  assert.deepEqual(await cleanup.finishBatch({ historyPersisted: true, queuePersisted: true }), ['blocked']);
  assert.equal(await exists(file), true);
  assert.equal(audits[0].blockingStatuses[0].hoster, 'byse.sx');
});

test('deletes only when enabled, history persisted, queue persisted, and every required hoster is done', async (t) => {
  const cases = [
    { name: 'setting disabled', enabled: false, historyPersisted: true, queuePersisted: true, outcome: 'setting-disabled' },
    { name: 'history missing', enabled: true, historyPersisted: false, queuePersisted: true, outcome: 'blocked' },
    { name: 'queue missing', enabled: true, historyPersisted: true, queuePersisted: false, outcome: 'blocked' }
  ];

  for (const entry of cases) {
    await t.test(entry.name, async (subtest) => {
      const { file } = await makeSource(subtest, `${entry.name}.bin`);
      const { cleanup, audits } = makeCleanup({ isEnabled: () => entry.enabled });
      const manifest = group(file);
      await cleanup.registerGroups([manifest]);
      await settleDone(cleanup, manifest);

      await cleanup.finishBatch({
        historyPersisted: entry.historyPersisted,
        queuePersisted: entry.queuePersisted
      });

      assert.equal(await exists(file), true);
      assert.equal(audits.length, 1);
      assert.equal(audits[0].outcome, entry.outcome);
    });
  }

  const { file } = await makeSource(t, 'all-barriers.bin');
  const { cleanup, audits } = makeCleanup();
  const manifest = group(file);
  await cleanup.registerGroups([manifest]);
  await settleDone(cleanup, manifest);

  await cleanup.finishBatch({ historyPersisted: true, queuePersisted: true });

  assert.equal(await exists(file), false);
  assert.deepEqual(audits.map((event) => event.outcome), ['delete-approved', 'source-staged', 'deleted']);
});

test('collects terminal states and blocks error, aborted, skipped, and pending jobs', async (t) => {
  const cases = [
    { status: 'error', apply: (cleanup, file) => cleanup.settle({ token: 'cleanup-1', jobId: 'job-byse', file, hoster: 'byse.sx', status: 'error' }) },
    { status: 'aborted', apply: (cleanup, file) => cleanup.settle({ token: 'cleanup-1', jobId: 'job-byse', file, hoster: 'byse.sx', status: 'aborted' }) },
    { status: 'skipped', apply: (cleanup) => cleanup.markSkipped('job-byse', 'missing-account') },
    { status: 'pending', apply: (cleanup, file) => cleanup.settle({ token: 'cleanup-1', jobId: 'job-byse', file, hoster: 'byse.sx', status: 'uploading' }) }
  ];

  for (const entry of cases) {
    await t.test(entry.status, async (subtest) => {
      const { file } = await makeSource(subtest, `${entry.status}.bin`);
      const { cleanup, audits } = makeCleanup();
      const manifest = group(file);
      await cleanup.registerGroups([manifest]);
      await cleanup.settle({ token: 'cleanup-1', jobId: 'job-voe', file, hoster: 'voe.sx', status: 'done' });
      await entry.apply(cleanup, file);

      await cleanup.finishBatch({ historyPersisted: true, queuePersisted: true });

      assert.equal(await exists(file), true);
      assert.equal(audits.length, 1);
      assert.equal(audits[0].outcome, 'blocked');
      assert.deepEqual(audits[0].blockingStatuses, [{ hoster: 'byse.sx', status: entry.status }]);
    });
  }
});

test('combines previous successes with a successful retry without relaxing other requirements', async (t) => {
  await t.test('last retry completes the immutable group', async (subtest) => {
    const { file } = await makeSource(subtest, 'retry-completes.bin');
    const { cleanup } = makeCleanup();
    const manifest = group(file, {
      confirmedHosters: ['voe.sx'],
      jobs: [
        { jobId: 'job-voe', file, hoster: 'voe.sx', status: 'pending', currentRound: false },
        { jobId: 'job-byse', file, hoster: 'byse.sx', status: 'pending', currentRound: true }
      ]
    });
    await cleanup.registerGroups([manifest]);
    await cleanup.settle({ token: 'cleanup-1', jobId: 'job-byse', file, hoster: 'byse.sx', status: 'done' });

    await cleanup.finishBatch({ historyPersisted: true, queuePersisted: true });

    assert.equal(await exists(file), false);
  });

  await t.test('an unselected failed requirement still blocks deletion', async (subtest) => {
    const { file } = await makeSource(subtest, 'retry-partial.bin');
    const { cleanup, audits } = makeCleanup();
    const manifest = group(file, {
      requiredHosters: ['voe.sx', 'byse.sx', 'vidmoly.me'],
      confirmedHosters: ['voe.sx'],
      jobs: [
        { jobId: 'job-voe', file, hoster: 'voe.sx', status: 'pending', currentRound: false },
        { jobId: 'job-byse', file, hoster: 'byse.sx', status: 'pending', currentRound: true },
        { jobId: 'job-vidmoly', file, hoster: 'vidmoly.me', status: 'error', currentRound: false }
      ]
    });
    await cleanup.registerGroups([manifest]);
    await cleanup.settle({ token: 'cleanup-1', jobId: 'job-byse', file, hoster: 'byse.sx', status: 'done' });

    await cleanup.finishBatch({ historyPersisted: true, queuePersisted: true });

    assert.equal(await exists(file), true);
    assert.deepEqual(audits[0].blockingStatuses, [{ hoster: 'vidmoly.me', status: 'error' }]);
  });
});

test('audits a changed or missing source without deleting a replacement', async (t) => {
  await t.test('source changed', async (subtest) => {
    const { file } = await makeSource(subtest, 'changed.bin');
    const { cleanup, audits } = makeCleanup();
    const manifest = group(file);
    await cleanup.registerGroups([manifest]);
    await settleDone(cleanup, manifest);
    await fs.promises.writeFile(file, Buffer.from('replacement source data with a different size'));

    await cleanup.finishBatch({ historyPersisted: true, queuePersisted: true });

    assert.equal(await exists(file), true);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].outcome, 'source-changed');
  });

  await t.test('source missing', async (subtest) => {
    const { file } = await makeSource(subtest, 'missing.bin');
    const { cleanup, audits } = makeCleanup();
    const manifest = group(file);
    await cleanup.registerGroups([manifest]);
    await settleDone(cleanup, manifest);
    await fs.promises.unlink(file);

    await cleanup.finishBatch({ historyPersisted: true, queuePersisted: true });

    assert.equal(audits.length, 1);
    assert.equal(audits[0].outcome, 'source-missing');
  });
});

test('rejects non-regular sources and audits the unsafe type', async (t) => {
  const { directory } = await makeSource(t);
  const unsafePath = path.join(directory, 'folder-source');
  await fs.promises.mkdir(unsafePath);
  const { cleanup, audits } = makeCleanup();
  const manifest = group(unsafePath);

  const fingerprints = await cleanup.registerGroups([manifest]);
  await settleDone(cleanup, manifest);
  await cleanup.finishBatch({ historyPersisted: true, queuePersisted: true });

  assert.equal(fingerprints['cleanup-1'], null);
  assert.equal((await fs.promises.lstat(unsafePath)).isDirectory(), true);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].outcome, 'unsafe-source-type');
});

test('runs unlink exactly once across repeated and concurrent finalization', async (t) => {
  const { file } = await makeSource(t);
  let unlinkCalls = 0;
  const injectedFs = {
    promises: {
      lstat: (...args) => fs.promises.lstat(...args),
      rename: (...args) => fs.promises.rename(...args),
      unlink: async (...args) => {
        unlinkCalls += 1;
        await fs.promises.unlink(...args);
      }
    }
  };
  const { cleanup, audits } = makeCleanup({ fs: injectedFs });
  const manifest = group(file);
  await cleanup.registerGroups([manifest]);
  await settleDone(cleanup, manifest);

  await Promise.all([
    cleanup.finishBatch({ historyPersisted: true, queuePersisted: true }),
    cleanup.finishBatch({ historyPersisted: true, queuePersisted: true })
  ]);
  await cleanup.finishBatch({ historyPersisted: true, queuePersisted: true });

  assert.equal(unlinkCalls, 1);
  assert.deepEqual(audits.map((event) => event.outcome), ['delete-approved', 'source-staged', 'deleted']);
});

test('retries EBUSY and EPERM with the bounded Windows delay schedule', async (t) => {
  const { file } = await makeSource(t);
  const failures = ['EBUSY', 'EPERM', 'EBUSY', 'EPERM', 'EBUSY'];
  let unlinkCalls = 0;
  const injectedFs = {
    promises: {
      lstat: (...args) => fs.promises.lstat(...args),
      rename: (...args) => fs.promises.rename(...args),
      unlink: async (...args) => {
        const code = failures[unlinkCalls];
        unlinkCalls += 1;
        if (code) throw Object.assign(new Error(code), { code });
        await fs.promises.unlink(...args);
      }
    }
  };
  const { cleanup, audits, waits } = makeCleanup({ fs: injectedFs });
  const manifest = group(file);
  await cleanup.registerGroups([manifest]);
  await settleDone(cleanup, manifest);

  await cleanup.finishBatch({ historyPersisted: true, queuePersisted: true });

  assert.equal(unlinkCalls, 6);
  assert.deepEqual(waits, [100, 250, 500, 1000, 2000]);
  assert.equal(await exists(file), false);
  assert.deepEqual(audits.map((event) => event.outcome), ['delete-approved', 'source-staged', 'deleted']);
  assert.equal(audits[2].attempts, 6);
});

test('swallows cleanup failures, preserves the source, and audits one final failure', async (t) => {
  await t.test('retryable failure exhausts all delays', async (subtest) => {
    const { file } = await makeSource(subtest, 'locked.bin');
    let unlinkCalls = 0;
    const injectedFs = {
      promises: {
        lstat: (...args) => fs.promises.lstat(...args),
        rename: (...args) => fs.promises.rename(...args),
        unlink: async () => {
          unlinkCalls += 1;
          throw Object.assign(new Error('locked'), { code: 'EBUSY' });
        }
      }
    };
    const { cleanup, audits, waits } = makeCleanup({ fs: injectedFs });
    const manifest = group(file);
    await cleanup.registerGroups([manifest]);
    await settleDone(cleanup, manifest);

    await assert.doesNotReject(cleanup.finishBatch({ historyPersisted: true, queuePersisted: true }));

    assert.equal(unlinkCalls, 6);
    assert.deepEqual(waits, [100, 250, 500, 1000, 2000]);
    assert.equal(await exists(file), true);
    assert.deepEqual(audits.map((event) => event.outcome), ['delete-approved', 'source-staged', 'failed']);
    assert.equal(audits[2].attempts, 6);
  });

  await t.test('non-retryable failure stops immediately', async (subtest) => {
    const { file } = await makeSource(subtest, 'denied.bin');
    let unlinkCalls = 0;
    const injectedFs = {
      promises: {
        lstat: (...args) => fs.promises.lstat(...args),
        rename: (...args) => fs.promises.rename(...args),
        unlink: async () => {
          unlinkCalls += 1;
          throw Object.assign(new Error('denied'), { code: 'EACCES' });
        }
      }
    };
    const { cleanup, audits, waits } = makeCleanup({ fs: injectedFs });
    const manifest = group(file);
    await cleanup.registerGroups([manifest]);
    await settleDone(cleanup, manifest);

    await assert.doesNotReject(cleanup.finishBatch({ historyPersisted: true, queuePersisted: true }));

    assert.equal(unlinkCalls, 1);
    assert.deepEqual(waits, []);
    assert.equal(await exists(file), true);
    assert.deepEqual(audits.map((event) => event.outcome), ['delete-approved', 'source-staged', 'failed']);
    assert.equal(audits[2].attempts, 1);
  });
});

test('preserves the original Windows path casing for filesystem operations', async (t) => {
  const { file } = await makeSource(t, 'SourceCase.BIN');
  const observed = [];
  const injectedFs = {
    promises: {
      lstat: async (target) => {
        observed.push(target);
        return fs.promises.lstat(target);
      },
      rename: (...args) => fs.promises.rename(...args),
      unlink: (...args) => fs.promises.unlink(...args)
    }
  };
  const { cleanup } = makeCleanup({ fs: injectedFs, platform: 'win32' });
  const manifest = group(file);
  await cleanup.registerGroups([manifest]);
  await settleDone(cleanup, manifest);
  await cleanup.finishBatch({ historyPersisted: true, queuePersisted: true });

  assert.equal(observed[0], file);
  assert.equal(await exists(file), false);
});

test('blocks both case-colliding Windows source groups', async (t) => {
  const { directory, file } = await makeSource(t, 'Movie.mkv');
  const secondFile = path.join(directory, 'movie.mkv');
  await fs.promises.writeFile(secondFile, Buffer.from('other source data'));
  const { cleanup } = makeCleanup({ platform: 'win32' });
  const first = group(file, { token: 'cleanup-upper' });
  const second = group(secondFile, { token: 'cleanup-lower' });
  await cleanup.registerGroups([first, second]);
  await settleDone(cleanup, first);
  await settleDone(cleanup, second);

  assert.deepEqual(await cleanup.finishBatch({ historyPersisted: true, queuePersisted: true }), ['blocked', 'blocked']);
  assert.equal(await exists(file), true);
  assert.equal(await exists(secondFile), true);
});

test('blocks deletion when the audit approval cannot be persisted', async (t) => {
  const { file } = await makeSource(t, 'audit-failure.bin');
  const { cleanup } = makeCleanup({ audit: async () => false });
  const manifest = group(file);
  await cleanup.registerGroups([manifest]);
  await settleDone(cleanup, manifest);

  assert.deepEqual(await cleanup.finishBatch({ historyPersisted: true, queuePersisted: true }), ['blocked']);
  assert.equal(await exists(file), true);
});

test('restores the staged source when the deletion commit audit fails', async (t) => {
  const { file } = await makeSource(t, 'audit-commit-failure.bin');
  let auditCalls = 0;
  const { cleanup } = makeCleanup({ audit: async () => ++auditCalls !== 2 });
  const manifest = group(file);
  await cleanup.registerGroups([manifest]);
  await settleDone(cleanup, manifest);

  assert.deepEqual(await cleanup.finishBatch({ historyPersisted: true, queuePersisted: true }), ['blocked']);
  assert.equal(await exists(file), true);
});

test('rechecks the staged file and restores a replacement without deleting it', async (t) => {
  const { file } = await makeSource(t, 'stage-race.bin');
  let unlinkCalls = 0;
  let firstRename = true;
  const injectedFs = {
    promises: {
      lstat: (...args) => fs.promises.lstat(...args),
      rename: async (from, to) => {
        await fs.promises.rename(from, to);
        if (firstRename) {
          firstRename = false;
          await fs.promises.writeFile(to, Buffer.from('replacement data'));
        }
      },
      unlink: async (...args) => {
        unlinkCalls += 1;
        return fs.promises.unlink(...args);
      }
    }
  };
  const { cleanup, audits } = makeCleanup({ fs: injectedFs });
  const manifest = group(file);
  await cleanup.registerGroups([manifest]);
  await settleDone(cleanup, manifest);
  await cleanup.finishBatch({ historyPersisted: true, queuePersisted: true });

  assert.equal(unlinkCalls, 0);
  assert.equal((await fs.promises.readFile(file, 'utf-8')), 'replacement data');
  assert.equal(audits.at(-1).outcome, 'source-changed');
});

test('keeps the source after done, failed history persistence, and an aborted retry of the same hoster', async (t) => {
  const { file } = await makeSource(t, 'history-barrier-retry.bin');
  const firstRound = makeCleanup();
  const firstManifest = group(file, {
    requiredHosters: ['voe.sx'],
    jobs: [{ jobId: 'job-voe', file, hoster: 'voe.sx', status: 'pending', currentRound: true }]
  });
  await firstRound.cleanup.registerGroups([firstManifest]);
  await firstRound.cleanup.settle({ token: 'cleanup-1', jobId: 'job-voe', file, hoster: 'voe.sx', status: 'done' });

  assert.deepEqual(await firstRound.cleanup.finishBatch({ historyPersisted: false, queuePersisted: true }), ['blocked']);
  assert.equal(await exists(file), true);

  const retryRound = makeCleanup();
  const retryManifest = group(file, {
    requiredHosters: ['voe.sx'],
    completedHosters: ['voe.sx'],
    jobs: [{ jobId: 'job-voe', file, hoster: 'voe.sx', status: 'pending', currentRound: true }]
  });
  await retryRound.cleanup.registerGroups([retryManifest]);
  await retryRound.cleanup.settle({ token: 'cleanup-1', jobId: 'job-voe', file, hoster: 'voe.sx', status: 'aborted' });

  assert.deepEqual(await retryRound.cleanup.finishBatch({ historyPersisted: true, queuePersisted: true }), ['blocked']);
  assert.equal(await exists(file), true);
});

test('deletes after a persisted partial round and a successful retry of the remaining hoster', async (t) => {
  const { file } = await makeSource(t, 'partial-round-retry.bin');
  const firstRound = makeCleanup();
  const firstManifest = group(file, {
    jobs: [
      { jobId: 'job-voe', file, hoster: 'voe.sx', status: 'pending', currentRound: true },
      { jobId: 'job-byse', file, hoster: 'byse.sx', status: 'pending', currentRound: true }
    ]
  });
  await firstRound.cleanup.registerGroups([firstManifest]);
  await firstRound.cleanup.settle({ token: 'cleanup-1', jobId: 'job-voe', file, hoster: 'voe.sx', status: 'done' });
  await firstRound.cleanup.settle({ token: 'cleanup-1', jobId: 'job-byse', file, hoster: 'byse.sx', status: 'error' });

  assert.deepEqual(await firstRound.cleanup.finishBatch({ historyPersisted: true, queuePersisted: true }), ['blocked']);
  assert.equal(await exists(file), true);

  const retryRound = makeCleanup();
  const retryManifest = group(file, {
    confirmedHosters: ['voe.sx'],
    jobs: [
      { jobId: 'job-voe', file, hoster: 'voe.sx', status: 'pending', currentRound: false },
      { jobId: 'job-byse', file, hoster: 'byse.sx', status: 'pending', currentRound: true }
    ]
  });
  await retryRound.cleanup.registerGroups([retryManifest]);
  await retryRound.cleanup.settle({ token: 'cleanup-1', jobId: 'job-byse', file, hoster: 'byse.sx', status: 'done' });

  assert.deepEqual(await retryRound.cleanup.finishBatch({ historyPersisted: true, queuePersisted: true }), ['deleted']);
  assert.equal(await exists(file), false);
});

test('does not trust a legacy completion after a failed queue barrier and restart', async (t) => {
  const { file } = await makeSource(t, 'queue-barrier-restart.bin');
  const firstRound = makeCleanup();
  const firstManifest = group(file, {
    requiredHosters: ['voe.sx'],
    jobs: [{ jobId: 'job-voe', file, hoster: 'voe.sx', status: 'pending', currentRound: true }]
  });
  await firstRound.cleanup.registerGroups([firstManifest]);
  await firstRound.cleanup.settle({ token: 'cleanup-1', jobId: 'job-voe', file, hoster: 'voe.sx', status: 'done' });

  assert.deepEqual(await firstRound.cleanup.finishBatch({ historyPersisted: true, queuePersisted: false }), ['blocked']);
  assert.equal(await exists(file), true);

  const restartedRound = makeCleanup();
  const restartedManifest = group(file, {
    requiredHosters: ['voe.sx'],
    completedHosters: ['voe.sx'],
    jobs: [{ jobId: 'job-voe', file, hoster: 'voe.sx', status: 'pending', currentRound: true }]
  });
  await restartedRound.cleanup.registerGroups([restartedManifest]);
  await restartedRound.cleanup.settle({ token: 'cleanup-1', jobId: 'job-voe', file, hoster: 'voe.sx', status: 'error' });

  assert.deepEqual(await restartedRound.cleanup.finishBatch({ historyPersisted: true, queuePersisted: true }), ['blocked']);
  assert.equal(await exists(file), true);
});

test('lets a current non-done retry override an earlier confirmed completion', async (t) => {
  const { file } = await makeSource(t, 'confirmed-hoster-retry.bin');
  const { cleanup, audits } = makeCleanup();
  const manifest = group(file, {
    requiredHosters: ['voe.sx'],
    confirmedHosters: ['voe.sx'],
    jobs: [{ jobId: 'job-voe', file, hoster: 'voe.sx', status: 'done', currentRound: true }]
  });
  await cleanup.registerGroups([manifest]);
  await cleanup.settle({ token: 'cleanup-1', jobId: 'job-voe', file, hoster: 'voe.sx', status: 'aborted' });

  assert.deepEqual(await cleanup.finishBatch({ historyPersisted: true, queuePersisted: true }), ['blocked']);
  assert.equal(await exists(file), true);
  assert.deepEqual(audits[0].blockingStatuses, [{ hoster: 'voe.sx', status: 'aborted' }]);
});

test('re-registering a hoster for the current round invalidates its earlier current success', async (t) => {
  const { file } = await makeSource(t, 'same-batch-retry.bin');
  const { cleanup, audits } = makeCleanup();
  const manifest = group(file, {
    requiredHosters: ['voe.sx'],
    jobs: [{ jobId: 'job-voe', file, hoster: 'voe.sx', status: 'pending', currentRound: true }]
  });
  await cleanup.registerGroups([manifest]);
  await cleanup.settle({ token: 'cleanup-1', jobId: 'job-voe', file, hoster: 'voe.sx', status: 'done' });
  await cleanup.registerGroups([manifest]);

  assert.deepEqual(await cleanup.finishBatch({ historyPersisted: true, queuePersisted: true }), ['blocked']);
  assert.equal(await exists(file), true);
  assert.deepEqual(audits[0].blockingStatuses, [{ hoster: 'voe.sx', status: 'pending' }]);
});
