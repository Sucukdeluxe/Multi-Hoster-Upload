function configureStartupRenderer(app, env = process.env, platform = process.platform) {
  const sessionName = String(env && env.SESSIONNAME || '');
  if (platform === 'win32' && /^RDP-/i.test(sessionName)) app.disableHardwareAcceleration();
  return app;
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
