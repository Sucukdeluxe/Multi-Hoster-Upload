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

function createNativeStartupLog({ fs, path, directory, commandLine, now = Date.now, pid = process.pid }) {
  const logDirectory = path.join(directory, 'startup-logs');
  const nativePath = path.join(logDirectory, `native-${now()}-${pid}.log`);
  const nativePattern = /^native-\d+-\d+\.log(?:\.previous)?$/;
  const reportPattern = /^report-\d+-\d+-\d+\.txt$/;
  const maxBytes = 2 * 1024 * 1024;
  let reportSequence = 0;
  let latestReport = null;
  let enabled = false;
  const list = pattern => {
    try {
      return fs.readdirSync(logDirectory, { withFileTypes: true })
        .filter(entry => entry.isFile() && pattern.test(entry.name))
        .map(entry => ({ name: entry.name, path: path.join(logDirectory, entry.name), modified: fs.statSync(path.join(logDirectory, entry.name)).mtimeMs }))
        .sort((a, b) => b.modified - a.modified || b.name.localeCompare(a.name));
    } catch { return []; }
  };
  const prune = (pattern, keep, preserve = []) => {
    const files = list(pattern);
    const protectedFiles = files.filter(file => preserve.includes(file.path));
    for (const file of files.filter(file => !preserve.includes(file.path)).slice(Math.max(0, keep - protectedFiles.length))) {
      try { fs.unlinkSync(file.path); } catch {}
    }
  };
  try {
    fs.mkdirSync(logDirectory, { recursive: true });
    fs.writeFileSync(nativePath, '', { flag: 'wx', mode: 0o600 });
    commandLine.appendSwitch('enable-logging', 'file');
    commandLine.appendSwitch('log-file', nativePath);
    commandLine.appendSwitch('log-level', '2');
    enabled = true;
    prune(nativePattern, 12, [nativePath, nativePath + '.previous']);
  } catch {}
  const maintain = () => {
    if (!enabled) return false;
    let descriptor;
    try {
      const size = fs.statSync(nativePath).size;
      if (size <= maxBytes) return true;
      descriptor = fs.openSync(nativePath, 'r');
      const buffer = Buffer.alloc(maxBytes);
      const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, size - buffer.length);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.writeFileSync(nativePath + '.previous', buffer.subarray(0, bytes), { mode: 0o600 });
      fs.truncateSync(nativePath, 0);
      prune(nativePattern, 12, [nativePath, nativePath + '.previous']);
      return true;
    } catch { return false; }
    finally { if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch {} } }
  };
  let maintenance = null;
  const maintainAsync = () => {
    if (maintenance) return maintenance;
    maintenance = (async () => {
      if (!enabled) return false;
      let handle;
      try {
        const size = (await fs.promises.stat(nativePath)).size;
        if (size <= maxBytes) return true;
        handle = await fs.promises.open(nativePath, 'r');
        const buffer = Buffer.alloc(maxBytes);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, size - buffer.length);
        await handle.close();
        handle = null;
        await fs.promises.writeFile(nativePath + '.previous', buffer.subarray(0, bytesRead), { mode: 0o600 });
        await fs.promises.truncate(nativePath, 0);
        return true;
      } catch { return false; }
      finally { if (handle) await handle.close().catch(() => {}); }
    })().finally(() => { maintenance = null; });
    return maintenance;
  };
  const files = () => list(nativePattern).sort((a, b) => Number(b.path === nativePath) - Number(a.path === nativePath))
    .map(file => ({ label: file.name, path: file.path, maxBytes }));
  const reports = () => list(reportPattern).sort((a, b) => Number(b.path === latestReport) - Number(a.path === latestReport))
    .map(file => ({ label: file.name, path: file.path, maxBytes: 5 * 1024 * 1024 }));
  const saveReport = text => {
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 5 * 1024 * 1024) return null;
    try {
      fs.mkdirSync(logDirectory, { recursive: true });
      const target = path.join(logDirectory, `report-${now()}-${pid}-${reportSequence++}.txt`);
      fs.writeFileSync(target, text, { flag: 'wx', mode: 0o600 });
      latestReport = target;
      prune(reportPattern, 10, [target]);
      return target;
    } catch { return null; }
  };
  const listAsync = async pattern => {
    const found = [];
    try {
      for (const entry of await fs.promises.readdir(logDirectory, { withFileTypes: true })) {
        if (!entry.isFile() || !pattern.test(entry.name)) continue;
        try {
          const target = path.join(logDirectory, entry.name);
          found.push({ name: entry.name, path: target, modified: (await fs.promises.stat(target)).mtimeMs });
        } catch {}
      }
    } catch {}
    return found.sort((a, b) => b.modified - a.modified || b.name.localeCompare(a.name));
  };
  const filesAsync = async () => (await listAsync(nativePattern)).sort((a, b) => Number(b.path === nativePath) - Number(a.path === nativePath))
    .map(file => ({ label: file.name, path: file.path, maxBytes }));
  const reportsAsync = async () => (await listAsync(reportPattern)).sort((a, b) => Number(b.path === latestReport) - Number(a.path === latestReport))
    .map(file => ({ label: file.name, path: file.path, maxBytes: 5 * 1024 * 1024 }));
  const saveReportAsync = async text => {
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 5 * 1024 * 1024) return null;
    try {
      await fs.promises.mkdir(logDirectory, { recursive: true });
      const target = path.join(logDirectory, `report-${now()}-${pid}-${reportSequence++}.txt`);
      await fs.promises.writeFile(target, text, { flag: 'wx', mode: 0o600 });
      latestReport = target;
      const entries = await listAsync(reportPattern);
      for (const file of entries.filter(file => file.path !== target).slice(9)) await fs.promises.unlink(file.path).catch(() => {});
      return target;
    } catch { return null; }
  };
  prune(reportPattern, 10);
  return { enabled, nativePath, logDirectory, files, filesAsync, reports, reportsAsync, saveReport, saveReportAsync, maintain, maintainAsync };
}

module.exports = { createStartupWindow, resolveStartupLanguage, createStartupQuery, createStartupDiagnostics, summarizeStartupPixels, createNativeStartupLog };
