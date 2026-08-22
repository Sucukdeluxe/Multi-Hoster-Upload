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

function writeKeyring(filePath, keys) {
  fs.writeFileSync(filePath, JSON.stringify({ version: 1, keys }));
}

describe('encrypted online backup keyring', () => {
  it('persists the spec keys schema without plaintext and returns frozen sanitized entries', async () => {
    const { filePath, keyring } = fixture();
    const key = validKey();
    const prepared = keyring.prepare(key, timestamp);

    await keyring.commit(prepared);

    const document = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const snapshot = await keyring.list();
    assert.deepEqual(Object.keys(document).sort(), ['keys', 'version']);
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
    let decryptAllowed = true;
    const { keyring } = fixture({
      decryptField: value => {
        if (!decryptAllowed) throw new Error('late revalidation');
        return decrypt(value);
      }
    });
    const removed = validKey();
    const retained = validKey();
    await keyring.commit(keyring.prepare(removed, timestamp));
    await keyring.commit(keyring.prepare(retained, '2026-08-22T11:00:00.000Z'));

    const plan = await keyring.prepareRemove(parseOnlineBackupKey(removed).id);
    decryptAllowed = false;
    assert.equal(plan.id, parseOnlineBackupKey(removed).id);
    assert.equal(plan.key, removed);
    assert.equal(await keyring.commitRemove(plan), true);
    decryptAllowed = true;
    assert.deepEqual((await keyring.list()).entries.map(entry => entry.id), [parseOnlineBackupKey(retained).id]);
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

  it('syncs complete temporary files before atomic replacement and syncs directory metadata', async () => {
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
    assert.equal(renames.length, 2);
    for (const rename of renames) {
      const source = rename.slice('rename:'.length).split('>')[0];
      assert.ok(events.indexOf(`write:${source}`) < events.indexOf(`sync:${source}`));
      assert.ok(events.indexOf(`sync:${source}`) < events.indexOf(`close:${source}`));
      assert.ok(events.indexOf(`close:${source}`) < events.indexOf(rename));
    }
    assert.equal(fs.existsSync(filePath), true);
    assert.equal(fs.existsSync(backupPath), true);
    assert.ok(events.filter(event => event === `sync:${path.basename(path.dirname(filePath))}`).length >= 2);
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

  it('skips a newer cryptographically invalid recovery temp in favor of the validated backup', async () => {
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
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(invalidTemp, future, future);
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

  it('recovers a newer fully synced commit temp after power loss before primary replacement', async () => {
    const first = fixture();
    const older = validKey();
    const newer = validKey();
    const olderEntry = first.keyring.prepare(older, timestamp);
    const newerEntry = first.keyring.prepare(newer, '2026-08-22T11:00:00.000Z');
    await first.keyring.commit(olderEntry);
    const recoveryTemp = path.join(first.directory, `.online-backup-keyring.json.${process.pid}.${crypto.randomUUID()}.recovery.tmp`);
    writeKeyring(recoveryTemp, [olderEntry, newerEntry]);
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(recoveryTemp, future, future);
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

  it('keeps the prior valid state and cleans temporary files when primary replacement fails', async () => {
    const first = fixture();
    const firstKey = validKey();
    await first.keyring.commit(first.keyring.prepare(firstKey, timestamp));
    const original = fs.readFileSync(first.filePath, 'utf8');
    const fsImpl = {
      ...fs.promises,
      rename: async (source, target) => {
        if (target === first.filePath) throw new Error('rename failed');
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

    await assert.rejects(keyring.commit(keyring.prepare(validKey(), '2026-08-22T11:00:00.000Z')), /rename failed/u);
    assert.equal(fs.readFileSync(first.filePath, 'utf8'), original);
    assert.equal(fs.readdirSync(first.directory).some(name => name.endsWith('.tmp')), false);
    assert.equal(await first.keyring.getKey(parseOnlineBackupKey(firstKey).id), firstKey);
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
