// Wraps Electron's safeStorage (OS-level credential encryption: DPAPI on
// Windows, Keychain on macOS, libsecret on Linux) to keep hoster passwords and
// API keys out of the plaintext electron-config.json.
//
// On Windows the DPAPI key is tied to the current user profile, so credentials
// encrypted here are only readable by the same Windows user. For backups we
// export to plaintext (the .mhu envelope has its own AES-GCM layer) so moving
// between machines/users works transparently.

const SENTINEL = 'enc:v1:';
const CRED_FIELDS = ['password', 'apiKey'];

class SecretStoreError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'SecretStoreError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

let _safeStorageCache = undefined;
async function getSafeStorage() {
  if (_safeStorageCache !== undefined) return _safeStorageCache;
  try {
    const { safeStorage } = require('electron');
    if (safeStorage && typeof safeStorage.isAsyncEncryptionAvailable === 'function'
      && await safeStorage.isAsyncEncryptionAvailable()) {
      _safeStorageCache = safeStorage;
      return _safeStorageCache;
    }
  } catch {}
  return null;
}

function unavailableError() {
  return new SecretStoreError('SECRET_STORE_UNAVAILABLE', 'Sicherer Zugangsdaten-Speicher ist nicht verfügbar');
}

function decryptFailedError(cause) {
  return new SecretStoreError('SECRET_STORE_DECRYPT_FAILED', 'Gespeicherte Zugangsdaten konnten nicht entschlüsselt werden', cause);
}

function isEncrypted(value) {
  if (typeof value !== 'string' || !value.startsWith(SENTINEL)) return false;
  const encoded = value.slice(SENTINEL.length);
  if (!encoded || encoded.length % 4 !== 0) return false;
  const decoded = Buffer.from(encoded, 'base64');
  return decoded.length > 0 && decoded.toString('base64') === encoded;
}

async function encryptField(value) {
  if (!value || typeof value !== 'string') return value;
  if (isEncrypted(value)) return value;
  const ss = await getSafeStorage();
  if (!ss) throw unavailableError();
  try {
    const buf = await ss.encryptStringAsync(value);
    return SENTINEL + Buffer.from(buf).toString('base64');
  } catch (cause) {
    throw new SecretStoreError('SECRET_STORE_ENCRYPT_FAILED', 'Zugangsdaten konnten nicht sicher verschlüsselt werden', cause);
  }
}

async function decryptFieldWithStatus(value) {
  if (!value || typeof value !== 'string') return { value, shouldReEncrypt: false };
  if (!isEncrypted(value)) {
    if (value.startsWith(SENTINEL)) throw decryptFailedError();
    return { value, shouldReEncrypt: false };
  }
  const ss = await getSafeStorage();
  if (!ss) throw unavailableError();
  let decrypted;
  try {
    decrypted = await ss.decryptStringAsync(Buffer.from(value.slice(SENTINEL.length), 'base64'));
  } catch (cause) {
    throw decryptFailedError(cause);
  }
  if (!decrypted || typeof decrypted.result !== 'string') throw decryptFailedError();
  return { value: decrypted.result, shouldReEncrypt: decrypted.shouldReEncrypt === true };
}

async function decryptField(value) {
  return (await decryptFieldWithStatus(value)).value;
}

function credentialSlots(config) {
  const slots = [];
  const cloudLogSync = config?.globalSettings?.cloudLogSync;
  if (cloudLogSync?.apiKey) slots.push([cloudLogSync, 'apiKey']);
  if (!config || !config.hosters || typeof config.hosters !== 'object') return slots;
  for (const accounts of Object.values(config.hosters)) {
    if (!Array.isArray(accounts)) continue;
    for (const acc of accounts) {
      if (!acc || typeof acc !== 'object') continue;
      for (const f of CRED_FIELDS) {
        if (acc[f]) slots.push([acc, f]);
      }
    }
  }
  return slots;
}

async function mapHosterAccounts(config, fn) {
  for (const [owner, field] of credentialSlots(config)) owner[field] = await fn(owner[field]);
  return config;
}

function hasEncryptedCredentials(config) {
  return credentialSlots(config).some(([owner, field]) => typeof owner[field] === 'string' && owner[field].startsWith(SENTINEL));
}

async function encryptCredentials(config) {
  return mapHosterAccounts(config, encryptField);
}

async function decryptCredentials(config) {
  let shouldReEncrypt = false;
  await mapHosterAccounts(config, async value => {
    const decrypted = await decryptFieldWithStatus(value);
    if (decrypted.shouldReEncrypt) shouldReEncrypt = true;
    return decrypted.value;
  });
  return { config, shouldReEncrypt };
}

module.exports = {
  SecretStoreError,
  encryptField,
  decryptField,
  decryptFieldWithStatus,
  encryptCredentials,
  decryptCredentials,
  hasEncryptedCredentials,
  isEncrypted
};
