const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const secretStore = require('./secret-store');
const { parseOnlineBackupKey } = require('./online-backup');

const STORED_ENTRY_KEYS = ['createdAt', 'encryptedKey', 'id'];
const STORED_DOCUMENT_KEYS = ['keys', 'version'];
const DIRECTORY_SYNC_UNSUPPORTED = new Set(['EACCES', 'EBADF', 'EISDIR', 'EINVAL', 'ENOTSUP', 'EPERM']);
const KEYRING_ERROR_CODES = Object.freeze({
  structure: 'KEYRING_STRUCTURE_INVALID',
  unavailable: 'KEYRING_SECURE_STORAGE_UNAVAILABLE',
  decrypt: 'KEYRING_DECRYPT_FAILED',
  mismatch: 'KEYRING_ID_MISMATCH',
  duplicate: 'KEYRING_DUPLICATE_ID',
  recovered: 'KEYRING_RECOVERED',
  encrypt: 'KEYRING_ENCRYPT_FAILED',
  plan: 'KEYRING_REMOVE_PLAN_INVALID'
});
const ERROR_MESSAGES = Object.freeze({
  [KEYRING_ERROR_CODES.structure]: 'Gespeicherter Online-Schlüsselbund ist beschädigt',
  [KEYRING_ERROR_CODES.unavailable]: 'Sichere Schlüsselspeicherung ist nicht verfügbar',
  [KEYRING_ERROR_CODES.decrypt]: 'Gespeicherter Online-Sicherungsschlüssel konnte nicht entschlüsselt werden',
  [KEYRING_ERROR_CODES.mismatch]: 'Gespeicherte Online-Sicherungskennung stimmt nicht mit dem Schlüssel überein',
  [KEYRING_ERROR_CODES.duplicate]: 'Gespeicherte Online-Sicherungskennung ist mehrdeutig',
  [KEYRING_ERROR_CODES.recovered]: 'Online-Schlüsselbund wurde aus einer Wiederherstellungsdatei geladen',
  [KEYRING_ERROR_CODES.encrypt]: 'Online-Sicherungsschlüssel konnte nicht sicher vorbereitet werden',
  [KEYRING_ERROR_CODES.plan]: 'Online-Sicherung konnte lokal nicht eindeutig entfernt werden'
});
const ISSUE_ORDER = Object.freeze([
  KEYRING_ERROR_CODES.unavailable,
  KEYRING_ERROR_CODES.duplicate,
  KEYRING_ERROR_CODES.decrypt,
  KEYRING_ERROR_CODES.mismatch,
  KEYRING_ERROR_CODES.structure,
  KEYRING_ERROR_CODES.recovered
]);

class OnlineBackupKeyringError extends Error {
  constructor(code) {
    super(ERROR_MESSAGES[code] || ERROR_MESSAGES[KEYRING_ERROR_CODES.structure]);
    this.name = 'OnlineBackupKeyringError';
    this.code = code;
  }
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  if (!isObject(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function isCanonicalId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{22}$/u.test(value)) return false;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.length === 16 && decoded.toString('base64url') === value;
}

function normalizeTimestamp(value) {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) throw new OnlineBackupKeyringError(KEYRING_ERROR_CODES.structure);
  return timestamp.toISOString();
}

function uniqueIssues(issues) {
  const values = [...new Set(issues)];
  values.sort((left, right) => ISSUE_ORDER.indexOf(left) - ISSUE_ORDER.indexOf(right));
  return values;
}

