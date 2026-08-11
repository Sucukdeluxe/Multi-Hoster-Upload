const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const secretStorePath = require.resolve('../lib/secret-store');

function withSecretStore(safeStorage, action) {
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'electron') return { safeStorage };
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[secretStorePath];
  try {
    return action(require(secretStorePath));
  } finally {
    Module._load = originalLoad;
    delete require.cache[secretStorePath];
  }
}

function availableSafeStorage(overrides = {}) {
  return {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(`protected:${value}`),
    decryptString: value => value.toString().replace(/^protected:/, ''),
    ...overrides
  };
}

test('encrypts and decrypts fields when secure storage is available', () => {
  withSecretStore(availableSafeStorage(), secretStore => {
    const encrypted = secretStore.encryptField('secret');
    assert.match(encrypted, /^enc:v1:/);
    assert.equal(secretStore.decryptField(encrypted), 'secret');
  });
});

test('refuses plaintext storage by default when secure storage is unavailable', () => {
  withSecretStore(null, secretStore => {
    assert.throws(
      () => secretStore.encryptField('secret'),
      error => error instanceof secretStore.SecretStoreError
        && error.code === 'SECRET_STORE_UNAVAILABLE'
    );
  });
});

test('never allows plaintext storage when secure storage is unavailable', () => {
  withSecretStore(null, secretStore => {
    assert.throws(
      () => secretStore.encryptField('secret', { allowPlaintext: true }),
      error => error instanceof secretStore.SecretStoreError
        && error.code === 'SECRET_STORE_UNAVAILABLE'
    );
    const config = { hosters: { example: [{ password: 'secret' }] } };
    assert.throws(
      () => secretStore.encryptCredentials(config, { allowPlaintext: true }),
      error => error instanceof secretStore.SecretStoreError
        && error.code === 'SECRET_STORE_UNAVAILABLE'
    );
  });
});

test('refuses plaintext storage by default when encryption fails', () => {
  const failure = new Error('encryption failed');
  withSecretStore(availableSafeStorage({ encryptString: () => { throw failure; } }), secretStore => {
    assert.throws(
      () => secretStore.encryptField('secret'),
      error => error instanceof secretStore.SecretStoreError
        && error.code === 'SECRET_STORE_ENCRYPT_FAILED'
        && error.cause === failure
    );
    assert.throws(
      () => secretStore.encryptField('secret', { allowPlaintext: true }),
      error => error instanceof secretStore.SecretStoreError
        && error.code === 'SECRET_STORE_ENCRYPT_FAILED'
        && error.cause === failure
    );
  });
});

test('throws an identifiable error for encrypted values without secure storage', () => {
  withSecretStore(null, secretStore => {
    assert.throws(
      () => secretStore.decryptField('enc:v1:cHJvdGVjdGVkOnNlY3JldA=='),
      error => error instanceof secretStore.SecretStoreError
        && error.code === 'SECRET_STORE_UNAVAILABLE'
    );
  });
});

test('throws an identifiable error when decryption fails', () => {
  const failure = new Error('decryption failed');
  withSecretStore(availableSafeStorage({ decryptString: () => { throw failure; } }), secretStore => {
    assert.throws(
      () => secretStore.decryptField('enc:v1:invalid'),
      error => error instanceof secretStore.SecretStoreError
        && error.code === 'SECRET_STORE_DECRYPT_FAILED'
        && error.cause === failure
    );
  });
});

test('keeps legacy plaintext values readable without secure storage', () => {
  withSecretStore(null, secretStore => {
    assert.equal(secretStore.decryptField('legacy-secret'), 'legacy-secret');
  });
});
