const fs = require('node:fs');
const path = require('node:path');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function validateSettings(value) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || !value.hosters
    || typeof value.hosters !== 'object'
    || Array.isArray(value.hosters)
    || !value.hosterSettings
    || typeof value.hosterSettings !== 'object'
    || Array.isArray(value.hosterSettings)
    || !value.globalSettings
    || typeof value.globalSettings !== 'object'
    || Array.isArray(value.globalSettings)
  ) {
    throw new Error('Backup hat eine ungültige Struktur');
  }
}

function createPortableSettingsSnapshot(config) {
  validateSettings(config);
  const snapshot = {
    hosters: clone(config.hosters),
    hosterSettings: clone(config.hosterSettings),
    globalSettings: clone(config.globalSettings),
    history: []
  };
  snapshot.globalSettings.pendingQueue = null;
  return snapshot;
}

function prepareImportedSettings(value, options = {}) {
  validateSettings(value);
  const imported = createPortableSettingsSnapshot(value);
  const pathExists = options.pathExists || fs.existsSync;
  const pathDirname = options.pathDirname || path.dirname;
  const globalSettings = imported.globalSettings;
  if (globalSettings.logFilePath && !pathExists(pathDirname(globalSettings.logFilePath))) {
    globalSettings.logFilePath = '';
  }
  if (globalSettings.folderMonitor && typeof globalSettings.folderMonitor === 'object') {
    if (globalSettings.folderMonitor.folderPath && !pathExists(globalSettings.folderMonitor.folderPath)) {
      globalSettings.folderMonitor.folderPath = '';
      globalSettings.folderMonitor.enabled = false;
    }
  }
  return imported;
}

module.exports = { createPortableSettingsSnapshot, prepareImportedSettings };