function createOnlineBackupKeyring({
  filePath,
  encryptField = secretStore.encryptField,
  decryptField = secretStore.decryptField,
  isEncrypted = secretStore.isEncrypted,
  parseKey = parseOnlineBackupKey,
  fsImpl = fs.promises
}) {
  const directory = path.dirname(filePath);
  const basename = path.basename(filePath);
  const backupPath = `${filePath}.bak`;
  const temporaryPrefix = `.${basename}.`;
  const removalPlans = new WeakMap();
  let mutation = Promise.resolve();

  function issueError(code) {
    return new OnlineBackupKeyringError(code);
  }

  function isTemporaryFileName(value) {
    return value.startsWith(temporaryPrefix)
      && /^\d+\.[0-9a-f-]+\.(?:primary|recovery)\.tmp$/u.test(value.slice(temporaryPrefix.length));
  }

  function recoveryCandidatePriority(candidatePath) {
    const name = path.basename(candidatePath);
    if (name.endsWith('.recovery.tmp')) return 0;
    if (name.endsWith('.primary.tmp')) return 1;
    return 2;
  }

  function encryptionError(error) {
    return issueError(error?.code === 'SECRET_STORE_UNAVAILABLE' ? KEYRING_ERROR_CODES.unavailable : KEYRING_ERROR_CODES.encrypt);
  }

  function decryptionIssue(error) {
    return error?.code === 'SECRET_STORE_UNAVAILABLE' ? KEYRING_ERROR_CODES.unavailable : KEYRING_ERROR_CODES.decrypt;
  }

  function parseDocument(contents) {
    let document;
    try {
      document = JSON.parse(contents);
    } catch {
      throw issueError(KEYRING_ERROR_CODES.structure);
    }
    if (!hasExactKeys(document, STORED_DOCUMENT_KEYS) || document.version !== 1 || !Array.isArray(document.keys)) {
      throw issueError(KEYRING_ERROR_CODES.structure);
    }
    return document;
  }

  async function readCandidate(candidatePath) {
    try {
      const contents = await fsImpl.readFile(candidatePath, 'utf8');
      return { status: 'valid', path: candidatePath, contents, document: parseDocument(contents) };
    } catch (error) {
      if (error?.code === 'ENOENT') return { status: 'missing', path: candidatePath };
      return { status: 'invalid', path: candidatePath };
    }
  }

  async function recoveryCandidates() {
    const candidates = new Set([backupPath]);
    try {
      const entries = await fsImpl.readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && isTemporaryFileName(entry.name)) candidates.add(path.join(directory, entry.name));
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw issueError(KEYRING_ERROR_CODES.structure);
    }
    const ranked = [];
    for (const candidatePath of candidates) {
      try {
        const stats = await fsImpl.stat(candidatePath);
        ranked.push({
          candidatePath,
          modified: stats.mtimeMs,
          priority: recoveryCandidatePriority(candidatePath)
        });
      } catch (error) {
        if (error?.code !== 'ENOENT') ranked.push({ candidatePath, modified: 0, priority: recoveryCandidatePriority(candidatePath) });
      }
    }
    ranked.sort((left, right) =>
      right.modified - left.modified
      || left.priority - right.priority
      || left.candidatePath.localeCompare(right.candidatePath)
    );
    return ranked.map(candidate => candidate.candidatePath);
  }

  function validateEntry(entry) {
    if (
      !hasExactKeys(entry, STORED_ENTRY_KEYS)
      || !isCanonicalId(entry.id)
      || typeof entry.encryptedKey !== 'string'
      || !isEncrypted(entry.encryptedKey)
      || typeof entry.createdAt !== 'string'
    ) {
      return { issue: KEYRING_ERROR_CODES.structure, id: typeof entry?.id === 'string' ? entry.id : null };
    }
    let createdAt;
    try {
      createdAt = normalizeTimestamp(entry.createdAt);
    } catch {
      return { issue: KEYRING_ERROR_CODES.structure, id: entry.id };
    }
    if (createdAt !== entry.createdAt) return { issue: KEYRING_ERROR_CODES.structure, id: entry.id };
    let key;
    try {
      key = decryptField(entry.encryptedKey);
    } catch (error) {
      return { issue: decryptionIssue(error), id: entry.id };
    }
    if (typeof key !== 'string') return { issue: KEYRING_ERROR_CODES.decrypt, id: entry.id };
    let parsed;
    try {
      parsed = parseKey(key);
    } catch {
      return { issue: KEYRING_ERROR_CODES.decrypt, id: entry.id };
    }
    if (parsed?.id !== entry.id) return { issue: KEYRING_ERROR_CODES.mismatch, id: entry.id };
    return {
      entry: {
        id: entry.id,
        encryptedKey: entry.encryptedKey,
        createdAt,
        key
      }
    };
  }

  function inspectSource(source) {
    const idCounts = new Map();
    for (const entry of source.document.keys) {
      if (isCanonicalId(entry?.id)) idCounts.set(entry.id, (idCounts.get(entry.id) || 0) + 1);
    }
    const duplicateIds = new Set([...idCounts].filter(([, count]) => count > 1).map(([id]) => id));
    const entries = [];
    const problems = [];
    for (const entry of source.document.keys) {
      if (duplicateIds.has(entry?.id)) continue;
      const result = validateEntry(entry);
      if (result.entry) entries.push(result.entry);
      else problems.push({ code: result.issue, id: result.id });
    }
    for (const id of duplicateIds) problems.push({ code: KEYRING_ERROR_CODES.duplicate, id });
    const issues = uniqueIssues([
      ...problems.map(problem => problem.code),
      ...(source.recovered ? [KEYRING_ERROR_CODES.recovered] : [])
    ]);
    return { source, entries, problems, duplicateIds, issues };
  }

  async function readState() {
    const primary = await readCandidate(filePath);
    if (primary.status === 'valid') {
      const primaryState = inspectSource({ ...primary, recovered: false });
      let primaryModified = 0;
      try {
        primaryModified = (await fsImpl.stat(filePath)).mtimeMs;
      } catch {}
      const candidates = await recoveryCandidates();
      if (!firstBlockingIssue(primaryState)) {
        for (const candidatePath of candidates) {
          if (!isTemporaryFileName(path.basename(candidatePath))) continue;
          let candidateModified = 0;
          try {
            candidateModified = (await fsImpl.stat(candidatePath)).mtimeMs;
          } catch {}
          if (candidateModified < primaryModified) continue;
          const candidate = await readCandidate(candidatePath);
          if (candidate.status !== 'valid') continue;
          const state = inspectSource({ ...candidate, recovered: true });
          if (!firstBlockingIssue(state)) return state;
        }
        return primaryState;
      }
      for (const candidatePath of candidates) {
        const candidate = await readCandidate(candidatePath);
        if (candidate.status !== 'valid') continue;
        const state = inspectSource({ ...candidate, recovered: true });
        if (!firstBlockingIssue(state)) return state;
      }
      return primaryState;
    }
    const candidates = await recoveryCandidates();
    let fallback = null;
    for (const candidatePath of candidates) {
      const candidate = await readCandidate(candidatePath);
      if (candidate.status !== 'valid') continue;
      const state = inspectSource({ ...candidate, recovered: true });
      fallback ||= state;
      if (!firstBlockingIssue(state)) return state;
    }
    if (fallback) return fallback;
    if (primary.status === 'missing' && candidates.length === 0) {
      const document = { version: 1, keys: [] };
      return inspectSource({
        status: 'valid',
        path: filePath,
        contents: JSON.stringify(document),
        document,
        recovered: false
      });
    }
    throw issueError(KEYRING_ERROR_CODES.structure);
  }

  function firstBlockingIssue(state) {
    return state.issues.find(issue => issue !== KEYRING_ERROR_CODES.recovered) || null;
  }

  function serialize(operation) {
    const next = mutation.catch(() => {}).then(operation);
    mutation = next;
    return next;
  }

  function temporaryPath(kind) {
    return path.join(directory, `.${basename}.${process.pid}.${crypto.randomUUID()}.${kind}.tmp`);
  }

  async function removeFile(target) {
    try {
      await fsImpl.unlink(target);
    } catch (error) {
      if (error?.code !== 'ENOENT') return false;
    }
    return true;
  }

  async function writeAndSync(target, contents) {
    let handle;
    let failure;
    try {
      handle = await fsImpl.open(target, 'wx', 0o600);
      await handle.writeFile(contents, { encoding: 'utf8' });
      await handle.sync();
    } catch (error) {
      failure = error;
    }
    if (handle) {
      try {
        await handle.close();
      } catch (error) {
        failure ||= error;
      }
    }
    if (failure) throw failure;
  }

  async function syncDirectory() {
    let handle;
    let failure;
    try {
      handle = await fsImpl.open(directory, 'r');
      await handle.sync();
    } catch (error) {
      if (!DIRECTORY_SYNC_UNSUPPORTED.has(error?.code)) failure = error;
    }
    if (handle) {
      try {
        await handle.close();
      } catch (error) {
        if (!DIRECTORY_SYNC_UNSUPPORTED.has(error?.code)) failure ||= error;
      }
    }
    if (failure) throw failure;
  }

  async function cleanupTemporaryFiles(except = null) {
    let entries;
    try {
      entries = await fsImpl.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const candidatePath = path.join(directory, entry.name);
      if (!entry.isFile() || !isTemporaryFileName(entry.name) || candidatePath === except) continue;
      await removeFile(candidatePath);
    }
  }

  async function writeEntries(entries) {
    const contents = JSON.stringify({
      version: 1,
      keys: entries.map(({ id, encryptedKey, createdAt }) => ({ id, encryptedKey, createdAt }))
    });
    const primaryTemporaryPath = temporaryPath('primary');
    const recoveryTemporaryPath = temporaryPath('recovery');
    await fsImpl.mkdir(directory, { recursive: true });
    try {
      await writeAndSync(primaryTemporaryPath, contents);
      await writeAndSync(recoveryTemporaryPath, contents);
      await syncDirectory();
      await fsImpl.rename(primaryTemporaryPath, filePath);
    } catch (error) {
      await removeFile(primaryTemporaryPath);
      await removeFile(recoveryTemporaryPath);
      throw error;
    }
    let recoveryPath = recoveryTemporaryPath;
    try {
      await syncDirectory();
      await fsImpl.rename(recoveryTemporaryPath, backupPath);
      recoveryPath = null;
      await syncDirectory();
    } catch {}
    try {
      await cleanupTemporaryFiles(recoveryPath);
    } catch {}
  }

  async function list() {
    const state = await readState();
    const entries = state.entries
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(({ id, key, createdAt }) => Object.freeze({
        id,
        displayKey: `${key.slice(0, 9)}…${key.slice(-4)}`,
        createdAt
      }));
    return Object.freeze({
      entries: Object.freeze(entries),
      issues: Object.freeze([...state.issues])
    });
  }

  function prepare(key, createdAt) {
    let parsed;
    try {
      parsed = parseKey(key);
    } catch {
      throw issueError(KEYRING_ERROR_CODES.structure);
    }
    let encryptedKey;
    try {
      encryptedKey = encryptField(key);
    } catch (error) {
      throw encryptionError(error);
    }
    if (typeof encryptedKey !== 'string' || encryptedKey === key || !isEncrypted(encryptedKey)) {
      throw issueError(KEYRING_ERROR_CODES.encrypt);
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
      if (!validated.entry) throw issueError(validated.issue);
      const state = await readState();
      const blockingIssue = firstBlockingIssue(state);
      if (blockingIssue) throw issueError(blockingIssue);
      if (state.entries.some(current => current.id === validated.entry.id)) return false;
      await writeEntries([...state.entries, validated.entry]);
      return true;
    });
  }

  async function getKey(id) {
    const state = await readState();
    if (state.duplicateIds.has(id)) throw issueError(KEYRING_ERROR_CODES.duplicate);
    const entry = state.entries.find(current => current.id === id);
    if (entry) return entry.key;
    const matchingProblem = state.problems.find(problem => problem.id === id);
    if (matchingProblem) throw issueError(matchingProblem.code);
    const blockingIssue = firstBlockingIssue(state);
    if (blockingIssue) throw issueError(blockingIssue);
    return null;
  }

  async function prepareRemove(id) {
    const state = await readState();
    const blockingIssue = firstBlockingIssue(state);
    if (blockingIssue) throw issueError(blockingIssue);
    const entry = state.entries.find(current => current.id === id);
    if (!entry) return null;
    const plan = Object.freeze({ id: entry.id, key: entry.key });
    removalPlans.set(plan, state.entries.filter(current => current.id !== id));
    return plan;
  }

  function commitRemove(plan) {
    return serialize(async () => {
      const remaining = removalPlans.get(plan);
      if (!remaining) throw issueError(KEYRING_ERROR_CODES.plan);
      await writeEntries(remaining);
      removalPlans.delete(plan);
      return true;
    });
  }

  async function remove(id) {
    const plan = await prepareRemove(id);
    if (!plan) return false;
    return commitRemove(plan);
  }

  return Object.freeze({ list, prepare, commit, remove, getKey, prepareRemove, commitRemove });
}

module.exports = {
  KEYRING_ERROR_CODES,
  OnlineBackupKeyringError,
  createOnlineBackupKeyring
};
