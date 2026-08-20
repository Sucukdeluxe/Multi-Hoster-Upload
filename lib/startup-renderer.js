function configureStartupRenderer(app, env = process.env, platform = process.platform) {
  const sessionName = String(env && env.SESSIONNAME || '');
  if (platform === 'win32' && /^RDP-/i.test(sessionName)) app.disableHardwareAcceleration();
  return app;
}

function resolveStartupLanguage(config) {
  return config && config.globalSettings && config.globalSettings.language === 'de' ? 'de' : 'en';
}

function createStartupQuery(config, version) {
  const normalizedVersion = /^\d+\.\d+\.\d+$/.test(String(version || '').trim()) ? String(version).trim() : '';
  return { language: resolveStartupLanguage(config), version: normalizedVersion };
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

module.exports = { configureStartupRenderer, createStartupWindow, resolveStartupLanguage, createStartupQuery };
