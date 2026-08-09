const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('settings import gate', () => {
  it('blocks upload starts for the complete import transition', () => {
    const { createSettingsImportGate } = require('../lib/settings-import-gate');
    let uploadRunning = false;
    const gate = createSettingsImportGate(() => uploadRunning);

    gate.begin();
    assert.equal(gate.canStartUpload(), false);
    assert.throws(() => gate.begin(), /bereits importiert/i);
    gate.end();
    assert.equal(gate.canStartUpload(), true);

    uploadRunning = true;
    assert.throws(() => gate.begin(), /laufender Uploads/i);
  });
});
