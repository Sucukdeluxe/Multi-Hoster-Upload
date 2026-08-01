const crypto = require('crypto');

const MAGIC = Buffer.from('MHU1');
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const ITERATIONS = 100_000;
const DIGEST = 'sha512';
const ALGO = 'aes-256-gcm';

// Fixed app-internal passphrase — backups are opaque without the app, which is
// enough protection for API keys stored locally. We keep the AES-GCM envelope
// (with random salt/iv) so each export is still distinct and authenticated.
const APP_PASSPHRASE = 'multi-hoster-upload::backup::v1';

function deriveKey(passphrase, salt) {
  return crypto.pbkdf2Sync(passphrase, salt, ITERATIONS, KEY_LEN, DIGEST);
}

/**
 * Encrypt a config object.
 * Returns a Buffer: MHU1 | salt(16) | iv(12) | tag(16) | ciphertext
 */
function encrypt(config) {
  const plaintext = Buffer.from(JSON.stringify(config), 'utf-8');
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const key = deriveKey(APP_PASSPHRASE, salt);

  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  plaintext.fill(0);
  key.fill(0);
  return Buffer.concat([MAGIC, salt, iv, tag, encrypted]);
}

/**
 * Decrypt a .mhu buffer.
 * Tries the app's built-in key first; if that fails and a user password is
 * provided, falls back to legacy password-based decryption. Throws a special
 * error with `needsPassword = true` if the app key fails and no password was
 * given, so callers can prompt the user for the legacy password.
 */
function decrypt(buffer, userPassword) {
  if (buffer.length < MAGIC.length + SALT_LEN + IV_LEN + TAG_LEN + 1) {
    throw new Error('Ungültiges Backup-Format');
  }

  const magic = buffer.subarray(0, 4);
  if (!magic.equals(MAGIC)) {
    throw new Error('Keine gültige .mhu Backup-Datei');
  }

  let offset = MAGIC.length;
  const salt = buffer.subarray(offset, offset += SALT_LEN);
  const iv = buffer.subarray(offset, offset += IV_LEN);
  const tag = buffer.subarray(offset, offset += TAG_LEN);
  const ciphertext = buffer.subarray(offset);

  const tryPassphrase = (passphrase) => {
    const key = deriveKey(passphrase, salt);
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    try {
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      const result = JSON.parse(decrypted.toString('utf-8'));
      decrypted.fill(0);
      key.fill(0);
      return result;
    } catch {
      key.fill(0);
      return null;
    }
  };

  // 1) Try the app-internal key (new format, no password required).
  const fromApp = tryPassphrase(APP_PASSPHRASE);
  if (fromApp) return fromApp;

  // 2) Legacy format: user had set their own password.
  if (userPassword) {
    const fromUser = tryPassphrase(userPassword);
    if (fromUser) return fromUser;
    throw new Error('Falsches Passwort oder beschädigte Datei');
  }

  const err = new Error('Dieses Backup wurde mit einem Passwort verschlüsselt');
  err.needsPassword = true;
  throw err;
}

module.exports = { encrypt, decrypt };
