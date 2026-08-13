function configureStartupRenderer(app, env = process.env, platform = process.platform) {
  const sessionName = String(env && env.SESSIONNAME || '');
  if (platform === 'win32' && /^RDP-/i.test(sessionName)) app.disableHardwareAcceleration();
  return app;
}

function resolveStartupLanguage(config) {
  return config && config.globalSettings && config.globalSettings.language === 'de' ? 'de' : 'en';
}

function createStartupRecoveryCoordinator({ load, reload, reveal, showFailure, close }) {
  let initialLoad;
  let crashReloads = 0;
  let terminalFailure;

  function endWithFailure(failure) {
    if (!terminalFailure) {
      terminalFailure = (async () => {
        if (typeof showFailure !== 'function') {
          await close(failure);
          return;
        }
        try {
          await showFailure(failure);
          reveal();
        } catch (surfaceError) {
          await close({ ...failure, surfaceError });
        }
      })();
    }
    return terminalFailure;
  }

  return {
    loadInitial(...args) {
      if (terminalFailure) return terminalFailure;
      if (!initialLoad) {
        initialLoad = (async () => {
          for (let attempt = 1; attempt <= 2; attempt++) {
            try {
              return await load(...args);
            } catch (error) {
              if (attempt === 2) {
                await endWithFailure({ phase: 'initial-load', attempt, error });
              }
            }
          }
        })();
      }
      return initialLoad;
    },
    async rendererCrashed(details) {
      if (terminalFailure) return terminalFailure;
      if (crashReloads >= 1) {
        return endWithFailure({ phase: 'renderer-crash', attempt: crashReloads + 1, details });
      }
      crashReloads++;
      try {
        await reload();
      } catch (error) {
        return endWithFailure({ phase: 'renderer-reload', attempt: crashReloads, details, error });
      }
    },
    rendererReady() {
      if (terminalFailure) return false;
      crashReloads = 0;
      reveal();
      return true;
    }
  };
}

function createStartupWindow(BrowserWindow, options) {
  const window = new BrowserWindow({ ...options, show: false });
  window.once('ready-to-show', () => {
    window.show();
  });

  return {
    window,
    load(target, onLoadError, options) {
      return window.loadFile(target, options).catch(onLoadError);
    }
  };
}

module.exports = {
  configureStartupRenderer,
  createStartupRecoveryCoordinator,
  createStartupWindow,
  resolveStartupLanguage
};
