const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');

const secretStore = require('../lib/secret-store');
const { createOnlineBackup, parseOnlineBackupKey } = require('../lib/online-backup');

const directories = [];
const timestamp = '2026-08-22T10:00:00.000Z';

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function encrypt(value) {
  return `enc:v1:${Buffer.from(value).toString('base64')}`;
}

function decrypt(value) {
  return Buffer.from(value.slice('enc:v1:'.length), 'base64').toString('utf8');
}

function isCanonicalEnvelope(value) {
  if (typeof value !== 'string' || !value.startsWith('enc:v1:')) return false;
  const encoded = value.slice('enc:v1:'.length);
  if (!encoded || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) return false;
  return Buffer.from(encoded, 'base64').toString('base64') === encoded;
}

function fixture(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mhu-keyring-'));
  directories.push(directory);
  const filePath = path.join(directory, 'online-backup-keyring.json');
  const { createOnlineBackupKeyring } = require('../lib/online-backup-keyring');
  return {
    directory,
    filePath,
    backupPath: `${filePath}.bak`,
    keyring: createOnlineBackupKeyring({
      filePath,
      encryptField: options.encryptField || encrypt,
      decryptField: options.decryptField || decrypt,
      isEncrypted: options.isEncrypted || isCanonicalEnvelope,
      fsImpl: options.fsImpl
    })
  };
}

function validKey() {
  return createOnlineBackup({}, '2.1.31').key;
}

function keyWithRecordId(sourceKey, fill) {
  const idBytes = parseOnlineBackupKey(sourceKey).idBytes;
  const masterKey = Buffer.alloc(32, fill);
  const context = Buffer.from('MHU2-ONLINE-KEY-V1', 'utf8');
  const checksum = crypto.createHash('sha256').update(context).update(idBytes).update(masterKey).digest().subarray(0, 4);
  return `MHU2-${Buffer.concat([idBytes, masterKey, checksum]).toString('base64url')}`;
}

function writeKeyring(filePath, keys, generation = null) {
  const document = generation === null
    ? { version: 1, keys }
    : { version: 2, generation, keys };
  fs.writeFileSync(filePath, JSON.stringify(document));
}

