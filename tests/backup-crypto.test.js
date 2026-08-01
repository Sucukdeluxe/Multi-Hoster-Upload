const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { encrypt, decrypt } = require('../lib/backup-crypto');

describe('backup-crypto', () => {
  const sampleConfig = {
    hosters: { 'doodstream.com': { enabled: true, apiKey: 'test-key-123' } },
    hosterSettings: { 'doodstream.com': { retries: 3 } },
    globalSettings: { alwaysOnTop: false },
    history: [{ file: 'test.mkv', link: 'https://example.com/abc' }]
  };

  it('encrypt then decrypt round-trips', () => {
    const buf = encrypt(sampleConfig);
    const result = decrypt(buf);
    assert.deepStrictEqual(result, sampleConfig);
  });

  it('decrypt with corrupted data throws', () => {
    const buf = encrypt(sampleConfig);
    buf[buf.length - 1] ^= 0xff; // flip last byte
    // With no password: app-key fails → needsPassword surfaces.
    assert.throws(() => decrypt(buf), (err) => err.needsPassword === true);
    // With a password: both app-key and password fail → Falsches Passwort.
    assert.throws(() => decrypt(buf, 'anything'), /Falsches Passwort/);
  });

  it('decrypt with invalid magic throws', () => {
    // Buffer must be long enough to pass the length check (>= 4+16+12+16+1 = 49)
    const buf = Buffer.alloc(60, 0x41); // 60 bytes of 'A'
    assert.throws(() => decrypt(buf), /Keine gültige/);
  });

  it('decrypt with too-short buffer throws', () => {
    assert.throws(() => decrypt(Buffer.alloc(10)), /Ungültiges Backup-Format/);
  });

  it('handles empty config gracefully', () => {
    const empty = { hosters: {}, hosterSettings: {}, globalSettings: {}, history: [] };
    const buf = encrypt(empty);
    assert.deepStrictEqual(decrypt(buf), empty);
  });

  it('decrypts legacy password-encrypted buffer when password is provided', () => {
    // Reproduce the old format: same envelope, but key derived from user password.
    const crypto = require('crypto');
    const plaintext = Buffer.from(JSON.stringify(sampleConfig), 'utf-8');
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const key = crypto.pbkdf2Sync('oldUserPw', salt, 100_000, 32, 'sha512');
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const legacyBuf = Buffer.concat([Buffer.from('MHU1'), salt, iv, tag, enc]);

    // Without password → should throw needsPassword
    assert.throws(() => decrypt(legacyBuf), (err) => err.needsPassword === true);

    // With correct password → should decrypt
    assert.deepStrictEqual(decrypt(legacyBuf, 'oldUserPw'), sampleConfig);

    // With wrong password → should throw (not needsPassword)
    assert.throws(() => decrypt(legacyBuf, 'wrongPw'), /Falsches Passwort/);
  });

  it('each encryption produces different output (random salt/iv)', () => {
    const a = encrypt(sampleConfig);
    const b = encrypt(sampleConfig);
    assert.ok(!a.equals(b), 'two encryptions should differ');
    // but both decrypt to same result
    assert.deepStrictEqual(decrypt(a), decrypt(b));
  });
});
