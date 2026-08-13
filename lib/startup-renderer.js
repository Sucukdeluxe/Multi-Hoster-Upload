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

function createStartupNavigationLoader(window, target, options = {}) {
  let startupDocument = 0;
  return function loadStartupDocument() {
    startupDocument++;
    return window.loadFile(target, {
      ...options,
      query: {
        ...options.query,
        startupDocument: String(startupDocument)
      }
    });
  };
}

function createStartupRevealGate(window, { onBlock } = {}) {
  let blocked = true;
  let activationPending = false;

  function hasWindow() {
    return !!window && (typeof window.isDestroyed !== 'function' || !window.isDestroyed());
  }

  function showAuthorizedSurface(activate) {
    if (!hasWindow()) return false;
    if (activate && window.isMinimized()) window.restore();
    if (!window.isVisible()) window.show();
    if (activate) window.focus();
    activationPending = false;
    return true;
  }

  const block = () => {
    blocked = true;
    if (typeof onBlock === 'function') onBlock();
    return true;
  };

  const request = () => {
    if (!hasWindow()) return false;
    activationPending = true;
    if (!blocked) showAuthorizedSurface(true);
    return true;
  };

  const reveal = () => {
    blocked = false;
    return showAuthorizedSurface(activationPending);
  };

  const navigate = (operation, ...args) => {
    block();
    return operation(...args);
  };

  return { block, navigate, request, reveal };
}

function createStartupExternalRevealBindings({
  getWindow,
  getRevealGate,
  sendDroppedFiles,
  maxPendingDropPayloads = 32
}) {
  const pendingDropPayloads = [];
  const pendingDropLimit = Number.isSafeInteger(maxPendingDropPayloads) && maxPendingDropPayloads > 0
    ? maxPendingDropPayloads
    : 32;
  let pendingWindow = null;
  let readyWindow = null;

  function clearPendingDropPayloads(window) {
    if (window && pendingWindow !== window) return false;
    pendingDropPayloads.length = 0;
    pendingWindow = null;
    return true;
  }

  function clearWindowState(window) {
    clearPendingDropPayloads(window);
    if (!window || readyWindow === window) readyWindow = null;
  }

  function getActiveWindow() {
    const window = getWindow();
    if (!window || (typeof window.isDestroyed === 'function' && window.isDestroyed())) {
      clearWindowState();
      return null;
    }
    if (pendingWindow && pendingWindow !== window) clearPendingDropPayloads();
    if (readyWindow && readyWindow !== window) readyWindow = null;
    return window;
  }

  function requestReveal() {
    const activeWindow = getActiveWindow();
    if (!activeWindow) return false;
    const revealGate = getRevealGate();
    if (!revealGate || typeof revealGate.request !== 'function') return false;
    revealGate.request();
    return true;
  }

  function queueDropPayload(window, paths) {
    if (pendingWindow && pendingWindow !== window) clearPendingDropPayloads();
    pendingWindow = window;
    if (pendingDropPayloads.length >= pendingDropLimit) pendingDropPayloads.shift();
    pendingDropPayloads.push(paths);
  }

  function handleDropTargetFiles(_event, paths) {
    const window = getActiveWindow();
    if (!window) return false;
    if (!window.isVisible() || window.isMinimized()) requestReveal();
    if (readyWindow === window) sendDroppedFiles(paths);
    else queueDropPayload(window, paths);
    return true;
  }

  function rendererBlocked(window) {
    const activeWindow = getActiveWindow();
    if (!activeWindow || activeWindow !== window) {
      clearWindowState(window);
      return false;
    }
    readyWindow = null;
    return true;
  }

  function rendererReady(window) {
    const activeWindow = getActiveWindow();
    if (!activeWindow || activeWindow !== window) {
      clearWindowState(window);
      return false;
    }
    readyWindow = window;
    if (pendingWindow !== window) return true;
    const payloads = pendingDropPayloads.splice(0);
    pendingWindow = null;
    for (const paths of payloads) sendDroppedFiles(paths);
    return true;
  }

  function windowClosed(window) {
    clearWindowState(window);
  }

  return {
    bindSecondInstance(app) {
      app.on('second-instance', requestReveal);
    },
    bindTrayClick(tray) {
      tray.on('click', requestReveal);
    },
    createTrayMenuItem(label) {
      return { label, click: requestReveal };
    },
    bindDropTargetFiles(ipcMain) {
      ipcMain.on('drop-target:files', handleDropTargetFiles);
    },
    rendererBlocked,
    rendererReady,
    windowClosed
  };
}

