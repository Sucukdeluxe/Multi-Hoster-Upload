const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createOnlineBackupManager } = require('../lib/online-backup-manager');
const { createOnlineBackupKeyring } = require('../lib/online-backup-keyring');
const { createOnlineBackup, parseOnlineBackupKey } = require('../lib/online-backup');

const key = `MHU2-${'K'.repeat(70)}`;
const id = 'managed-backup-id';
const record = { id, blob: 'encrypted-blob', deleteVerifier: 'delete-verifier' };
const settings = { globalSettings: { alwaysOnTop: true } };
const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function createFixture(overrides = {}) {
  const events = [];
  const state = new Map();
  const entries = new Map();
  if (overrides.initialKey !== null) {
    state.set(id, overrides.initialKey || key);
    entries.set(id, {
      id,
      displayKey: `${key.slice(0, 9)}…${key.slice(-4)}`,
      createdAt: '2026-08-22T10:00:00.000Z',
      expiresAt: null
    });
  }
  let createdAt;
  let expiresAt;
  let createArguments;
  const removalPlans = new WeakMap();
  const keyring = {
    list: async () => {
      events.push('list');
      if (overrides.listError) throw overrides.listError;
      return {
        entries: [...entries.values()],
        issues: overrides.listIssues || []
      };
    },
    prepare: (value, timestamp, expiration) => {
      events.push('prepare');
      if (overrides.prepareError) throw overrides.prepareError;
      createdAt = timestamp;
      expiresAt = expiration ?? null;
      return { id, encryptedKey: 'encrypted-key', createdAt: timestamp, expiresAt };
    },
    commit: async (entry) => {
      events.push('commit');
      if (overrides.commitError) throw overrides.commitError;
      state.set(entry.id, key);
      entries.set(entry.id, {
        id: entry.id,
        displayKey: `${key.slice(0, 9)}…${key.slice(-4)}`,
        createdAt: entry.createdAt,
        expiresAt: entry.expiresAt ?? null
      });
    },
    getKey: async (entryId) => {
      events.push('getKey');
      if (overrides.getKeyError) throw overrides.getKeyError;
      return state.get(entryId) || null;
    },
    prepareRemove: async (entryId) => {
      events.push('prepareRemove');
      if (overrides.prepareRemoveError) throw overrides.prepareRemoveError;
      const value = state.get(entryId);
      if (!value) return null;
      const plan = { id: entryId, key: value };
      removalPlans.set(plan, entryId);
      return plan;
    },
    commitRemove: async (plan) => {
      events.push('commitRemove');
      if (overrides.commitRemoveError) throw overrides.commitRemoveError;
      const entryId = removalPlans.get(plan);
      if (!entryId) throw new Error('invalid plan');
      removalPlans.delete(plan);
      state.delete(entryId);
      entries.delete(entryId);
      return true;
    }
  };
  const manager = createOnlineBackupManager({
    keyring,
    loadSettings: async () => settings,
    appVersion: () => '2.1.31',
    createBackup: (...args) => {
      createArguments = args;
      const expiration = args[3] === 'forever' ? null : new Date(new Date(args[2]).getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
      return { key, record, expiresAt: expiration };
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
    get expiresAt() {
      return expiresAt;
    },
    get createArguments() {
      return createArguments;
    }
  };
}

function codedError(code, secret = key) {
  const error = new Error(`failure ${secret}`);
  error.code = code;
  return error;
}

function encrypted(value) {
  return `enc:v1:${Buffer.from(value).toString('base64')}`;
}

function realKeyring(keys) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mhu-manager-keyring-'));
  directories.push(directory);
  const filePath = path.join(directory, 'online-backup-keys.json');
  fs.writeFileSync(filePath, JSON.stringify({ version: 1, keys }));
  return createOnlineBackupKeyring({
    filePath,
    encryptField: encrypted,
    decryptField: value => Buffer.from(value.slice('enc:v1:'.length), 'base64').toString('utf8'),
    isEncrypted: value => typeof value === 'string'
      && value.startsWith('enc:v1:')
      && Buffer.from(value.slice('enc:v1:'.length), 'base64').toString('base64') === value.slice('enc:v1:'.length)
  });
}

function keyWithRecordId(sourceKey, fill) {
  const idBytes = parseOnlineBackupKey(sourceKey).idBytes;
  const masterKey = Buffer.alloc(32, fill);
  const checksum = crypto.createHash('sha256')
    .update(Buffer.from('MHU2-ONLINE-KEY-V1', 'utf8'))
    .update(idBytes)
    .update(masterKey)
    .digest()
    .subarray(0, 4);
  return `MHU2-${Buffer.concat([idBytes, masterKey, checksum]).toString('base64url')}`;
}

function deleteVerifier(value) {
  const parsed = parseOnlineBackupKey(value);
  const deleteSecret = Buffer.from(crypto.hkdfSync(
    'sha256',
    parsed.masterKey,
    parsed.idBytes,
    Buffer.from('MHU-ONLINE-DELETE-V1', 'utf8'),
    32
  ));
  return crypto.createHash('sha256').update(deleteSecret).digest('base64url');
}

describe('transactional online backup manager', () => {
  it('creates in prepare, upload, commit order and returns only the sanitized entry', async () => {
    const fixture = createFixture({ initialKey: null });

    const result = await fixture.manager.createManaged();

    assert.deepEqual(fixture.events, ['prepare', 'upload', 'commit']);
    assert.deepEqual(fixture.createArguments, [settings, '2.1.31', fixture.createdAt, '7d']);
    assert.match(fixture.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.deepEqual(result, {
      ok: true,
      entry: {
        id,
        displayKey: `${key.slice(0, 9)}…${key.slice(-4)}`,
        createdAt: fixture.createdAt,
        expiresAt: fixture.expiresAt
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
        createdAt: fixture.createdAt,
        expiresAt: fixture.expiresAt
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

  it('returns typed sanitized keyring errors instead of a false not-found copy result', async () => {
    const fixture = createFixture({
      getKeyError: codedError('KEYRING_SECURE_STORAGE_UNAVAILABLE')
    });

    const result = await fixture.manager.copyManaged(id);

    assert.deepEqual(result, {
      ok: false,
      code: 'KEYRING_SECURE_STORAGE_UNAVAILABLE',
      error: 'Sichere Schlüsselspeicherung ist nicht verfügbar'
    });
    assert.equal(result.notFound, undefined);
    assert.equal(JSON.stringify(result).includes(key), false);
  });

  it('removes the local entry after a successful remote deletion', async () => {
    const fixture = createFixture();

    const result = await fixture.manager.deleteManaged(id);

    assert.deepEqual(fixture.events, ['prepareRemove', `delete:${key}`, 'commitRemove']);
    assert.deepEqual(result, { ok: true, removedId: id, notFound: false });
    assert.equal(fixture.state.has(id), false);
    assert.equal(JSON.stringify(result).includes(key), false);
  });

  it('removes a stale local entry and reports a missing remote backup', async () => {
    const fixture = createFixture({ deletionOutcome: { deleted: false, notFound: true } });

    const result = await fixture.manager.deleteManaged(id);

    assert.deepEqual(fixture.events, ['prepareRemove', `delete:${key}`, 'commitRemove']);
    assert.deepEqual(result, { ok: true, removedId: id, notFound: true });
    assert.equal(fixture.state.has(id), false);
  });

  it('keeps the local entry when remote deletion fails', async () => {
    const fixture = createFixture({ deleteError: new Error(`network failed with ${key}`) });

    const result = await fixture.manager.deleteManaged(id);

    assert.deepEqual(fixture.events, ['prepareRemove', `delete:${key}`]);
    assert.deepEqual(result, { ok: false, error: 'Online-Sicherung konnte nicht gelöscht werden' });
    assert.equal(fixture.state.has(id), true);
    assert.equal(JSON.stringify(result).includes(key), false);
  });

  it('blocks remote deletion when a valid target has a corrupt neighboring entry', async () => {
    const valid = createOnlineBackup({}, '2.1.31').key;
    const corrupt = createOnlineBackup({}, '2.1.31').key;
    const keyring = realKeyring([
      { id: parseOnlineBackupKey(valid).id, encryptedKey: encrypted(valid), createdAt: '2026-08-22T10:00:00.000Z' },
      { id: parseOnlineBackupKey(corrupt).id, encryptedKey: 'enc:v1:YWJjZA', createdAt: '2026-08-22T11:00:00.000Z' }
    ]);
    let remoteCalls = 0;
    const manager = createOnlineBackupManager({
      keyring,
      loadSettings: async () => settings,
      appVersion: () => '2.1.31',
      deleteBackup: async () => { remoteCalls++; return { deleted: true, notFound: false }; },
      copyText: () => {}
    });

    const result = await manager.deleteManaged(parseOnlineBackupKey(valid).id);

    assert.deepEqual(result, {
      ok: false,
      code: 'KEYRING_STRUCTURE_INVALID',
      error: 'Gespeicherter Online-Schlüsselbund ist beschädigt'
    });
    assert.equal(remoteCalls, 0);
  });

  it('blocks duplicate IDs with different delete verifiers before remote deletion', async () => {
    const first = createOnlineBackup({}, '2.1.31').key;
    const second = keyWithRecordId(first, 0x33);
    const entryId = parseOnlineBackupKey(first).id;
    assert.notEqual(deleteVerifier(first), deleteVerifier(second));
    const keyring = realKeyring([
      { id: entryId, encryptedKey: encrypted(first), createdAt: '2026-08-22T10:00:00.000Z' },
      { id: entryId, encryptedKey: encrypted(second), createdAt: '2026-08-22T11:00:00.000Z' }
    ]);
    let remoteCalls = 0;
    const manager = createOnlineBackupManager({
      keyring,
      loadSettings: async () => settings,
      appVersion: () => '2.1.31',
      deleteBackup: async () => { remoteCalls++; return { deleted: true, notFound: false }; },
      copyText: () => {}
    });

    const result = await manager.deleteManaged(entryId);

    assert.deepEqual(result, {
      ok: false,
      code: 'KEYRING_DUPLICATE_ID',
      error: 'Gespeicherte Online-Sicherungskennung ist mehrdeutig'
    });
    assert.equal(remoteCalls, 0);
  });

  it('does not call copy or remote deletion dependencies for unknown IDs', async () => {
    const fixture = createFixture({ initialKey: null });

    const copied = await fixture.manager.copyManaged('unknown-id');
    const deleted = await fixture.manager.deleteManaged('unknown-id');

    assert.deepEqual(fixture.events, ['getKey', 'prepareRemove']);
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
      'prepareRemove',
      `delete:${key}`,
      'commitRemove'
    ]);
  });

  it('lists sanitized entries and contains dependency failures at the public boundary', async () => {
    const fixture = createFixture();

    assert.deepEqual(await fixture.manager.listManaged(), {
      ok: true,
      entries: [{
        id,
        displayKey: `${key.slice(0, 9)}…${key.slice(-4)}`,
        createdAt: '2026-08-22T10:00:00.000Z',
        expiresAt: null
      }]
    });
    fixture.keyring.list = async () => {
      throw new Error(`list failed with ${key}`);
    };
    const failed = await fixture.manager.listManaged();
    assert.deepEqual(failed, { ok: false, error: 'Online-Sicherungen konnten nicht geladen werden' });
    assert.equal(JSON.stringify(failed).includes(key), false);
  });

  it('keeps readable list entries with a typed warning and never reports damaged nonempty state as empty success', async () => {
    const readable = createFixture({ listIssues: ['KEYRING_DECRYPT_FAILED'] });

    assert.deepEqual(await readable.manager.listManaged(), {
      ok: true,
      entries: [{
        id,
        displayKey: `${key.slice(0, 9)}…${key.slice(-4)}`,
        createdAt: '2026-08-22T10:00:00.000Z',
        expiresAt: null
      }],
      warningCode: 'KEYRING_DECRYPT_FAILED',
      warning: 'Gespeicherter Online-Sicherungsschlüssel konnte nicht entschlüsselt werden'
    });

    const damaged = createFixture({ initialKey: null, listIssues: ['KEYRING_ID_MISMATCH'] });
    assert.deepEqual(await damaged.manager.listManaged(), {
      ok: false,
      entries: [],
      code: 'KEYRING_ID_MISMATCH',
      error: 'Gespeicherte Online-Sicherungskennung stimmt nicht mit dem Schlüssel überein'
    });
  });
});
