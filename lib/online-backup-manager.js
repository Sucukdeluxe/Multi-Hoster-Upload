const {
  createOnlineBackup,
  deleteOnlineBackup,
  uploadOnlineBackup
} = require('./online-backup');

const ERRORS = Object.freeze({
  list: 'Online-Sicherungen konnten nicht geladen werden',
  create: 'Online-Sicherung konnte nicht erstellt werden',
  copy: 'Online-Sicherungsschlüssel konnte nicht kopiert werden',
  delete: 'Online-Sicherung konnte nicht gelöscht werden',
  notFound: 'Online-Sicherungsschlüssel wurde nicht gefunden'
});

function sanitizeEntry(entry) {
  return {
    id: entry.id,
    displayKey: entry.displayKey,
    createdAt: entry.createdAt
  };
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
    const entries = await keyring.list();
    return entries.map(sanitizeEntry);
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
    const entries = await listEntries();
    const entry = entries.find((current) => current.id === prepared.id);
    if (!entry) throw new Error(ERRORS.create);
    return { ok: true, entry };
  }

  async function deleteTransaction(id) {
    const key = await keyring.getKey(id);
    if (!key) return { ok: false, notFound: true, error: ERRORS.notFound };
    const outcome = await deleteBackup(key);
    if (!outcome?.deleted && !outcome?.notFound) throw new Error(ERRORS.delete);
    await keyring.remove(id);
    return { ok: true, removedId: id, notFound: outcome.notFound };
  }

  async function listManaged() {
    try {
      return { ok: true, entries: await listEntries() };
    } catch {
      return { ok: false, error: ERRORS.list };
    }
  }

  async function createManaged() {
    try {
      return await serialize(createTransaction);
    } catch {
      return { ok: false, error: ERRORS.create };
    }
  }

  async function copyManaged(id) {
    try {
      const key = await keyring.getKey(id);
      if (!key) return { ok: false, notFound: true, error: ERRORS.notFound };
      await copyText(key);
      return { ok: true };
    } catch {
      return { ok: false, error: ERRORS.copy };
    }
  }

  async function deleteManaged(id) {
    try {
      return await serialize(() => deleteTransaction(id));
    } catch {
      return { ok: false, error: ERRORS.delete };
    }
  }

  return Object.freeze({ listManaged, createManaged, copyManaged, deleteManaged });
}

module.exports = { createOnlineBackupManager };
