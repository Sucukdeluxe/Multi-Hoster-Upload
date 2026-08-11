const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const SourceDeleteJournal = require('../lib/source-delete-journal');

test('restores a staged source after an interrupted deletion', async (t) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mhu-delete-journal-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'source.bin');
  const stagedFile = path.join(directory, '.source.bin.mhu-delete-test');
  const journal = new SourceDeleteJournal(path.join(directory, 'journal.jsonl'));
  await fs.promises.writeFile(file, 'source');
  await journal.plan({ token: 'cleanup-1', file, stagedFile });
  await fs.promises.rename(file, stagedFile);

  const outcomes = await journal.recover();

  assert.equal(await fs.promises.readFile(file, 'utf-8'), 'source');
  assert.equal(outcomes[0].outcome, 'restored');
  assert.deepEqual(await journal.recover(), []);
});

test('clears a completed deletion record when neither source nor stage remains', async (t) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mhu-delete-journal-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const journal = new SourceDeleteJournal(path.join(directory, 'journal.jsonl'));
  await journal.plan({ token: 'cleanup-2', file: path.join(directory, 'source.bin'), stagedFile: path.join(directory, '.staged') });

  const outcomes = await journal.recover();

  assert.equal(outcomes[0].outcome, 'cleared');
  assert.deepEqual(await journal.recover(), []);
});

test('continues recovery after one malformed active entry', async (t) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mhu-delete-journal-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const journal = new SourceDeleteJournal(path.join(directory, 'journal.jsonl'));
  const file = path.join(directory, 'source.bin');
  const stagedFile = path.join(directory, '.source.bin.mhu-delete-test');
  await journal.plan({ token: 'broken', file: null, stagedFile: null });
  await fs.promises.writeFile(stagedFile, 'source');
  await journal.plan({ token: 'valid', file, stagedFile });

  const outcomes = await journal.recover();

  assert.equal(outcomes.find((entry) => entry.token === 'broken').outcome, 'recovery-failed');
  assert.equal(outcomes.find((entry) => entry.token === 'valid').outcome, 'restored');
  assert.equal(await fs.promises.readFile(file, 'utf-8'), 'source');
});

test('retries transient Windows rename locks during recovery', async (t) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mhu-delete-journal-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'source.bin');
  const stagedFile = path.join(directory, '.source.bin.mhu-delete-test');
  const journalPath = path.join(directory, 'journal.jsonl');
  let renameCalls = 0;
  const waits = [];
  const injectedFs = {
    promises: {
      mkdir: (...args) => fs.promises.mkdir(...args),
      open: (...args) => fs.promises.open(...args),
      readFile: (...args) => fs.promises.readFile(...args),
      lstat: (...args) => fs.promises.lstat(...args),
      rename: async (...args) => {
        renameCalls += 1;
        if (renameCalls < 3) throw Object.assign(new Error('locked'), { code: 'EBUSY' });
        return fs.promises.rename(...args);
      }
    }
  };
  const writer = new SourceDeleteJournal(journalPath);
  await fs.promises.writeFile(stagedFile, 'source');
  await writer.plan({ token: 'cleanup-retry', file, stagedFile });
  const journal = new SourceDeleteJournal(journalPath, null, { fs: injectedFs, wait: async (delay) => waits.push(delay) });

  const outcomes = await journal.recover();

  assert.equal(outcomes[0].outcome, 'restored');
  assert.equal(renameCalls, 3);
  assert.deepEqual(waits, [100, 250]);
});
