function resolveStartupLanguage(config) {
  return config && config.globalSettings && config.globalSettings.language === 'de' ? 'de' : 'en';
}

function createStartupQuery(config, version, development = false) {
  const normalizedVersion = /^\d+\.\d+\.\d+$/.test(String(version || '').trim()) ? String(version).trim() : '';
  return { language: resolveStartupLanguage(config), version: normalizedVersion, ...(development ? { development: '1' } : {}) };
}

function createStartupWindow(BrowserWindow, options) {
  const window = new BrowserWindow({ ...options, show: false });
  let nativePaintReady = false;
  let rendererLoadFinished = false;
  let revealed = false;
  const reveal = () => {
    if (revealed || !nativePaintReady || !rendererLoadFinished) return;
    revealed = true;
    window.show();
  };
  window.once('ready-to-show', () => {
    nativePaintReady = true;
    reveal();
  });
  window.webContents.once('did-finish-load', () => {
    rendererLoadFinished = true;
    reveal();
  });

  return {
    window,
    load(target, onLoadError, options) {
      return window.loadFile(target, options).catch((error) => {
        rendererLoadFinished = true;
        reveal();
        return onLoadError(error);
      });
    }
  };
}

module.exports = { createStartupWindow, resolveStartupLanguage, createStartupQuery };
