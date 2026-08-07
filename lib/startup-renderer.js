function configureStartupRenderer(app) {
  app.disableHardwareAcceleration();
}

function createStartupWindow(BrowserWindow, options) {
  const window = new BrowserWindow({ ...options, show: false });
  window.once('ready-to-show', () => {
    window.show();
  });

  return {
    window,
    load(target, onLoadError) {
      return window.loadFile(target).catch(onLoadError);
    }
  };
}

module.exports = { configureStartupRenderer, createStartupWindow };
