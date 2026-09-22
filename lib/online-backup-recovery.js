const crypto = require('node:crypto');

function recoveryPublicKey(pem) {
  if (typeof pem !== 'string' || pem.length > 8192 || !pem.startsWith('-----BEGIN PUBLIC KEY-----')) throw new Error('Ungültiger öffentlicher Wiederherstellungsschlüssel');
  const key = crypto.createPublicKey(pem);
  if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength !== 3072) throw new Error('Wiederherstellung benötigt RSA-3072');
  return key;
}

function fingerprint(key) {
  return crypto.createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('base64url');
}

function wrapBackupKey(key, id, pem) {
  const publicKey = recoveryPublicKey(pem);
  return {
    version: 1,
    keyId: fingerprint(publicKey),
    wrappedKey: crypto.publicEncrypt({ key: publicKey, oaepHash: 'sha256', padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepLabel: Buffer.from(`MHU-RECOVERY-V1:${id}`) }, Buffer.from(key)).toString('base64url')
  };
}

function recoverBackupKey(id, record, privatePem) {
  const { parseOnlineBackupKey, restoreOnlineBackup } = require('./online-backup');
  if (!record?.recovery || record.recovery.version !== 1) throw new Error('Diese Sicherung enthält keine Wiederherstellungsdaten');
  if (record.expiresAt !== null && (!record.expiresAt || !Number.isFinite(Date.parse(record.expiresAt)) || Date.parse(record.expiresAt) <= Date.now())) throw new Error('Die Sicherung ist abgelaufen oder ihr Ablaufdatum ist ungültig');
  const privateKey = crypto.createPrivateKey(privatePem);
  const publicKey = crypto.createPublicKey(privateKey);
  if (record.recovery.keyId !== fingerprint(publicKey)) throw new Error('Der Wiederherstellungsschlüssel gehört nicht zu dieser Sicherung');
  const wrapped = record.recovery.wrappedKey;
  if (typeof wrapped !== 'string' || !/^[A-Za-z0-9_-]{512}$/.test(wrapped)) throw new Error('Ungültige Wiederherstellungsdaten');
  const key = crypto.privateDecrypt({ key: privateKey, oaepHash: 'sha256', padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepLabel: Buffer.from(`MHU-RECOVERY-V1:${id}`) }, Buffer.from(wrapped, 'base64url')).toString('utf8');
  if (parseOnlineBackupKey(key).id !== id) throw new Error('Die Sicherungskennung stimmt nicht überein');
  restoreOnlineBackup(key, record.blob);
  return key;
}

module.exports = { recoveryPublicKey, wrapBackupKey, recoverBackupKey };
