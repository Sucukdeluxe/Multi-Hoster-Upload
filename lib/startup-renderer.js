function configureStartupRenderer(app, env = process.env, platform = process.platform) {
  const sessionName = String(env && env.SESSIONNAME || '');
  if (platform === 'win32' && /^RDP-/i.test(sessionName)) app.disableHardwareAcceleration();
  return app;
}

function resolveStartupLanguage(config) {
  return config && config.globalSettings && config.globalSettings.language === 'de' ? 'de' : 'en';
}

function createStartupFailureDocument(language) {
  const german = language === 'de';
  const title = german ? 'Oberfläche konnte nicht geladen werden' : 'The interface could not load';
  const detail = german
    ? 'Multi Hoster Uploader konnte die Oberfläche nach einem sicheren Wiederherstellungsversuch nicht laden.'
    : 'Multi Hoster Uploader could not load the interface after a safe recovery attempt.';
  const close = german ? 'Schließen' : 'Close';
  return `<!doctype html><html lang="${german ? 'de' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Multi Hoster Uploader</title><style>html,body{height:100%;margin:0;background:#1f1f1f;color:#f4f4f4;font:15px system-ui,sans-serif}body{display:grid;place-items:center}.card{width:min(520px,calc(100% - 48px));padding:28px;border:1px solid #444;border-radius:12px;background:#292929;box-shadow:0 18px 50px #0008}h1{margin:0 0 12px;font-size:22px}p{margin:0 0 22px;color:#c8c8c8;line-height:1.5}button{min-height:38px;padding:0 18px;border:1px solid #555;border-radius:7px;background:#363636;color:#fff;font-weight:650;cursor:pointer}button:hover{background:#414141}</style></head><body><main class="card"><h1>${title}</h1><p>${detail}</p><button type="button" onclick="window.close()">${close}</button></main></body></html>`;
}

function createStartupRecoveryCoordinator({
  load,
  reload,
  reveal,
  showFailure,
  close,
  readyTimeoutMs = 15000,
  scheduleReadyDeadline = setTimeout,
  cancelReadyDeadline = clearTimeout
}) {
  let initialLoad;
  let crashReloads = 0;
  let terminalFailure;
  let recovery;
  let readyDeadline;
  let rendererDocument = 0;
  let awaitingReady = false;
  let stopped = false;

  function clearRendererDeadline() {
    if (readyDeadline !== undefined) cancelReadyDeadline(readyDeadline);
    readyDeadline = undefined;
  }

  function abandonRendererDocument() {
    awaitingReady = false;
    clearRendererDeadline();
  }

  function endWithFailure(failure) {
    if (stopped) return Promise.resolve(false);
    if (!terminalFailure) {
      abandonRendererDocument();
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

  function recoverRenderer(phase, details) {
    if (stopped) return Promise.resolve(false);
    if (terminalFailure) return terminalFailure;
    if (recovery) return recovery;
    abandonRendererDocument();
    const currentRecovery = (async () => {
      if (crashReloads >= 1) {
        return endWithFailure({ phase, attempt: crashReloads + 1, details });
      }
      crashReloads++;
      try {
        await reload();
        return true;
      } catch (error) {
        if (stopped) return false;
        return endWithFailure({ phase: 'renderer-reload', attempt: crashReloads, details, error });
      }
    })();
    recovery = currentRecovery;
    currentRecovery.then(
      () => {
        if (recovery === currentRecovery) recovery = undefined;
      },
      () => {
        if (recovery === currentRecovery) recovery = undefined;
      }
    );
    return currentRecovery;
  }

  return {
    loadInitial(...args) {
      if (stopped) return Promise.resolve(false);
      if (terminalFailure) return terminalFailure;
      if (!initialLoad) {
        initialLoad = (async () => {
          for (let attempt = 1; attempt <= 2; attempt++) {
            if (stopped) return false;
            try {
              return await load(...args);
            } catch (error) {
              if (stopped) return false;
              if (attempt === 2) {
                await endWithFailure({ phase: 'initial-load', attempt, error });
              }
            }
          }
        })();
      }
      return initialLoad;
    },
    rendererCrashed(details) {
      return recoverRenderer('renderer-crash', details);
    },
    rendererInitializationFailed(details) {
      return recoverRenderer('renderer-initialization', details);
    },
    rendererLoadStarted() {
      if (stopped || terminalFailure) return false;
      clearRendererDeadline();
      rendererDocument++;
      awaitingReady = true;
      return true;
    },
    rendererLoaded() {
      if (stopped || terminalFailure || !awaitingReady) return false;
      clearRendererDeadline();
      const document = rendererDocument;
      readyDeadline = scheduleReadyDeadline(() => {
        if (stopped || terminalFailure || !awaitingReady || rendererDocument !== document) return false;
        readyDeadline = undefined;
        return recoverRenderer('renderer-ready-timeout', { timeoutMs: readyTimeoutMs });
      }, readyTimeoutMs);
      if (readyDeadline && typeof readyDeadline.unref === 'function') readyDeadline.unref();
      return true;
    },
    rendererReady() {
      if (stopped || terminalFailure) return false;
      abandonRendererDocument();
      crashReloads = 0;
      reveal();
      return true;
    },
    dispose() {
      if (stopped) return false;
      stopped = true;
      abandonRendererDocument();
      return true;
    }
  };
}

function createStartupRendererHandlers({ window, coordinator, onReady, onInitializationFailed }) {
  let disposed = false;

  function accepts(event) {
    return !disposed && window && !window.isDestroyed() && event && event.sender === window.webContents;
  }

  return {
    documentLoadStarted() {
      if (disposed) return false;
      return coordinator.rendererLoadStarted();
    },
    documentLoaded() {
      if (disposed) return false;
      return coordinator.rendererLoaded();
    },
    rendererCrashed(details) {
      if (disposed) return false;
      return coordinator.rendererCrashed(details);
    },
    rendererInitializationFailed(event, details) {
      if (!accepts(event)) return false;
      if (typeof onInitializationFailed === 'function') onInitializationFailed(details);
      return coordinator.rendererInitializationFailed(details);
    },
    rendererReady(event) {
      if (!accepts(event)) return false;
      const ready = coordinator.rendererReady();
      if (ready && typeof onReady === 'function') onReady();
      return ready;
    },
    dispose() {
      if (disposed) return false;
      disposed = true;
      return coordinator.dispose();
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
  createStartupFailureDocument,
  createStartupRecoveryCoordinator,
  createStartupRendererHandlers,
  createStartupWindow,
  resolveStartupLanguage
};