describe('encrypted online backup keyring', () => {
  it('persists the spec keys schema without plaintext and returns frozen sanitized entries', async () => {
    const { filePath, keyring } = fixture();
    const key = validKey();
    const prepared = keyring.prepare(key, timestamp);

    await keyring.commit(prepared);

    const document = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const snapshot = await keyring.list();
    assert.deepEqual(Object.keys(document).sort(), ['generation', 'keys', 'version']);
    assert.equal(document.version, 2);
    assert.equal(document.generation, 1);
    assert.equal(document.keys.length, 1);
    assert.equal(fs.readFileSync(filePath, 'utf8').includes(key), false);
    assert.deepEqual(snapshot.issues, []);
    assert.deepEqual(snapshot.entries, [{
      id: parseOnlineBackupKey(key).id,
      displayKey: `${key.slice(0, 9)}…${key.slice(-4)}`,
      createdAt: timestamp
    }]);
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.entries), true);
    assert.equal(Object.isFrozen(snapshot.entries[0]), true);
    assert.equal(await keyring.getKey(prepared.id), key);
  });

  it('keeps a valid v1 primary authoritative over an older v1 backup and migrates to v2', async () => {
    const { filePath, backupPath, keyring } = fixture();
    const backupKey = validKey();
    const primaryKey = validKey();
    const addedKey = validKey();
    writeKeyring(backupPath, [{
      id: parseOnlineBackupKey(backupKey).id,
      encryptedKey: encrypt(backupKey),
      createdAt: timestamp
    }]);
    writeKeyring(filePath, [{
      id: parseOnlineBackupKey(primaryKey).id,
      encryptedKey: encrypt(primaryKey),
      createdAt: '2026-08-22T11:00:00.000Z'
    }]);

    assert.deepEqual((await keyring.list()).entries.map(entry => entry.id), [parseOnlineBackupKey(primaryKey).id]);
    assert.equal(await keyring.commit(keyring.prepare(addedKey, '2026-08-22T12:00:00.000Z')), true);

    const document = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.deepEqual(Object.keys(document).sort(), ['generation', 'keys', 'version']);
    assert.equal(document.version, 2);
    assert.equal(document.generation, 1);
    assert.equal(fs.readFileSync(filePath, 'utf8').includes(primaryKey), false);
    assert.equal(fs.readFileSync(filePath, 'utf8').includes(backupKey), false);
    assert.equal(fs.readFileSync(filePath, 'utf8').includes(addedKey), false);
    assert.deepEqual((await keyring.list()).entries.map(entry => entry.id), [
      parseOnlineBackupKey(addedKey).id,
      parseOnlineBackupKey(primaryKey).id
    ]);
  });

  it('requires a canonical encrypted envelope before decrypting stored values', async () => {
    const key = validKey();
    const id = parseOnlineBackupKey(key).id;
    for (const encryptedKey of [key, 'enc:v2:YWJjZA==', 'enc:v1:YWJjZA']) {
      let decryptCalls = 0;
      const { filePath, keyring } = fixture({
        decryptField: value => {
          decryptCalls++;
          return value;
        }
      });
      writeKeyring(filePath, [{ id, encryptedKey, createdAt: timestamp }]);

      const snapshot = await keyring.list();

      assert.deepEqual(snapshot.entries, []);
      assert.deepEqual(snapshot.issues, ['KEYRING_STRUCTURE_INVALID']);
      assert.equal(decryptCalls, 0);
    }
  });

  it('rejects plaintext even when the real secret store would pass legacy values through', async () => {
    const { filePath, keyring } = fixture({
      decryptField: secretStore.decryptField,
      isEncrypted: secretStore.isEncrypted
    });
    const key = validKey();
    writeKeyring(filePath, [{ id: parseOnlineBackupKey(key).id, encryptedKey: key, createdAt: timestamp }]);

    assert.equal(secretStore.decryptField(key), key);
    const snapshot = await keyring.list();
    assert.deepEqual(snapshot.entries, []);
    assert.deepEqual(snapshot.issues, ['KEYRING_STRUCTURE_INVALID']);
    await assert.rejects(
      keyring.getKey(parseOnlineBackupKey(key).id),
      error => error.code === 'KEYRING_STRUCTURE_INVALID' && !error.message.includes(key)
    );
  });

  it('types secure-storage, decryption, ID-mismatch, and structure failures without secrets', async () => {
    const key = validKey();
    const otherKey = validKey();
    const cases = [
      {
        expected: 'KEYRING_SECURE_STORAGE_UNAVAILABLE',
        decryptField: () => { throw new secretStore.SecretStoreError('SECRET_STORE_UNAVAILABLE', `unavailable ${key}`); },
        entry: { id: parseOnlineBackupKey(key).id, encryptedKey: encrypt(key), createdAt: timestamp }
      },
      {
        expected: 'KEYRING_DECRYPT_FAILED',
        decryptField: () => { throw new secretStore.SecretStoreError('SECRET_STORE_DECRYPT_FAILED', `decrypt ${key}`); },
        entry: { id: parseOnlineBackupKey(key).id, encryptedKey: encrypt(key), createdAt: timestamp }
      },
      {
        expected: 'KEYRING_ID_MISMATCH',
        decryptField: decrypt,
        entry: { id: parseOnlineBackupKey(otherKey).id, encryptedKey: encrypt(key), createdAt: timestamp }
      },
      {
        expected: 'KEYRING_STRUCTURE_INVALID',
        decryptField: decrypt,
        entry: { id: parseOnlineBackupKey(key).id, encryptedKey: encrypt(key), createdAt: 'not-a-date' }
      }
    ];

    for (const testCase of cases) {
      const { filePath, keyring } = fixture({ decryptField: testCase.decryptField });
      writeKeyring(filePath, [testCase.entry]);
      const snapshot = await keyring.list();
      assert.deepEqual(snapshot.entries, []);
      assert.deepEqual(snapshot.issues, [testCase.expected]);
      assert.equal(JSON.stringify(snapshot).includes(key), false);
      assert.equal(JSON.stringify(snapshot).includes(testCase.entry.encryptedKey), false);
    }
  });

  it('keeps readable entries available while reporting neighboring corruption', async () => {
    const { filePath, keyring } = fixture();
    const readable = validKey();
    const broken = validKey();
    writeKeyring(filePath, [
      { id: parseOnlineBackupKey(readable).id, encryptedKey: encrypt(readable), createdAt: timestamp },
      { id: parseOnlineBackupKey(broken).id, encryptedKey: 'enc:v1:YWJjZA', createdAt: timestamp }
    ]);

    const snapshot = await keyring.list();

    assert.deepEqual(snapshot.entries.map(entry => entry.id), [parseOnlineBackupKey(readable).id]);
    assert.deepEqual(snapshot.issues, ['KEYRING_STRUCTURE_INVALID']);
    assert.equal(await keyring.getKey(parseOnlineBackupKey(readable).id), readable);
    await assert.rejects(
      keyring.getKey(parseOnlineBackupKey(broken).id),
      error => error.code === 'KEYRING_STRUCTURE_INVALID'
    );
  });

  it('does not expose duplicate IDs and blocks an ambiguous removal plan', async () => {
    const { filePath, keyring } = fixture();
    const first = validKey();
    const second = keyWithRecordId(first, 0x5a);
    const id = parseOnlineBackupKey(first).id;
    writeKeyring(filePath, [
      { id, encryptedKey: encrypt(first), createdAt: timestamp },
      { id, encryptedKey: encrypt(second), createdAt: '2026-08-22T11:00:00.000Z' }
    ]);

    const snapshot = await keyring.list();

    assert.deepEqual(snapshot.entries, []);
    assert.deepEqual(snapshot.issues, ['KEYRING_DUPLICATE_ID']);
    await assert.rejects(keyring.getKey(id), error => error.code === 'KEYRING_DUPLICATE_ID');
    await assert.rejects(keyring.prepareRemove(id), error => error.code === 'KEYRING_DUPLICATE_ID');
  });

  it('fully validates a unique removal plan before committing exactly that plan', async () => {
    const { keyring } = fixture();
    const removed = validKey();
    const retained = validKey();
    await keyring.commit(keyring.prepare(removed, timestamp));
    await keyring.commit(keyring.prepare(retained, '2026-08-22T11:00:00.000Z'));

    const plan = await keyring.prepareRemove(parseOnlineBackupKey(removed).id);
    assert.equal(plan.id, parseOnlineBackupKey(removed).id);
    assert.equal(plan.key, removed);
    assert.equal(await keyring.commitRemove(plan), true);
    assert.deepEqual((await keyring.list()).entries.map(entry => entry.id), [parseOnlineBackupKey(retained).id]);
  });

  it('rebases a stale removal plan onto the current state without dropping newer keys', async () => {
    const { filePath, keyring } = fixture();
    const removed = validKey();
    const added = validKey();
    await keyring.commit(keyring.prepare(removed, timestamp));
    const plan = await keyring.prepareRemove(parseOnlineBackupKey(removed).id);
    await keyring.commit(keyring.prepare(added, '2026-08-22T11:00:00.000Z'));

    assert.equal(await keyring.commitRemove(plan), true);

    const document = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(document.version, 2);
    assert.equal(document.generation, 3);
    assert.deepEqual((await keyring.list()).entries.map(entry => entry.id), [parseOnlineBackupKey(added).id]);
    assert.equal(await keyring.getKey(parseOnlineBackupKey(removed).id), null);
  });

  it('treats a stale removal plan whose target is already absent as idempotent', async () => {
    const { keyring } = fixture();
    const removed = validKey();
    await keyring.commit(keyring.prepare(removed, timestamp));
    const stalePlan = await keyring.prepareRemove(parseOnlineBackupKey(removed).id);
    const currentPlan = await keyring.prepareRemove(parseOnlineBackupKey(removed).id);
    assert.equal(await keyring.commitRemove(currentPlan), true);

    assert.equal(await keyring.commitRemove(stalePlan), false);
    assert.deepEqual((await keyring.list()).entries, []);
  });

  it('blocks removal before remote work when any neighboring entry is corrupt', async () => {
    const { filePath, keyring } = fixture();
    const valid = validKey();
    const invalid = validKey();
    writeKeyring(filePath, [
      { id: parseOnlineBackupKey(valid).id, encryptedKey: encrypt(valid), createdAt: timestamp },
      { id: parseOnlineBackupKey(invalid).id, encryptedKey: 'enc:v1:YWJjZA', createdAt: timestamp }
    ]);

    await assert.rejects(
      keyring.prepareRemove(parseOnlineBackupKey(valid).id),
      error => error.code === 'KEYRING_STRUCTURE_INVALID'
    );
  });

  it('does not replace the encrypted value or creation timestamp for duplicate commits', async () => {
    let encryptionCount = 0;
    const encryptField = value => `enc:v1:${Buffer.from(`${++encryptionCount}:${value}`).toString('base64')}`;
    const decryptField = value => Buffer.from(value.slice('enc:v1:'.length), 'base64').toString('utf8').replace(/^\d+:/u, '');
    const { filePath, keyring } = fixture({ encryptField, decryptField });
    const key = validKey();
    const first = keyring.prepare(key, timestamp);
    const duplicate = keyring.prepare(key, '2026-08-22T12:00:00.000Z');

    await keyring.commit(first);
    const original = fs.readFileSync(filePath, 'utf8');
    await keyring.commit(duplicate);

    assert.equal(fs.readFileSync(filePath, 'utf8'), original);
    assert.deepEqual((await keyring.list()).entries, [{
      id: parseOnlineBackupKey(key).id,
      displayKey: `${key.slice(0, 9)}…${key.slice(-4)}`,
      createdAt: timestamp
    }]);
  });

  it('sorts newer entries first', async () => {
    const { keyring } = fixture();
    const older = validKey();
    const newer = validKey();

    await keyring.commit(keyring.prepare(older, timestamp));
    await keyring.commit(keyring.prepare(newer, '2026-08-22T11:00:00.000Z'));

    assert.deepEqual((await keyring.list()).entries.map(entry => entry.id), [
      parseOnlineBackupKey(newer).id,
      parseOnlineBackupKey(older).id
    ]);
  });

  it('returns success after a validated recovery commit when primary publication fails', async () => {
    const first = fixture();
    const older = validKey();
    const newer = validKey();
    await first.keyring.commit(first.keyring.prepare(older, timestamp));
    const fsImpl = {
      ...fs.promises,
      rename: async (source, target) => {
        if (target === first.filePath) throw new Error('primary publication failed');
        return fs.promises.rename(source, target);
      }
    };
    const { createOnlineBackupKeyring } = require('../lib/online-backup-keyring');
    const keyring = createOnlineBackupKeyring({
      filePath: first.filePath,
      encryptField: encrypt,
      decryptField: decrypt,
      isEncrypted: isCanonicalEnvelope,
      fsImpl
    });

    assert.equal(await keyring.commit(keyring.prepare(newer, '2026-08-22T11:00:00.000Z')), true);
    assert.deepEqual((await keyring.list()).entries.map(entry => entry.id), [
      parseOnlineBackupKey(newer).id,
      parseOnlineBackupKey(older).id
    ]);
  });

  it('rejects a recovery staging write failure without exposing the new key', async () => {
    const first = fixture();
    const older = validKey();
    const newer = validKey();
    await first.keyring.commit(first.keyring.prepare(older, timestamp));
    const fsImpl = {
      ...fs.promises,
      open: async (target, flags, mode) => {
        const handle = await fs.promises.open(target, flags, mode);
        if (!String(target).endsWith('.staging.tmp')) return handle;
        return {
          writeFile: async () => { throw new Error('recovery staging write failed'); },
          sync: () => handle.sync(),
          close: () => handle.close()
        };
      },
      unlink: async target => {
        if (String(target).endsWith('.staging.tmp')) throw Object.assign(new Error('staging cleanup failed'), { code: 'EBUSY' });
        return fs.promises.unlink(target);
      }
    };
    const { createOnlineBackupKeyring } = require('../lib/online-backup-keyring');
    const keyring = createOnlineBackupKeyring({
      filePath: first.filePath,
      encryptField: encrypt,
      decryptField: decrypt,
      isEncrypted: isCanonicalEnvelope,
      fsImpl
    });

    await assert.rejects(
      keyring.commit(keyring.prepare(newer, '2026-08-22T11:00:00.000Z')),
      /recovery staging write failed/u
    );
    assert.equal(fs.readdirSync(first.directory).some(name => name.endsWith('.staging.tmp')), true);
    assert.equal(fs.readdirSync(first.directory).some(name => name.endsWith('.recovery.tmp')), false);
    assert.deepEqual((await keyring.list()).entries.map(entry => entry.id), [parseOnlineBackupKey(older).id]);
    assert.equal(await keyring.getKey(parseOnlineBackupKey(newer).id), null);
  });

  it('rejects a recovery staging revalidation mismatch before publishing a candidate', async () => {
    const first = fixture();
    const older = validKey();
    const newer = validKey();
    await first.keyring.commit(first.keyring.prepare(older, timestamp));
    const fsImpl = {
      ...fs.promises,
      readFile: async (target, encoding) => {
        const contents = await fs.promises.readFile(target, encoding);
        if (!String(target).endsWith('.staging.tmp')) return contents;
        const document = JSON.parse(contents);
        document.generation++;
        return JSON.stringify(document);
      },
      unlink: async target => {
        if (String(target).endsWith('.staging.tmp')) throw Object.assign(new Error('staging cleanup failed'), { code: 'EBUSY' });
        return fs.promises.unlink(target);
      }
    };
    const { createOnlineBackupKeyring } = require('../lib/online-backup-keyring');
    const keyring = createOnlineBackupKeyring({
      filePath: first.filePath,
      encryptField: encrypt,
      decryptField: decrypt,
      isEncrypted: isCanonicalEnvelope,
      fsImpl
    });

    await assert.rejects(
      keyring.commit(keyring.prepare(newer, '2026-08-22T11:00:00.000Z')),
      error => error.code === 'KEYRING_STRUCTURE_INVALID'
    );
    assert.equal(fs.readdirSync(first.directory).some(name => name.endsWith('.staging.tmp')), true);
    assert.equal(fs.readdirSync(first.directory).some(name => name.endsWith('.recovery.tmp')), false);
    assert.equal(await keyring.getKey(parseOnlineBackupKey(newer).id), null);
  });

  it('cannot throw and later expose a rolled-back key when cleanup fails', async () => {
    const first = fixture();
    const older = validKey();
    const newer = validKey();
    await first.keyring.commit(first.keyring.prepare(older, timestamp));
    let readdirCalls = 0;
    const fsImpl = {
      ...fs.promises,
      readdir: async (...args) => {
        readdirCalls++;
        if (readdirCalls === 2) throw Object.assign(new Error('cleanup failed'), { code: 'EIO' });
        return fs.promises.readdir(...args);
      },
      rename: async (source, target) => {
        if (target === first.filePath || target === first.backupPath) throw new Error('publication failed');
        return fs.promises.rename(source, target);
      }
    };
    const { createOnlineBackupKeyring } = require('../lib/online-backup-keyring');
    const keyring = createOnlineBackupKeyring({
      filePath: first.filePath,
      encryptField: encrypt,
      decryptField: decrypt,
      isEncrypted: isCanonicalEnvelope,
      fsImpl
    });

    assert.equal(await keyring.commit(keyring.prepare(newer, '2026-08-22T11:00:00.000Z')), true);
    assert.equal(await keyring.getKey(parseOnlineBackupKey(newer).id), newer);
  });

  it('file-syncs and revalidates recovery staging before best-effort publication', async () => {
    const events = [];
    const fsImpl = {
      ...fs.promises,
      open: async (target, flags, mode) => {
        const handle = await fs.promises.open(target, flags, mode);
        const label = path.basename(String(target));
        return {
          writeFile: async (...args) => {
            events.push(`write:${label}`);
            return handle.writeFile(...args);
          },
          sync: async () => {
            events.push(`sync:${label}`);
            return handle.sync();
          },
          close: async () => {
            events.push(`close:${label}`);
            return handle.close();
          }
        };
      },
      rename: async (source, target) => {
        events.push(`rename:${path.basename(source)}>${path.basename(target)}`);
        return fs.promises.rename(source, target);
      }
    };
    const { filePath, backupPath, keyring } = fixture({ fsImpl });

    await keyring.commit(keyring.prepare(validKey(), timestamp));

    const renames = events.filter(event => event.startsWith('rename:'));
    assert.equal(renames.length, 3);
    const stagingRename = renames.find(rename => rename.includes('.staging.tmp>') && rename.endsWith('.recovery.tmp'));
    const primaryRename = renames.find(rename => rename.includes('.primary.tmp>') && rename.endsWith(`>${path.basename(filePath)}`));
    const backupRename = renames.find(rename => rename.includes('.recovery.tmp>') && rename.endsWith(`>${path.basename(backupPath)}`));
    const stagingSource = stagingRename.slice('rename:'.length).split('>')[0];
    const primarySource = primaryRename.slice('rename:'.length).split('>')[0];
    assert.ok(events.indexOf(`write:${stagingSource}`) < events.indexOf(`sync:${stagingSource}`));
    assert.ok(events.indexOf(`sync:${stagingSource}`) < events.indexOf(`close:${stagingSource}`));
    assert.ok(events.indexOf(`close:${stagingSource}`) < events.indexOf(stagingRename));
    assert.ok(events.indexOf(stagingRename) < events.indexOf(`write:${primarySource}`));
    assert.ok(events.indexOf(`close:${primarySource}`) < events.indexOf(primaryRename));
    assert.ok(events.indexOf(stagingRename) < events.indexOf(backupRename));
    assert.equal(fs.existsSync(filePath), true);
    assert.equal(fs.existsSync(backupPath), true);
  });

  it('does not depend on a Windows directory fsync commit boundary', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mhu-keyring-'));
    directories.push(directory);
    const filePath = path.join(directory, 'online-backup-keyring.json');
    let directoryOpens = 0;
    const fsImpl = {
      ...fs.promises,
      open: async (target, flags, mode) => {
        const handle = await fs.promises.open(target, flags, mode);
        if (path.resolve(String(target)) !== path.resolve(directory)) return handle;
        directoryOpens++;
        return {
          sync: async () => { throw Object.assign(new Error('unsupported'), { code: 'EPERM' }); },
          close: () => handle.close()
        };
      }
    };
    const { createOnlineBackupKeyring } = require('../lib/online-backup-keyring');
    const keyring = createOnlineBackupKeyring({
      filePath,
      encryptField: encrypt,
      decryptField: decrypt,
      isEncrypted: isCanonicalEnvelope,
      fsImpl
    });

    assert.equal(await keyring.commit(keyring.prepare(validKey(), timestamp)), true);
    assert.equal(directoryOpens, 0);
  });

  it('rejects unsafe or loose v2 generation documents', async () => {
    const key = validKey();
    const entry = { id: parseOnlineBackupKey(key).id, encryptedKey: encrypt(key), createdAt: timestamp };
    for (const generation of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1']) {
      const { filePath, keyring } = fixture();
      fs.writeFileSync(filePath, JSON.stringify({ version: 2, generation, keys: [entry] }));
      await assert.rejects(keyring.list(), error => error.code === 'KEYRING_STRUCTURE_INVALID');
    }
    const { filePath, keyring } = fixture();
    fs.writeFileSync(filePath, JSON.stringify({ version: 2, generation: 1, keys: [entry], extra: true }));
    await assert.rejects(keyring.list(), error => error.code === 'KEYRING_STRUCTURE_INVALID');
  });

  it('recovers a validated backup without presenting corruption as an empty keyring', async () => {
    const first = fixture();
    const key = validKey();
    await first.keyring.commit(first.keyring.prepare(key, timestamp));
    fs.writeFileSync(first.filePath, '{damaged-primary');
    const { createOnlineBackupKeyring } = require('../lib/online-backup-keyring');
    const recovered = createOnlineBackupKeyring({
      filePath: first.filePath,
      encryptField: encrypt,
      decryptField: decrypt,
      isEncrypted: isCanonicalEnvelope
    });

    const snapshot = await recovered.list();

    assert.deepEqual(snapshot.entries.map(entry => entry.id), [parseOnlineBackupKey(key).id]);
    assert.deepEqual(snapshot.issues, ['KEYRING_RECOVERED']);
  });

  it('recovers a valid v1 backup when the v1 primary is cryptographically unusable', async () => {
    const first = fixture();
    const backupKey = validKey();
    const brokenKey = validKey();
    writeKeyring(first.backupPath, [{
      id: parseOnlineBackupKey(backupKey).id,
      encryptedKey: encrypt(backupKey),
      createdAt: timestamp
    }]);
    writeKeyring(first.filePath, [{
      id: parseOnlineBackupKey(brokenKey).id,
      encryptedKey: 'enc:v1:YWJjZA==',
      createdAt: '2026-08-22T11:00:00.000Z'
    }]);

    const snapshot = await first.keyring.list();

    assert.deepEqual(snapshot.entries.map(entry => entry.id), [parseOnlineBackupKey(backupKey).id]);
    assert.deepEqual(snapshot.issues, ['KEYRING_RECOVERED']);
    assert.equal(JSON.stringify(snapshot).includes(backupKey), false);
    assert.equal(JSON.stringify(snapshot).includes(brokenKey), false);
  });

  it('loads a valid v1 backup when no primary exists', async () => {
    const first = fixture();
    const backupKey = validKey();
    writeKeyring(first.backupPath, [{
      id: parseOnlineBackupKey(backupKey).id,
      encryptedKey: encrypt(backupKey),
      createdAt: timestamp
    }]);

    const snapshot = await first.keyring.list();

    assert.deepEqual(snapshot.entries.map(entry => entry.id), [parseOnlineBackupKey(backupKey).id]);
    assert.deepEqual(snapshot.issues, ['KEYRING_RECOVERED']);
    assert.equal(JSON.stringify(snapshot).includes(backupKey), false);
  });

  it('uses modification time only to choose among valid v1 recovery candidates', async () => {
    const first = fixture();
    const backupKey = validKey();
    const recoveryKey = validKey();
    fs.writeFileSync(first.filePath, '{broken-primary');
    writeKeyring(first.backupPath, [{
      id: parseOnlineBackupKey(backupKey).id,
      encryptedKey: encrypt(backupKey),
      createdAt: timestamp
    }]);
    const recoveryTemp = path.join(first.directory, `.online-backup-keyring.json.${process.pid}.${crypto.randomUUID()}.recovery.tmp`);
    writeKeyring(recoveryTemp, [{
      id: parseOnlineBackupKey(recoveryKey).id,
      encryptedKey: encrypt(recoveryKey),
      createdAt: '2026-08-22T11:00:00.000Z'
    }]);
    const older = new Date('2026-08-22T12:00:00.000Z');
    const newer = new Date('2026-08-22T13:00:00.000Z');
    fs.utimesSync(first.backupPath, older, older);
    fs.utimesSync(recoveryTemp, newer, newer);

    const snapshot = await first.keyring.list();

    assert.deepEqual(snapshot.entries.map(entry => entry.id), [parseOnlineBackupKey(recoveryKey).id]);
    assert.deepEqual(snapshot.issues, ['KEYRING_RECOVERED']);
    assert.equal(JSON.stringify(snapshot).includes(backupKey), false);
    assert.equal(JSON.stringify(snapshot).includes(recoveryKey), false);
  });

  it('recovers a cryptographically valid backup when the primary only passes structural validation', async () => {
    const first = fixture();
    const key = validKey();
    await first.keyring.commit(first.keyring.prepare(key, timestamp));
    writeKeyring(first.filePath, [{
      id: parseOnlineBackupKey(key).id,
      encryptedKey: 'enc:v1:YWJjZA',
      createdAt: timestamp
    }]);
    const { createOnlineBackupKeyring } = require('../lib/online-backup-keyring');
    const recovered = createOnlineBackupKeyring({
      filePath: first.filePath,
      encryptField: encrypt,
      decryptField: decrypt,
      isEncrypted: isCanonicalEnvelope
    });

    const snapshot = await recovered.list();

    assert.deepEqual(snapshot.entries.map(entry => entry.id), [parseOnlineBackupKey(key).id]);
    assert.deepEqual(snapshot.issues, ['KEYRING_RECOVERED']);
    assert.equal(await recovered.getKey(parseOnlineBackupKey(key).id), key);
  });

  it('selects the highest valid generation regardless of equal modification times', async () => {
    const first = fixture();
    const older = validKey();
    const newer = validKey();
    const olderEntry = first.keyring.prepare(older, timestamp);
    const newerEntry = first.keyring.prepare(newer, '2026-08-22T11:00:00.000Z');
    writeKeyring(first.filePath, [olderEntry, newerEntry], 2);
    const staleTemp = path.join(first.directory, `.online-backup-keyring.json.${process.pid}.${crypto.randomUUID()}.recovery.tmp`);
    writeKeyring(staleTemp, [olderEntry], 1);
    const sameTime = new Date('2026-08-22T12:00:00.000Z');
    fs.utimesSync(first.filePath, sameTime, sameTime);
    fs.utimesSync(staleTemp, sameTime, sameTime);

    assert.deepEqual((await first.keyring.list()).entries.map(entry => entry.id), [
      parseOnlineBackupKey(newer).id,
      parseOnlineBackupKey(older).id
    ]);
    assert.deepEqual((await first.keyring.list()).issues, []);
  });

  it('selects a higher-generation recovery candidate over an equal-time primary', async () => {
    const first = fixture();
    const older = validKey();
    const newer = validKey();
    const olderEntry = first.keyring.prepare(older, timestamp);
    const newerEntry = first.keyring.prepare(newer, '2026-08-22T11:00:00.000Z');
    writeKeyring(first.filePath, [olderEntry], 1);
    const recoveryTemp = path.join(first.directory, `.online-backup-keyring.json.${process.pid}.${crypto.randomUUID()}.recovery.tmp`);
    writeKeyring(recoveryTemp, [olderEntry, newerEntry], 2);
    const sameTime = new Date('2026-08-22T12:00:00.000Z');
    fs.utimesSync(first.filePath, sameTime, sameTime);
    fs.utimesSync(recoveryTemp, sameTime, sameTime);

    const snapshot = await first.keyring.list();

    assert.deepEqual(snapshot.entries.map(entry => entry.id), [
      parseOnlineBackupKey(newer).id,
      parseOnlineBackupKey(older).id
    ]);
    assert.deepEqual(snapshot.issues, ['KEYRING_RECOVERED']);
  });

  it('blocks conflicting v2 canonical payloads at the same positive generation', async () => {
    const first = fixture();
    const primaryKey = validKey();
    const backupKey = validKey();
    writeKeyring(first.filePath, [{
      id: parseOnlineBackupKey(primaryKey).id,
      encryptedKey: encrypt(primaryKey),
      createdAt: timestamp
    }], 4);
    writeKeyring(first.backupPath, [{
      id: parseOnlineBackupKey(backupKey).id,
      encryptedKey: encrypt(backupKey),
      createdAt: timestamp
    }], 4);

    await assert.rejects(
      first.keyring.list(),
      error => error.code === 'KEYRING_STRUCTURE_INVALID'
    );
  });

  it('skips a cryptographically invalid recovery temp in favor of the validated backup', async () => {
    const first = fixture();
    const key = validKey();
    await first.keyring.commit(first.keyring.prepare(key, timestamp));
    fs.writeFileSync(first.filePath, '{damaged-primary');
    const invalidTemp = path.join(first.directory, `.online-backup-keyring.json.${process.pid}.${crypto.randomUUID()}.recovery.tmp`);
    writeKeyring(invalidTemp, [{
      id: parseOnlineBackupKey(key).id,
      encryptedKey: 'enc:v1:YWJjZA',
      createdAt: timestamp
    }]);
    const { createOnlineBackupKeyring } = require('../lib/online-backup-keyring');
    const recovered = createOnlineBackupKeyring({
      filePath: first.filePath,
      encryptField: encrypt,
      decryptField: decrypt,
      isEncrypted: isCanonicalEnvelope
    });

    const snapshot = await recovered.list();

    assert.deepEqual(snapshot.entries.map(entry => entry.id), [parseOnlineBackupKey(key).id]);
    assert.deepEqual(snapshot.issues, ['KEYRING_RECOVERED']);
  });

  it('recovers a higher-generation commit temp after power loss before primary replacement', async () => {
    const first = fixture();
    const older = validKey();
    const newer = validKey();
    const olderEntry = first.keyring.prepare(older, timestamp);
    const newerEntry = first.keyring.prepare(newer, '2026-08-22T11:00:00.000Z');
    await first.keyring.commit(olderEntry);
    const recoveryTemp = path.join(first.directory, `.online-backup-keyring.json.${process.pid}.${crypto.randomUUID()}.recovery.tmp`);
    writeKeyring(recoveryTemp, [olderEntry, newerEntry], 2);
    const { createOnlineBackupKeyring } = require('../lib/online-backup-keyring');
    const recovered = createOnlineBackupKeyring({
      filePath: first.filePath,
      encryptField: encrypt,
      decryptField: decrypt,
      isEncrypted: isCanonicalEnvelope
    });

    const snapshot = await recovered.list();

    assert.deepEqual(snapshot.entries.map(entry => entry.id), [
      parseOnlineBackupKey(newer).id,
      parseOnlineBackupKey(older).id
    ]);
    assert.deepEqual(snapshot.issues, ['KEYRING_RECOVERED']);
  });

  it('commits successfully once the primary is published even when later cleanup fails', async () => {
    const first = fixture();
    const firstKey = validKey();
    const secondKey = validKey();
    await first.keyring.commit(first.keyring.prepare(firstKey, timestamp));
    let readdirCalls = 0;
    const fsImpl = {
      ...fs.promises,
      readdir: async (...args) => {
        readdirCalls++;
        if (readdirCalls === 2) throw Object.assign(new Error('cleanup failed'), { code: 'EIO' });
        return fs.promises.readdir(...args);
      }
    };
    const { createOnlineBackupKeyring } = require('../lib/online-backup-keyring');
    const keyring = createOnlineBackupKeyring({
      filePath: first.filePath,
      encryptField: encrypt,
      decryptField: decrypt,
      isEncrypted: isCanonicalEnvelope,
      fsImpl
    });

    assert.equal(await keyring.commit(keyring.prepare(secondKey, '2026-08-22T11:00:00.000Z')), true);
    assert.equal(await keyring.getKey(parseOnlineBackupKey(secondKey).id), secondKey);
    assert.deepEqual((await keyring.list()).entries.map(entry => entry.id), [
      parseOnlineBackupKey(secondKey).id,
      parseOnlineBackupKey(firstKey).id
    ]);
  });

  it('types invalid documents and never includes plaintext or ciphertext in errors', async () => {
    const { filePath, backupPath, keyring } = fixture();
    const key = validKey();
    fs.writeFileSync(filePath, `{invalid-${key}`);
    fs.writeFileSync(backupPath, '{invalid-backup');

    await assert.rejects(
      keyring.list(),
      error => error.code === 'KEYRING_STRUCTURE_INVALID'
        && !error.message.includes(key)
        && !error.message.includes('invalid-backup')
    );
  });
});
