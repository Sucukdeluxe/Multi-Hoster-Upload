const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createOnlineBackupManager } = require('../lib/online-backup-manager');

const key = `MHU2-${'K'.repeat(70)}`;
const id = 'managed-backup-id';
const record = { id, blob: 'encrypted-blob', deleteVerifier: 'delete-verifier' };
const settings = { globalSettings: { alwaysOnTop: true } };

function createFixture(overrides = {}) {
  const events = [];
  const state = new Map();
  const entries = new Map();
  if (overrides.initialKey !== null) {
    state.set(id, overrides.initialKey || key);
    entries.set(id, {
      id,
      displayKey: `${key.slice(0, 9)}…${key.slice(-4)}`,
      createdAt: '2026-08-22T10:00:00.000Z'
    });
  }
  let createdAt;
  let createArguments;
  const keyring = {
    list: async () => {
      events.push('list');
      return [...entries.values()];
    },
    prepare: (value, timestamp) => {
      events.push('prepare');
      if (overrides.prepareError) throw overrides.prepareError;
      createdAt = timestamp;
      return { id, encryptedKey: 'encrypted-key', createdAt: timestamp };
    },
    commit: async (entry) => {
      events.push('commit');
      if (overrides.commitError) throw overrides.commitError;
      state.set(entry.id, key);
      entries.set(entry.id, {
        id: entry.id,
        displayKey: `${key.slice(0, 9)}…${key.slice(-4)}`,
        createdAt: entry.createdAt
      });
    },
    remove: async (entryId) => {
      events.push('remove');
      const existed = state.delete(entryId);
      entries.delete(entryId);
      return existed;
    },
    getKey: async (entryId) => {
      events.push('getKey');
      return state.get(entryId) || null;
    }
  };
  const manager = createOnlineBackupManager({
    keyring,
    loadSettings: async () => settings,
    appVersion: () => '2.1.31',
    createBackup: (...args) => {
      createArguments = args;
      return { key, record };
    },
    uploadBackup: async (uploadedRecord) => {
      events.push('upload');
      assert.equal(uploadedRecord, record);
      if (overrides.uploadError) throw overrides.uploadError;
    },
    deleteBackup: async (value) => {
      events.push(`delete:${value}`);
      if (overrides.deleteError) throw overrides.deleteError;
      return overrides.deletionOutcome || { deleted: true, notFound: false };
    },
    copyText: (value) => events.push(`copy:${value}`)
  });
  return {
    events,
    keyring,
    manager,
    state,
    get createdAt() {
      return createdAt;
    },
    get createArguments() {
      return createArguments;
    }
  };
}

