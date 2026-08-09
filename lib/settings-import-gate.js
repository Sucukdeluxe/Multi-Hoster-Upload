function createSettingsImportGate(isUploadRunning) {
  if (typeof isUploadRunning !== 'function') throw new TypeError('isUploadRunning must be a function');
  let importing = false;
  return {
    begin() {
      if (importing) throw new Error('Einstellungen werden bereits importiert');
      if (isUploadRunning()) throw new Error('Während laufender Uploads können keine Einstellungen importiert werden');
      importing = true;
    },
    end() {
      importing = false;
    },
    canStartUpload() {
      return !importing;
    }
  };
}

module.exports = { createSettingsImportGate };
