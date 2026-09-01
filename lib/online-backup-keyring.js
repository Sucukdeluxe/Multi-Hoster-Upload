const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const secretStore = require('./secret-store');
const { parseOnlineBackupKey } = require('./online-backup');

const STORED_LEGACY_ENTRY_KEYS = ['createdAt', 'encryptedKey', 'id'];
const STORED_EXPIRING_ENTRY_KEYS = ['createdAt', 'encryptedKey', 'expiresAt', 'id'];
const STORED_V1_DOCUMENT_KEYS = ['keys', 'version'];
const STORED_GENERATED_DOCUMENT_KEYS = ['generation', 'keys', 'version'];
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
  fsImpl = fs.promises,
  now = () => Date.now()
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

  function isCandidateTemporaryFileName(value) {
    return value.startsWith(temporaryPrefix)
      && /^\d+\.[0-9a-f-]+\.(?:primary|recovery)\.tmp$/u.test(value.slice(temporaryPrefix.length));
  }

  function isOwnedTemporaryFileName(value) {
    return value.startsWith(temporaryPrefix)
      && /^\d+\.[0-9a-f-]+\.(?:primary|recovery|staging)\.tmp$/u.test(value.slice(temporaryPrefix.length));
  }

  function candidatePriority(candidatePath) {
    if (candidatePath === filePath) return 0;
    const name = path.basename(candidatePath);
    if (name.endsWith('.recovery.tmp')) return 1;
    if (name.endsWith('.primary.tmp')) return 2;
    return 3;
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
    if (hasExactKeys(document, STORED_V1_DOCUMENT_KEYS) && document.version === 1 && Array.isArray(document.keys)) {
      return { version: 1, generation: 0, keys: document.keys };
    }
    if (
      hasExactKeys(document, STORED_GENERATED_DOCUMENT_KEYS)
      && document.version === 2
      && Number.isSafeInteger(document.generation)
      && document.generation > 0
      && Array.isArray(document.keys)
    ) {
      return document;
    }
    throw issueError(KEYRING_ERROR_CODES.structure);
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
        if (entry.isFile() && isCandidateTemporaryFileName(entry.name)) candidates.add(path.join(directory, entry.name));
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw issueError(KEYRING_ERROR_CODES.structure);
    }
    return [...candidates].sort((left, right) =>
      candidatePriority(left) - candidatePriority(right)
      || left.localeCompare(right)
    );
  }

  function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (isObject(value)) {
      return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
  }

  function canonicalPayload(document) {
    return canonicalJson({ generation: document.generation, keys: document.keys });
  }

  function validateEntry(entry) {
    const hasLegacyShape = hasExactKeys(entry, STORED_LEGACY_ENTRY_KEYS);
    const hasExpiringShape = hasExactKeys(entry, STORED_EXPIRING_ENTRY_KEYS);
    if (
      (!hasLegacyShape && !hasExpiringShape)
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
    let expiresAt = null;
    if (hasExpiringShape && entry.expiresAt !== null) {
      if (typeof entry.expiresAt !== 'string') return { issue: KEYRING_ERROR_CODES.structure, id: entry.id };
      try {
        expiresAt = normalizeTimestamp(entry.expiresAt);
      } catch {
        return { issue: KEYRING_ERROR_CODES.structure, id: entry.id };
      }
      if (expiresAt !== entry.expiresAt || expiresAt <= createdAt) return { issue: KEYRING_ERROR_CODES.structure, id: entry.id };
    }
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
        expiresAt,
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
    return {
      source,
      version: source.document.version,
      generation: source.document.generation,
      payload: canonicalPayload(source.document),
      entries,
      problems,
      duplicateIds,
      issues
    };
  }

  function selectEquivalentState(states) {
    return [...states].sort((left, right) =>
      candidatePriority(left.source.path) - candidatePriority(right.source.path)
      || left.source.path.localeCompare(right.source.path)
    )[0];
  }

  function selectGeneration(states, generation) {
    const matches = states.filter(state => state.generation === generation);
    if (new Set(matches.map(state => state.payload)).size !== 1) throw issueError(KEYRING_ERROR_CODES.structure);
    return selectEquivalentState(matches);
  }

  function selectLegacyState(states) {
    const primary = states.find(state => state.source.path === filePath);
    if (primary) return primary;
    return [...states].sort((left, right) =>
      right.source.modified - left.source.modified
      || candidatePriority(left.source.path) - candidatePriority(right.source.path)
      || left.source.path.localeCompare(right.source.path)
    )[0];
  }

  async function readState() {
    const paths = [filePath, ...await recoveryCandidates()];
    const states = [];
    let observedCandidate = false;
    for (const candidatePath of paths) {
      const candidate = await readCandidate(candidatePath);
      if (candidate.status === 'missing') continue;
      observedCandidate = true;
      if (candidate.status !== 'valid') continue;
      let modified = 0;
      if (candidate.document.version === 1) {
        try {
          modified = (await fsImpl.stat(candidatePath)).mtimeMs;
        } catch {}
      }
      states.push(inspectSource({ ...candidate, modified, recovered: candidatePath !== filePath }));
    }
    if (states.length === 0) {
      if (observedCandidate) throw issueError(KEYRING_ERROR_CODES.structure);
      const document = { version: 1, generation: 0, keys: [] };
      return inspectSource({
        status: 'valid',
        path: filePath,
        contents: JSON.stringify({ version: 1, keys: [] }),
        document,
        recovered: false
      });
    }
    const generatedStates = states.filter(state => state.version === 2);
    if (generatedStates.length > 0) {
      const highestObservedGeneration = Math.max(...generatedStates.map(state => state.generation));
      selectGeneration(generatedStates, highestObservedGeneration);
      const validGeneratedStates = generatedStates.filter(state => !firstBlockingIssue(state));
      if (validGeneratedStates.length > 0) {
        const highestValidGeneration = Math.max(...validGeneratedStates.map(state => state.generation));
        return selectGeneration(validGeneratedStates, highestValidGeneration);
      }
    }
    const legacyStates = states.filter(state => state.version === 1);
    const validLegacyStates = legacyStates.filter(state => !firstBlockingIssue(state));
    if (validLegacyStates.length > 0) return selectLegacyState(validLegacyStates);
    if (generatedStates.length > 0) {
      const highestObservedGeneration = Math.max(...generatedStates.map(state => state.generation));
      return selectGeneration(generatedStates, highestObservedGeneration);
    }
    return selectLegacyState(legacyStates);
  }

  function firstBlockingIssue(state) {
    return state.issues.find(issue => issue !== KEYRING_ERROR_CODES.recovered) || null;
  }

  function serialize(operation) {
    const next = mutation.catch(() => {}).then(operation);
    mutation = next;
    return next;
  }

  function nextGeneration(generation) {
    if (!Number.isSafeInteger(generation) || generation < 0 || generation >= Number.MAX_SAFE_INTEGER) {
      throw issueError(KEYRING_ERROR_CODES.structure);
    }
    return generation + 1;
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
      if (!entry.isFile() || !isOwnedTemporaryFileName(entry.name) || candidatePath === except) continue;
      await removeFile(candidatePath);
    }
  }

  async function validateStaging(stagingPath, generation, payload) {
    const candidate = await readCandidate(stagingPath);
    if (candidate.status !== 'valid') throw issueError(KEYRING_ERROR_CODES.structure);
    const state = inspectSource({ ...candidate, recovered: false });
    const blockingIssue = firstBlockingIssue(state);
    if (blockingIssue) throw issueError(blockingIssue);
    if (state.generation !== generation || state.payload !== payload) throw issueError(KEYRING_ERROR_CODES.structure);
  }

  async function writeEntries(entries, generation) {
    const contents = JSON.stringify({
      version: 2,
      generation,
      keys: entries.map(({ id, encryptedKey, createdAt, expiresAt }) => ({ id, encryptedKey, createdAt, expiresAt: expiresAt ?? null }))
    });
    const payload = canonicalPayload(parseDocument(contents));
    const stagingPath = temporaryPath('staging');
    const primaryTemporaryPath = temporaryPath('primary');
    const recoveryTemporaryPath = temporaryPath('recovery');
    await fsImpl.mkdir(directory, { recursive: true });
    try {
      await writeAndSync(stagingPath, contents);
      await validateStaging(stagingPath, generation, payload);
      await fsImpl.rename(stagingPath, recoveryTemporaryPath);
    } catch (error) {
      await removeFile(stagingPath);
      throw error;
    }
    let recoveryPath = recoveryTemporaryPath;
    try {
      await writeAndSync(primaryTemporaryPath, contents);
      await fsImpl.rename(primaryTemporaryPath, filePath);
    } catch {}
    try {
      await fsImpl.rename(recoveryTemporaryPath, backupPath);
      recoveryPath = null;
    } catch {}
    try {
      await cleanupTemporaryFiles(recoveryPath);
    } catch {}
  }

  function isExpired(entry) {
    return entry.expiresAt !== null && new Date(entry.expiresAt).getTime() <= Number(now());
  }

  function list() {
    return serialize(async () => {
      const state = await readState();
      const activeEntries = state.entries.filter(entry => !isExpired(entry));
      if (activeEntries.length !== state.entries.length && !firstBlockingIssue(state)) {
        await writeEntries(activeEntries, nextGeneration(state.generation));
      }
      const entries = activeEntries
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .map(({ id, key, createdAt, expiresAt }) => Object.freeze({
          id,
          displayKey: `${key.slice(0, 9)}…${key.slice(-4)}`,
          createdAt,
          expiresAt
        }));
      return Object.freeze({
        entries: Object.freeze(entries),
        issues: Object.freeze([...state.issues])
      });
    });
  }

  function prepare(key, createdAt, expiresAt = null) {
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
    const normalizedCreatedAt = normalizeTimestamp(createdAt);
    const normalizedExpiresAt = expiresAt === null ? null : normalizeTimestamp(expiresAt);
    if (normalizedExpiresAt !== null && normalizedExpiresAt <= normalizedCreatedAt) {
      throw issueError(KEYRING_ERROR_CODES.structure);
    }
    return Object.freeze({
      id: parsed.id,
      encryptedKey,
      createdAt: normalizedCreatedAt,
      expiresAt: normalizedExpiresAt
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
      await writeEntries([...state.entries, validated.entry], nextGeneration(state.generation));
      return true;
    });
  }

  async function getKey(id) {
    const state = await readState();
    if (state.duplicateIds.has(id)) throw issueError(KEYRING_ERROR_CODES.duplicate);
    const entry = state.entries.find(current => current.id === id);
    if (entry && !isExpired(entry)) return entry.key;
    if (entry) return null;
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
    removalPlans.set(plan, true);
    return plan;
  }

  function commitRemove(plan) {
    return serialize(async () => {
      if (!removalPlans.has(plan)) throw issueError(KEYRING_ERROR_CODES.plan);
      const state = await readState();
      const blockingIssue = firstBlockingIssue(state);
      if (blockingIssue) throw issueError(blockingIssue);
      const currentEntry = state.entries.find(current => current.id === plan.id);
      if (!currentEntry) {
        removalPlans.delete(plan);
        return false;
      }
      if (currentEntry.key !== plan.key) {
        removalPlans.delete(plan);
        throw issueError(KEYRING_ERROR_CODES.plan);
      }
      await writeEntries(
        state.entries.filter(current => current.id !== plan.id),
        nextGeneration(state.generation)
      );
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
