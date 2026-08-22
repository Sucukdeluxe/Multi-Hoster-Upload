const {
  createOnlineBackup,
  deleteOnlineBackup,
  uploadOnlineBackup
} = require('./online-backup');
const { KEYRING_ERROR_CODES } = require('./online-backup-keyring');

const ERRORS = Object.freeze({
  list: 'Online-Sicherungen konnten nicht geladen werden',
  create: 'Online-Sicherung konnte nicht erstellt werden',
  copy: 'Online-Sicherungsschlüssel konnte nicht kopiert werden',
  delete: 'Online-Sicherung konnte nicht gelöscht werden',
  notFound: 'Online-Sicherungsschlüssel wurde nicht gefunden'
});
const KEYRING_MESSAGES = Object.freeze({
  [KEYRING_ERROR_CODES.structure]: 'Gespeicherter Online-Schlüsselbund ist beschädigt',
  [KEYRING_ERROR_CODES.unavailable]: 'Sichere Schlüsselspeicherung ist nicht verfügbar',
  [KEYRING_ERROR_CODES.decrypt]: 'Gespeicherter Online-Sicherungsschlüssel konnte nicht entschlüsselt werden',
  [KEYRING_ERROR_CODES.mismatch]: 'Gespeicherte Online-Sicherungskennung stimmt nicht mit dem Schlüssel überein',
  [KEYRING_ERROR_CODES.duplicate]: 'Gespeicherte Online-Sicherungskennung ist mehrdeutig',
  [KEYRING_ERROR_CODES.recovered]: 'Online-Schlüsselbund wurde aus einer Wiederherstellungsdatei geladen',
  [KEYRING_ERROR_CODES.encrypt]: 'Online-Sicherungsschlüssel konnte nicht sicher vorbereitet werden',
  [KEYRING_ERROR_CODES.plan]: 'Online-Sicherung konnte lokal nicht eindeutig entfernt werden'
});

function sanitizeEntry(entry) {
  return {
    id: entry.id,
    displayKey: entry.displayKey,
    createdAt: entry.createdAt
  };
}

function sanitizeCreatedEntry(entry, key) {
  return {
    id: entry.id,
    displayKey: `${key.slice(0, 9)}…${key.slice(-4)}`,
    createdAt: entry.createdAt
  };
}

function keyringFailure(error, fallback) {
  const message = KEYRING_MESSAGES[error?.code];
  if (!message) return { ok: false, error: fallback };
  return { ok: false, code: error.code, error: message };
}

function createOnlineBackupManager({
  keyring,
  loadSettings,
  appVersion,
  createBackup = createOnlineBackup,
  uploadBackup = uploadOnlineBackup,
  deleteBackup = deleteOnlineBackup,
  copyText
}) {
  let mutation = Promise.resolve();

  function serialize(operation) {
    const next = mutation.catch(() => {}).then(operation);
    mutation = next;
    return next;
  }

  async function listEntries() {
    const snapshot = await keyring.list();
    if (!snapshot || !Array.isArray(snapshot.entries) || !Array.isArray(snapshot.issues)) throw new Error(ERRORS.list);
    return {
      entries: snapshot.entries.map(sanitizeEntry),
      issues: snapshot.issues
    };
  }

  async function createTransaction() {
    const createdAt = new Date().toISOString();
    const settings = await loadSettings();
    const created = createBackup(settings, appVersion(), createdAt);
    const prepared = keyring.prepare(created.key, createdAt);
    await uploadBackup(created.record);
    try {
      await keyring.commit(prepared);
    } catch (error) {
      try {
        await deleteBackup(created.key);
      } catch {}
      throw error;
    }
    return { ok: true, entry: sanitizeCreatedEntry(prepared, created.key) };
  }

  async function deleteTransaction(id) {
    const plan = await keyring.prepareRemove(id);
    if (!plan) return { ok: false, notFound: true, error: ERRORS.notFound };
    const outcome = await deleteBackup(plan.key);
    if (!outcome?.deleted && !outcome?.notFound) throw new Error(ERRORS.delete);
    await keyring.commitRemove(plan);
    return { ok: true, removedId: id, notFound: outcome.notFound };
  }

  async function listManaged() {
    try {
      const snapshot = await listEntries();
      const issue = snapshot.issues[0];
      if (!issue) return { ok: true, entries: snapshot.entries };
      const message = KEYRING_MESSAGES[issue] || ERRORS.list;
      if (snapshot.entries.length || issue === KEYRING_ERROR_CODES.recovered) {
        return {
          ok: true,
          entries: snapshot.entries,
          warningCode: issue,
          warning: message
        };
      }
      return { ok: false, entries: [], code: issue, error: message };
    } catch (error) {
      return keyringFailure(error, ERRORS.list);
    }
  }

  async function createManaged() {
    try {
      return await serialize(createTransaction);
    } catch (error) {
      return keyringFailure(error, ERRORS.create);
    }
  }

  async function copyManaged(id) {
    try {
      const key = await keyring.getKey(id);
      if (!key) return { ok: false, notFound: true, error: ERRORS.notFound };
      await copyText(key);
      return { ok: true };
    } catch (error) {
      return keyringFailure(error, ERRORS.copy);
    }
  }

  async function deleteManaged(id) {
    try {
      return await serialize(() => deleteTransaction(id));
    } catch (error) {
      return keyringFailure(error, ERRORS.delete);
    }
  }

  return Object.freeze({ listManaged, createManaged, copyManaged, deleteManaged });
}

module.exports = { createOnlineBackupManager };
