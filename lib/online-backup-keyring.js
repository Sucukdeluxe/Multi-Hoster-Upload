const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const secretStore = require('./secret-store');
const { parseOnlineBackupKey } = require('./online-backup');

const STORED_ENTRY_KEYS = ['createdAt', 'encryptedKey', 'id'];

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeTimestamp(value) {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) throw new Error('Ungültiger Erstellungszeitpunkt');
  return timestamp.toISOString();
}

function createOnlineBackupKeyring({
  filePath,
  encryptField = secretStore.encryptField,
  decryptField = secretStore.decryptField,
  parseKey = parseOnlineBackupKey,
  fsImpl = fs.promises
}) {
  let mutation = Promise.resolve();

  function validateEntry(entry) {
    if (!isObject(entry)) return null;
    const keys = Object.keys(entry).sort();
    if (
      keys.length !== STORED_ENTRY_KEYS.length
      || !keys.every((key, index) => key === STORED_ENTRY_KEYS[index])
      || typeof entry.id !== 'string'
      || !entry.id
      || typeof entry.encryptedKey !== 'string'
      || !entry.encryptedKey
      || typeof entry.createdAt !== 'string'
    ) {
      return null;
    }
    let key;
    let parsed;
    try {
      key = decryptField(entry.encryptedKey);
      parsed = parseKey(key);
    } catch {
      return null;
    }
    if (typeof key !== 'string' || parsed?.id !== entry.id) return null;
    let createdAt;
    try {
      createdAt = normalizeTimestamp(entry.createdAt);
    } catch {
      return null;
    }
    if (createdAt !== entry.createdAt) return null;
    return { id: entry.id, encryptedKey: entry.encryptedKey, createdAt, key };
  }

  async function readEntries(rejectInvalidEntries = false) {
    let contents;
    try {
      contents = await fsImpl.readFile(filePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    let document;
    try {
      document = JSON.parse(contents);
    } catch {
      throw new Error('Gespeicherter Online-Schlüsselbund ist ungültig');
    }
    if (!isObject(document) || document.version !== 1 || !Array.isArray(document.entries)) {
      throw new Error('Gespeicherter Online-Schlüsselbund ist ungültig');
    }
    const entries = document.entries.map(validateEntry);
    if (rejectInvalidEntries && entries.some((entry) => !entry)) {
      throw new Error('Gespeicherter Online-Schlüsselbund ist ungültig');
    }
    return entries.filter(Boolean);
  }

  async function writeEntries(entries) {
    const directory = path.dirname(filePath);
    const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    const document = JSON.stringify({
      version: 1,
      entries: entries.map(({ id, encryptedKey, createdAt }) => ({ id, encryptedKey, createdAt }))
    });
    await fsImpl.mkdir(directory, { recursive: true });
    try {
      await fsImpl.writeFile(temporaryPath, document, { encoding: 'utf8', flag: 'wx' });
      await fsImpl.rename(temporaryPath, filePath);
    } catch (error) {
      try {
        await fsImpl.unlink(temporaryPath);
      } catch (cleanupError) {
        if (cleanupError?.code !== 'ENOENT') throw cleanupError;
      }
      throw error;
    }
  }

  function serialize(operation) {
    const next = mutation.catch(() => {}).then(operation);
    mutation = next;
    return next;
  }

  async function list() {
    const entries = await readEntries();
    const sanitized = entries
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(({ id, key, createdAt }) => Object.freeze({
        id,
        displayKey: `${key.slice(0, 9)}…${key.slice(-4)}`,
        createdAt
      }));
    return Object.freeze(sanitized);
  }

  function prepare(key, createdAt) {
    let parsed;
    let encryptedKey;
    try {
      parsed = parseKey(key);
      encryptedKey = encryptField(key);
    } catch {
      throw new Error('Online-Sicherungsschlüssel konnte nicht sicher vorbereitet werden');
    }
    if (typeof encryptedKey !== 'string' || !encryptedKey || encryptedKey === key) {
      throw new Error('Online-Sicherungsschlüssel konnte nicht sicher vorbereitet werden');
    }
    return Object.freeze({
      id: parsed.id,
      encryptedKey,
      createdAt: normalizeTimestamp(createdAt)
    });
  }

  function commit(entry) {
    return serialize(async () => {
      const validated = validateEntry(entry);
      if (!validated) throw new Error('Online-Sicherungsschlüssel ist ungültig');
      const entries = await readEntries(true);
      if (entries.some((current) => current.id === validated.id)) return;
      await writeEntries([...entries, validated]);
    });
  }

  function remove(id) {
    return serialize(async () => {
      const entries = await readEntries(true);
      const remaining = entries.filter((entry) => entry.id !== id);
      if (remaining.length === entries.length) return false;
      await writeEntries(remaining);
      return true;
    });
  }

  async function getKey(id) {
    const entries = await readEntries();
    return entries.find((entry) => entry.id === id)?.key ?? null;
  }

  return Object.freeze({ list, prepare, commit, remove, getKey });
}

module.exports = { createOnlineBackupKeyring };
