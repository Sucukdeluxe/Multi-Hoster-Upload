const crypto = require('node:crypto');
const zlib = require('node:zlib');

const ONLINE_BACKUP_API_URL = 'https://uploader.24-music.de/backup-api';
const KEY_PREFIX = 'MHU2-';
const KEY_BODY_LENGTH = 70;
const RECORD_ID_LENGTH = 16;
const MASTER_KEY_LENGTH = 32;
const CHECKSUM_LENGTH = 4;
const NONCE_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const BLOB_VERSION = 1;
const MAX_BLOB_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_PLAINTEXT_BYTES = 512 * 1024;
const REQUEST_TIMEOUT_MS = 12_000;
const KEY_CONTEXT = Buffer.from('MHU2-ONLINE-KEY-V1', 'utf8');
const AAD_CONTEXT = Buffer.from('MHU-ONLINE-BACKUP-V1', 'utf8');

function checksum(idBytes, masterKey) {
  return crypto.createHash('sha256').update(KEY_CONTEXT).update(idBytes).update(masterKey).digest().subarray(0, CHECKSUM_LENGTH);
}

function deriveSecret(masterKey, idBytes, purpose) {
  return Buffer.from(crypto.hkdfSync('sha256', masterKey, idBytes, Buffer.from(`MHU-ONLINE-${purpose}-V1`, 'utf8'), 32));
}

function deriveDeleteSecret(parsed) {
  return deriveSecret(parsed.masterKey, parsed.idBytes, 'DELETE');
}

function aad(idBytes) {
  return Buffer.concat([AAD_CONTEXT, idBytes]);
}

function encodeKey(idBytes, masterKey) {
  const body = Buffer.concat([idBytes, masterKey, checksum(idBytes, masterKey)]).toString('base64url');
  return `${KEY_PREFIX}${body}`;
}

function validatePayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Online-Sicherung enthält keine gültigen Einstellungen');
  }
  if (
    value.version !== 1
    || value.kind !== 'settings-only'
    || typeof value.appVersion !== 'string'
    || typeof value.exportedAt !== 'string'
    || !value.settings
    || typeof value.settings !== 'object'
    || Array.isArray(value.settings)
    || Object.prototype.hasOwnProperty.call(value, 'session')
    || Object.prototype.hasOwnProperty.call(value, 'history')
  ) {
    throw new Error('Online-Sicherung enthält keine gültigen Einstellungen');
  }
  return value;
}

function endpoint(baseUrl, relativePath) {
  const normalized = String(baseUrl || '').trim().replace(/\/+$/, '');
  const url = new URL(`${normalized}${relativePath}`);
  if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    throw new Error('Online-Sicherungen benötigen eine sichere HTTPS-Verbindung');
  }
  return url.toString();
}

async function requestText(url, init, options = {}) {
  const controller = new AbortController();
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : REQUEST_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await (options.fetchImpl || fetch)(url, { ...init, signal: controller.signal });
    const body = await readLimitedText(response);
    return { response, body };
  } catch {
    if (controller.signal.aborted) throw new Error('Online-Sicherungsdienst antwortet nicht');
    throw new Error('Online-Sicherungsdienst ist nicht erreichbar');
  } finally {
    clearTimeout(timer);
  }
}

