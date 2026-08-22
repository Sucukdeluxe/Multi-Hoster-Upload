const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createOnlineBackup, parseOnlineBackupKey } = require('../lib/online-backup');

const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mhu-keyring-'));
  directories.push(directory);
  const filePath = path.join(directory, 'online-backup-keyring.json');
  const encryptField = options.encryptField || ((value) => `enc:v1:${Buffer.from(value).toString('base64')}`);
  const decryptField = options.decryptField || ((value) => Buffer.from(value.slice('enc:v1:'.length), 'base64').toString('utf8'));
  const { createOnlineBackupKeyring } = require('../lib/online-backup-keyring');
  return {
    directory,
    filePath,
    keyring: createOnlineBackupKeyring({ filePath, encryptField, decryptField, fsImpl: options.fsImpl })
  };
}

function validKey() {
  return createOnlineBackup({}, '2.1.31').key;
}

describe('encrypted online backup keyring', () => {
  it('persists only encrypted keys and returns frozen sanitized entries plus the decrypted key', async () => {
    const { filePath, keyring } = fixture();
    const key = validKey();
    const prepared = keyring.prepare(key, '2026-08-22T10:00:00.000Z');

    await keyring.commit(prepared);

    const listed = await keyring.list();
    assert.equal(fs.readFileSync(filePath, 'utf8').includes(key), false);
    assert.deepEqual(listed, [{
      id: parseOnlineBackupKey(key).id,
      displayKey: `${key.slice(0, 9)}…${key.slice(-4)}`,
      createdAt: '2026-08-22T10:00:00.000Z'
    }]);
    assert.equal(Object.isFrozen(listed), true);
    assert.equal(Object.isFrozen(listed[0]), true);
    assert.equal(await keyring.getKey(prepared.id), key);
  });

  it('throws during prepare without writing when safe encryption is unavailable or fails', () => {
    for (const failure of [
      () => { throw new Error('Sicherer Zugangsdaten-Speicher ist nicht verfügbar'); },
      (value) => { throw new Error(`Verschlüsselung fehlgeschlagen: ${value}`); }
    ]) {
      const { filePath, keyring } = fixture({ encryptField: failure });
      const key = validKey();
      assert.throws(() => keyring.prepare(key, '2026-08-22T10:00:00.000Z'), (error) => !error.message.includes(key));
      assert.equal(fs.existsSync(filePath), false);
    }
  });

  it('sorts newer entries first', async () => {
    const { keyring } = fixture();
    const older = validKey();
    const newer = validKey();

    await keyring.commit(keyring.prepare(older, '2026-08-22T10:00:00.000Z'));
    await keyring.commit(keyring.prepare(newer, '2026-08-22T11:00:00.000Z'));

    assert.deepEqual((await keyring.list()).map((entry) => entry.id), [
      parseOnlineBackupKey(newer).id,
      parseOnlineBackupKey(older).id
    ]);
  });

  it('does not replace the encrypted value or creation timestamp for duplicate IDs', async () => {
    let encryptionCount = 0;
    const encryptField = (value) => `enc:v1:${++encryptionCount}:${Buffer.from(value).toString('base64')}`;
    const decryptField = (value) => Buffer.from(value.split(':').slice(3).join(':'), 'base64').toString('utf8');
    const { filePath, keyring } = fixture({ encryptField, decryptField });
    const key = validKey();
    const first = keyring.prepare(key, '2026-08-22T10:00:00.000Z');
    const duplicate = keyring.prepare(key, '2026-08-22T12:00:00.000Z');

    await keyring.commit(first);
    const original = fs.readFileSync(filePath, 'utf8');
    await keyring.commit(duplicate);

    assert.equal(fs.readFileSync(filePath, 'utf8'), original);
    assert.deepEqual(await keyring.list(), [{
      id: parseOnlineBackupKey(key).id,
      displayKey: `${key.slice(0, 9)}…${key.slice(-4)}`,
      createdAt: '2026-08-22T10:00:00.000Z'
    }]);
  });

  it('removes entries atomically and reports whether an entry existed', async () => {
    const { directory, filePath, keyring } = fixture();
    const key = validKey();
    const prepared = keyring.prepare(key, '2026-08-22T10:00:00.000Z');
    await keyring.commit(prepared);

    assert.equal(await keyring.remove(prepared.id), true);
    assert.equal(await keyring.remove(prepared.id), false);
    assert.deepEqual(await keyring.list(), []);
    assert.deepEqual(fs.readdirSync(directory), [path.basename(filePath)]);
  });

  it('skips invalid entry shapes while listing but blocks mutation for invalid JSON', async () => {
    const { filePath, keyring } = fixture();
    const key = validKey();
    const prepared = keyring.prepare(key, '2026-08-22T10:00:00.000Z');
    fs.writeFileSync(filePath, JSON.stringify({
      version: 1,
      entries: [
        prepared,
        null,
        { id: 7, encryptedKey: 'enc:v1:value', createdAt: '2026-08-22T10:00:00.000Z' },
        { id: prepared.id, encryptedKey: '', createdAt: 'invalid' }
      ]
    }));

    assert.equal((await keyring.list()).length, 1);
    fs.writeFileSync(filePath, '{invalid-json');
    const next = keyring.prepare(validKey(), '2026-08-22T11:00:00.000Z');
    await assert.rejects(keyring.commit(next));
    assert.equal(fs.readFileSync(filePath, 'utf8'), '{invalid-json');
  });

  it('rejects entries with additional properties without legitimizing the unsafe file during mutation', async () => {
    const { filePath, keyring } = fixture();
    const key = validKey();
    const prepared = keyring.prepare(key, '2026-08-22T10:00:00.000Z');
    const contents = JSON.stringify({
      version: 1,
      entries: [{ ...prepared, plaintextKey: key }]
    });
    fs.writeFileSync(filePath, contents);

    await assert.rejects(keyring.commit(prepared));
    assert.equal(fs.readFileSync(filePath, 'utf8'), contents);
    assert.deepEqual(await keyring.list(), []);
  });

  it('keeps the previous valid file readable and removes the temporary file after rename fails', async () => {
    const firstFixture = fixture();
    const firstKey = validKey();
    await firstFixture.keyring.commit(firstFixture.keyring.prepare(firstKey, '2026-08-22T10:00:00.000Z'));
    const original = fs.readFileSync(firstFixture.filePath, 'utf8');
    const fsImpl = {
      ...fs.promises,
      rename: async () => { throw new Error('rename failed'); }
    };
    const { createOnlineBackupKeyring } = require('../lib/online-backup-keyring');
    const keyring = createOnlineBackupKeyring({
      filePath: firstFixture.filePath,
      encryptField: (value) => `enc:v1:${Buffer.from(value).toString('base64')}`,
      decryptField: (value) => Buffer.from(value.slice('enc:v1:'.length), 'base64').toString('utf8'),
      fsImpl
    });
    const secondKey = validKey();

    await assert.rejects(keyring.commit(keyring.prepare(secondKey, '2026-08-22T11:00:00.000Z')), /rename failed/);
    assert.equal(fs.readFileSync(firstFixture.filePath, 'utf8'), original);
    assert.deepEqual(fs.readdirSync(firstFixture.directory), [path.basename(firstFixture.filePath)]);
    assert.equal(await firstFixture.keyring.getKey(parseOnlineBackupKey(firstKey).id), firstKey);
  });

  it('never includes complete plaintext keys in persisted files or mutation errors', async () => {
    const { filePath, keyring } = fixture();
    const firstKey = validKey();
    const secondKey = validKey();
    await keyring.commit(keyring.prepare(firstKey, '2026-08-22T10:00:00.000Z'));
    fs.writeFileSync(filePath, '{invalid-json');

    let error;
    try {
      await keyring.commit(keyring.prepare(secondKey, '2026-08-22T11:00:00.000Z'));
    } catch (caught) {
      error = caught;
    }

    assert.ok(error);
    assert.equal(error.message.includes(firstKey), false);
    assert.equal(error.message.includes(secondKey), false);
    assert.equal(fs.readFileSync(filePath, 'utf8').includes(firstKey), false);
    assert.equal(fs.readFileSync(filePath, 'utf8').includes(secondKey), false);
  });
});