function createStartupCloseHandler({ window, shouldPrepareClose, requestClosePreparation }) {
  return function handleStartupClose(event) {
    if (!shouldPrepareClose() || window.webContents.isDestroyed()) return false;
    event.preventDefault();
    requestClosePreparation();
    return true;
  };
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
  let initialLoadPending = false;
  let navigation;
  let recoveryNavigations = 0;
  let terminalFailure;
  let recovery;
  let queuedRecovery;
  let readyDeadline;
  let rendererGeneration = 0;
  let awaitingGeneration = null;
  let stopped = false;

  function clearRendererDeadline() {
    if (readyDeadline !== undefined) cancelReadyDeadline(readyDeadline);
    readyDeadline = undefined;
  }

  function clearRendererDocument() {
    awaitingGeneration = null;
    clearRendererDeadline();
  }

  function acceptRendererDocument(generation) {
    if (!Number.isInteger(generation) || awaitingGeneration !== generation) return false;
    clearRendererDocument();
    return true;
  }

  async function runNavigation(operation, args = []) {
    if (navigation) return navigation;
    const currentNavigation = Promise.resolve().then(() => operation(...args));
    navigation = currentNavigation;
    try {
      return await currentNavigation;
    } finally {
      if (navigation === currentNavigation) navigation = undefined;
    }
  }

  function endWithFailure(failure) {
    if (stopped) return Promise.resolve(false);
    if (!terminalFailure) {
      clearRendererDocument();
      terminalFailure = Promise.resolve().then(async () => {
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
      });
    }
    return terminalFailure;
  }

  function trackRecovery(currentRecovery) {
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

  async function performRecovery(phase, details) {
    if (stopped) return false;
    if (terminalFailure) return terminalFailure;
    if (recoveryNavigations >= 1) {
      return endWithFailure({ phase, attempt: recoveryNavigations + 1, details });
    }
    recoveryNavigations++;
    try {
      await runNavigation(reload);
      return true;
    } catch (error) {
      if (stopped) return false;
      return endWithFailure({ phase: 'renderer-reload', attempt: recoveryNavigations, details, error });
    }
  }

  function recoverRenderer(phase, details) {
    if (stopped) return Promise.resolve(false);
    if (terminalFailure) return terminalFailure;
    clearRendererDocument();
    if (initialLoadPending) {
      queuedRecovery = { phase, details, recoveryNavigations };
      if (recovery) return recovery;
      const currentRecovery = Promise.resolve(initialLoad).then(() => {
        const pendingRecovery = queuedRecovery;
        queuedRecovery = undefined;
        if (stopped) return false;
        if (terminalFailure) return terminalFailure;
        if (!pendingRecovery || recoveryNavigations > pendingRecovery.recoveryNavigations) return true;
        return performRecovery(pendingRecovery.phase, pendingRecovery.details);
      });
      return trackRecovery(currentRecovery);
    }
    if (recovery) return recovery;
    return trackRecovery(performRecovery(phase, details));
  }

  return {
    loadInitial(...args) {
      if (stopped) return Promise.resolve(false);
      if (terminalFailure) return terminalFailure;
      if (!initialLoad) {
        initialLoadPending = true;
        const currentInitialLoad = (async () => {
          for (let attempt = 1; attempt <= 2; attempt++) {
            if (stopped) return false;
            if (attempt === 2) recoveryNavigations = Math.max(recoveryNavigations, 1);
            try {
              return await runNavigation(load, args);
            } catch (error) {
              if (stopped) return false;
              if (attempt === 2) {
                await endWithFailure({ phase: 'initial-load', attempt, error });
              }
            }
          }
        })();
        initialLoad = currentInitialLoad;
        currentInitialLoad.then(
          () => {
            initialLoadPending = false;
          },
          () => {
            initialLoadPending = false;
          }
        );
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
      clearRendererDocument();
      rendererGeneration++;
      awaitingGeneration = rendererGeneration;
      return rendererGeneration;
    },
    rendererLoaded(generation) {
      if (stopped || terminalFailure || awaitingGeneration !== generation) return false;
      clearRendererDeadline();
      readyDeadline = scheduleReadyDeadline(() => {
        if (stopped || terminalFailure || awaitingGeneration !== generation) return false;
        readyDeadline = undefined;
        return recoverRenderer('renderer-ready-timeout', { timeoutMs: readyTimeoutMs });
      }, readyTimeoutMs);
      if (readyDeadline && typeof readyDeadline.unref === 'function') readyDeadline.unref();
      return true;
    },
    rendererReady(generation) {
      if (stopped || terminalFailure || !acceptRendererDocument(generation)) return false;
      recoveryNavigations = 0;
      reveal();
      return true;
    },
    dispose() {
      if (stopped) return false;
      stopped = true;
      queuedRecovery = undefined;
      clearRendererDocument();
      return true;
    }
  };
}

function createStartupRendererHandlers({
  window,
  ipcMain,
  coordinator,
  onDocumentLoadStarted,
  onRendererCrashed,
  onReady,
  onInitializationFailed
}) {
  let disposed = false;
  let generation = null;
  let activeFrame = null;
  let pendingDocumentUrl = null;
  let pendingFrameAddress = null;
  const webContents = window && window.webContents;

  function frameAddress(frame) {
    if (!frame || frame.detached) return null;
    if (typeof frame.isDestroyed === 'function' && frame.isDestroyed()) return null;
    if (!Number.isInteger(frame.processId) || typeof frame.frameToken !== 'string' || !frame.frameToken) return null;
    return `${frame.processId}:${frame.frameToken}`;
  }

  function frameIdentity(frame) {
    const address = frameAddress(frame);
    if (!address) return null;
    if (typeof frame.url !== 'string' || !frame.url) return null;
    return `${address}:${frame.url}`;
  }

  function startDocument(url, frame) {
    if (disposed) return false;
    generation = coordinator.rendererLoadStarted();
    activeFrame = null;
    pendingDocumentUrl = typeof url === 'string' && url ? url : null;
    pendingFrameAddress = frameAddress(frame);
    if (generation !== false && typeof onDocumentLoadStarted === 'function') onDocumentLoadStarted();
    return generation;
  }

  function finishDocument() {
    if (disposed || generation === null) return false;
    activeFrame = frameIdentity(webContents && webContents.mainFrame);
    return coordinator.rendererLoaded(generation);
  }

  function resolveEventFrame(event) {
    if (disposed || !window || window.isDestroyed() || !event || event.sender !== webContents) return null;
    if (!frameIdentity(event.senderFrame)) return null;
    return event.senderFrame;
  }

  function resolveReadyGeneration(event) {
    const senderFrame = resolveEventFrame(event);
    if (!senderFrame || !Number.isInteger(generation) || !activeFrame || frameIdentity(senderFrame) !== activeFrame) return null;
    return generation;
  }

  function resolveInitializationGeneration(event) {
    const senderFrame = resolveEventFrame(event);
    if (!senderFrame || !Number.isInteger(generation)) return null;
    if (activeFrame) return frameIdentity(senderFrame) === activeFrame ? generation : null;
    if (!pendingDocumentUrl || !pendingFrameAddress) return null;
    if (senderFrame.url !== pendingDocumentUrl || frameAddress(senderFrame) !== pendingFrameAddress) return null;
    return generation;
  }

  function handleNavigation(details, _url, isInPlace, isMainFrame) {
    const sameDocument = details && typeof details.isSameDocument === 'boolean' ? details.isSameDocument : isInPlace;
    const mainFrame = details && typeof details.isMainFrame === 'boolean' ? details.isMainFrame : isMainFrame;
    if (sameDocument || mainFrame === false) return false;
    const url = details && typeof details.url === 'string' ? details.url : _url;
    const frame = details && details.frame;
    return startDocument(url, frame);
  }

  function handleRendererCrash(_event, details) {
    if (disposed) return false;
    if (typeof onRendererCrashed === 'function') onRendererCrashed(details);
    return coordinator.rendererCrashed(details);
  }

  function handleRendererInitializationFailed(event, details) {
    if (resolveInitializationGeneration(event) === null) return false;
    if (typeof onInitializationFailed === 'function') onInitializationFailed(details);
    return coordinator.rendererInitializationFailed(details);
  }

  function handleRendererReady(event) {
    const eventGeneration = resolveReadyGeneration(event);
    if (eventGeneration === null) return false;
    const ready = coordinator.rendererReady(eventGeneration);
    if (ready && typeof onReady === 'function') onReady();
    return ready;
  }

  if (webContents && typeof webContents.on === 'function') {
    webContents.on('did-start-navigation', handleNavigation);
    webContents.on('did-finish-load', finishDocument);
    webContents.on('render-process-gone', handleRendererCrash);
  }
  if (ipcMain && typeof ipcMain.on === 'function') {
    ipcMain.on('app:close-handshake-ready', handleRendererReady);
    ipcMain.on('app:renderer-initialization-failed', handleRendererInitializationFailed);
  }

  return {
    documentLoadStarted: startDocument,
    documentLoaded: finishDocument,
    rendererCrashed(details) {
      if (disposed) return false;
      return coordinator.rendererCrashed(details);
    },
    rendererInitializationFailed: handleRendererInitializationFailed,
    rendererReady: handleRendererReady,
    dispose() {
      if (disposed) return false;
      disposed = true;
      if (webContents && typeof webContents.removeListener === 'function') {
        webContents.removeListener('did-start-navigation', handleNavigation);
        webContents.removeListener('did-finish-load', finishDocument);
        webContents.removeListener('render-process-gone', handleRendererCrash);
      }
      if (ipcMain && typeof ipcMain.removeListener === 'function') {
        ipcMain.removeListener('app:close-handshake-ready', handleRendererReady);
        ipcMain.removeListener('app:renderer-initialization-failed', handleRendererInitializationFailed);
      }
      return coordinator.dispose();
    }
  };
}

function createStartupWindow(BrowserWindow, options) {
  const window = new BrowserWindow({ ...options, show: false });

  return {
    window,
    load(target, onLoadError, options) {
      return window.loadFile(target, options).catch(onLoadError);
    }
  };
}

module.exports = {
  configureStartupRenderer,
  createStartupCloseHandler,
  createStartupExternalRevealBindings,
  createStartupFailureDocument,
  createStartupNavigationLoader,
  createStartupRecoveryCoordinator,
  createStartupRevealGate,
  createStartupRendererHandlers,
  createStartupWindow,
  resolveStartupLanguage
};