async function readLimitedText(response) {
  const contentLength = Number(response.headers.get('content-length') || '0');
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new Error('Antwort des Online-Sicherungsdienstes ist zu groß');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('Antwort des Online-Sicherungsdienstes ist zu groß');
    }
    chunks.push(Buffer.from(result.value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseOnlineBackupKey(key) {
  const normalized = String(key || '').trim();
  if (!new RegExp(`^${KEY_PREFIX}[A-Za-z0-9_-]{${KEY_BODY_LENGTH}}$`).test(normalized)) {
    throw new Error('Online-Sicherungsschlüssel ist ungültig');
  }
  const decoded = Buffer.from(normalized.slice(KEY_PREFIX.length), 'base64url');
  if (decoded.length !== RECORD_ID_LENGTH + MASTER_KEY_LENGTH + CHECKSUM_LENGTH) {
    throw new Error('Online-Sicherungsschlüssel ist ungültig');
  }
  if (decoded.toString('base64url') !== normalized.slice(KEY_PREFIX.length)) {
    throw new Error('Online-Sicherungsschlüssel ist ungültig');
  }
  const idBytes = decoded.subarray(0, RECORD_ID_LENGTH);
  const masterKey = decoded.subarray(RECORD_ID_LENGTH, RECORD_ID_LENGTH + MASTER_KEY_LENGTH);
  const actualChecksum = decoded.subarray(RECORD_ID_LENGTH + MASTER_KEY_LENGTH);
  const expectedChecksum = checksum(idBytes, masterKey);
  if (!crypto.timingSafeEqual(actualChecksum, expectedChecksum)) {
    throw new Error('Online-Sicherungsschlüssel ist beschädigt');
  }
  return {
    id: idBytes.toString('base64url'),
    idBytes: Buffer.from(idBytes),
    masterKey: Buffer.from(masterKey)
  };
}

function createOnlineBackup(settings, appVersion, exportedAt = new Date().toISOString()) {
  const idBytes = crypto.randomBytes(RECORD_ID_LENGTH);
  const masterKey = crypto.randomBytes(MASTER_KEY_LENGTH);
  const key = encodeKey(idBytes, masterKey);
  const encryptionKey = deriveSecret(masterKey, idBytes, 'ENCRYPTION');
  const nonce = crypto.randomBytes(NONCE_LENGTH);
  const payload = {
    version: 1,
    kind: 'settings-only',
    appVersion: String(appVersion || ''),
    exportedAt,
    settings: JSON.parse(JSON.stringify(settings))
  };
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  if (plaintext.length > MAX_PLAINTEXT_BYTES) {
    throw new Error('Einstellungen sind für eine Online-Sicherung zu groß');
  }
  const compressed = zlib.gzipSync(plaintext, { level: 9 });
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, nonce, { authTagLength: AUTH_TAG_LENGTH });
  cipher.setAAD(aad(idBytes));
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const blobBytes = Buffer.concat([Buffer.from([BLOB_VERSION]), nonce, cipher.getAuthTag(), ciphertext]);
  if (blobBytes.length > MAX_BLOB_BYTES) {
    throw new Error('Einstellungen sind für eine Online-Sicherung zu groß');
  }
  const parsed = parseOnlineBackupKey(key);
  const deleteVerifier = crypto.createHash('sha256').update(deriveDeleteSecret(parsed)).digest('base64url');
  return {
    key,
    record: {
      id: parsed.id,
      blob: blobBytes.toString('base64url'),
      deleteVerifier
    }
  };
}

function restoreOnlineBackup(key, blob) {
  const parsed = parseOnlineBackupKey(key);
  if (typeof blob !== 'string' || !/^[A-Za-z0-9_-]+$/.test(blob) || blob.length > Math.ceil(MAX_BLOB_BYTES * 4 / 3) + 4) {
    throw new Error('Online-Sicherung ist beschädigt');
  }
  const bytes = Buffer.from(blob, 'base64url');
  if (bytes.toString('base64url') !== blob || bytes.length < 1 + NONCE_LENGTH + AUTH_TAG_LENGTH || bytes[0] !== BLOB_VERSION) {
    throw new Error('Online-Sicherung ist beschädigt');
  }
  const nonce = bytes.subarray(1, 1 + NONCE_LENGTH);
  const tag = bytes.subarray(1 + NONCE_LENGTH, 1 + NONCE_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = bytes.subarray(1 + NONCE_LENGTH + AUTH_TAG_LENGTH);
  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      deriveSecret(parsed.masterKey, parsed.idBytes, 'ENCRYPTION'),
      nonce,
      { authTagLength: AUTH_TAG_LENGTH }
    );
    decipher.setAAD(aad(parsed.idBytes));
    decipher.setAuthTag(tag);
    const compressed = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const plaintext = zlib.gunzipSync(compressed, { maxOutputLength: MAX_PLAINTEXT_BYTES }).toString('utf8');
    return validatePayload(JSON.parse(plaintext));
  } catch (error) {
    if (error instanceof Error && /keine gültigen Einstellungen/.test(error.message)) throw error;
    throw new Error('Online-Sicherung konnte nicht entschlüsselt werden oder ist beschädigt');
  }
}

async function uploadOnlineBackup(record, baseUrl = ONLINE_BACKUP_API_URL, options) {
  const { response } = await requestText(endpoint(baseUrl, '/v1/backups'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(record)
  }, options);
  if (response.status !== 201) throw new Error('Online-Sicherung konnte nicht gespeichert werden');
}

async function downloadOnlineBackup(key, baseUrl = ONLINE_BACKUP_API_URL, options) {
  const parsed = parseOnlineBackupKey(key);
  const { response, body } = await requestText(endpoint(baseUrl, '/v1/backups/restore'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ id: parsed.id })
  }, options);
  if (response.status !== 200) {
    throw new Error(response.status === 404 ? 'Online-Sicherung wurde nicht gefunden' : 'Online-Sicherung konnte nicht geladen werden');
  }
  let value;
  try {
    value = JSON.parse(body);
  } catch {
    throw new Error('Online-Sicherungsdienst hat ungültige Daten geliefert');
  }
  if (typeof value?.blob !== 'string') throw new Error('Online-Sicherungsdienst hat ungültige Daten geliefert');
  return restoreOnlineBackup(key, value.blob);
}

async function deleteOnlineBackup(key, baseUrl = ONLINE_BACKUP_API_URL, options) {
  const parsed = parseOnlineBackupKey(key);
  const deleteSecret = deriveDeleteSecret(parsed).toString('base64url');
  const { response } = await requestText(endpoint(baseUrl, '/v1/backups/delete'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ id: parsed.id, deleteSecret })
  }, options);
  if (response.status === 204) return { deleted: true, notFound: false };
  if (response.status === 404) return { deleted: false, notFound: true };
  throw new Error('Online-Sicherung konnte nicht gelöscht werden');
}

module.exports = {
  ONLINE_BACKUP_API_URL,
  createOnlineBackup,
  deleteOnlineBackup,
  downloadOnlineBackup,
  parseOnlineBackupKey,
  restoreOnlineBackup,
  uploadOnlineBackup
};
