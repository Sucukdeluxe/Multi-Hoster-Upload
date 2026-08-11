const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Minimal app mock for ConfigStore
function createTestConfigStore() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mhu-test-'));
  const mockApp = {
    isPackaged: false,
    getPath: (name) => tmpDir,
    getPath: () => tmpDir
  };
  const ConfigStore = require('../lib/config-store');
  const store = new ConfigStore(mockApp, { allowPlaintextCredentialStorage: true });
  store.filePath = path.join(tmpDir, 'test-config.json');
  return { store, tmpDir };
}

describe('remote config defaults', () => {
  it('should include remote settings in defaults', () => {
    const { store } = createTestConfigStore();
    const config = store.load();
    const remote = config.globalSettings.remote;

    assert.strictEqual(remote.enabled, false);
    assert.strictEqual(remote.port, 9100);
    assert.strictEqual(typeof remote.token, 'string');
    assert.strictEqual(remote.token, '');
    assert.strictEqual(remote.allowInput, true);
  });

  it('should deep-merge remote settings with existing config', async () => {
    const { store } = createTestConfigStore();
    // Save config with partial remote settings
    await store.save({
      globalSettings: {
        remote: { enabled: true, port: 9200 }
      }
    });

    const config = store.load();
    const remote = config.globalSettings.remote;

    // Saved values preserved
    assert.strictEqual(remote.enabled, true);
    assert.strictEqual(remote.port, 9200);
    // Defaults merged in
    assert.strictEqual(remote.allowInput, true);
    assert.strictEqual(remote.token, '');
  });
});