describe('transactional online backup manager', () => {
  it('creates in prepare, upload, commit order and returns only the sanitized entry', async () => {
    const fixture = createFixture({ initialKey: null });

    const result = await fixture.manager.createManaged();

    assert.deepEqual(fixture.events, ['prepare', 'upload', 'commit']);
    assert.deepEqual(fixture.createArguments, [settings, '2.1.31', fixture.createdAt]);
    assert.match(fixture.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.deepEqual(result, {
      ok: true,
      entry: {
        id,
        displayKey: `${key.slice(0, 9)}…${key.slice(-4)}`,
        createdAt: fixture.createdAt
      }
    });
    assert.equal(JSON.stringify(result).includes(key), false);
  });

  it('keeps a committed create successful without a post-commit keyring read', async () => {
    const fixture = createFixture({ initialKey: null });
    fixture.keyring.list = async () => {
      fixture.events.push('list');
      throw new Error('list unavailable after commit');
    };

    const result = await fixture.manager.createManaged();

    assert.deepEqual(fixture.events, ['prepare', 'upload', 'commit']);
    assert.deepEqual(result, {
      ok: true,
      entry: {
        id,
        displayKey: `${key.slice(0, 9)}…${key.slice(-4)}`,
        createdAt: fixture.createdAt
      }
    });
  });

  it('does not upload when preparing encrypted local state fails', async () => {
    const fixture = createFixture({
      initialKey: null,
      prepareError: new Error(`prepare failed with ${key}`)
    });

    const result = await fixture.manager.createManaged();

    assert.deepEqual(fixture.events, ['prepare']);
    assert.deepEqual(result, { ok: false, error: 'Online-Sicherung konnte nicht erstellt werden' });
    assert.equal(JSON.stringify(result).includes(key), false);
  });

  it('does not commit when the upload fails', async () => {
    const fixture = createFixture({
      initialKey: null,
      uploadError: new Error(`upload failed with ${key}`)
    });

    const result = await fixture.manager.createManaged();

    assert.deepEqual(fixture.events, ['prepare', 'upload']);
    assert.deepEqual(result, { ok: false, error: 'Online-Sicherung konnte nicht erstellt werden' });
    assert.equal(JSON.stringify(result).includes(key), false);
  });

  it('rolls the remote backup back with the in-memory key when commit fails', async () => {
    const fixture = createFixture({
      initialKey: null,
      commitError: new Error(`commit failed with ${key}`)
    });

    const result = await fixture.manager.createManaged();

    assert.deepEqual(fixture.events, ['prepare', 'upload', 'commit', `delete:${key}`]);
    assert.deepEqual(result, { ok: false, error: 'Online-Sicherung konnte nicht erstellt werden' });
    assert.equal(JSON.stringify(result).includes(key), false);
  });

  it('keeps a commit failure sanitized when best-effort rollback also fails', async () => {
    const fixture = createFixture({
      initialKey: null,
      commitError: new Error(`commit failed with ${key}`),
      deleteError: new Error(`rollback failed with ${key}`)
    });

    const result = await fixture.manager.createManaged();

    assert.deepEqual(fixture.events, ['prepare', 'upload', 'commit', `delete:${key}`]);
    assert.deepEqual(result, { ok: false, error: 'Online-Sicherung konnte nicht erstellt werden' });
    assert.equal(JSON.stringify(result).includes(key), false);
  });

  it('decrypts a managed key only inside copy and returns no key', async () => {
    const fixture = createFixture();

    const result = await fixture.manager.copyManaged(id);

    assert.deepEqual(fixture.events, ['getKey', `copy:${key}`]);
    assert.deepEqual(result, { ok: true });
    assert.equal(JSON.stringify(result).includes(key), false);
  });

  it('removes the local entry after a successful remote deletion', async () => {
    const fixture = createFixture();

    const result = await fixture.manager.deleteManaged(id);

    assert.deepEqual(fixture.events, ['getKey', `delete:${key}`, 'remove']);
    assert.deepEqual(result, { ok: true, removedId: id, notFound: false });
    assert.equal(fixture.state.has(id), false);
    assert.equal(JSON.stringify(result).includes(key), false);
  });

  it('removes a stale local entry and reports a missing remote backup', async () => {
    const fixture = createFixture({ deletionOutcome: { deleted: false, notFound: true } });

    const result = await fixture.manager.deleteManaged(id);

    assert.deepEqual(fixture.events, ['getKey', `delete:${key}`, 'remove']);
    assert.deepEqual(result, { ok: true, removedId: id, notFound: true });
    assert.equal(fixture.state.has(id), false);
  });

  it('keeps the local entry when remote deletion fails', async () => {
    const fixture = createFixture({ deleteError: new Error(`network failed with ${key}`) });

    const result = await fixture.manager.deleteManaged(id);

    assert.deepEqual(fixture.events, ['getKey', `delete:${key}`]);
    assert.deepEqual(result, { ok: false, error: 'Online-Sicherung konnte nicht gelöscht werden' });
    assert.equal(fixture.state.has(id), true);
    assert.equal(JSON.stringify(result).includes(key), false);
  });

  it('does not call copy or remote deletion dependencies for unknown IDs', async () => {
    const fixture = createFixture({ initialKey: null });

    const copied = await fixture.manager.copyManaged('unknown-id');
    const deleted = await fixture.manager.deleteManaged('unknown-id');

    assert.deepEqual(fixture.events, ['getKey', 'getKey']);
    assert.deepEqual(copied, {
      ok: false,
      notFound: true,
      error: 'Online-Sicherungsschlüssel wurde nicht gefunden'
    });
    assert.deepEqual(deleted, {
      ok: false,
      notFound: true,
      error: 'Online-Sicherungsschlüssel wurde nicht gefunden'
    });
  });

  it('serializes concurrent create and delete mutations in request order', async () => {
    const fixture = createFixture({ initialKey: null });
    let releaseUpload;
    fixture.manager = createOnlineBackupManager({
      keyring: fixture.keyring,
      loadSettings: async () => settings,
      appVersion: () => '2.1.31',
      createBackup: (_settings, _version, exportedAt) => {
        fixture.createdTimestamp = exportedAt;
        return { key, record };
      },
      uploadBackup: async () => {
        fixture.events.push('upload:start');
        await new Promise((resolve) => {
          releaseUpload = resolve;
        });
        fixture.events.push('upload:end');
      },
      deleteBackup: async (value) => {
        fixture.events.push(`delete:${value}`);
        return { deleted: true, notFound: false };
      },
      copyText: () => {}
    });

    const creating = fixture.manager.createManaged();
    const deleting = fixture.manager.deleteManaged(id);
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(fixture.events, ['prepare', 'upload:start']);
    releaseUpload();
    const [created, deleted] = await Promise.all([creating, deleting]);

    assert.equal(created.ok, true);
    assert.deepEqual(deleted, { ok: true, removedId: id, notFound: false });
    assert.deepEqual(fixture.events, [
      'prepare',
      'upload:start',
      'upload:end',
      'commit',
      'getKey',
      `delete:${key}`,
      'remove'
    ]);
  });

  it('lists sanitized entries and contains dependency failures at the public boundary', async () => {
    const fixture = createFixture();

    assert.deepEqual(await fixture.manager.listManaged(), {
      ok: true,
      entries: [{
        id,
        displayKey: `${key.slice(0, 9)}…${key.slice(-4)}`,
        createdAt: '2026-08-22T10:00:00.000Z'
      }]
    });
    fixture.keyring.list = async () => {
      throw new Error(`list failed with ${key}`);
    };
    const failed = await fixture.manager.listManaged();
    assert.deepEqual(failed, { ok: false, error: 'Online-Sicherungen konnten nicht geladen werden' });
    assert.equal(JSON.stringify(failed).includes(key), false);
  });
});
