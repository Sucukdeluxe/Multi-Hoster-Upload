const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('settings backup snapshot', () => {
  it('copies accounts and settings while excluding history, queue and rotation state', () => {
    const { createPortableSettingsSnapshot } = require('../lib/settings-backup');
    const input = {
      hosters: { 'voe.sx': [{ id: 'v1', username: 'user', password: 'secret', enabled: true }] },
      hosterSettings: { 'voe.sx': { retries: 7 } },
      globalSettings: { alwaysOnTop: true, pendingQueue: [{ file: 'private.mkv' }] },
      history: [{ file: 'done.mkv' }],
      rotationCursors: { 'voe.sx': 4 }
    };

    const snapshot = createPortableSettingsSnapshot(input);

    assert.deepEqual(snapshot, {
      hosters: input.hosters,
      hosterSettings: input.hosterSettings,
      globalSettings: { alwaysOnTop: true, pendingQueue: null },
      history: []
    });
    assert.notEqual(snapshot.hosters, input.hosters);
  });

  it('validates imports and clears only source-machine paths that do not exist locally', () => {
    const { prepareImportedSettings } = require('../lib/settings-backup');
    const snapshot = {
      hosters: { 'byse.sx': [{ id: 'b1', apiKey: 'secret', enabled: true }] },
      hosterSettings: { 'byse.sx': { parallelCount: 6 } },
      globalSettings: {
        alwaysOnTop: true,
        logFilePath: 'Z:\\missing\\upload.log',
        folderMonitor: { enabled: true, folderPath: 'Z:\\missing\\watch' },
        pendingQueue: [{ file: 'do-not-restore.mkv' }]
      }
    };

    const imported = prepareImportedSettings(snapshot, { pathExists: () => false, pathDirname: (value) => value });

    assert.equal(imported.globalSettings.logFilePath, '');
    assert.deepEqual(imported.globalSettings.folderMonitor, { enabled: false, folderPath: '' });
    assert.equal(imported.globalSettings.pendingQueue, null);
    assert.deepEqual(imported.history, []);
    assert.throws(() => prepareImportedSettings({ hosters: {} }), /ungültige Struktur/i);
  });
});
