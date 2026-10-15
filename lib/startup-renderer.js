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

const STARTUP_PHASES = new Set([
  'preload-started', 'dom-ready', 'page-loaded', 'renderer-error', 'renderer-rejection', 'resource-error',
  'script-started', 'config-requested', 'config-loaded', 'automation-status-loaded',
  'evidence-requested', 'evidence-loaded', 'layout-created', 'listeners-ready',
  'initialized', 'initialization-failed'
]);

function createStartupDiagnostics({ fs, path, directory, metadata = {}, now = Date.now }) {
  const filePath = path.join(directory, 'startup-diagnostics.jsonl');
  const startedAt = now();
  const session = `${startedAt}-${process.pid}`;
  let sequence = 0;
  const reportedPhases = new Set();
  const write = (event, details = {}) => {
    const entry = { session, sequence: sequence++, timestamp: new Date(now()).toISOString(), elapsedMs: Math.max(0, now() - startedAt), event, ...details };
    try {
      fs.mkdirSync(directory, { recursive: true });
      if (fs.existsSync(filePath) && fs.statSync(filePath).size >= 1024 * 1024) {
        const backup = filePath + '.1';
        if (fs.existsSync(backup)) fs.unlinkSync(backup);
        fs.renameSync(filePath, backup);
      }
      fs.appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf8');
      return true;
    } catch {
      return false;
    }
  };
  const recordPhase = (phase, generation) => {
    if (typeof phase !== 'string' || !STARTUP_PHASES.has(phase)) return false;
    if (!Number.isSafeInteger(generation) || generation < 0) return false;
    const key = `${generation}:${phase}`;
    if (reportedPhases.has(key)) return false;
    reportedPhases.add(key);
    return write('renderer-phase', { phase, generation });
  };
  write('process-start', metadata);
  return { filePath, write, recordPhase };
}

function summarizeStartupPixels(image) {
  if (!image || image.isEmpty()) return { empty: true };
  const size = image.getSize();
  const bitmap = image.resize({ width: 48, height: 32 }).toBitmap();
  const pixels = bitmap.length / 4;
  let white = 0;
  let dark = 0;
  for (let i = 0; i < bitmap.length; i += 4) {
    if (bitmap[i] >= 245 && bitmap[i + 1] >= 245 && bitmap[i + 2] >= 245) white++;
    if (bitmap[i] <= 64 && bitmap[i + 1] <= 64 && bitmap[i + 2] <= 64) dark++;
  }
  return { empty: false, width: size.width, height: size.height, whiteRatio: pixels ? Math.round(white / pixels * 1000) / 1000 : 0, darkRatio: pixels ? Math.round(dark / pixels * 1000) / 1000 : 0 };
}

module.exports = { createStartupWindow, resolveStartupLanguage, createStartupQuery, createStartupDiagnostics, summarizeStartupPixels };
