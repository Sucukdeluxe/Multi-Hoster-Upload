const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('settings backup snapshot', () => {
  it('copies accounts and settings while excluding history, queue and rotation state', () => {
    const { createPortableSettingsSnapshot } = require('../lib/settings-backup');
    const input = {
      hosters: { 'voe.sx': [{ id: 'v1', username: 'user', password: 'secret', enabled: true }] },
      hosterSettings: { 'voe.sx': { retries: 7 } },
      globalSettings: {
        language: 'de',
        autoHealthCheckEnabled: false,
        alwaysOnTop: true,
        pendingQueue: [{ file: 'private.mkv' }],
        uploadRecovery: { jobs: ['private.mkv'] },
        lastBrowseDirectory: 'Z:\\private',
        folderMonitor: {
          enabled: true,
          folderPath: 'D:\\watch',
          recursive: true,
          paused: true,
          pausedAt: 123,
          telemetry: { detected: 8 }
        }
      },
      history: [{ file: 'done.mkv' }],
      rotationCursors: { 'voe.sx': 4 }
    };

    const snapshot = createPortableSettingsSnapshot(input);

    assert.deepEqual(snapshot, {
      hosters: input.hosters,
      hosterSettings: input.hosterSettings,
      globalSettings: {
        language: 'de',
        autoHealthCheckEnabled: false,
        alwaysOnTop: true,
        pendingQueue: null,
        uploadRecovery: null,
        lastBrowseDirectory: '',
        folderMonitor: {
          enabled: true,
          folderPath: 'D:\\watch',
          recursive: true,
          paused: false,
          pausedAt: null
        }
      },
      history: []
    });
    assert.notEqual(snapshot.hosters, input.hosters);
  });

  it('preserves configured paths, disables a missing monitored folder and reports both missing paths', () => {
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

    const warnings = [];
    const imported = prepareImportedSettings(snapshot, { pathExists: () => false, pathDirname: (value) => value, warnings });

    assert.equal(imported.globalSettings.logFilePath, 'Z:\\missing\\upload.log');
    assert.deepEqual(imported.globalSettings.folderMonitor, { enabled: false, folderPath: 'Z:\\missing\\watch', paused: false, pausedAt: null });
    assert.equal(imported.globalSettings.pendingQueue, null);
    assert.equal(imported.globalSettings.uploadRecovery, null);
    assert.equal(imported.globalSettings.lastBrowseDirectory, '');
    assert.deepEqual(imported.history, []);
    assert.deepEqual(warnings, [
      'Log-Dateipfad (Ordner nicht gefunden)',
      'Ordnerüberwachung (Ordner nicht gefunden und deaktiviert)'
    ]);
    assert.throws(() => prepareImportedSettings({ hosters: {} }), /ungültige Struktur/i);
  });
});
