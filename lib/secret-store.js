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

let _safeStorageCache = undefined;
function getSafeStorage() {
  if (_safeStorageCache !== undefined) return _safeStorageCache;
  try {
    const { safeStorage } = require('electron');
    if (safeStorage && typeof safeStorage.isEncryptionAvailable === 'function'
      && safeStorage.isEncryptionAvailable()) {
      _safeStorageCache = safeStorage;
      return _safeStorageCache;
    }
  } catch {}
  _safeStorageCache = null;
  return null;
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(SENTINEL);
}

function encryptField(value) {
  if (!value || typeof value !== 'string') return value;
  if (isEncrypted(value)) return value;
  const ss = getSafeStorage();
  if (!ss) return value;
  try {
    const buf = ss.encryptString(value);
    return SENTINEL + buf.toString('base64');
  } catch {
    return value;
  }
}

function decryptField(value) {
  if (!value || typeof value !== 'string') return value;
  if (!isEncrypted(value)) return value;
  const ss = getSafeStorage();
  if (!ss) return '';
  try {
    const buf = Buffer.from(value.slice(SENTINEL.length), 'base64');
    return ss.decryptString(buf);
  } catch {
    return '';
  }
}

function mapHosterAccounts(config, fn) {
  if (!config || !config.hosters || typeof config.hosters !== 'object') return config;
  for (const accounts of Object.values(config.hosters)) {
    if (!Array.isArray(accounts)) continue;
    for (const acc of accounts) {
      if (!acc || typeof acc !== 'object') continue;
      for (const f of CRED_FIELDS) {
        if (acc[f]) acc[f] = fn(acc[f]);
      }
    }
  }
  return config;
}

function encryptCredentials(config) { return mapHosterAccounts(config, encryptField); }
function decryptCredentials(config) { return mapHosterAccounts(config, decryptField); }

module.exports = { encryptField, decryptField, encryptCredentials, decryptCredentials, isEncrypted };
