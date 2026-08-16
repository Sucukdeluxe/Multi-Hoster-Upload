/**
 * UI smoke test - launches the real app and checks DOM elements via webContents.
 * Run with: node tests/ui-smoke.js
 * (This spawns Electron as a child process)
 */
if (!process.env.RUN_UI_SMOKE) {
  const { test } = require('node:test');
  test('ui smoke skipped unless RUN_UI_SMOKE=1', () => {});
  return;
}

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const productVersion = require('../package.json').version;
const uiRunId = `${process.pid}-${Date.now()}`;
const visualScreenshotDir = process.env.MHU_UI_SCREENSHOT_DIR
  ? path.resolve(process.env.MHU_UI_SCREENSHOT_DIR)
  : '';
const injectPath = path.join(__dirname, `_ui-inject.${uiRunId}.tmp.js`);
const userDataPath = path.join(os.tmpdir(), `mhu-ui-smoke-${uiRunId}`);

if (visualScreenshotDir) fs.mkdirSync(visualScreenshotDir, { recursive: true });

// Create a temp script that the real Electron app will execute via --eval
const testScript = `
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { installHiddenElectronWindowHarness } = require(path.join(process.cwd(), 'tests', 'support', 'hidden-electron-window'));
const hiddenWindowHarness = installHiddenElectronWindowHarness({ BrowserWindow });
const isolatedUserDataPath = app.getPath('userData');
const setAppPath = app.setPath.bind(app);
app.setPath = (name, value) => setAppPath(name, name === 'userData' ? isolatedUserDataPath : value);
app.setVersion(${JSON.stringify(productVersion)});
const fs = require('fs');
const net = require('net');
const ConfigStore = require(path.join(process.cwd(), 'lib', 'config-store'));
const RemoteServer = require(path.join(process.cwd(), 'lib', 'remote-server'));
const { listenOnLoopback, installLoopbackRemoteServerGuard } = require(path.join(process.cwd(), 'tests', 'support', 'ui-network-safety'));
const updaterModule = require(path.join(process.cwd(), 'lib', 'updater'));
const uiRemoteBindAddresses = [];
const startupConfigPath = path.join(app.getPath('userData'), 'electron-config.json');
fs.mkdirSync(path.dirname(startupConfigPath), { recursive: true });
fs.writeFileSync(startupConfigPath, JSON.stringify({ globalSettings: { language: 'de' } }), 'utf8');
installLoopbackRemoteServerGuard(RemoteServer, address => uiRemoteBindAddresses.push(address));
let preparedUpdateMockCalls = 0;
let launchedUpdateMockCalls = 0;
let updateCheckMockCalls = 0;
updaterModule.checkForUpdate = async () => {
  updateCheckMockCalls++;
  return updateCheckMockCalls === 1
    ? { available: true, remoteVersion: '9.9.8' }
    : { available: false };
};
updaterModule.prepareUpdate = async (onProgress) => {
  preparedUpdateMockCalls++;
  if (onProgress) onProgress({ stage: 'prepared', percent: 100 });
  return { installerPath: path.join(app.getPath('temp'), 'mhu-ui-update-' + preparedUpdateMockCalls + '.exe') };
};
updaterModule.launchPreparedUpdate = () => {
  launchedUpdateMockCalls++;
  return true;
};
const initialIpcHandlers = new Map();
const registerIpcHandler = ipcMain.handle.bind(ipcMain);
let initialConfigReadDelayed = false;
let startupLanguagePendingSnapshot = null;
let failNextConfigRead = false;
let rendererInitializationFailureSignal = null;
const captureRendererInitializationFailure = (_event, details) => {
  rendererInitializationFailureSignal = details;
};
ipcMain.on('app:renderer-initialization-failed', captureRendererInitializationFailure);
ipcMain.handle = (channel, listener) => {
  const registeredListener = channel === 'get-config'
    ? async (...args) => {
        if (failNextConfigRead) {
          failNextConfigRead = false;
          throw new Error('Injected renderer initialization failure');
        }
        const result = await listener(...args);
        if (!initialConfigReadDelayed) {
          initialConfigReadDelayed = true;
          const deadline = Date.now() + 1500;
          let window = hiddenWindowHarness.getWindows()[0];
          while (window && !window.isVisible() && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 25));
            window = hiddenWindowHarness.getWindows()[0];
          }
          startupLanguagePendingSnapshot = window
            ? {
                visible: window.isVisible(),
                language: await window.webContents.executeJavaScript('document.documentElement.lang'),
                query: await window.webContents.executeJavaScript('location.search')
              }
            : null;
          const elapsed = 1500 - Math.max(0, deadline - Date.now());
          await new Promise(resolve => setTimeout(resolve, Math.max(0, 4000 - elapsed)));
        }
        return result;
      }
    : listener;
  if (!initialIpcHandlers.has(channel)) initialIpcHandlers.set(channel, registeredListener);
  return registerIpcHandler(channel, registeredListener);
};
function restoreInitialIpcHandler(channel) {
  ipcMain.removeHandler(channel);
  const listener = initialIpcHandlers.get(channel);
  if (listener) registerIpcHandler(channel, listener);
}
const originalAtomicWrite = ConfigStore.prototype._atomicWrite;
const originalHistoryAtomicWrite = ConfigStore.prototype._writeHistoryFileAtomic;
let activeConfigStore = null;
let blockedWriteMarker = '';
let blockedWriteStarted = false;
let releaseBlockedWrite = null;
let blockedHistoryWriteMarker = '';
let blockedHistoryWriteStarted = false;
let releaseBlockedHistoryWrite = null;
ConfigStore.prototype._atomicWrite = function (data) {
  activeConfigStore = this;
  if (blockedWriteMarker && !blockedWriteStarted && String(data).includes(blockedWriteMarker)) {
    blockedWriteStarted = true;
    return new Promise((resolve, reject) => {
      releaseBlockedWrite = () => originalAtomicWrite.call(this, data).then(resolve, reject);
    });
  }
  return originalAtomicWrite.call(this, data);
};
ConfigStore.prototype._writeHistoryFileAtomic = function (history) {
  activeConfigStore = this;
  if (blockedHistoryWriteMarker && !blockedHistoryWriteStarted && JSON.stringify(history).includes(blockedHistoryWriteMarker)) {
    blockedHistoryWriteStarted = true;
    return new Promise((resolve, reject) => {
      releaseBlockedHistoryWrite = () => originalHistoryAtomicWrite.call(this, history).then(resolve, reject);
    });
  }
  return originalHistoryAtomicWrite.call(this, history);
};

// Monkey-patch: after the real window loads, run tests
const origReady = app.whenReady;

async function runAfterDelay(win, delayMs) {
  await new Promise(r => setTimeout(r, delayMs));
  return win;
}

async function waitUntil(read, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return null;
}

// Wait for app to be ready, then wait for the real window to load
setTimeout(async () => {
  const windows = hiddenWindowHarness.getWindows();
  if (windows.length === 0) { console.log('ERROR: No windows found'); process.exit(1); }
  const win = windows[0];
  win.setIgnoreMouseEvents(true);
  if (win.isFullScreen()) win.setFullScreen(false);
  if (win.isMaximized()) win.unmaximize();
  const wc = win.webContents;
  if (typeof wc.setFrameRate === 'function') wc.setFrameRate(60);
  const initialReducedMotion = await wc.executeJavaScript('matchMedia("(prefers-reduced-motion: reduce)").matches');
  if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
  await wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  const setWindowBounds = async bounds => {
    if (win.isMaximized()) win.unmaximize();
    win.setBounds(bounds);
    await waitUntil(() => {
      const current = win.getBounds();
      return current.x === bounds.x && current.y === bounds.y && current.width === bounds.width && current.height === bounds.height;
    }, 1500);
    await new Promise(resolve => setTimeout(resolve, 100));
  };
  const startupBounds = win.getBounds();
  await setWindowBounds({ ...startupBounds, width: 1100, height: 750 });
  const originalBounds = win.getBounds();
  const visualScreenshotDir = ${JSON.stringify(visualScreenshotDir)};
  const rendererDiagnostics = [];
  let rendererUnresponsiveCount = 0;
  wc.on('console-message', (_event, level, message, line, sourceId) => {
    if (level === 3) rendererDiagnostics.push({ type: 'console', message, line, sourceId });
  });
  wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (isMainFrame) rendererDiagnostics.push({ type: 'load', errorCode, errorDescription, validatedURL });
  });
  wc.on('render-process-gone', (_event, details) => {
    rendererDiagnostics.push({ type: 'gone', details });
  });
  win.on('unresponsive', () => { rendererUnresponsiveCount++; });

  async function captureVisual(name) {
    if (!visualScreenshotDir) return;
    await new Promise(resolve => setTimeout(resolve, 150));
    const screenshot = await wc.capturePage();
    fs.writeFileSync(path.join(visualScreenshotDir, name), screenshot.toPNG());
  }

  // Wait for renderer init
  await new Promise(r => setTimeout(r, 2000));

  let passed = 0;
  let failed = 0;
  const results = [];
  let realAppQuit = null;
  let relaunchCalls = 0;

  function check(name, condition) {
    if (condition) { passed++; results.push('  PASS: ' + name); }
    else { failed++; results.push('  FAIL: ' + name); }
  }

  try {
    check('Every UI smoke window stays offscreen and never takes focus', hiddenWindowHarness.areNativeSurfacesSuppressed(hiddenWindowHarness.getWindows()));
    check('Hot Dev forces full motion despite the Windows reduced-motion preference', initialReducedMotion === false);
    const startupUpdateState = await wc.executeJavaScript('(() => { const button = document.getElementById("headerUpdateBtn"); return [_knownUpdateInfo?.remoteVersion, button?.hidden, getComputedStyle(button).display, document.getElementById("updateBanner")?.style.display].join("|"); })()');
    check('Startup update survives pending renderer initialization', startupUpdateState === '9.9.8|false|flex|flex');
    await wc.executeJavaScript('_knownUpdateInfo = null; closeUpdateDialog(); _syncHeaderUpdateState();');

    const germanStartupReady = await waitUntil(() => wc.executeJavaScript('document.documentElement.lang + "|" + document.getElementById("languageInput")?.value + "|" + [...document.querySelectorAll(".tab")].map(tab => tab.textContent.trim()).join(",")'));
    check('Returning German profiles never expose an English frame while startup config is pending', startupLanguagePendingSnapshot !== null && (!startupLanguagePendingSnapshot.visible || startupLanguagePendingSnapshot.language === 'de') && new URLSearchParams(startupLanguagePendingSnapshot.query).get('language') === 'de' && germanStartupReady === 'de|de|Upload,Accounts,Einstellungen,Verlauf');
    await wc.executeJavaScript('(async () => { config.globalSettings = { ...(config.globalSettings || {}), language: "en" }; await window.api.saveGlobalSettings(config.globalSettings); setUiLanguage("en"); renderSettings(); })()');
    const languageReady = await waitUntil(() => wc.executeJavaScript('Boolean(document.getElementById("languageInput"))'));
    check('Runtime language switching renders the complete English interface', languageReady === true && await wc.executeJavaScript('document.documentElement.lang + "|" + document.getElementById("languageInput")?.value + "|" + [...document.querySelectorAll(".tab")].map(tab => tab.textContent.trim()).join(",")') === 'en|en|Upload,Accounts,Settings,History');
    await wc.executeJavaScript('document.getElementById("settings-tab").click()');
    const languagePickerContract = await wc.executeJavaScript('(() => { const picker = document.getElementById("languagePicker"); const select = document.getElementById("languageInput"); const indicator = picker?.querySelector(".language-picker-indicator"); const buttons = [...(picker?.querySelectorAll(".language-option") || [])]; return [select?.hidden, buttons.length, buttons.map(button => button.dataset.language).join(","), buttons.map(button => button.getAttribute("aria-pressed")).join(","), Boolean(buttons[0]?.querySelector(".language-flag-en") && buttons[1]?.querySelector(".language-flag-de")), indicator ? parseFloat(getComputedStyle(indicator).transitionDuration) > 0 : false].join("|"); })()');
    check('Language uses a two-option animated flag picker instead of a visible dropdown', languagePickerContract === 'true|2|en,de|true,false|true|true');
    const languagePickerMotion = await wc.executeJavaScript('(async () => { const picker = document.getElementById("languagePicker"); const indicator = picker?.querySelector(".language-picker-indicator"); if (!picker || !indicator) return null; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); const before = indicator.getBoundingClientRect().left; picker.querySelector("[data-language=de]").click(); const germanLanguage = document.documentElement.lang; await new Promise(resolve => setTimeout(resolve, 90)); const movingRight = indicator.getBoundingClientRect().left; await new Promise(resolve => setTimeout(resolve, 170)); const german = { language: germanLanguage, selected: picker.dataset.language, pressed: picker.querySelector("[data-language=de]").getAttribute("aria-pressed"), left: indicator.getBoundingClientRect().left }; picker.querySelector("[data-language=en]").click(); const englishLanguage = document.documentElement.lang; await new Promise(resolve => setTimeout(resolve, 90)); const movingLeft = indicator.getBoundingClientRect().left; await new Promise(resolve => setTimeout(resolve, 170)); const english = { language: englishLanguage, selected: picker.dataset.language, pressed: picker.querySelector("[data-language=en]").getAttribute("aria-pressed"), left: indicator.getBoundingClientRect().left }; return { before, movingRight, movingLeft, german, english }; })()');
    if (!languagePickerMotion || !(languagePickerMotion.movingRight > languagePickerMotion.before + 2 && languagePickerMotion.movingRight < languagePickerMotion.german.left - 2) || !(languagePickerMotion.movingLeft < languagePickerMotion.german.left - 2 && languagePickerMotion.movingLeft > languagePickerMotion.before + 2)) console.log('Language picker motion: ' + JSON.stringify(languagePickerMotion));
    check('Language indicator visibly slides right and left while applying both languages immediately', Boolean(languagePickerMotion && languagePickerMotion.german.language === 'de' && languagePickerMotion.german.selected === 'de' && languagePickerMotion.german.pressed === 'true' && languagePickerMotion.movingRight > languagePickerMotion.before + 2 && languagePickerMotion.movingRight < languagePickerMotion.german.left - 2 && languagePickerMotion.english.language === 'en' && languagePickerMotion.english.selected === 'en' && languagePickerMotion.english.pressed === 'true' && languagePickerMotion.movingLeft < languagePickerMotion.german.left - 2 && languagePickerMotion.movingLeft > languagePickerMotion.before + 2 && Math.abs(languagePickerMotion.english.left - languagePickerMotion.before) <= 1));
    await captureVisual('00-language-picker.png');
    await wc.executeJavaScript('document.getElementById("upload-tab").click()');
    const unchangedValues = await wc.executeJavaScript('(() => { setUiLanguage("de"); const nodes = []; const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let node = walker.nextNode(); while (node) { if (node.nodeValue.trim()) nodes.push({ node, source: node.nodeValue.trim() }); node = walker.nextNode(); } const attributes = [...document.querySelectorAll("[title],[aria-label],[placeholder],[data-tooltip]")].flatMap(element => ["title", "aria-label", "placeholder", "data-tooltip"].filter(name => element.hasAttribute(name)).map(name => ({ element, name, source: element.getAttribute(name).trim() }))); setUiLanguage("en"); const unchanged = nodes.filter(entry => entry.source === entry.node.nodeValue.trim()).map(entry => entry.source); unchanged.push(...attributes.filter(entry => entry.source === entry.element.getAttribute(entry.name).trim()).map(entry => entry.source)); return [...new Set(unchanged.filter(value => /[A-Za-zÄÖÜäöüß]{2}/.test(value)))].sort(); })()');
    const neutralUiValues = new Set(['0 kB/s', 'Accounts', 'BBCode', 'CSV', 'Changelog', 'ETA', 'ETA --:--', 'FileUploader Log', 'HTML', 'JSON', 'Label (optional)', 'Link', 'Log', 'Logs & Support', 'MB/s', 'MHU2-…', 'MULTI HOSTER UPLOADER', 'Markdown', 'Multi Hoster Uploader', 'OK', 'Plaintext', 'Port', 'Server', 'Start', 'Status', 'Update', 'Upload', 'Uploads', 'Verbose Logging', 'Webhook', 'account-rotation.log', 'debug.log', 'doodstream-debug.log', 'fileuploader.log', 'upload-audit.log', 'upload-debug.log', 'mp4,mkv,avi']);
    const neutralUiPathBasenames = new Set(['account-rotation.log', 'doodstream-debug.log', 'fileuploader.log', 'upload-audit.log', 'upload-debug.log']);
    const unexpectedUnchangedValues = unchangedValues.filter(value => !neutralUiValues.has(value) && !neutralUiPathBasenames.has(path.basename(value)) && !value.includes('Multi-Hoster-Uploader'));
    if (process.env.AUDIT_I18N_UNCHANGED === '1' || unexpectedUnchangedValues.length) console.log('Unchanged i18n values: ' + JSON.stringify(unchangedValues, null, 2));
    check('Every mounted human-facing value is translated or explicitly language-neutral', unexpectedUnchangedValues.length === 0);
    const englishValues = await wc.executeJavaScript('(() => { const values = []; const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let node = walker.nextNode(); while (node) { const value = node.nodeValue.trim(); if (value) values.push(value); node = walker.nextNode(); } values.push(...[...document.querySelectorAll("[title],[aria-label],[placeholder]")].flatMap(element => [element.title, element.getAttribute("aria-label"), element.getAttribute("placeholder")])); return [...new Set(values.filter(Boolean))]; })()');
    const germanTerms = ['ä', 'ö', 'ü', 'ß', 'Allgemein', 'Änderungen', 'Abbrechen', 'Aktiv', 'Alle', 'Anzeigen', 'Accounts hinzufügen', 'Arbeitsbereich', 'Archiv', 'Auswahl', 'Auswählen', 'Automatik', 'Bearbeiten', 'Benachrichtigungen', 'Bereit', 'Datei', 'Dateien', 'Deaktiviert', 'Diagnose', 'Einstellungen', 'Englisch', 'Entfernen', 'Erfolgreich', 'Erstellt', 'Fehler', 'Fernsteuerung', 'Fortschritt', 'Geschwindigkeit', 'Gestern', 'Gestoppt', 'Hilfe', 'Hinzufügen', 'Inaktiv', 'Keine', 'Konnte', 'Kopieren', 'Löschen', 'Nach', 'Neue', 'Nicht', 'Öffnen', 'Ordner', 'Primär', 'Priorität', 'Prüfen', 'Schließen', 'Sekunden', 'Speichern', 'Sprache', 'Stunden', 'Unbekannt', 'Verlauf', 'verwendet', 'Warteschlange', 'Wird', 'Zeigen', 'Ziel'];
    const containsGermanTerm = value => { const lower = value.toLocaleLowerCase('de-DE'); const words = lower.match(/[A-Za-zÄÖÜäöüß]+/g) || []; return germanTerms.some(term => term.length === 1 ? value.includes(term) : term.includes(' ') ? lower.includes(term.toLocaleLowerCase('de-DE')) : words.includes(term.toLocaleLowerCase('de-DE'))); };
    const englishResidue = englishValues.filter(containsGermanTerm);
    if (englishResidue.length) console.log('English residue: ' + JSON.stringify(englishResidue, null, 2));
    check('English default leaves no German interface copy behind', englishResidue.length === 0);
    const englishSidebarHeadings = await wc.executeJavaScript('[...document.querySelectorAll("#upload-view, #accounts-view, #history-view")].map(view => [view.querySelector(".view-sidebar-kicker")?.textContent?.trim(), view.querySelector(".view-sidebar-title")?.textContent?.trim()].join("|"))');
    check('English sidebar hierarchy uses distinct translated kickers', englishSidebarHeadings.join('::') === 'Workspace|Uploads::Manage accounts|Accounts::Archive|History');
    const englishTelemetryLabels = await wc.executeJavaScript('[...document.querySelectorAll("#uploadTelemetry .upload-telemetry-label")].map(el => el.textContent.trim()).join("|")');
    check('English upload telemetry is fully localized and ordered by relevance', englishTelemetryLabels === 'Remaining|Total|Running|Connections|Completed|Failed|Speed|ETA');
    const englishLayoutFits = await wc.executeJavaScript('(() => { const states = [...document.querySelectorAll(".tab")].map(tab => { tab.click(); const view = document.querySelector(".view.active"); return view && view.scrollWidth <= view.clientWidth + 1; }); document.querySelector(".tab[data-view=upload]")?.click(); return states.every(Boolean) && document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1; })()');
    check('English labels fit every main view without horizontal overflow', englishLayoutFits === true);
    const speedSparklineAcrossTabs = await wc.executeJavaScript('(() => [...document.querySelectorAll(".tab")].map(tab => { tab.click(); const widget = document.getElementById("uploadSpeedSparkline"); const rect = widget?.getBoundingClientRect(); const style = widget && getComputedStyle(widget); return Boolean(widget && !widget.classList.contains("is-hidden") && style.visibility === "visible" && style.opacity === "1" && rect.width > 0 && rect.height > 0); }))()');
    check('Upload speed sparkline stays visible across every main tab', speedSparklineAcrossTabs.length === 4 && speedSparklineAcrossTabs.every(Boolean));
    const englishEmptyAccountHosterLabel = await wc.executeJavaScript('(() => { const container = document.getElementById("accountsSidebarHosters"); return [container?.getAttribute("data-empty-label"), getComputedStyle(container, "::after").content].join("|"); })()');
    check('Empty account hoster sidebar renders its localized English label', englishEmptyAccountHosterLabel === 'No hosts yet|"No hosts yet"');
    await wc.executeJavaScript('document.querySelector(".tab[data-view=upload]")?.click()');
    const liveLanguageSwitch = await wc.executeJavaScript('(() => { const input = document.getElementById("languageInput"); input.value = "de"; input.dispatchEvent(new Event("change", { bubbles: true })); const german = [...document.querySelectorAll(".tab")].map(tab => tab.textContent.trim()).join(","); input.value = "en"; input.dispatchEvent(new Event("change", { bubbles: true })); const english = [...document.querySelectorAll(".tab")].map(tab => tab.textContent.trim()).join(","); input.value = "de"; input.dispatchEvent(new Event("change", { bubbles: true })); return [german, english, document.documentElement.lang].join("|"); })()');
    check('Language changes apply immediately in both directions', liveLanguageSwitch === 'Upload,Accounts,Einstellungen,Verlauf|Upload,Accounts,Settings,History|de');
    const localizedStableMetric = await wc.executeJavaScript(\`(async () => {
      const previousJobs = queueJobs;
      queueJobs = Array.from({ length: 1234 }, (_, index) => ({ id: 'ui-locale-done-' + index, status: 'done' }));
      _queueStatsCache = null;
      updateStatusBar();
      await new Promise(resolve => setTimeout(resolve, 360));
      const metric = document.getElementById('uploadTelemetryCompleted');
      const german = [metric?.textContent.trim(), metric?.getAttribute('aria-label')];
      setUiLanguage('en');
      const english = [metric?.textContent.trim(), metric?.getAttribute('aria-label')];
      setUiLanguage('de');
      queueJobs = previousJobs;
      _queueStatsCache = null;
      updateStatusBar();
      return { german, english };
    })()\`);
    check('Language changes redraw stable telemetry values with the active locale', localizedStableMetric.german.join('|') === '1.234|1.234' && localizedStableMetric.english.join('|') === '1,234|1,234');
    const germanSidebarHeadings = await wc.executeJavaScript('[...document.querySelectorAll("#upload-view, #accounts-view, #history-view")].map(view => [view.querySelector(".view-sidebar-kicker")?.textContent?.trim(), view.querySelector(".view-sidebar-title")?.textContent?.trim()].join("|"))');
    check('German sidebar hierarchy uses distinct localized kickers', germanSidebarHeadings.join('::') === 'Arbeitsbereich|Uploads::Accounts verwalten|Accounts::Archiv|Verlauf');
    const saveAfterLanguageChange = await wc.executeJavaScript('(() => { const button = document.getElementById("saveSettingsBtn"); const channels = getComputedStyle(button).backgroundColor.match(/[0-9.]+/g)?.map(Number) || []; return { disabled: button.disabled, success: button.classList.contains("btn-success"), green: channels.length >= 3 && channels[1] > channels[0] * 1.25 && channels[1] > channels[2] * 1.2 }; })()');
    check('Changing language enables a visibly green save action', saveAfterLanguageChange.disabled === false && saveAfterLanguageChange.success && saveAfterLanguageChange.green);
    await wc.executeJavaScript('document.getElementById("saveSettingsBtn").click()');
    await waitUntil(() => wc.executeJavaScript('document.getElementById("saveSettingsBtn").disabled'));
    const saveAfterCommit = await wc.executeJavaScript('(() => { const button = document.getElementById("saveSettingsBtn"); return [button.disabled, button.classList.contains("btn-secondary")].join("|"); })()');
    check('Saving returns the action to its disabled gray state', saveAfterCommit === 'true|true');
    const englishLanguageQuery = await wc.executeJavaScript(\`(async () => {
      const input = document.getElementById('languageInput');
      input.value = 'en';
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await saveSettings({ feedbackText: 'Saved' });
      return new URL(location.href).searchParams.get('language');
    })()\`);
    const languageReloadFinished = new Promise(resolve => wc.once('did-finish-load', resolve));
    wc.reload();
    await languageReloadFinished;
    const reloadedLanguageState = await waitUntil(() => wc.executeJavaScript(\`(() => {
      if (typeof config !== 'object' || config.globalSettings?.language !== 'en') return '';
      return [document.documentElement.lang, new URL(location.href).searchParams.get('language'), [...document.querySelectorAll('.tab')].map(tab => tab.textContent.trim()).join(',')].join('|');
    })()\`));
    const germanLanguageQuery = await wc.executeJavaScript(\`(async () => {
      const input = document.getElementById('languageInput');
      input.value = 'de';
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await saveSettings({ feedbackText: 'Gespeichert' });
      return { query: new URL(location.href).searchParams.get('language'), active: document.documentElement.lang };
    })()\`);
    check('Saved language remains the startup language after a renderer reload', englishLanguageQuery === 'en' && reloadedLanguageState === 'en|en|Upload,Accounts,Settings,History' && germanLanguageQuery.query === 'de' && germanLanguageQuery.active === 'de');

    await wc.executeJavaScript('queueJobs = []; selectedFiles = []; selectedJobIds.clear(); rebuildJobIndex(); setUploadSidebarFilter("all"); updateUploadView(); renderQueueTable(); updateStatusBar();');
    console.log('\\n=== Upload View ===');

    const tabCount = await wc.executeJavaScript('document.querySelectorAll(".tab").length');
    check('4 tabs exist', tabCount === 4);

    const appHeaderExists = await wc.executeJavaScript('Boolean(document.querySelector(".app-header"))');
    check('App shell exposes the primary header', appHeaderExists);

    const cursorContract = await wc.executeJavaScript('[getComputedStyle(document.body).cursor, getComputedStyle(document.getElementById("settings-tab")).cursor].join("|")');
    check('Main surface keeps a visible default cursor and interactive controls keep the pointer cursor', cursorContract === 'default|pointer');

    const appBrandText = await wc.executeJavaScript('document.querySelector(".app-brand-name")?.textContent?.trim()');
    check('App header shows the Multi Hoster Uploader brand', appBrandText === 'MULTI HOSTER UPLOADER');

    const topbarIconCount = await wc.executeJavaScript('document.querySelectorAll(".app-header .tab .top-nav-icon").length');
    check('App header exposes exactly four topbar icons', topbarIconCount === 4);

    const headerUpdateButtonExists = await wc.executeJavaScript('Boolean(document.getElementById("headerUpdateBtn"))');
    check('App header exposes the update action', headerUpdateButtonExists);

    const initialHeaderUpdateVisibility = await wc.executeJavaScript('(() => { const button = document.getElementById("headerUpdateBtn"); return [button?.hidden, getComputedStyle(button).display].join("|"); })()');
    check('Header update action stays hidden until an update is available', initialHeaderUpdateVisibility === 'true|none');

    const initialUpdateLabel = await wc.executeJavaScript('document.querySelector("#headerUpdateBtn .header-update-label")?.textContent?.trim()');
    check('App header uses the compact update label', initialUpdateLabel === 'Update');

    const bodyBackground = await wc.executeJavaScript('getComputedStyle(document.body).backgroundColor');
    check('App shell uses the dark reference canvas', bodyBackground === 'rgb(15, 15, 15)');

    const shellDensity = await wc.executeJavaScript('(() => ({ header: document.querySelector(".app-header")?.getBoundingClientRect().height, sidebar: document.querySelector("#upload-view > .view-sidebar")?.getBoundingClientRect().width }))()');
    check('App shell keeps a compact desktop density', shellDensity.header <= 50 && shellDensity.sidebar <= 230);

    const tabLabels = await wc.executeJavaScript('[...document.querySelectorAll(".tab")].map(el => el.textContent.trim()).join("|")');
    check('Current tab labels present', tabLabels === 'Upload|Accounts|Einstellungen|Verlauf');

    const tabSemantics = await wc.executeJavaScript('document.querySelector(".tab-bar")?.getAttribute("role") + "|" + document.querySelector(".tab.active")?.getAttribute("aria-selected")');
    check('Tab navigation exposes active state', tabSemantics === 'tablist|true');

    const activeTab = await wc.executeJavaScript('document.querySelector(".tab.active")?.textContent?.trim()');
    check('Upload tab active by default', activeTab === 'Upload');

    const tabStops = await wc.executeJavaScript('[...document.querySelectorAll(".tab")].map(el => el.tabIndex).join("|")');
    check('Tab navigation exposes one keyboard stop', tabStops === '0|-1|-1|-1');

    await wc.executeJavaScript('document.querySelector("[data-menu-trigger=datei]")?.click()');
    await new Promise(resolve => setTimeout(resolve, 60));
    const mainMenuOpeningMotion = await wc.executeJavaScript('(() => { const menu = document.querySelector("[data-menu-dropdown=datei]"); if (!menu) return "missing"; const style = getComputedStyle(menu); const clip = style.clipPath; return [style.display !== "none", clip !== "none" && !/^inset\\(0(px)?\\)$/.test(clip), style.transform !== "none", parseFloat(style.animationDuration) >= .12].join("|"); })()');
    check('Header dropdown visibly unfolds from top to bottom', mainMenuOpeningMotion === 'true|true|true|true');
    await new Promise(resolve => setTimeout(resolve, 160));
    await wc.executeJavaScript('document.querySelector(".menu-submenu")?.dispatchEvent(new MouseEvent("mouseenter"))');
    await new Promise(resolve => setTimeout(resolve, 60));
    const submenuOpeningMotion = await wc.executeJavaScript('(() => { const menu = document.querySelector(".menu-submenu-dropdown"); if (!menu) return "missing"; const style = getComputedStyle(menu); const clip = style.clipPath; return [style.display !== "none", clip !== "none" && !/^inset\\(0(px)?\\)$/.test(clip), style.transform !== "none", parseFloat(style.animationDuration) >= .12].join("|"); })()');
    check('Nested header menu visibly unfolds from top to bottom', submenuOpeningMotion === 'true|true|true|true');
    await new Promise(resolve => setTimeout(resolve, 160));
    const menuWindowBounds = win.getBounds();
    const submenuReachability = {};
    for (const [label, width, height] of [['standard', 1100, 750], ['minimum', 800, 550]]) {
      await setWindowBounds({ ...win.getBounds(), width, height });
      submenuReachability[label] = await wc.executeJavaScript('(() => { const parent = document.querySelector("[data-menu-dropdown=datei]"); const target = document.querySelector(".menu-submenu-dropdown [data-menu-action=backup-export]"); if (!parent || !target) return "missing"; const rect = target.getBoundingClientRect(); const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2); return [getComputedStyle(parent).clipPath, hit === target || target.contains(hit)].join("|"); })()');
    }
    await setWindowBounds(menuWindowBounds);
    check('Backup submenu is painted and reachable at the standard window size', submenuReachability.standard === 'none|true');
    check('Backup submenu is painted and reachable at the minimum window size', submenuReachability.minimum === 'none|true');
    await wc.executeJavaScript('document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))');
    await new Promise(resolve => setTimeout(resolve, 60));
    const mainMenuClosingMotion = await wc.executeJavaScript('(() => { const menu = document.querySelector("[data-menu-dropdown=datei]"); if (!menu) return "missing"; const style = getComputedStyle(menu); const clip = style.clipPath; return [style.display !== "none", menu.classList.contains("menu-closing"), clip !== "none" && !/^inset\\(0(px)?\\)$/.test(clip)].join("|"); })()');
    check('Header dropdown remains visible while folding from bottom to top', mainMenuClosingMotion === 'true|true|true');
    await new Promise(resolve => setTimeout(resolve, 160));
    const mainMenuClosed = await wc.executeJavaScript('getComputedStyle(document.querySelector("[data-menu-dropdown=datei]")).display');
    check('Header dropdown is hidden after its closing motion', mainMenuClosed === 'none');

    const dropVisible = await wc.executeJavaScript('document.getElementById("dropZone")?.style.display !== "none"');
    check('Drop zone visible (no files)', dropVisible);

    const queueHidden = await wc.executeJavaScript('document.getElementById("queueShell")?.style.display');
    check('Queue hidden (no files)', queueHidden === 'none');

    const desktopDropFixture = path.join(app.getPath('temp'), 'mhu-native-drop-' + process.pid + '.mkv');
    fs.writeFileSync(desktopDropFixture, Buffer.from('desktop drop fixture'));
    const desktopDropPoint = await wc.executeJavaScript('(() => { const rect = document.querySelector(".upload-workspace")?.getBoundingClientRect(); return rect ? { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + Math.min(rect.height / 2, 180)) } : null; })()');
    let desktopDropState = null;
    const desktopDropDebuggerWasAttached = wc.debugger.isAttached();
    try {
      if (!desktopDropDebuggerWasAttached) wc.debugger.attach('1.3');
      const dragData = {
        items: [{ mimeType: 'text/uri-list', data: 'file:///' + desktopDropFixture.replace(/\\\\/g, '/') }],
        files: [desktopDropFixture],
        dragOperationsMask: 1
      };
      await wc.debugger.sendCommand('Input.dispatchDragEvent', { type: 'dragEnter', ...desktopDropPoint, data: dragData });
      await wc.debugger.sendCommand('Input.dispatchDragEvent', { type: 'dragOver', ...desktopDropPoint, data: dragData });
      await wc.debugger.sendCommand('Input.dispatchDragEvent', { type: 'drop', ...desktopDropPoint, data: dragData });
      await waitUntil(() => wc.executeJavaScript('document.getElementById("hosterModal")?.style.display === "flex"'));
      desktopDropState = await wc.executeJavaScript('(() => ({ modal: document.getElementById("hosterModal")?.style.display, paths: _pendingFiles.map(file => file.path) }))()');
      await wc.executeJavaScript('cancelHosterModal()');
    } finally {
      if (!desktopDropDebuggerWasAttached && wc.debugger.isAttached()) wc.debugger.detach();
      try { fs.unlinkSync(desktopDropFixture); } catch {}
    }
    check('Desktop file drop reaches the upload selection with its native path', desktopDropState?.modal === 'flex' && desktopDropState.paths.length === 1 && desktopDropState.paths[0] === desktopDropFixture);

    const floatingDropFolder = fs.mkdtempSync(path.join(app.getPath('temp'), 'mhu-floating-folder-drop-'));
    const floatingDropNested = path.join(floatingDropFolder, 'nested');
    const floatingDropFirst = path.join(floatingDropFolder, 'first.mkv');
    const floatingDropSecond = path.join(floatingDropNested, 'second.mp4');
    fs.mkdirSync(floatingDropNested);
    fs.writeFileSync(floatingDropFirst, Buffer.from('first floating drop fixture'));
    fs.writeFileSync(floatingDropSecond, Buffer.from('second floating drop fixture'));
    let floatingFolderDropState = null;
    try {
      wc.send('drop-target:files', [{ path: floatingDropFolder, name: path.basename(floatingDropFolder), size: 0, isDirectory: true }]);
      await waitUntil(() => wc.executeJavaScript('document.getElementById("hosterModal")?.style.display === "flex" && _pendingFiles.length === 2'));
      floatingFolderDropState = await wc.executeJavaScript('(() => ({ modal: document.getElementById("hosterModal")?.style.display, paths: _pendingFiles.map(file => file.path).sort() }))()');
      await wc.executeJavaScript('cancelHosterModal()');
    } finally {
      fs.rmSync(floatingDropFolder, { recursive: true, force: true });
    }
    check('Floating drop target recursively expands folders before hoster selection', floatingFolderDropState?.modal === 'flex' && floatingFolderDropState.paths.join('|') === [floatingDropFirst, floatingDropSecond].sort().join('|'));

    const populatedDropFixture = path.join(app.getPath('temp'), 'mhu-populated-drop-' + process.pid + '.mkv');
    fs.writeFileSync(populatedDropFixture, Buffer.from('populated queue drop fixture'));
    await wc.executeJavaScript('(() => { selectedFiles = [{ path: "C:/ui/existing.bin", name: "existing.bin", size: 16 }]; queueJobs = [{ id: "ui-existing-drop-row", file: "C:/ui/existing.bin", fileName: "existing.bin", hoster: "doodstream.com", status: "preview", bytesUploaded: 0, bytesTotal: 16, speedKbs: 0, elapsed: 0, remaining: 0, progress: 0 }]; rebuildJobIndex(); updateUploadView(); renderQueueTable(); })()');
    const populatedDropPoint = await wc.executeJavaScript('(() => { const rect = document.getElementById("queueShell")?.getBoundingClientRect(); return rect ? { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + Math.min(140, rect.height / 3)) } : null; })()');
    let populatedDropState = null;
    const populatedDropDebuggerWasAttached = wc.debugger.isAttached();
    try {
      if (!populatedDropDebuggerWasAttached) wc.debugger.attach('1.3');
      const dragData = {
        items: [{ mimeType: 'text/uri-list', data: 'file:///' + populatedDropFixture.replace(/\\\\/g, '/') }],
        files: [populatedDropFixture],
        dragOperationsMask: 1
      };
      await wc.debugger.sendCommand('Input.dispatchDragEvent', { type: 'dragEnter', ...populatedDropPoint, data: dragData });
      await wc.debugger.sendCommand('Input.dispatchDragEvent', { type: 'dragOver', ...populatedDropPoint, data: dragData });
      await wc.debugger.sendCommand('Input.dispatchDragEvent', { type: 'drop', ...populatedDropPoint, data: dragData });
      await waitUntil(() => wc.executeJavaScript('document.getElementById("hosterModal")?.style.display === "flex"'));
      populatedDropState = await wc.executeJavaScript('(() => ({ modal: document.getElementById("hosterModal")?.style.display, paths: _pendingFiles.map(file => file.path) }))()');
      await wc.executeJavaScript('cancelHosterModal(); selectedFiles = []; queueJobs = []; rebuildJobIndex(); _queueStatsCache = null; updateUploadView(); renderQueueTable(); updateStatusBar();');
    } finally {
      if (!populatedDropDebuggerWasAttached && wc.debugger.isAttached()) wc.debugger.detach();
      try { fs.unlinkSync(populatedDropFixture); } catch {}
    }
    check('Desktop file drop still reaches upload selection while the queue is populated', populatedDropState?.modal === 'flex' && populatedDropState.paths.length === 1 && populatedDropState.paths[0] === populatedDropFixture);

    const duplicateDropFixture = path.join(app.getPath('temp'), 'mhu-duplicate-drop-' + process.pid + '.mkv');
    fs.writeFileSync(duplicateDropFixture, Buffer.from('duplicate queue drop fixture'));
    await wc.executeJavaScript('(() => { selectedFiles = [{ path: ' + JSON.stringify(duplicateDropFixture) + ', name: "mhu-duplicate-drop.mkv", size: 28 }]; queueJobs = [{ id: "ui-duplicate-drop-row", file: ' + JSON.stringify(duplicateDropFixture) + ', fileName: "mhu-duplicate-drop.mkv", hoster: "doodstream.com", status: "done", bytesUploaded: 28, bytesTotal: 28, speedKbs: 0, elapsed: 1, remaining: 0, progress: 100 }]; rebuildJobIndex(); updateUploadView(); renderQueueTable(); const toast = document.getElementById("copyToast"); toast.textContent = ""; toast.classList.remove("show"); })()');
    const duplicateDropPoint = await wc.executeJavaScript('(() => { const rect = document.getElementById("queueShell")?.getBoundingClientRect(); return rect ? { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + Math.min(140, rect.height / 3)) } : null; })()');
    let duplicateDropState = null;
    const duplicateDropDebuggerWasAttached = wc.debugger.isAttached();
    try {
      if (!duplicateDropDebuggerWasAttached) wc.debugger.attach('1.3');
      const dragData = {
        items: [{ mimeType: 'text/uri-list', data: 'file:///' + duplicateDropFixture.replace(/\\\\/g, '/') }],
        files: [duplicateDropFixture],
        dragOperationsMask: 1
      };
      await wc.debugger.sendCommand('Input.dispatchDragEvent', { type: 'dragEnter', ...duplicateDropPoint, data: dragData });
      await wc.debugger.sendCommand('Input.dispatchDragEvent', { type: 'dragOver', ...duplicateDropPoint, data: dragData });
      await wc.debugger.sendCommand('Input.dispatchDragEvent', { type: 'drop', ...duplicateDropPoint, data: dragData });
      await new Promise(resolve => setTimeout(resolve, 100));
      duplicateDropState = await wc.executeJavaScript('(() => ({ modal: document.getElementById("hosterModal")?.style.display, pending: _pendingFiles.length, toast: document.getElementById("copyToast")?.textContent, shown: document.getElementById("copyToast")?.classList.contains("show") }))()');
      await wc.executeJavaScript('selectedFiles = []; queueJobs = []; rebuildJobIndex(); _queueStatsCache = null; updateUploadView(); renderQueueTable(); updateStatusBar();');
    } finally {
      if (!duplicateDropDebuggerWasAttached && wc.debugger.isAttached()) wc.debugger.detach();
      try { fs.unlinkSync(duplicateDropFixture); } catch {}
    }
    check('Dropping a file already in the upload jobs explains the exact duplicate balance instead of doing nothing', duplicateDropState?.modal === 'none' && duplicateDropState.pending === 0 && duplicateDropState.shown === true && duplicateDropState.toast === 'Kandidaten: 1 · Bereits vorhanden / dupliziert: 1 · Durch Dateinamenfilter ausgeschlossen: 0 · Fehlend / unlesbar / leer: 0 · Akzeptierte Dateien: 0');

    const startDisabled = await wc.executeJavaScript('document.getElementById("startUploadBtn")?.disabled');
    check('Start button disabled initially', startDisabled === true);

    const legacyStatusbar = await wc.executeJavaScript('document.getElementById("statusbar")');
    check('Legacy bottom statusbar is removed', legacyStatusbar === null);

    const version = await wc.executeJavaScript('document.getElementById("versionLabel")?.textContent');
    check('Version label matches package.json', version === ${JSON.stringify(`v${productVersion}`)});
    const standardHeaderBrand = await wc.executeJavaScript('(() => { const brand = document.querySelector(".app-brand-name"); if (!brand) return null; const rect = brand.getBoundingClientRect(); return { visible: getComputedStyle(brand).display !== "none" && rect.width > 0, fits: brand.scrollWidth <= brand.clientWidth + 1, text: brand.textContent.trim() }; })()');
    check('Standard window shows the full product name', standardHeaderBrand?.visible === true && standardHeaderBrand.fits === true && standardHeaderBrand.text === 'MULTI HOSTER UPLOADER');
    const versionMonogram = await wc.executeJavaScript('document.querySelector(".version-monogram")');
    check('Header version badge has no meaningless monogram', versionMonogram === null);
    const windowTitle = await wc.executeJavaScript('document.title');
    check('Window uses the Multi Hoster Uploader title', windowTitle === 'Multi Hoster Uploader');
    const appAlertState = await wc.executeJavaScript('showAppAlert("Keine Hoster mit Zugangsdaten für einen Check."); (() => { const modal = document.getElementById("appAlertModal"); return [modal?.style.display, modal?.getAttribute("aria-hidden"), document.getElementById("appAlertTitle")?.textContent, document.getElementById("appAlertMessage")?.textContent, document.activeElement?.id].join("|"); })()');
    check('Hoster check uses the styled app dialog', appAlertState === 'flex|false|Hinweis|Keine Hoster mit Zugangsdaten für einen Check.|appAlertConfirmBtn');
    await wc.executeJavaScript('document.getElementById("appAlertConfirmBtn")?.click(); true');
    const appAlertClosed = await wc.executeJavaScript('document.getElementById("appAlertModal")?.style.display');
    check('Styled app dialog closes with its confirmation action', appAlertClosed === 'none');

    const localizedQueueHeaders = await wc.executeJavaScript('[...document.querySelectorAll("#queueTable thead th")].map(el => el.childNodes[0]?.textContent.trim()).join("|")');
    check('Upload table labels are consistently German', localizedQueueHeaders === 'Dateiname|Hochgeladen / Größe|Hoster|Status|Zeit|Rest|Geschwindigkeit|Fortschritt');

    const localizedRecentTabs = await wc.executeJavaScript('[...document.querySelectorAll(".recent-tab")].map(el => el.textContent.trim()).join("|")');
    check('Recent panel labels are consistently German', localizedRecentTabs === 'Dateien|Statistik');

    const localizedTelemetry = await wc.executeJavaScript('[...document.querySelectorAll("#uploadTelemetry .upload-telemetry-label")].map(el => el.textContent.trim()).join("|")');
    check('Upload telemetry exposes all eight German labels in the requested order', localizedTelemetry === 'Verbleibend|Gesamt|Läuft|Verbindungen|Fertig|Fehler|Geschwindigkeit|ETA');

    const initialTelemetryValues = await wc.executeJavaScript('[...document.querySelectorAll("#uploadTelemetry .upload-telemetry-value")].map(el => el.getAttribute("aria-label") || el.textContent.trim()).join("|")');
    check('Upload telemetry starts with stable empty values', initialTelemetryValues === '0|0|0|0|0|0|0 B/s|--:--');

    const previewQueueCounts = await wc.executeJavaScript(\`(() => {
      queueJobs = [{ id: 'existing-done', file: 'C:/ui/existing-done.bin', fileName: 'existing-done.bin', hoster: 'doodstream.com', status: 'done', bytesUploaded: 1024, bytesTotal: 1024, speedKbs: 0, elapsed: 1, remaining: 0, progress: 1 }];
      selectedFiles = [];
      selectedUploadHosters = ['doodstream.com'];
      _sessionDoneCount = 1;
      _sessionErrorCount = 0;
      _queueStatsCache = null;
      updateStatusBar();
      selectedFiles = [1, 2, 3].map(index => ({ path: 'C:/ui/new-' + index + '.bin', name: 'new-' + index + '.bin', size: 2048 }));
      buildQueuePreview();
      const result = {
        queue: queueJobs.map(job => job.status).join('|'),
        sidebar: ['All', 'Active', 'Waiting', 'Done', 'Error'].map(key => document.getElementById('uploadSidebar' + key + 'Count')?.textContent).join('|'),
        telemetry: ['Total', 'Remaining', 'Running'].map(key => document.getElementById('uploadTelemetry' + key)?.getAttribute('aria-label')).join('|')
      };
      queueJobs = [];
      selectedFiles = [];
      selectedUploadHosters = [];
      _sessionDoneCount = 0;
      _queueStatsCache = null;
      updateStatusBar();
      return result;
    })()\`);
    check('Adding preview files immediately refreshes upload counts before the batch starts', previewQueueCounts.queue === 'done|preview|preview|preview' && previewQueueCounts.sidebar === '4|0|3|1|0' && previewQueueCounts.telemetry === '4|3|0');
    const readyStatusColors = await wc.executeJavaScript('(() => { const preview = document.createElement("span"); const done = document.createElement("span"); preview.className = "status-badge status-preview"; done.className = "status-badge status-done"; preview.textContent = "Bereit"; done.textContent = "Fertig"; document.body.append(preview, done); const previewStyle = getComputedStyle(preview); const doneStyle = getComputedStyle(done); const result = { previewColor: previewStyle.color, previewBackground: previewStyle.backgroundColor, doneColor: doneStyle.color, doneBackground: doneStyle.backgroundColor }; preview.remove(); done.remove(); return result; })()');
    check('Ready uses the same semantic green treatment as completed uploads', readyStatusColors.previewColor === readyStatusColors.doneColor && readyStatusColors.previewBackground === readyStatusColors.doneBackground && readyStatusColors.previewBackground !== 'rgba(0, 0, 0, 0)');

    const sidebarBadgeStyle = await wc.executeJavaScript(\`(() => {
      const badge = document.getElementById('uploadSidebarAllCount');
      const style = getComputedStyle(badge);
      const rect = badge.getBoundingClientRect();
      return { background: style.backgroundColor, color: style.color, fontSize: parseFloat(style.fontSize), fontWeight: parseInt(style.fontWeight, 10), width: rect.width, height: rect.height };
    })()\`);
    check('Sidebar count badges use a larger light-blue high-contrast pill', sidebarBadgeStyle.background === 'rgb(186, 208, 252)' && sidebarBadgeStyle.color === 'rgb(16, 23, 35)' && sidebarBadgeStyle.fontSize >= 12 && sidebarBadgeStyle.fontWeight >= 600 && sidebarBadgeStyle.width >= 22 && sidebarBadgeStyle.height >= 22);

    const speedSparklineState = await wc.executeJavaScript('(() => { const widget = document.getElementById("uploadSpeedSparkline"); const canvas = document.getElementById("uploadSpeedCanvas"); const rect = canvas?.getBoundingClientRect(); return [Boolean(widget), widget?.classList.contains("is-hidden"), rect?.width > 0, rect?.height > 0, document.getElementById("uploadSpeedValue")?.textContent].join("|"); })()');
    check('Upload header exposes the visible speed sparkline', speedSparklineState === 'true|false|true|true|0 B/s');

    const speedSparklineGeometry = await wc.executeJavaScript('(() => { const widget = document.getElementById("uploadSpeedSparkline")?.getBoundingClientRect(); const canvas = document.getElementById("uploadSpeedCanvas")?.getBoundingClientRect(); const value = document.getElementById("uploadSpeedValue")?.getBoundingClientRect(); return { widgetWidth: widget?.width || 0, canvasWidth: canvas?.width || 0, gap: value && canvas ? value.left - canvas.right : 0, contained: Boolean(widget && canvas && value && canvas.left >= widget.left && value.right <= widget.right) }; })()');
    check('Upload header extends the speed line toward the value instead of leaving a fixed empty column', speedSparklineGeometry.canvasWidth >= 108 && speedSparklineGeometry.gap >= 3 && speedSparklineGeometry.gap <= 5 && speedSparklineGeometry.contained);

    const toolbarLabels = await wc.executeJavaScript('[...document.querySelectorAll("#queueCommandBar .toolbar-btn")].map(el => el.getAttribute("aria-label")).join("|")');
    check('Upload toolbar actions have German accessible names', toolbarLabels === 'Alle Uploads starten|Ausgewählte Uploads starten|Ausgewählte Datei erneut hochladen|Ausgewählten Upload abbrechen|Aktive Uploads beenden und stoppen|Alle Uploads abbrechen|Ganz nach oben|Nach oben|Nach unten|Ganz nach unten');

    const uploadWorkspaceLayout = await wc.executeJavaScript('(() => { const view = document.getElementById("upload-view"); const sidebar = view?.querySelector(":scope > .view-sidebar"); const main = view?.querySelector(":scope > .view-main"); if (!sidebar || !main) return false; const sidebarRect = sidebar.getBoundingClientRect(); const mainRect = main.getBoundingClientRect(); return sidebarRect.width > 0 && mainRect.width > 0 && sidebarRect.right <= mainRect.left; })()');
    check('Upload view separates sidebar and main workspace', uploadWorkspaceLayout === true);

    const uploadSidebarInformation = await wc.executeJavaScript('(() => { const sidebar = document.querySelector("#upload-view > .view-sidebar")?.getBoundingClientRect(); const availability = document.getElementById("uploadAvailability")?.getBoundingClientRect(); const telemetry = document.getElementById("uploadTelemetry")?.getBoundingClientRect(); return Boolean(sidebar && availability && telemetry && availability.bottom <= telemetry.top && telemetry.bottom <= sidebar.bottom + 1 && document.getElementById("uploadSidebarAccountsCount")); })()');
    check('Upload sidebar stacks availability above bottom telemetry', uploadSidebarInformation === true);

    const lowerSidebarTypography = await wc.executeJavaScript('(() => { const availabilityLabel = document.querySelector("#uploadAvailability .view-sidebar-section-label"); const availabilityText = document.querySelector("#uploadAvailability .view-sidebar-summary"); const telemetryLabel = document.querySelector("#uploadTelemetry .upload-telemetry-label"); const telemetryValue = document.querySelector("#uploadTelemetry .upload-telemetry-value"); return [availabilityLabel, availabilityText, telemetryLabel, telemetryValue].map(element => parseFloat(getComputedStyle(element).fontSize)); })()');
    check('Availability and telemetry use the larger readable type scale', lowerSidebarTypography[0] >= 11 && lowerSidebarTypography[1] >= 12 && lowerSidebarTypography[2] >= 12 && lowerSidebarTypography[3] >= 12);

    const telemetryUpdate = await wc.executeJavaScript(\`(() => {
      queueJobs = [
        { id: 'telemetry-running', status: 'uploading', bytesTotal: 4096, bytesUploaded: 1024 },
        { id: 'telemetry-waiting', status: 'queued', bytesTotal: 2048, bytesUploaded: 0 },
        { id: 'telemetry-done', status: 'done', bytesTotal: 1024, bytesUploaded: 1024 },
        { id: 'telemetry-error', status: 'error', bytesTotal: 1024, bytesUploaded: 0 }
      ];
      _sessionDoneCount = 7;
      _sessionErrorCount = 2;
      lastUploadStats = { ...lastUploadStats, globalSpeedKbs: 2, activeJobs: 1, state: 'uploading' };
      updateStatusBar();
      const total = document.getElementById('uploadTelemetryTotal');
      const rolling = total?.querySelectorAll(':scope > span').length;
      return {
        values: ['Total', 'Connections', 'Remaining', 'Running', 'Completed', 'Failed', 'Speed', 'Eta'].map(key => {
          const element = document.getElementById('uploadTelemetry' + key);
          return element?.getAttribute('aria-label') || element?.textContent.trim();
        }).join('|'),
        rolling,
        direction: total?.dataset.direction,
        speedPair: [document.getElementById('uploadTelemetrySpeed')?.textContent, document.getElementById('uploadSpeedValue')?.textContent].join('|')
      };
    })()\`);
    check('Upload telemetry reflects current queue activity', telemetryUpdate.values === '4|1|2|1|1|1|2 kB/s|00:03');
    check('Changing integer telemetry rolls vertically', telemetryUpdate.rolling === 2 && telemetryUpdate.direction === 'up');
    check('Header and sidebar speed update synchronously from the same live sample', telemetryUpdate.speedPair === '2 kB/s|2 kB/s');
    const secondSynchronizedSpeed = await wc.executeJavaScript('lastUploadStats = { ...lastUploadStats, globalSpeedKbs: 1536 }; updateStatusBar(); [document.getElementById("uploadTelemetrySpeed")?.textContent, document.getElementById("uploadSpeedValue")?.textContent].join("|")');
    check('Header and sidebar speed stay synchronized across later samples', secondSynchronizedSpeed === '1.5 MB/s|1.5 MB/s');
    const runtimeTimerRestart = await wc.executeJavaScript(\`(async () => {
      if (statsRunTimer) clearInterval(statsRunTimer);
      statsRunTimer = null;
      statsStartTime = 0;
      handleStats({ state: 'uploading', globalSpeedKbs: 1, totalBytes: 1, elapsed: 0, activeJobs: 1 });
      const first = { start: statsStartTime, timer: statsRunTimer };
      handleStats({ state: 'idle', globalSpeedKbs: 0, totalBytes: 1, elapsed: 1, activeJobs: 0 });
      const idle = { start: statsStartTime, timer: statsRunTimer };
      await new Promise(resolve => setTimeout(resolve, 2));
      handleStats({ state: 'uploading', globalSpeedKbs: 1, totalBytes: 2, elapsed: 0, activeJobs: 1 });
      const second = { start: statsStartTime, timer: statsRunTimer };
      handleStats({ state: 'idle', globalSpeedKbs: 0, totalBytes: 2, elapsed: 1, activeJobs: 0 });
      return { first, idle, second, settled: { start: statsStartTime, timer: statsRunTimer } };
    })()\`);
    check('Runtime telemetry starts a fresh timer for every upload batch', runtimeTimerRestart.first.start > 0 && runtimeTimerRestart.first.timer !== null && runtimeTimerRestart.idle.start === 0 && runtimeTimerRestart.idle.timer === null && runtimeTimerRestart.second.start > runtimeTimerRestart.first.start && runtimeTimerRestart.second.timer !== null && runtimeTimerRestart.settled.start === 0 && runtimeTimerRestart.settled.timer === null);
    const failedQueueCountConsistency = await wc.executeJavaScript(\`(() => {
      queueJobs = [
        { id: 'failed-count-a', status: 'error', bytesTotal: 1024, bytesUploaded: 0 },
        { id: 'failed-count-b', status: 'error', bytesTotal: 1024, bytesUploaded: 0 },
        { id: 'failed-count-waiting', status: 'queued', bytesTotal: 1024, bytesUploaded: 0 }
      ];
      _sessionErrorCount = 0;
      _queueStatsCache = null;
      updateStatusBar();
      return {
        filter: document.getElementById('uploadSidebarErrorCount')?.textContent,
        telemetry: document.getElementById('uploadTelemetryFailed')?.getAttribute('aria-label')
      };
    })()\`);
    check('Failed queue jobs update the filter badge and telemetry count consistently', failedQueueCountConsistency.filter === '2' && failedQueueCountConsistency.telemetry === '2');
    await new Promise(resolve => setTimeout(resolve, 360));
    await wc.executeJavaScript('queueJobs = []; _sessionDoneCount = 0; _sessionErrorCount = 0; lastUploadStats = { ...lastUploadStats, globalSpeedKbs: 0, activeJobs: 0, state: "idle" }; updateStatusBar();');

    const uploadSidebarBorders = await wc.executeJavaScript('(() => { const items = [...document.querySelectorAll("#upload-view .view-sidebar-item")]; const inactive = items.filter(item => !item.classList.contains("active")); const inactiveBorders = inactive.every(item => { const style = getComputedStyle(item); return style.borderTopWidth === "1px" && style.borderTopStyle === "solid" && !style.borderTopColor.endsWith(", 0)"); }); const active = items.find(item => item.classList.contains("active")); const indicator = document.querySelector("#upload-view .view-sidebar-indicator"); const activeTransparent = active && getComputedStyle(active).backgroundColor === "rgba(0, 0, 0, 0)"; const indicatorVisible = indicator && getComputedStyle(indicator).borderTopWidth === "1px" && !getComputedStyle(indicator).borderTopColor.endsWith(", 0)"); return [items.length, inactiveBorders, activeTransparent, indicatorVisible].join("|"); })()');
    check('Upload sidebar filters keep individual borders and move the active surface to the indicator', uploadSidebarBorders === '5|true|true|true');

    const sidebarIndicatorCount = await wc.executeJavaScript('document.querySelectorAll(".view-sidebar-navigation > .view-sidebar-indicator").length');
    check('Upload, account and history sidebars expose moving selection indicators', sidebarIndicatorCount === 3);

    await wc.executeJavaScript('window.__uiUploadIndicatorStart = document.querySelector("#upload-view .view-sidebar-indicator")?.getBoundingClientRect().top; document.querySelector("[data-upload-sidebar-target=error]")?.click()');
    await new Promise(resolve => setTimeout(resolve, 90));
    const uploadIndicatorMovingDown = await wc.executeJavaScript('(() => { const indicator = document.querySelector("#upload-view .view-sidebar-indicator"); const target = document.querySelector("[data-upload-sidebar-target=error]"); const start = window.__uiUploadIndicatorStart; if (!indicator || !target || !Number.isFinite(start)) return "missing"; const current = indicator.getBoundingClientRect().top; const targetTop = target.getBoundingClientRect().top; const duration = parseFloat(getComputedStyle(indicator).transitionDuration); return [current > start + 2 && current < targetTop - 2, duration >= .15].join("|"); })()');
    check('Upload sidebar indicator remains visibly in motion while gliding down', uploadIndicatorMovingDown === 'true|true');
    await new Promise(resolve => setTimeout(resolve, 170));
    const uploadIndicatorAtError = await wc.executeJavaScript('(() => { const indicator = document.querySelector("#upload-view .view-sidebar-indicator"); const target = document.querySelector("[data-upload-sidebar-target=error]"); if (!indicator || !target) return "missing"; const indicatorRect = indicator.getBoundingClientRect(); const targetRect = target.getBoundingClientRect(); window.__uiUploadIndicatorErrorTop = indicatorRect.top; return [Math.abs(indicatorRect.top - targetRect.top) <= 1, Math.abs(indicatorRect.height - targetRect.height) <= 1].join("|"); })()');
    check('Upload sidebar indicator glides to a lower filter', uploadIndicatorAtError === 'true|true');
    await wc.executeJavaScript('document.querySelector("[data-upload-sidebar-target=all]")?.click()');
    await new Promise(resolve => setTimeout(resolve, 90));
    const uploadIndicatorMovingUp = await wc.executeJavaScript('(() => { const indicator = document.querySelector("#upload-view .view-sidebar-indicator"); const target = document.querySelector("[data-upload-sidebar-target=all]"); const start = window.__uiUploadIndicatorErrorTop; if (!indicator || !target || !Number.isFinite(start)) return false; const current = indicator.getBoundingClientRect().top; const targetTop = target.getBoundingClientRect().top; return current < start - 2 && current > targetTop + 2; })()');
    check('Upload sidebar indicator remains visibly in motion while gliding up', uploadIndicatorMovingUp === true);
    await new Promise(resolve => setTimeout(resolve, 170));

    const uploadFrameFit = await wc.executeJavaScript('(() => { const view = document.getElementById("upload-view")?.getBoundingClientRect(); return Boolean(view && view.bottom <= window.innerHeight + 1); })()');
    check('Upload view fits inside the viewport', uploadFrameFit === true);

    await captureVisual('01-upload.png');

    const uploadFilterState = await wc.executeJavaScript(\`(() => {
      const makeJob = (id, fileName, status) => ({ id, file: 'C:/ui/' + fileName, fileName, hoster: 'byse.sx', status, bytesUploaded: 0, bytesTotal: 1024, speedKbs: 0, elapsed: 0, remaining: 0, progress: status === 'done' ? 1 : 0 });
      const waiting = Array.from({ length: 201 }, (_, index) => makeJob('ui-wait-' + index, 'wait-' + String(index).padStart(3, '0') + '.bin', 'queued'));
      queueJobs = [makeJob('ui-active-z', 'active-z.bin', 'uploading'), ...waiting, makeJob('ui-error', 'error.bin', 'error'), makeJob('ui-done', 'done.bin', 'done'), makeJob('ui-active-a', 'active-a.bin', 'retrying')];
      queueSortState.key = 'filename';
      queueSortState.direction = 'asc';
      selectedJobIds.clear();
      selectedJobIds.add('ui-active-z');
      selectedJobIds.add('ui-error');
      const sourceOrder = queueJobs.map(job => job.id).join(',');
      document.getElementById('queueContainer').scrollTop = 0;
      renderQueueTable();
      const allState = {
        working: _sortedJobsCache.length,
        rendered: document.querySelectorAll('#queueBody .queue-row').length,
        spacer: Boolean(document.querySelector('#queueBody .virtual-spacer')),
        height: document.querySelector('#queueBody .queue-row')?.style.height
      };
      const inspect = (value) => {
        document.querySelector('[data-upload-sidebar-target="' + value + '"]').click();
        return {
          working: _sortedJobsCache.length,
          ids: [...document.querySelectorAll('#queueBody .queue-row')].map(row => row.dataset.jobId),
          names: [...document.querySelectorAll('#queueBody .queue-row .col-filename')].map(cell => cell.textContent),
          spacer: Boolean(document.querySelector('#queueBody .virtual-spacer')),
          selected: [...selectedJobIds],
          pressed: [...document.querySelectorAll('[data-upload-sidebar-target]')].filter(button => button.getAttribute('aria-pressed') === 'true').map(button => button.dataset.uploadSidebarTarget),
          active: [...document.querySelectorAll('[data-upload-sidebar-target].active')].map(button => button.dataset.uploadSidebarTarget)
        };
      };
      const active = inspect('active');
      const waitingState = inspect('waiting');
      const done = inspect('done');
      const error = inspect('error');
      const restored = inspect('all');
      const sourceUnchanged = sourceOrder === queueJobs.map(job => job.id).join(',');
      queueJobs = [makeJob('ui-only-waiting', 'only-waiting.bin', 'queued')];
      const emptyError = inspect('error');
      const emptySafe = queueJobs.length === 1 && emptyError.working === 0 && emptyError.ids.length === 0;
      queueJobs = [];
      document.querySelector('[data-upload-sidebar-target="all"]').click();
      updateStatusBar();
      return { allState, active, waitingState, done, error, restored, sourceUnchanged, emptySafe };
    })()\`);
    check('Upload sidebar filters the visible queue without mutating source order', uploadFilterState.active.working === 2 && uploadFilterState.active.names.join('|') === 'active-a.bin|active-z.bin' && uploadFilterState.waitingState.working === 201 && uploadFilterState.done.ids.join('|') === 'ui-done' && uploadFilterState.error.ids.join('|') === 'ui-error' && uploadFilterState.restored.working === 205 && uploadFilterState.sourceUnchanged);
    check('Upload sidebar retains 28px virtual rows for large filtered queues', uploadFilterState.allState.working === 205 && uploadFilterState.allState.rendered > 0 && uploadFilterState.allState.rendered < 205 && uploadFilterState.allState.spacer && uploadFilterState.allState.height === '28px' && uploadFilterState.waitingState.spacer);
    check('Upload sidebar exposes one pressed filter and handles empty matches', uploadFilterState.active.pressed.join('|') === 'active' && uploadFilterState.active.active.join('|') === 'active' && uploadFilterState.error.pressed.join('|') === 'error' && uploadFilterState.error.active.join('|') === 'error' && uploadFilterState.emptySafe);
    check('Upload sidebar drops hidden selections when changing filters', uploadFilterState.active.selected.join('|') === 'ui-active-z');

    const uploadProgressMotion = await wc.executeJavaScript(\`(async () => {
      const table = document.createElement('table');
      table.style.cssText = 'position:fixed;left:20px;top:20px;width:700px;';
      const tbody = document.createElement('tbody');
      const job = { id: 'ui-smooth-progress', file: 'C:/ui/smooth.bin', fileName: 'smooth.bin', hoster: 'byse.sx', status: 'uploading', bytesUploaded: 920, bytesTotal: 1000, speedKbs: 1, elapsed: 1, remaining: 1, progress: .92 };
      tbody.innerHTML = buildRowHtml(job);
      table.append(tbody);
      document.body.append(table);
      const row = tbody.querySelector('.queue-row');
      const track = row.querySelector('.progress-bar-bg');
      const fill = row.querySelector('.progress-bar-fill');
      track.style.cssText = 'flex:none;width:400px;';
      const ratio = () => fill.getBoundingClientRect().width / track.getBoundingClientRect().width;
      const background = getComputedStyle(fill).backgroundImage;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const start = ratio();
      job.progress = .924;
      job.bytesUploaded = 924;
      _updateRowInPlace(row, job);
      await new Promise(resolve => setTimeout(resolve, 80));
      const fractionalMiddle = ratio();
      await new Promise(resolve => setTimeout(resolve, 240));
      const fractionalEnd = ratio();
      const fractionalLabel = row.querySelector('.progress-pct').textContent;
      job.progress = .93;
      job.bytesUploaded = 930;
      _updateRowInPlace(row, job);
      const nextFrames = [];
      for (let frame = 0; frame < 12; frame++) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        nextFrames.push(ratio());
      }
      await new Promise(resolve => setTimeout(resolve, 240));
      const end = ratio();
      table.remove();
      return { background, start, fractionalMiddle, fractionalEnd, fractionalLabel, nextFrames, end };
    })()\`);
    check('Active upload progress uses the green success gradient', uploadProgressMotion.background === 'linear-gradient(90deg, rgb(117, 211, 155), rgb(156, 226, 184))');
    check('Active upload progress moves continuously before the rounded percentage changes', uploadProgressMotion.start > .919 && uploadProgressMotion.start < .921 && uploadProgressMotion.fractionalMiddle > uploadProgressMotion.start && uploadProgressMotion.fractionalMiddle < .924 && uploadProgressMotion.fractionalEnd > .923 && uploadProgressMotion.fractionalEnd < .925 && uploadProgressMotion.fractionalLabel === '92%');
    const smoothFrameCount = uploadProgressMotion.nextFrames.slice(1).filter((value, index) => value > uploadProgressMotion.nextFrames[index] + .00001).length;
    const monotonicFrames = uploadProgressMotion.nextFrames.every((value, index, values) => index === 0 || value >= values[index - 1] - .00001);
    console.log('Upload progress frame trace: ' + [uploadProgressMotion.fractionalEnd, ...uploadProgressMotion.nextFrames, uploadProgressMotion.end].map(value => (value * 100).toFixed(3)).join(' -> '));
    check('Active upload progress glides through the next whole percentage across real frames', uploadProgressMotion.nextFrames.length === 12 && smoothFrameCount >= 8 && monotonicFrames && uploadProgressMotion.nextFrames.at(-1) > uploadProgressMotion.fractionalEnd && uploadProgressMotion.nextFrames.at(-1) < .93 && uploadProgressMotion.end > .929 && uploadProgressMotion.end < .931);

    const uploadSelectionScope = await wc.executeJavaScript(\`(() => {
      const makeJob = (id, status) => ({ id, file: 'C:/ui/' + id + '.bin', fileName: id + '.bin', hoster: 'byse.sx', status, bytesUploaded: 0, bytesTotal: 1024, speedKbs: 0, elapsed: 0, remaining: 0, progress: status === 'done' ? 1 : 0 });
      const activeA = makeJob('scope-active-a', 'uploading');
      const activeZ = makeJob('scope-active-z', 'retrying');
      const error = makeJob('scope-error', 'error');
      const done = makeJob('scope-done', 'done');
      queueJobs = [activeZ, error, done, activeA];
      rebuildJobIndex();
      selectedJobIds.clear();
      selectedRecentIds.clear();
      setUploadSidebarFilter('active');
      document.getElementById('queueContainer').dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
      const ctrlASelected = [...selectedJobIds].sort();
      selectedJobIds.clear();
      selectedJobIds.add(activeA.id);
      activeA.status = 'done';
      renderQueueTable();
      const statusChangeSelected = [...selectedJobIds];
      const statusChangeVisible = _sortedJobsCache.map(job => job.id);
      queueJobs = [activeZ, error, done, activeA];
      activeA.status = 'uploading';
      rebuildJobIndex();
      setUploadSidebarFilter('active');
      selectedJobIds.clear();
      selectedJobIds.add(error.id);
      updateQueueActionButtons();
      const hiddenAction = {
        selected: [...selectedJobIds],
        retryDisabled: document.getElementById('reuploadSelectedBtn').disabled,
        moveDisabled: document.getElementById('moveTopBtn').disabled
      };
      queueJobs = [];
      selectedJobIds.clear();
      rebuildJobIndex();
      setUploadSidebarFilter('all');
      updateStatusBar();
      return { ctrlASelected, statusChangeSelected, statusChangeVisible, hiddenAction };
    })()\`);
    check('Ctrl+A selects only jobs visible in the upload filter', uploadSelectionScope.ctrlASelected.join('|') === 'scope-active-a|scope-active-z');
    check('Status changes drop selections that leave the upload filter', uploadSelectionScope.statusChangeSelected.length === 0 && uploadSelectionScope.statusChangeVisible.join('|') === 'scope-active-z');
    check('Selected upload actions ignore hidden stale selections', uploadSelectionScope.hiddenAction.selected.length === 0 && uploadSelectionScope.hiddenAction.retryDisabled && uploadSelectionScope.hiddenAction.moveDisabled);

    const queueSelectionAnchor = await wc.executeJavaScript(\`(() => {
      queueJobs = ['a', 'b', 'c', 'd'].map(id => ({ id: 'anchor-' + id, file: 'C:/ui/anchor-' + id + '.bin', fileName: 'anchor-' + id + '.bin', hoster: 'byse.sx', status: 'queued', bytesUploaded: 0, bytesTotal: 100, progress: 0 }));
      selectedJobIds.clear();
      rebuildJobIndex();
      renderQueueTable();
      const row = id => document.querySelector('[data-job-id="anchor-' + id + '"]');
      handleRowClick({ ctrlKey: false, metaKey: false, shiftKey: false }, row('a'));
      handleRowClick({ ctrlKey: true, metaKey: false, shiftKey: false }, row('c'));
      handleRowClick({ ctrlKey: false, metaKey: false, shiftKey: true }, row('d'));
      const selected = [...selectedJobIds].sort();
      const aria = Object.fromEntries(['a', 'b', 'c', 'd'].map(id => [id, row(id).getAttribute('aria-selected')]));
      queueJobs = [];
      selectedJobIds.clear();
      rebuildJobIndex();
      renderQueueTable();
      return { selected, aria };
    })()\`);
    check('Shift selection starts from the last clicked row and keeps ARIA state synchronized', queueSelectionAnchor.selected.join('|') === 'anchor-a|anchor-c|anchor-d' && queueSelectionAnchor.aria.a === 'true' && queueSelectionAnchor.aria.b === 'false' && queueSelectionAnchor.aria.c === 'true' && queueSelectionAnchor.aria.d === 'true');

    const queueSelectionVisual = await wc.executeJavaScript('(() => { queueJobs = [{ id: "ui-selection-visual", file: "C:/ui/selection.bin", fileName: "selection.bin", hoster: "byse.sx", status: "queued", bytesUploaded: 0, bytesTotal: 100, progress: 0 }]; selectedJobIds.clear(); selectedJobIds.add("ui-selection-visual"); rebuildJobIndex(); renderQueueTable(); const row = document.querySelector(".queue-row.selected"); const style = getComputedStyle(row); const channels = style.backgroundColor.match(/[0-9.]+/g)?.map(Number) || []; const result = { userSelect: getComputedStyle(row.querySelector(".col-filename")).userSelect, alpha: channels[3] ?? 1, marker: style.boxShadow !== "none" }; queueJobs = []; selectedJobIds.clear(); rebuildJobIndex(); renderQueueTable(); return result; })()');
    check('Upload rows prevent accidental text selection and expose a strong selected state', queueSelectionVisual.userSelect === 'none' && queueSelectionVisual.alpha >= 0.16 && queueSelectionVisual.marker);

    const removedAnchorState = await wc.executeJavaScript('(() => { queueJobs = ["a", "b"].map(id => ({ id: "ui-anchor-remove-" + id, file: "C:/ui/anchor-remove-" + id + ".bin", fileName: "anchor-remove-" + id + ".bin", hoster: "byse.sx", status: "queued", bytesUploaded: 0, bytesTotal: 100, progress: 0 })); selectedJobIds.clear(); rebuildJobIndex(); renderQueueTable(); const first = document.querySelector("[data-job-id=ui-anchor-remove-a]"); handleRowClick({ ctrlKey: false, metaKey: false, shiftKey: false }, first); const removed = queueJobs.shift(); removeJobFromIndex(removed, true); selectedJobIds.delete(removed.id); renderQueueTable(); const second = document.querySelector("[data-job-id=ui-anchor-remove-b]"); handleRowClick({ ctrlKey: false, metaKey: false, shiftKey: true }, second); const result = { anchor: selectionAnchorJobId, selected: [...selectedJobIds] }; queueJobs = []; selectedJobIds.clear(); selectionAnchorJobId = null; rebuildJobIndex(); renderQueueTable(); return result; })()');
    check('Removing the selected anchor leaves the next Shift click usable', removedAnchorState.anchor === 'ui-anchor-remove-b' && removedAnchorState.selected.join('|') === 'ui-anchor-remove-b');

    const removeAllDanger = await wc.executeJavaScript('(() => { const item = document.querySelector("#contextMenu [data-action=delete-all]"); const channels = getComputedStyle(item).color.match(/[0-9.]+/g)?.map(Number) || []; return Boolean(item && channels.length >= 3 && channels[0] > channels[1] * 1.2 && channels[0] > channels[2] * 1.15); })()');
    check('Remove all is visually marked as a destructive queue action', removeAllDanger === true);

    await wc.executeJavaScript('(() => { queuePersistThrottle.cancel(); queueJobs = [{ id: "ui-cleanup-survivor", file: "C:/ui/cleanup-remove-selected.bin", fileName: "cleanup-remove-selected.bin", hoster: "doodstream.com", status: "done", bytesTotal: 100, sourceCleanupMetadataVersion: 2, sourceCleanupToken: "ui-cleanup-remove-selected", sourceCleanupRequiredHosters: ["doodstream.com", "voe.sx"], sourceCleanupConfirmedHosters: ["doodstream.com"], sourceCleanupStartedHosters: ["doodstream.com"] }, { id: "ui-cleanup-remove-preview", file: "C:/ui/cleanup-remove-selected.bin", fileName: "cleanup-remove-selected.bin", hoster: "voe.sx", status: "preview", bytesTotal: 100, sourceCleanupMetadataVersion: 2, sourceCleanupToken: "ui-cleanup-remove-selected", sourceCleanupRequiredHosters: ["doodstream.com", "voe.sx"], sourceCleanupConfirmedHosters: ["doodstream.com"], sourceCleanupStartedHosters: ["doodstream.com"] }]; selectedJobIds.clear(); selectedJobIds.add("ui-cleanup-remove-preview"); rebuildJobIndex(); renderQueueTable(); window.__uiCleanupPreviewRemoval = handleContextAction("delete-selected"); return true; })()');
    await waitUntil(() => wc.executeJavaScript('document.getElementById("appAlertModal").style.display === "flex"'));
    await wc.executeJavaScript('document.getElementById("appAlertConfirmBtn").click()');
    const previewCleanupRemoval = await wc.executeJavaScript('window.__uiCleanupPreviewRemoval.then(() => { delete window.__uiCleanupPreviewRemoval; queuePersistThrottle.cancel(); const survivor = queueJobs[0]; const result = { length: queueJobs.length, id: survivor?.id, required: survivor?.sourceCleanupRequiredHosters || [], confirmed: survivor?.sourceCleanupConfirmedHosters || [], finalizing: sourceCleanupFinalizationPending }; queueJobs = []; selectedJobIds.clear(); rebuildJobIndex(); renderQueueTable(); return result; })');
    check('Removing an unstarted destination drops only that cleanup prerequisite', previewCleanupRemoval.length === 1 && previewCleanupRemoval.id === 'ui-cleanup-survivor' && previewCleanupRemoval.required.join('|') === 'doodstream.com' && previewCleanupRemoval.confirmed.join('|') === 'doodstream.com' && previewCleanupRemoval.finalizing === false);

    const queueTelemetryState = await wc.executeJavaScript(\`(async () => {
      queueJobs = [
        { id: 'telemetry-done-a', status: 'done' },
        { id: 'telemetry-done-b', status: 'done' },
        { id: 'telemetry-error', status: 'error' },
        { id: 'telemetry-queued', status: 'queued' }
      ];
      _sessionDoneCount = 91;
      _sessionErrorCount = 92;
      _queueStatsCache = null;
      updateStatusBar();
      await new Promise(resolve => setTimeout(resolve, 360));
      const result = {
        completed: document.getElementById('uploadTelemetryCompleted')?.textContent.trim(),
        failed: document.getElementById('uploadTelemetryFailed')?.textContent.trim(),
        sidebarDone: document.getElementById('uploadSidebarDoneCount')?.textContent.trim(),
        sidebarFailed: document.getElementById('uploadSidebarErrorCount')?.textContent.trim()
      };
      queueJobs = [];
      _sessionDoneCount = 0;
      _sessionErrorCount = 0;
      _queueStatsCache = null;
      updateStatusBar();
      return result;
    })()\`);
    check('Lower telemetry and sidebar badges use the same current queue state', queueTelemetryState.completed === '2' && queueTelemetryState.failed === '1' && queueTelemetryState.sidebarDone === '2' && queueTelemetryState.sidebarFailed === '1');

    let releaseSelectedQueueCancel = null;
    ipcMain.removeHandler('cancel-selected-jobs');
    ipcMain.handle('cancel-selected-jobs', () => new Promise(resolve => { releaseSelectedQueueCancel = () => resolve(true); }));
    await wc.executeJavaScript('(() => { queueJobs = [{ id: "ui-delete-selected-survivor", file: "C:/ui/delete-selected.bin", fileName: "delete-selected.bin", hoster: "doodstream.com", status: "done", bytesUploaded: 100, bytesTotal: 100, progress: 1, sourceCleanupMetadataVersion: 2, sourceCleanupToken: "ui-delete-selected-token", sourceCleanupRequiredHosters: ["doodstream.com", "byse.sx"], sourceCleanupConfirmedHosters: ["doodstream.com"] }, { id: "ui-delete-selected", file: "C:/ui/delete-selected.bin", fileName: "delete-selected.bin", hoster: "byse.sx", status: "queued", bytesUploaded: 0, bytesTotal: 100, progress: 0, sourceCleanupMetadataVersion: 2, sourceCleanupToken: "ui-delete-selected-token", sourceCleanupRequiredHosters: ["doodstream.com", "byse.sx"], sourceCleanupConfirmedHosters: ["doodstream.com"] }]; selectedJobIds.clear(); selectedJobIds.add("ui-delete-selected"); rebuildJobIndex(); renderQueueTable(); window.__uiDeleteSelectedPromise = handleContextAction("delete-selected"); return true; })()');
    await waitUntil(() => wc.executeJavaScript('document.getElementById("appAlertModal").style.display === "flex"'));
    await wc.executeJavaScript('document.getElementById("appAlertConfirmBtn").click()');
    await waitUntil(() => releaseSelectedQueueCancel);
    const selectedQueueStillPresent = await wc.executeJavaScript('queueJobs.length');
    releaseSelectedQueueCancel();
    const selectedQueueAfterCancel = await wc.executeJavaScript('window.__uiDeleteSelectedPromise.then(() => { delete window.__uiDeleteSelectedPromise; const result = { length: queueJobs.length, required: queueJobs[0]?.sourceCleanupRequiredHosters || [] }; queueJobs = []; rebuildJobIndex(); return result; })');
    check('Removing selected uploads waits for the main-process cancellation acknowledgement', selectedQueueStillPresent === 2 && selectedQueueAfterCancel.length === 1);
    check('Cancelling a started destination never relaxes cleanup prerequisites', selectedQueueAfterCancel.required.join('|') === 'doodstream.com|byse.sx');
    restoreInitialIpcHandler('cancel-selected-jobs');

    let releaseFullQueueCancel = null;
    let fullQueueCancelCalls = 0;
    let selectedQueueCancelCalls = 0;
    ipcMain.removeHandler('cancel-upload');
    ipcMain.handle('cancel-upload', () => {
      fullQueueCancelCalls++;
      return new Promise(resolve => { releaseFullQueueCancel = () => resolve(true); });
    });
    ipcMain.removeHandler('cancel-selected-jobs');
    ipcMain.handle('cancel-selected-jobs', () => { selectedQueueCancelCalls++; return true; });
    await wc.executeJavaScript('(() => { uploading = true; queueJobs = Array.from({ length: 100 }, (_, index) => ({ id: "ui-delete-all-" + index, file: "C:/ui/delete-all-" + index + ".bin", fileName: "delete-all-" + index + ".bin", hoster: "byse.sx", status: "queued", bytesUploaded: 0, bytesTotal: 100, progress: 0 })); selectedJobIds.clear(); rebuildJobIndex(); renderQueueTable(); window.__uiDeleteAllPromise = handleContextAction("delete-all"); return true; })()');
    await waitUntil(() => wc.executeJavaScript('document.getElementById("appAlertModal").style.display === "flex"'));
    await wc.executeJavaScript('document.getElementById("appAlertConfirmBtn").click()');
    await waitUntil(() => releaseFullQueueCancel);
    const fullQueueStillPresent = await wc.executeJavaScript('queueJobs.length');
    releaseFullQueueCancel();
    const fullQueueAfterCancel = await wc.executeJavaScript('window.__uiDeleteAllPromise.then(() => { delete window.__uiDeleteAllPromise; return { length: queueJobs.length, uploading }; })');
    check('Remove all keeps a 100-job cancellation responsive and issues one batch cancellation', fullQueueStillPresent === 100 && fullQueueAfterCancel.length === 0 && fullQueueAfterCancel.uploading === false && fullQueueCancelCalls === 1 && selectedQueueCancelCalls === 0);
    restoreInitialIpcHandler('cancel-upload');
    restoreInitialIpcHandler('cancel-selected-jobs');

    await wc.executeJavaScript('(() => { uploading = false; queuePersistThrottle.cancel(); const required = ["doodstream.com", "voe.sx", "byse.sx"]; window.__uiDeleteAllCleanupJobs = [{ id: "ui-delete-all-cleanup-done", file: "C:/ui/delete-all-cleanup.bin", fileName: "delete-all-cleanup.bin", hoster: "doodstream.com", status: "done", bytesTotal: 100, sourceCleanupMetadataVersion: 2, sourceCleanupToken: "ui-delete-all-cleanup-token", sourceCleanupRequiredHosters: [...required], sourceCleanupConfirmedHosters: ["doodstream.com"], sourceCleanupStartedHosters: ["doodstream.com"] }, { id: "ui-delete-all-cleanup-voe", file: "C:/ui/delete-all-cleanup.bin", fileName: "delete-all-cleanup.bin", hoster: "voe.sx", status: "preview", bytesTotal: 100, sourceCleanupMetadataVersion: 2, sourceCleanupToken: "ui-delete-all-cleanup-token", sourceCleanupRequiredHosters: [...required], sourceCleanupConfirmedHosters: ["doodstream.com"], sourceCleanupStartedHosters: ["doodstream.com"] }, { id: "ui-delete-all-cleanup-byse", file: "C:/ui/delete-all-cleanup.bin", fileName: "delete-all-cleanup.bin", hoster: "byse.sx", status: "preview", bytesTotal: 100, sourceCleanupMetadataVersion: 2, sourceCleanupToken: "ui-delete-all-cleanup-token", sourceCleanupRequiredHosters: [...required], sourceCleanupConfirmedHosters: ["doodstream.com"], sourceCleanupStartedHosters: ["doodstream.com"] }]; queueJobs = window.__uiDeleteAllCleanupJobs; selectedJobIds.clear(); rebuildJobIndex(); renderQueueTable(); window.__uiDeleteAllCleanupPromise = handleContextAction("delete-all"); return true; })()');
    await waitUntil(() => wc.executeJavaScript('document.getElementById("appAlertModal").style.display === "flex"'));
    await wc.executeJavaScript('document.getElementById("appAlertConfirmBtn").click()');
    const deleteAllCleanupState = await wc.executeJavaScript('window.__uiDeleteAllCleanupPromise.then(() => { delete window.__uiDeleteAllCleanupPromise; queuePersistThrottle.cancel(); const result = { queueLength: queueJobs.length, required: window.__uiDeleteAllCleanupJobs.map(job => job.sourceCleanupRequiredHosters || []), confirmed: window.__uiDeleteAllCleanupJobs.map(job => job.sourceCleanupConfirmedHosters || []) }; delete window.__uiDeleteAllCleanupJobs; return result; })');
    check('Remove all drops only never-started cleanup destinations without authorizing deletion', deleteAllCleanupState.queueLength === 0 && deleteAllCleanupState.required.every(hosters => hosters.join('|') === 'doodstream.com') && deleteAllCleanupState.confirmed.every(hosters => hosters.join('|') === 'doodstream.com'));

    await wc.executeJavaScript('(() => { const required = ["doodstream.com", "voe.sx", "byse.sx"]; queueJobs = [{ id: "ui-delete-hoster-cleanup-done", file: "C:/ui/delete-hoster-cleanup.bin", fileName: "delete-hoster-cleanup.bin", hoster: "doodstream.com", status: "done", bytesTotal: 100, sourceCleanupMetadataVersion: 2, sourceCleanupToken: "ui-delete-hoster-cleanup-token", sourceCleanupRequiredHosters: [...required], sourceCleanupConfirmedHosters: ["doodstream.com"], sourceCleanupStartedHosters: ["doodstream.com"] }, { id: "ui-delete-hoster-cleanup-voe", file: "C:/ui/delete-hoster-cleanup.bin", fileName: "delete-hoster-cleanup.bin", hoster: "voe.sx", status: "preview", bytesTotal: 100, sourceCleanupMetadataVersion: 2, sourceCleanupToken: "ui-delete-hoster-cleanup-token", sourceCleanupRequiredHosters: [...required], sourceCleanupConfirmedHosters: ["doodstream.com"], sourceCleanupStartedHosters: ["doodstream.com"] }, { id: "ui-delete-hoster-cleanup-byse", file: "C:/ui/delete-hoster-cleanup.bin", fileName: "delete-hoster-cleanup.bin", hoster: "byse.sx", status: "preview", bytesTotal: 100, sourceCleanupMetadataVersion: 2, sourceCleanupToken: "ui-delete-hoster-cleanup-token", sourceCleanupRequiredHosters: [...required], sourceCleanupConfirmedHosters: ["doodstream.com"], sourceCleanupStartedHosters: ["doodstream.com"] }]; selectedJobIds.clear(); rebuildJobIndex(); renderQueueTable(); window.__uiDeleteHosterCleanupPromise = handleContextAction("delete-hoster:voe.sx"); return true; })()');
    await waitUntil(() => wc.executeJavaScript('document.getElementById("appAlertModal").style.display === "flex"'));
    await wc.executeJavaScript('document.getElementById("appAlertConfirmBtn").click()');
    const deleteHosterCleanupState = await wc.executeJavaScript('window.__uiDeleteHosterCleanupPromise.then(() => { delete window.__uiDeleteHosterCleanupPromise; queuePersistThrottle.cancel(); const result = { ids: queueJobs.map(job => job.id), required: queueJobs.map(job => job.sourceCleanupRequiredHosters || []), confirmed: queueJobs.map(job => job.sourceCleanupConfirmedHosters || []) }; queueJobs = []; rebuildJobIndex(); return result; })');
    check('Removing one unstarted host destination preserves every remaining cleanup prerequisite', deleteHosterCleanupState.ids.join('|') === 'ui-delete-hoster-cleanup-done|ui-delete-hoster-cleanup-byse' && deleteHosterCleanupState.required.every(hosters => hosters.join('|') === 'doodstream.com|byse.sx') && deleteHosterCleanupState.confirmed.every(hosters => hosters.join('|') === 'doodstream.com'));

    const keyboardTab = await wc.executeJavaScript('document.getElementById("upload-tab").focus(); document.getElementById("upload-tab").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); document.querySelector(".tab.active")?.textContent?.trim() + "|" + document.activeElement?.id');
    check('Arrow keys move and activate main tabs', keyboardTab === 'Accounts|accounts-tab');

    await wc.executeJavaScript('window.__uiTabIndicatorStart = document.querySelector(".tab-indicator")?.getBoundingClientRect().left; document.getElementById("history-tab")?.click()');
    await new Promise(resolve => setTimeout(resolve, 90));
    const tabIndicatorInFlight = await wc.executeJavaScript('(() => { const indicator = document.querySelector(".tab-indicator"); const target = document.getElementById("history-tab"); const start = window.__uiTabIndicatorStart; if (!indicator || !target || !Number.isFinite(start)) return "missing"; const current = indicator.getBoundingClientRect().left; const targetLeft = target.getBoundingClientRect().left; const duration = parseFloat(getComputedStyle(indicator).transitionDuration); return [current > start + 2 && current < targetLeft - 2, duration >= .15].join("|"); })()');
    check('Main navigation indicator remains visibly in motion while gliding right', tabIndicatorInFlight === 'true|true');
    await new Promise(resolve => setTimeout(resolve, 150));
    const tabIndicatorAtHistory = await wc.executeJavaScript('(() => { const indicator = document.querySelector(".tab-indicator"); const tab = document.getElementById("history-tab"); if (!indicator || !tab) return "missing"; const indicatorRect = indicator.getBoundingClientRect(); const tabRect = tab.getBoundingClientRect(); const style = getComputedStyle(indicator); return [Math.abs(indicatorRect.left - tabRect.left) <= 1, Math.abs(indicatorRect.width - tabRect.width) <= 1, style.transitionProperty.includes("transform")].join("|"); })()');
    check('Main navigation indicator glides to a tab selected on the right', tabIndicatorAtHistory === 'true|true|true');
    await wc.executeJavaScript('document.getElementById("upload-tab")?.click()');
    await new Promise(resolve => setTimeout(resolve, 240));
    const tabIndicatorAtUpload = await wc.executeJavaScript('(() => { const indicator = document.querySelector(".tab-indicator"); const tab = document.getElementById("upload-tab"); if (!indicator || !tab) return "missing"; const indicatorRect = indicator.getBoundingClientRect(); const tabRect = tab.getBoundingClientRect(); return [Math.abs(indicatorRect.left - tabRect.left) <= 1, Math.abs(indicatorRect.width - tabRect.width) <= 1].join("|"); })()');
    check('Main navigation indicator glides back to a tab selected on the left', tabIndicatorAtUpload === 'true|true');

    const ctxHidden = await wc.executeJavaScript('document.getElementById("contextMenu")?.style.display');
    check('Context menu hidden', ctxHidden === 'none');

    console.log('\\n=== Accounts View ===');

    await wc.executeJavaScript('document.querySelector(".tab[data-view=\\'accounts\\']").click()');
    await new Promise(r => setTimeout(r, 300));

    const accountsActive = await wc.executeJavaScript('document.getElementById("accounts-view")?.classList.contains("active")');
    check('Accounts tab active', accountsActive);

    const hosterHealthSemantics = await wc.executeJavaScript('(() => { const section = document.getElementById("hosterHealthOverview"); const table = section?.querySelector("table"); const list = document.getElementById("accountsList"); return { labelled: section?.getAttribute("role") === "region" && section?.getAttribute("aria-labelledby") === "hosterHealthTitle", table: Boolean(table && table.querySelector("caption") && table.querySelectorAll("thead th").length === 8), beforeAccounts: Boolean(section && list && (section.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING)) }; })()');
    check('Host health overview is an accessible table above account groups', hosterHealthSemantics.labelled && hosterHealthSemantics.table && hosterHealthSemantics.beforeAccounts);

    const accountsWorkspaceLayout = await wc.executeJavaScript('(() => { const view = document.getElementById("accounts-view"); const sidebar = view?.querySelector(":scope > .view-sidebar"); const main = view?.querySelector(":scope > .view-main"); if (!sidebar || !main) return false; const sidebarRect = sidebar.getBoundingClientRect(); const mainRect = main.getBoundingClientRect(); return sidebarRect.width > 0 && mainRect.width > 0 && sidebarRect.right <= mainRect.left; })()');
    check('Accounts view separates sidebar and main workspace', accountsWorkspaceLayout === true);

    const accountSidebarInformation = await wc.executeJavaScript('(() => { const sidebar = document.querySelector("#accounts-view > .view-sidebar")?.getBoundingClientRect(); const section = document.querySelector("#accounts-view .view-sidebar-hoster-section")?.getBoundingClientRect(); return Boolean(sidebar && section && section.top >= sidebar.top + sidebar.height * 0.55); })()');
    check('Account sidebar keeps hoster information in its lower area', accountSidebarInformation === true);

    const accountsFrameFit = await wc.executeJavaScript('(() => { const view = document.getElementById("accounts-view")?.getBoundingClientRect(); return Boolean(view && view.bottom <= window.innerHeight + 1); })()');
    check('Accounts view fits inside the viewport', accountsFrameFit === true);

    const accountHeaderControlHeights = await wc.executeJavaScript('(() => [document.getElementById("accountsRunHealthCheckBtn"), document.querySelector(".accounts-auto-check"), document.getElementById("addAccountBtn")].map(element => element?.getBoundingClientRect().height || 0))()');
    check('Accounts header actions share one rendered height', accountHeaderControlHeights.every(height => height > 0 && Math.abs(height - accountHeaderControlHeights[0]) <= 0.5));

    const hosterHealthStates = await wc.executeJavaScript(\`(() => {
      const previousConfig = config;
      const previousStatuses = accountStatuses;
      const previousSessionFailedKeys = _sessionFailedKeys;
      const hadHistory = Object.hasOwn(window, '_historyForStats');
      const previousHistory = window._historyForStats;
      config = { ...config, hosters: Object.fromEntries(HOSTERS.map(name => [name, []])) };
      accountStatuses = {};
      _sessionFailedKeys = new Set();
      window._historyForStats = [];
      _invalidateHosterLifetimeCache();
      renderAccounts();
      const empty = document.querySelector('#hosterHealthOverview [data-hoster-health-empty]')?.textContent.trim() || '';
      config.hosters['voe.sx'] = [
        { id: 'health-ready', enabled: true, authType: 'login', username: 'ready@example.invalid', password: 'secret' },
        { id: 'health-failed', enabled: true, authType: 'login', username: 'failed@example.invalid', password: 'secret' }
      ];
      config.hosters['byse.sx'] = [
        { id: 'health-unchecked', enabled: true, authType: 'api', apiKey: 'unchecked-key' }
      ];
      accountStatuses = {
        'health-ready': { status: 'ok' },
        'health-failed': { status: 'error' },
        'health-unchecked': { status: 'unchecked' }
      };
      _sessionFailedKeys = new Set(['voe.sx:health-failed']);
      window._historyForStats = [{
        timestamp: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        files: [{
          name: 'health.bin',
          size: 1024 * 1024,
          results: [
            { hoster: 'voe.sx', status: 'done', durationSec: 2 },
            { hoster: 'voe.sx', status: 'error', durationSec: 1 },
            { hoster: 'voe.sx', status: 'skipped', durationSec: 1 }
          ]
        }]
      }];
      _invalidateHosterLifetimeCache();
      renderAccounts();
      const voe = document.querySelector('[data-hoster-health-row="voe.sx"]');
      const byse = document.querySelector('[data-hoster-health-row="byse.sx"]');
      const german = {
        sample: voe?.querySelector('[data-health="sample"]')?.textContent.trim(),
        outcomes: voe?.querySelector('[data-health="outcomes"]')?.textContent.trim(),
        rate: voe?.querySelector('[data-health="rate"]')?.textContent.trim(),
        throughput: voe?.querySelector('[data-health="throughput"]')?.textContent.trim(),
        lastSuccess: voe?.querySelector('[data-health="last-success"]')?.textContent.trim(),
        recentFailures: voe?.querySelector('[data-health="recent-failures"]')?.textContent.trim(),
        accountProblems: voe?.querySelector('[data-health="accounts"]')?.textContent.trim(),
        unchecked: byse?.querySelector('[data-health="accounts"]')?.textContent.trim()
      };
      setUiLanguage('en');
      const english = {
        title: document.getElementById('hosterHealthTitle')?.textContent.trim(),
        throughput: document.querySelector('#hosterHealthOverview th[data-health-column="throughput"]')?.textContent.trim(),
        unchecked: document.querySelector('[data-hoster-health-row="byse.sx"] [data-health="accounts"]')?.textContent.trim()
      };
      setUiLanguage('de');
      config = previousConfig;
      accountStatuses = previousStatuses;
      _sessionFailedKeys = previousSessionFailedKeys;
      if (hadHistory) window._historyForStats = previousHistory;
      else delete window._historyForStats;
      _invalidateHosterLifetimeCache();
      renderAccounts();
      return { empty, german, english };
    })()\`);
    check('Host health overview renders clean empty and unchecked account states', hosterHealthStates.empty === 'Noch keine Hoster-Daten.' && hosterHealthStates.german.unchecked === 'Nicht geprüft');
    check('Host health overview renders counts, existing-rate semantics, effective historical throughput, recent failures, and account problems', hosterHealthStates.german.sample === '3' && hosterHealthStates.german.outcomes === '1 / 1 / 1' && hosterHealthStates.german.rate === '50 %' && hosterHealthStates.german.throughput === '512 kB/s' && hosterHealthStates.german.lastSuccess !== 'Nie' && hosterHealthStates.german.recentFailures === '1' && hosterHealthStates.german.accountProblems === '1');
    check('Host health overview switches fully to English without a renderer restart', hosterHealthStates.english.title === 'Host health' && hosterHealthStates.english.throughput === 'Effective historical throughput' && hosterHealthStates.english.unchecked === 'Not checked');

    const hosterHealthRegressionStates = await wc.executeJavaScript(\`(() => {
      const previousConfig = config;
      const previousStatuses = accountStatuses;
      const previousSessionFailedKeys = _sessionFailedKeys;
      const hadHistory = Object.hasOwn(window, '_historyForStats');
      const previousHistory = window._historyForStats;
      let states;
      try {
        config = { ...config, hosters: Object.fromEntries(HOSTERS.map(name => [name, []])) };
        config.hosters['voe.sx'] = [
          { id: 'health-disabled-error', enabled: false, authType: 'api', apiKey: 'disabled-key' },
          { id: 'health-disabled-unchecked', enabled: false, authType: 'api', apiKey: 'disabled-key' },
          { id: 'health-disabled-checking', enabled: false, authType: 'api', apiKey: 'disabled-key' }
        ];
        accountStatuses = {
          'health-disabled-error': { status: 'error' },
          'health-disabled-unchecked': { status: 'unchecked' },
          'health-disabled-checking': { status: 'checking' }
        };
        _sessionFailedKeys = new Set(['voe.sx:health-disabled-error']);
        window._historyForStats = [
          {
            id: 'health-invalid-time',
            timestamp: 'not-a-date',
            files: [{ name: 'invalid.bin', size: 1024, results: [{ hoster: 'voe.sx', status: 'done', durationSec: 1 }] }]
          },
          {
            id: 'health-future-time',
            timestamp: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            files: [{ name: 'future.bin', size: 1024, results: [{ hoster: 'voe.sx', status: 'error' }] }]
          }
        ];
        _invalidateHosterLifetimeCache();
        renderAccounts();
        const invalidRow = document.querySelector('[data-hoster-health-row="voe.sx"]');
        const invalidAndDisabled = {
          sample: invalidRow?.querySelector('[data-health="sample"]')?.textContent.trim(),
          outcomes: invalidRow?.querySelector('[data-health="outcomes"]')?.textContent.trim(),
          lastSuccess: invalidRow?.querySelector('[data-health="last-success"]')?.textContent.trim(),
          recentFailures: invalidRow?.querySelector('[data-health="recent-failures"]')?.textContent.trim(),
          accountProblems: invalidRow?.querySelector('[data-health="accounts"]')?.textContent.trim()
        };

        states = { invalidAndDisabled };
      } finally {
        config = previousConfig;
        accountStatuses = previousStatuses;
        _sessionFailedKeys = previousSessionFailedKeys;
        if (hadHistory) window._historyForStats = previousHistory;
        else delete window._historyForStats;
        _invalidateHosterLifetimeCache();
        renderAccounts();
      }
      return states;
    })()\`);
    check('Host health excludes disabled accounts and invalid or future batches from rendered problem and time statistics', hosterHealthRegressionStates.invalidAndDisabled.sample === '0' && hosterHealthRegressionStates.invalidAndDisabled.outcomes === '0 / 0 / 0' && hosterHealthRegressionStates.invalidAndDisabled.lastSuccess === 'Nie' && hosterHealthRegressionStates.invalidAndDisabled.recentFailures === '0' && hosterHealthRegressionStates.invalidAndDisabled.accountProblems === '0');

    const healthHistoryResolvers = [];
    ipcMain.removeHandler('get-history');
    ipcMain.handle('get-history', () => new Promise(resolve => { healthHistoryResolvers.push(resolve); }));
    const healthBeforeReload = await wc.executeJavaScript(\`(() => {
      window.__healthReloadPrevious = {
        config,
        accountStatuses,
        sessionFailedKeys: _sessionFailedKeys,
        hadHistory: Object.hasOwn(window, '_historyForStats'),
        history: window._historyForStats,
        historyEverLoaded: _historyEverLoaded,
        historyDirty: _historyDirty
      };
      config = { ...config, hosters: Object.fromEntries(HOSTERS.map(name => [name, []])) };
      accountStatuses = {};
      _sessionFailedKeys = new Set();
      window._historyForStats = [{
        id: 'health-before-batch',
        timestamp: new Date(Date.now() - 60000).toISOString(),
        files: [{ name: 'before.bin', size: 1024, results: [{ hoster: 'voe.sx', status: 'done', durationSec: 1 }] }]
      }];
      _invalidateHosterLifetimeCache();
      renderAccounts();
      window.__healthStaleReload = loadHistory();
      const row = document.querySelector('[data-hoster-health-row="voe.sx"]');
      return {
        sample: row?.querySelector('[data-health="sample"]')?.textContent.trim(),
        outcomes: row?.querySelector('[data-health="outcomes"]')?.textContent.trim()
      };
    })()\`);
    await waitUntil(() => healthHistoryResolvers.length === 1);
    const healthPendingReload = await wc.executeJavaScript(\`(() => {
      handleBatchDone({
        id: 'health-pruned-completed',
        timestamp: new Date().toISOString(),
        total: 1,
        succeeded: 1,
        failed: 0,
        skipped: 0,
        files: [{ name: 'pruned.bin', size: 2048, results: [{ hoster: 'voe.sx', status: 'done', durationSec: 1 }] }]
      }, { historyPersisted: true, deferPersistence: true });
      const row = document.querySelector('[data-hoster-health-row="voe.sx"]');
      return {
        sample: row?.querySelector('[data-health="sample"]')?.textContent.trim(),
        outcomes: row?.querySelector('[data-health="outcomes"]')?.textContent.trim(),
        ids: window._historyForStats.map(batch => batch.id)
      };
    })()\`);
    const healthPostBatchReloadStarted = Boolean(await waitUntil(() => healthHistoryResolvers.length === 2, 750));
    const retainedHealthHistory = [{
      id: 'health-retained-authoritative',
      timestamp: new Date().toISOString(),
      files: [{ name: 'retained.bin', size: 1024, results: [{ hoster: 'voe.sx', status: 'error' }] }]
    }];
    const staleHealthHistory = [{
      id: 'health-stale-before-batch',
      timestamp: new Date().toISOString(),
      files: [{ name: 'stale.bin', size: 1024, results: [{ hoster: 'voe.sx', status: 'done', durationSec: 1 }] }]
    }, {
      id: 'health-pruned-completed',
      timestamp: new Date().toISOString(),
      files: [{ name: 'pruned.bin', size: 2048, results: [{ hoster: 'voe.sx', status: 'done', durationSec: 1 }] }]
    }];
    if (healthPostBatchReloadStarted) {
      healthHistoryResolvers[1](retainedHealthHistory);
      await waitUntil(() => wc.executeJavaScript('window._historyForStats?.[0]?.id === "health-retained-authoritative"'));
    } else {
      healthHistoryResolvers[0](staleHealthHistory);
      await wc.executeJavaScript('window.__healthStaleReload');
    }
    const healthAfterAuthoritativeReload = await wc.executeJavaScript(\`(() => {
      const row = document.querySelector('[data-hoster-health-row="voe.sx"]');
      return {
        sample: row?.querySelector('[data-health="sample"]')?.textContent.trim(),
        outcomes: row?.querySelector('[data-health="outcomes"]')?.textContent.trim(),
        ids: window._historyForStats.map(batch => batch.id)
      };
    })()\`);
    if (healthPostBatchReloadStarted) {
      healthHistoryResolvers[0](staleHealthHistory);
      await wc.executeJavaScript('window.__healthStaleReload');
    }
    const healthAfterStaleReload = await wc.executeJavaScript(\`(() => {
      const row = document.querySelector('[data-hoster-health-row="voe.sx"]');
      return {
        sample: row?.querySelector('[data-health="sample"]')?.textContent.trim(),
        outcomes: row?.querySelector('[data-health="outcomes"]')?.textContent.trim(),
        ids: window._historyForStats.map(batch => batch.id)
      };
    })()\`);
    restoreInitialIpcHandler('get-history');
    await wc.executeJavaScript(\`(() => {
      const previous = window.__healthReloadPrevious;
      config = previous.config;
      accountStatuses = previous.accountStatuses;
      _sessionFailedKeys = previous.sessionFailedKeys;
      _historyEverLoaded = previous.historyEverLoaded;
      _historyDirty = previous.historyDirty;
      if (previous.hadHistory) window._historyForStats = previous.history;
      else delete window._historyForStats;
      delete window.__healthReloadPrevious;
      delete window.__healthStaleReload;
      _invalidateHosterLifetimeCache();
      renderAccounts();
    })()\`);
    check('A persisted batch starts a fresh Health reload without replacing existing values with a loading or local state', healthPostBatchReloadStarted && healthBeforeReload.sample === '1' && healthBeforeReload.outcomes === '1 / 0 / 0' && healthPendingReload.sample === '1' && healthPendingReload.outcomes === '1 / 0 / 0' && healthPendingReload.ids.join('|') === 'health-before-batch');
    check('The authoritative post-batch reload removes batches already pruned by retention from Health', healthAfterAuthoritativeReload.sample === '1' && healthAfterAuthoritativeReload.outcomes === '0 / 1 / 0' && healthAfterAuthoritativeReload.ids.join('|') === 'health-retained-authoritative');
    check('A delayed older History response cannot overwrite the newest Health snapshot', healthAfterStaleReload.sample === '1' && healthAfterStaleReload.outcomes === '0 / 1 / 0' && healthAfterStaleReload.ids.join('|') === 'health-retained-authoritative');

    await captureVisual('02-accounts.png');

    const accountListValid = await wc.executeJavaScript('Boolean(document.querySelector("#accountsList .accounts-empty") || document.querySelectorAll("#accountsList .account-hoster-group").length)');
    check('Account manager list structure rendered', accountListValid);

    const addAccountEnabled = await wc.executeJavaScript('document.getElementById("addAccountBtn")?.disabled === false');
    check('Add account button enabled', addAccountEnabled);

    const emptyAccountAction = await wc.executeJavaScript('document.querySelector("[data-account-empty-add]")?.textContent?.trim() || document.getElementById("addAccountBtn")?.textContent?.trim()');
    check('Account list offers direct add action', emptyAccountAction === 'Ersten Account hinzufügen' || emptyAccountAction === 'Account hinzufügen');

    const accountEmptyStateActionCount = await wc.executeJavaScript('document.querySelectorAll("#accountsList [data-account-empty-add]").length');
    check('Account empty state avoids a duplicate primary action', accountEmptyStateActionCount === 0);

    await wc.executeJavaScript('(() => { const trigger = document.querySelector("[data-account-empty-add]") || document.getElementById("addAccountBtn"); trigger?.focus(); trigger?.click(); })()');
    await new Promise(r => setTimeout(r, 200));

    const accountModalVisible = await wc.executeJavaScript('document.getElementById("accountModal")?.style.display');
    check('Account modal opens', accountModalVisible === 'flex');

    const accountModalTitle = await wc.executeJavaScript('document.getElementById("accountModalTitle")?.textContent');
    check('Account modal is in add mode', accountModalTitle === 'Account hinzufügen');

    const accountModalSemantics = await wc.executeJavaScript('document.querySelector("#accountModal .modal-card")?.getAttribute("role") + "|" + document.querySelector("#accountModal .modal-card")?.getAttribute("aria-modal")');
    check('Account modal exposes dialog semantics', accountModalSemantics === 'dialog|true');

    const accountFormLabels = await wc.executeJavaScript('["accountHosterSelect", "accField_label", "accField_username", "accField_password"].every(id => document.getElementById(id)?.labels?.length === 1)');
    check('Account form controls have linked labels', accountFormLabels);

    const accountStatusLive = await wc.executeJavaScript('document.getElementById("accountModalStatus")?.getAttribute("aria-live")');
    check('Account validation status is announced', accountStatusLive === 'polite');

    const initialAccountFocus = await wc.executeJavaScript('document.activeElement?.id');
    check('Account modal focuses first control', initialAccountFocus === 'accountHosterSelect');

    const trappedAccountFocus = await wc.executeJavaScript('document.getElementById("saveAccountBtn").focus(); document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })); document.activeElement?.id');
    check('Account modal keeps keyboard focus inside', trappedAccountFocus === 'closeAccountModalBtn');

    const authOptionCount = await wc.executeJavaScript('document.querySelectorAll("#accountHosterSelect option").length');
    check('7 hoster authentication options exist', authOptionCount === 7);

    const hosterCount = await wc.executeJavaScript('[...new Set([...document.querySelectorAll("#accountHosterSelect option")].map(el => el.value.split(":")[0]))].length');
    check('5 hosters exist', hosterCount === 5);

    const accountSubmitLabel = await wc.executeJavaScript('document.getElementById("saveAccountBtn")?.textContent');
    check('Account submit label is Prüfen und speichern', accountSubmitLabel === 'Prüfen und speichern');

    const credentialInputs = await wc.executeJavaScript('document.querySelectorAll("#accountCredsFields .key-input").length');
    check('Credential inputs rendered', credentialInputs === 2);

    const passwordToggleState = await wc.executeJavaScript('document.querySelector("#accountCredsFields .toggle-vis").click(); document.querySelector("#accountCredsFields .toggle-vis").getAttribute("aria-label") + "|" + document.querySelector("#accountCredsFields .toggle-vis").getAttribute("aria-pressed")');
    check('Password visibility action exposes its state', passwordToggleState === 'Passwort verbergen|true');

    await wc.executeJavaScript('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
    await new Promise(resolve => setTimeout(resolve, 340));
    const accountModalHidden = await wc.executeJavaScript('document.getElementById("accountModal")?.style.display');
    check('Escape closes account modal', accountModalHidden === 'none');

    const restoredAccountFocus = await wc.executeJavaScript('document.activeElement?.hasAttribute("data-account-empty-add") || document.activeElement?.id === "addAccountBtn"');
    check('Account modal restores trigger focus', restoredAccountFocus === true);

    await wc.executeJavaScript('(() => { const trigger = document.querySelector("[data-account-empty-add]") || document.getElementById("addAccountBtn"); trigger.focus(); trigger.click(); document.querySelector("[data-account-empty-add]")?.remove(); document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); })()');
    await new Promise(resolve => setTimeout(resolve, 340));
    const fallbackAccountFocus = await wc.executeJavaScript('document.activeElement?.id');
    check('Account modal restores stable focus after list rerender', fallbackAccountFocus === 'addAccountBtn');

    ipcMain.removeHandler('validate-credentials');
    ipcMain.handle('validate-credentials', () => ({ ok: true, status: 'ok', message: 'Credentials verified', checkedAt: '2033-01-02T03:04:05.000Z' }));
    ipcMain.removeHandler('save-config');
    ipcMain.handle('save-config', () => true);
    await wc.executeJavaScript(\`(() => {
      HOSTERS.forEach(name => { config.hosters[name] = []; });
      config.hosters['byse.sx'] = [{ id: 'ui-animated-account', enabled: true, authType: 'api', apiKey: 'animated-key' }];
      accountStatuses = { 'ui-animated-account': { status: 'ok', message: 'Ready' } };
      renderAccounts();
      document.querySelector('[data-account-edit="ui-animated-account"]')?.click();
    })()\`);
    await new Promise(resolve => setTimeout(resolve, 60));
    const accountEditOpeningFrame = await wc.executeJavaScript(\`(() => {
      const modal = document.getElementById('accountModal');
      const card = modal?.querySelector('.modal-card');
      const style = card ? getComputedStyle(card) : null;
      return {
        title: document.getElementById('accountModalTitle')?.textContent,
        display: modal?.style.display,
        animation: style?.animationName || 'none',
        duration: parseFloat(style?.animationDuration || '0'),
        transform: style?.transform || 'none',
        clipPath: style?.clipPath || 'none',
        opacity: Number(style?.opacity || 1),
        overlayAnimation: getComputedStyle(modal).animationName,
        overlayAlpha: Number((getComputedStyle(modal).backgroundColor.match(/[0-9.]+/g) || [0, 0, 0, 0])[3] || 0)
      };
    })()\`);
    check('Editing an account unfolds the editor through a real opening frame', accountEditOpeningFrame.title === 'Account bearbeiten' && accountEditOpeningFrame.display === 'flex' && accountEditOpeningFrame.animation !== 'none' && accountEditOpeningFrame.duration >= .34 && (accountEditOpeningFrame.transform !== 'none' || accountEditOpeningFrame.clipPath !== 'none' || accountEditOpeningFrame.opacity < 1));
    check('Opening the account editor softly fades in the surrounding dimming', accountEditOpeningFrame.overlayAnimation !== 'none' && accountEditOpeningFrame.overlayAlpha > 0 && accountEditOpeningFrame.overlayAlpha < .6);
    await new Promise(resolve => setTimeout(resolve, 340));
    const apiEyeEmoji = await wc.executeJavaScript('document.querySelector("#accountCredsFields .toggle-vis")?.textContent');
    check('API key visibility uses the normal eye emoji', apiEyeEmoji === '👁️');

    await wc.executeJavaScript('document.getElementById("closeAccountModalBtn")?.click()');
    await new Promise(resolve => setTimeout(resolve, 60));
    const accountEditClosingFrame = await wc.executeJavaScript(\`(() => {
      const modal = document.getElementById('accountModal');
      const card = modal?.querySelector('.modal-card');
      const style = card ? getComputedStyle(card) : null;
      return {
        display: modal?.style.display,
        ariaHidden: modal?.getAttribute('aria-hidden'),
        modalInert: modal?.inert,
        headerInert: document.querySelector('.app-header')?.inert,
        activeViewInert: document.querySelector('.view.active')?.inert,
        animation: style?.animationName || 'none',
        duration: parseFloat(style?.animationDuration || '0'),
        transform: style?.transform || 'none',
        clipPath: style?.clipPath || 'none',
        opacity: Number(style?.opacity || 1),
        overlayAnimation: getComputedStyle(modal).animationName,
        overlayAlpha: Number((getComputedStyle(modal).backgroundColor.match(/[0-9.]+/g) || [0, 0, 0, 0])[3] || 0)
      };
    })()\`);
    check('The close button folds the account editor upward without blocking the application', accountEditClosingFrame.display === 'flex' && accountEditClosingFrame.ariaHidden === 'true' && accountEditClosingFrame.modalInert === true && accountEditClosingFrame.headerInert === false && accountEditClosingFrame.activeViewInert === false && accountEditClosingFrame.animation !== 'none' && accountEditClosingFrame.duration >= .28 && (accountEditClosingFrame.transform !== 'none' || accountEditClosingFrame.clipPath !== 'none' || accountEditClosingFrame.opacity < 1));
    check('Closing the account editor softly fades out the surrounding dimming', accountEditClosingFrame.overlayAnimation !== 'none' && accountEditClosingFrame.overlayAlpha > 0 && accountEditClosingFrame.overlayAlpha < .6);
    await new Promise(resolve => setTimeout(resolve, 340));
    const accountEditClosed = await wc.executeJavaScript('document.getElementById("accountModal")?.style.display === "none"');
    check('The account editor hides after its closing animation', accountEditClosed === true);

    await wc.executeJavaScript('document.querySelector("[data-account-edit=ui-animated-account]")?.click()');
    await new Promise(resolve => setTimeout(resolve, 400));
    await wc.executeJavaScript('document.getElementById("saveAccountBtn")?.click()');
    await new Promise(resolve => setTimeout(resolve, 680));
    const accountSaveClosingFrame = await wc.executeJavaScript(\`(() => {
      const modal = document.getElementById('accountModal');
      const card = modal?.querySelector('.modal-card');
      const style = card ? getComputedStyle(card) : null;
      return { display: modal?.style.display, animation: style?.animationName || 'none' };
    })()\`);
    check('A verified saved account uses the same closing animation', accountSaveClosingFrame.display === 'flex' && accountSaveClosingFrame.animation !== 'none');
    await new Promise(resolve => setTimeout(resolve, 340));
    const accountSaveClosed = await wc.executeJavaScript('document.getElementById("accountModal")?.style.display === "none"');
    check('A verified saved account hides after the closing animation', accountSaveClosed === true);
    restoreInitialIpcHandler('validate-credentials');
    restoreInitialIpcHandler('save-config');

    await setWindowBounds({ ...win.getBounds(), width: 1280, height: 720 });

    const emptyAccountsGeometry = await wc.executeJavaScript(\`(() => {
      HOSTERS.forEach(name => { config.hosters[name] = []; });
      accountStatuses = {};
      renderAccounts();
      const list = document.getElementById('accountsList');
      return {
        emptyVisible: Boolean(list?.querySelector('.accounts-empty')),
        contained: Boolean(list && list.scrollHeight <= list.clientHeight + 1)
      };
    })()\`);
    check('Empty account state remains contained at 1280x720', emptyAccountsGeometry.emptyVisible && emptyAccountsGeometry.contained);
    await captureVisual('02-accounts-empty-1280x720.png');

    const accountCollapseMotion = await wc.executeJavaScript(\`(async () => {
      const hoster = HOSTERS[0];
      HOSTERS.forEach(name => { config.hosters[name] = []; });
      config.hosters[hoster] = [{ id: 'ui-collapse-account', label: 'Animated account', enabled: true, authType: 'login', username: 'animated@example.invalid', password: 'fictional-password' }];
      accountStatuses = { 'ui-collapse-account': { status: 'ok', message: 'Bereit' } };
      _hosterGroupOpenMemory.set(hoster, { state: 'closed', errorsAtClose: 0 });
      renderAccounts();
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const sample = async (trigger, body) => {
        const closedStart = body.getBoundingClientRect().height;
        trigger.click();
        await wait(70);
        const opening = body.getBoundingClientRect().height;
        const openingState = body.classList.contains('is-open');
        const duration = parseFloat(getComputedStyle(body).transitionDuration) * 1000;
        await wait(240);
        const opened = body.getBoundingClientRect().height;
        trigger.click();
        await wait(70);
        const closing = body.getBoundingClientRect().height;
        const closingState = !body.classList.contains('is-open');
        await wait(240);
        const closedEnd = body.getBoundingClientRect().height;
        return { closedStart, opening, opened, closing, closedEnd, openingState, closingState, duration };
      };
      const hosterMotion = await sample(document.querySelector('[data-hoster-toggle]'), document.querySelector('.account-hoster-group-body'));
      const settingsMotion = await sample(document.querySelector('[data-hoster-settings-toggle]'), document.querySelector('.account-hoster-settings-body'));
      return { hosterMotion, settingsMotion };
    })()\`);
    const hasSmoothAccountCollapse = motion => motion.closedStart <= 1 && motion.opening > 1 && motion.opening < motion.opened - 1 && motion.closing > 1 && motion.closing < motion.opened - 1 && motion.closedEnd <= 1 && motion.openingState && motion.closingState && motion.duration >= 180;
    check('Hoster groups visibly animate while opening and closing', hasSmoothAccountCollapse(accountCollapseMotion.hosterMotion));
    check('Hoster upload settings visibly animate while opening and closing', hasSmoothAccountCollapse(accountCollapseMotion.settingsMotion));

    const accountSettingsDescriptionLayout = await wc.executeJavaScript(\`(async () => {
      const hoster = HOSTERS[0];
      const settings = document.querySelector('[data-hoster-settings-toggle="' + hoster + '"]');
      if (settings && settings.getAttribute('aria-expanded') !== 'true') settings.click();
      await new Promise(resolve => setTimeout(resolve, 240));
      const container = document.querySelector('.account-hoster-settings-body-inner');
      const rows = [...document.querySelectorAll('.account-hoster-option-row')];
      const containerRect = container?.getBoundingClientRect();
      return rows.map(row => {
        const rowRect = row.getBoundingClientRect();
        const hintRect = row.querySelector('.hint')?.getBoundingClientRect();
        const inputRect = row.querySelector('input')?.getBoundingClientRect();
        return {
          widthRatio: containerRect ? rowRect.width / containerRect.width : 0,
          descriptionBeforeToggle: Boolean(hintRect && inputRect && hintRect.right <= inputRect.left)
        };
      });
    })()\`);
    const accountSettingsDescriptionLayoutClean = accountSettingsDescriptionLayout.length === 3 && accountSettingsDescriptionLayout.every(row => row.widthRatio >= .97 && row.descriptionBeforeToggle);
    if (!accountSettingsDescriptionLayoutClean) console.log('Account settings description layout:', JSON.stringify(accountSettingsDescriptionLayout));
    check('Account host options give descriptions a full clean row with toggles aligned right', accountSettingsDescriptionLayoutClean);

    const accountsFooterGeometry = await wc.executeJavaScript(\`(() => {
      const main = document.querySelector('#accounts-view .accounts-main')?.getBoundingClientRect();
      const list = document.getElementById('accountsList')?.getBoundingClientRect();
      const footer = document.getElementById('accountsListFooter')?.getBoundingClientRect();
      return {
        visible: Boolean(footer && footer.height > 0),
        anchored: Boolean(main && footer && Math.abs(main.bottom - footer.bottom) <= 1),
        listEndsAtFooter: Boolean(list && footer && Math.abs(list.bottom - footer.top) <= 1)
      };
    })()\`);
    check('Accounts collapse-all footer stays anchored to the bottom below short hoster content', accountsFooterGeometry.visible && accountsFooterGeometry.anchored && accountsFooterGeometry.listEndsAtFooter);
    await captureVisual('02-accounts-footer-short.png');

    const tallAccountGroupGeometry = await wc.executeJavaScript(\`(() => {
      const hoster = HOSTERS[0];
      HOSTERS.forEach(name => { config.hosters[name] = []; });
      config.hosters[hoster] = [1, 2, 3, 4].map(index => ({
        id: 'ui-overflow-tall-' + index,
        label: 'Fictional account ' + index,
        enabled: true,
        authType: 'login',
        username: 'tall-' + index + '@example.invalid',
        password: 'fictional-password-' + index
      }));
      accountStatuses = Object.fromEntries(config.hosters[hoster].map(account => [account.id, { status: 'ok', message: 'Bereit' }]));
      renderAccounts();
      document.querySelector('[data-hoster-toggle]')?.click();
      document.querySelector('[data-hoster-settings-toggle]')?.click();
      const list = document.getElementById('accountsList');
      const group = list?.querySelector('.account-hoster-group');
      if (list) list.scrollTop = list.scrollHeight;
      return {
        groupCount: list?.querySelectorAll('.account-hoster-group').length || 0,
        listOverflows: Boolean(list && list.scrollHeight > list.clientHeight),
        listScrolls: Boolean(list && list.scrollTop > 0),
        groupContained: Boolean(group && group.scrollHeight <= group.clientHeight + 1)
      };
    })()\`);
    check('One tall account group overflows through the Accounts list', tallAccountGroupGeometry.groupCount === 1 && tallAccountGroupGeometry.listOverflows && tallAccountGroupGeometry.listScrolls && tallAccountGroupGeometry.groupContained);
    await captureVisual('02-accounts-tall-1280x720.png');

    const expandedAccountsGeometry = await wc.executeJavaScript(\`(() => {
      const hosters = HOSTERS.slice(0, 4);
      HOSTERS.forEach(name => { config.hosters[name] = []; });
      accountStatuses = {};
      hosters.forEach((hoster, index) => {
        const account = {
          id: 'ui-overflow-account-' + (index + 1),
          label: 'Fictional account ' + (index + 1),
          enabled: true,
          authType: 'login',
          username: 'account-' + (index + 1) + '@example.invalid',
          password: 'fictional-password-' + (index + 1)
        };
        config.hosters[hoster] = [account];
        accountStatuses[account.id] = { status: index === 0 ? 'error' : 'ok', message: index === 0 ? 'Fictional error' : 'Bereit' };
      });
      renderAccounts();
      document.querySelectorAll('[data-hoster-toggle]').forEach(header => {
        if (!header.nextElementSibling?.classList.contains('is-open')) header.click();
      });
      [...document.querySelectorAll('[data-hoster-settings-toggle]')].slice(0, 3).forEach(header => header.click());
      const list = document.getElementById('accountsList');
      const groups = [...list.querySelectorAll('.account-hoster-group')].filter(group => !group.hidden);
      if (list) list.scrollTop = list.scrollHeight;
      return {
        groupCount: groups.length,
        openGroupCount: groups.filter(group => group.querySelector('.account-hoster-group-body')?.classList.contains('is-open')).length,
        openSettingsCount: groups.filter(group => group.querySelector('.account-hoster-settings-body')?.classList.contains('is-open')).length,
        listClientHeight: list?.clientHeight || 0,
        listScrollHeight: list?.scrollHeight || 0,
        listScrollTop: list?.scrollTop || 0,
        bottomReachable: Boolean(list && list.scrollTop + list.clientHeight >= list.scrollHeight - 1),
        groupsContained: groups.every(group => group.scrollHeight <= group.clientHeight + 1)
      };
    })()\`);
    console.log('Accounts overflow geometry:', JSON.stringify(expandedAccountsGeometry));
    check('Expanded account fixtures render four open hoster groups and three open settings sections', expandedAccountsGeometry.groupCount === 4 && expandedAccountsGeometry.openGroupCount === 4 && expandedAccountsGeometry.openSettingsCount >= 3);
    check('Expanded account groups overflow through the Accounts list', expandedAccountsGeometry.listScrollHeight > expandedAccountsGeometry.listClientHeight);
    check('Expanded Accounts list accepts a positive scrollTop and reaches its bottom', expandedAccountsGeometry.listScrollTop > 0 && expandedAccountsGeometry.bottomReachable);
    check('Expanded account hoster groups do not clip their own content', expandedAccountsGeometry.groupsContained);
    await captureVisual('02-accounts-expanded-1280x720.png');

    const filteredAccountsGeometry = await wc.executeJavaScript(\`(() => {
      document.querySelector('[data-accounts-sidebar-filter="error"]')?.click();
      const groups = [...document.querySelectorAll('#accountsList .account-hoster-group')];
      const visibleGroups = groups.filter(group => !group.hidden);
      const result = {
        visibleGroupCount: visibleGroups.length,
        hiddenGroupCount: groups.filter(group => group.hidden).length,
        groupsContained: visibleGroups.every(group => group.scrollHeight <= group.clientHeight + 1)
      };
      return result;
    })()\`);
    check('Filtered account state hides unmatched groups without clipping the visible group', filteredAccountsGeometry.visibleGroupCount === 1 && filteredAccountsGeometry.hiddenGroupCount === 3 && filteredAccountsGeometry.groupsContained);
    await captureVisual('02-accounts-filtered-1280x720.png');
    await wc.executeJavaScript('document.querySelector("[data-accounts-sidebar-filter=all]")?.click()');
    await setWindowBounds(originalBounds);

    const mixedGroupStatus = await wc.executeJavaScript(\`(() => {
      config.hosters['byse.sx'] = [
        { id: 'ui-status-ok-1', enabled: true, authType: 'api', apiKey: 'key-one' },
        { id: 'ui-status-ok-2', enabled: true, authType: 'api', apiKey: 'key-two' },
        { id: 'ui-status-error', enabled: true, authType: 'api', apiKey: 'key-three' }
      ];
      accountStatuses['ui-status-ok-1'] = { status: 'ok', message: 'Bereit' };
      accountStatuses['ui-status-ok-2'] = { status: 'ok', message: 'Bereit' };
      accountStatuses['ui-status-error'] = { status: 'error', message: 'Deaktiviert durch Administrator' };
      renderAccounts();
      const dot = document.querySelector('.account-hoster-group[data-hoster-group="byse.sx"] .account-hoster-group-header .account-status-dot');
      return [dot?.className, getComputedStyle(dot).backgroundColor].join('|');
    })()\`);
    check('Mixed account results use orange group status', mixedGroupStatus === 'account-status-dot status-warn|rgb(240, 195, 108)');

    const allErrorGroupStatus = await wc.executeJavaScript(\`(() => {
      accountStatuses['ui-status-ok-1'] = { status: 'error', message: 'Fehler' };
      accountStatuses['ui-status-ok-2'] = { status: 'error', message: 'Fehler' };
      renderAccounts();
      return document.querySelector('.account-hoster-group[data-hoster-group="byse.sx"] .account-hoster-group-header .account-status-dot')?.className;
    })()\`);
    check('All-error account group uses red status', allErrorGroupStatus === 'account-status-dot status-error');

    const otpCardState = await wc.executeJavaScript(\`(() => {
      config.hosters['doodstream.com'] = [{ id: 'ui-status-otp', enabled: true, authType: 'login', username: 'otp@example.com', password: 'password' }];
      accountStatuses['ui-status-otp'] = { status: 'otp_required', message: 'OTP wurde an deine E-Mail gesendet.' };
      renderAccounts();
      const card = [...document.querySelectorAll('.account-card')].find(el => el.dataset.accountId === 'ui-status-otp');
      return [
        card?.querySelector('[data-account-otp-input]')?.getAttribute('placeholder'),
        card?.querySelector('[data-account-otp-submit]')?.textContent?.trim(),
        card?.querySelector('.account-status')?.textContent?.trim()
      ].join('|');
    })()\`);
    check('OTP-required account exposes inline code input and save action', otpCardState === 'Code aus E-Mail|Prüfen und speichern|OTP erforderlich');

    const otpSubmitState = await wc.executeJavaScript(\`(() => {
      const card = [...document.querySelectorAll('.account-card')].find(el => el.dataset.accountId === 'ui-status-otp');
      card.querySelector('[data-account-otp-input]').value = '123456';
      card.querySelector('[data-account-otp-submit]').click();
      return [accountStatuses['ui-status-otp']?.status, String(card.querySelector('[data-account-otp-submit]')?.disabled)].join('|');
    })()\`);
    check('Inline OTP submission starts validation', otpSubmitState === 'checking|true');

    const accountFilterState = await wc.executeJavaScript(\`(() => {
      HOSTERS.forEach(name => { config.hosters[name] = []; });
      config.hosters['doodstream.com'] = [
        { id: 'ui-filter-no-creds', enabled: true, authType: 'login', username: '', password: '' }
      ];
      config.hosters['byse.sx'] = [
        { id: 'ui-filter-ready', enabled: true, authType: 'api', apiKey: 'ready-key' },
        { id: 'ui-filter-disabled', enabled: false, authType: 'api', apiKey: 'disabled-key' },
        { id: 'ui-filter-error', enabled: true, authType: 'api', apiKey: 'error-key' }
      ];
      accountStatuses = {
        'ui-filter-no-creds': { status: 'ok', message: 'Bereit' },
        'ui-filter-ready': { status: 'ok', message: 'Bereit' },
        'ui-filter-disabled': { status: 'ok', message: 'Bereit' },
        'ui-filter-error': { status: 'error', message: 'Fehler' }
      };
      renderAccounts();
      const inspect = (value) => {
        document.querySelector('[data-accounts-sidebar-filter="' + value + '"]').click();
        return {
          cards: [...document.querySelectorAll('#accountsList .account-card')].filter(card => !card.hidden).map(card => card.dataset.accountId).sort(),
          groups: [...document.querySelectorAll('#accountsList .account-hoster-group')].filter(group => !group.hidden).map(group => group.dataset.hosterGroup).sort(),
          pressed: [...document.querySelectorAll('[data-accounts-sidebar-filter]')].filter(button => button.getAttribute('aria-pressed') === 'true').map(button => button.dataset.accountsSidebarFilter),
          active: [...document.querySelectorAll('[data-accounts-sidebar-filter].active')].map(button => button.dataset.accountsSidebarFilter)
        };
      };
      const ready = inspect('ready');
      const warning = inspect('warning');
      const error = inspect('error');
      const all = inspect('all');
      const counters = ['accountsSidebarAllCount', 'accountsSidebarReadyCount', 'accountsSidebarWarningCount', 'accountsSidebarErrorCount'].map(id => document.getElementById(id)?.textContent);
      return { ready, warning, error, all, counters };
    })()\`);
    check('Account sidebar filters cards and hides hoster groups without matches', accountFilterState.ready.cards.join('|') === 'ui-filter-ready' && accountFilterState.ready.groups.join('|') === 'byse.sx' && accountFilterState.warning.cards.join('|') === 'ui-filter-disabled|ui-filter-no-creds' && accountFilterState.warning.groups.join('|') === 'byse.sx|doodstream.com' && accountFilterState.error.cards.join('|') === 'ui-filter-error' && accountFilterState.error.groups.join('|') === 'byse.sx' && accountFilterState.all.cards.length === 4);
    check('Account sidebar classifies disabled and credential-less accounts as action needed', accountFilterState.counters.join('|') === '4|1|2|1');
    check('Account sidebar exposes exactly one pressed filter', accountFilterState.error.pressed.join('|') === 'error' && accountFilterState.error.active.join('|') === 'error' && accountFilterState.all.pressed.join('|') === 'all' && accountFilterState.all.active.join('|') === 'all');

    ipcMain.removeHandler('run-health-check');
    ipcMain.handle('run-health-check', (_event, payload) => {
      const accountId = payload.hosters?.[0]?.accountId;
      const failed = accountId === 'ui-filter-error';
      return {
        checkedAt: failed ? '2030-02-03T04:05:06.000Z' : '2030-01-02T03:04:05.000Z',
        results: (payload.hosters || []).map(item => ({ accountId: item.accountId, status: failed ? 'error' : 'ok', message: failed ? 'Check failed' : 'Ready' }))
      };
    });
    const completedAccountCheckState = await wc.executeJavaScript(\`(async () => {
      await checkSingleAccount('ui-filter-ready');
      const ready = accountStatuses['ui-filter-ready'];
      const readyGerman = document.querySelector('[data-account-id="ui-filter-ready"] .account-card-subtitle')?.textContent || '';
      await checkSingleAccount('ui-filter-error');
      const failed = accountStatuses['ui-filter-error'];
      const failedGerman = document.querySelector('[data-account-id="ui-filter-error"] .account-card-subtitle')?.textContent || '';
      setUiLanguage('en');
      renderAccounts();
      const readyEnglish = document.querySelector('[data-account-id="ui-filter-ready"] .account-card-subtitle')?.textContent || '';
      const failedEnglish = document.querySelector('[data-account-id="ui-filter-error"] .account-card-subtitle')?.textContent || '';
      setUiLanguage('de');
      renderAccounts();
      return { ready, failed, readyGerman, failedGerman, readyEnglish, failedEnglish, generations: accountStatusGenerations.size };
    })()\`);
    check('Single-account checks retain the main-process checkedAt timestamp for success and failure', completedAccountCheckState.ready?.status === 'ok' && completedAccountCheckState.ready?.checkedAt === '2030-01-02T03:04:05.000Z' && completedAccountCheckState.failed?.status === 'error' && completedAccountCheckState.failed?.checkedAt === '2030-02-03T04:05:06.000Z' && completedAccountCheckState.generations === 0);
    check('Single-account check timestamps use the active interface language', /geprüft \\d{2}:\\d{2}/.test(completedAccountCheckState.readyGerman) && /geprüft \\d{2}:\\d{2}/.test(completedAccountCheckState.failedGerman) && /checked \\d{2}:\\d{2}/.test(completedAccountCheckState.readyEnglish) && /checked \\d{2}:\\d{2}/.test(completedAccountCheckState.failedEnglish));
    restoreInitialIpcHandler('run-health-check');

    let resolveStaleAccountCheck = null;
    ipcMain.removeHandler('run-health-check');
    ipcMain.handle('run-health-check', () => new Promise(resolve => { resolveStaleAccountCheck = resolve; }));
    const staleAccountCheck = wc.executeJavaScript(\`(() => {
      HOSTERS.forEach(name => { config.hosters[name] = []; });
      config.hosters['byse.sx'] = [{ id: 'ui-stale-account-check', enabled: true, authType: 'api', apiKey: 'old-key' }];
      accountStatuses = { 'ui-stale-account-check': { status: 'ok', message: 'Old credentials ready' } };
      healthCheckRunning = false;
      renderAccounts();
      return checkSingleAccount('ui-stale-account-check');
    })()\`);
    await waitUntil(() => resolveStaleAccountCheck);
    await wc.executeJavaScript(\`(() => {
      const candidateHosters = structuredClone(config.hosters);
      candidateHosters['byse.sx'][0].apiKey = 'new-key';
      _applyCommittedAccount(
        { accountId: 'ui-stale-account-check', candidateHosters, isEdit: true },
        { status: 'ok', message: 'New credentials ready', checkedAt: '2032-01-02T03:04:05.000Z' }
      );
    })()\`);
    resolveStaleAccountCheck({ checkedAt: '2031-01-02T03:04:05.000Z', results: [{ accountId: 'ui-stale-account-check', status: 'error', message: 'Old credential check failed' }] });
    await staleAccountCheck;
    const staleAccountCheckState = await wc.executeJavaScript(\`(() => {
      const status = accountStatuses['ui-stale-account-check'];
      const card = document.querySelector('[data-account-id="ui-stale-account-check"]');
      return { status: status?.status, message: status?.message, checkedAt: status?.checkedAt, card: card?.querySelector('.account-status')?.textContent.trim() };
    })()\`);
    check('A late account check cannot overwrite newly committed credentials or its newer timestamp', staleAccountCheckState.status === 'ok' && staleAccountCheckState.message === 'New credentials ready' && staleAccountCheckState.checkedAt === '2032-01-02T03:04:05.000Z' && staleAccountCheckState.card === 'Bereit');
    restoreInitialIpcHandler('run-health-check');

    let resolveImportedAccountCheck = null;
    ipcMain.removeHandler('run-health-check');
    ipcMain.handle('run-health-check', () => new Promise(resolve => { resolveImportedAccountCheck = resolve; }));
    const importedAccountCheck = wc.executeJavaScript(\`(() => {
      healthCheckRunning = false;
      return checkSingleAccount('ui-stale-account-check');
    })()\`);
    await waitUntil(() => resolveImportedAccountCheck);
    await wc.executeJavaScript(\`(() => {
      const imported = structuredClone(config);
      imported.hosters['byse.sx'][0].apiKey = 'imported-key';
      applyImportedConfig(imported, 'Importiert');
    })()\`);
    resolveImportedAccountCheck({ results: [{ accountId: 'ui-stale-account-check', status: 'error', message: 'Pre-import credentials failed' }] });
    await importedAccountCheck;
    const importedAccountCheckState = await wc.executeJavaScript(\`(() => {
      const status = accountStatuses['ui-stale-account-check'];
      return { status: status?.status, message: status?.message || '', generations: accountStatusGenerations.size, apiKey: config.hosters['byse.sx'][0].apiKey };
    })()\`);
    check('A backup import invalidates account checks started with older credentials', importedAccountCheckState.status === 'unchecked' && importedAccountCheckState.message === '' && importedAccountCheckState.generations === 0 && importedAccountCheckState.apiKey === 'imported-key');
    restoreInitialIpcHandler('run-health-check');

    console.log('\\n=== Settings View ===');

    await wc.executeJavaScript('document.querySelector(".tab[data-view=\\'settings\\']").click()');
    await new Promise(r => setTimeout(r, 300));

    const settingsActive = await wc.executeJavaScript('document.getElementById("settings-view")?.classList.contains("active")');
    check('Settings tab active', settingsActive);

    let updateCheckCallCount = 0;
    const updateCheckResolvers = [];
    ipcMain.removeHandler('app:check-updates');
    ipcMain.handle('app:check-updates', () => {
      updateCheckCallCount++;
      return new Promise(resolve => updateCheckResolvers.push(resolve));
    });
    await wc.executeJavaScript(\`(() => {
      _knownUpdateInfo = null;
      _updateCheckBusy = false;
      closeUpdateDialog();
      _syncHeaderUpdateState();
      document.getElementById('manualUpdateCheckBtn').click();
      _handleMenuAction('check-updates');
      document.getElementById('headerUpdateBtn').click();
    })()\`);
    await new Promise(resolve => setTimeout(resolve, 100));
    const coordinatedUpdateBusy = await wc.executeJavaScript('(() => { const manual = document.getElementById("manualUpdateCheckBtn"); const header = document.getElementById("headerUpdateBtn"); return [manual?.disabled, manual?.getAttribute("aria-busy"), manual?.textContent?.trim(), header?.disabled, header?.getAttribute("aria-busy"), header?.hidden].join("|"); })()');
    check('All update entry points share one in-flight check', updateCheckCallCount === 1 && coordinatedUpdateBusy === 'true|true|Prüfe…|true|true|true');
    updateCheckResolvers.splice(0).forEach(resolve => resolve({ available: false, error: 'Simulierter Netzwerkfehler' }));
    await new Promise(resolve => setTimeout(resolve, 150));
    const coordinatedUpdateError = await wc.executeJavaScript('(() => { const manual = document.getElementById("manualUpdateCheckBtn"); const header = document.getElementById("headerUpdateBtn"); return [manual?.disabled, header?.disabled, header?.hidden, manual?.textContent?.trim(), document.getElementById("copyToast")?.textContent?.trim()].join("|"); })()');
    check('Settings update check uses the shared error contract', coordinatedUpdateError === 'false|false|true|Nach Updates suchen|Updateprüfung fehlgeschlagen');
    await wc.executeJavaScript('document.getElementById("copyToast")?.classList.remove("show")');

    await wc.executeJavaScript('requestUpdateCheck(); true');
    await new Promise(resolve => setTimeout(resolve, 100));
    updateCheckResolvers.splice(0).forEach(resolve => resolve({ available: false }));
    await new Promise(resolve => setTimeout(resolve, 150));
    const noUpdateHeaderVisibility = await wc.executeJavaScript('(() => { const button = document.getElementById("headerUpdateBtn"); return [button?.hidden, getComputedStyle(button).display].join("|"); })()');
    check('Successful no-update result keeps the header action hidden', noUpdateHeaderVisibility === 'true|none');

    const settingsNavigation = await wc.executeJavaScript('(() => { const buttons = [...document.querySelectorAll(".settings-nav-button")]; return [buttons.length, buttons.map(button => button.textContent.trim()).join("|"), document.querySelector(".settings-nav-button.active")?.dataset.settingsPage, document.getElementById("settingsSearchInput")?.placeholder].join("::"); })()');
    check('Settings use the task-based sidebar navigation', settingsNavigation === '8::Allgemein|Uploads|Automatik|Benachrichtigungen|Logs & Support|Fernsteuerung|Diagnose-Zugriff|Backup & Übertragen::allgemein::Einstellungen durchsuchen');

    const settingsIndicatorContract = await wc.executeJavaScript('(() => { const indicator = document.querySelector(".settings-navigation > .settings-nav-indicator"); const active = document.querySelector(".settings-nav-button.active"); if (!indicator || !active) return "missing"; const indicatorStyle = getComputedStyle(indicator); const activeStyle = getComputedStyle(active); const indicatorRect = indicator.getBoundingClientRect(); const activeRect = active.getBoundingClientRect(); return [activeStyle.backgroundColor === "rgba(0, 0, 0, 0)", indicatorStyle.borderTopWidth === "1px", parseFloat(indicatorStyle.transitionDuration) >= .15, Math.abs(indicatorRect.top - activeRect.top) <= 1, Math.abs(indicatorRect.height - activeRect.height) <= 1].join("|"); })()');
    check('Settings navigation moves its active surface onto one sliding indicator', settingsIndicatorContract === 'true|true|true|true|true');
    const settingsNavigationBorders = await wc.executeJavaScript('(() => { const buttons = [...document.querySelectorAll(".settings-nav-button:not([hidden])")]; const active = buttons.find(button => button.classList.contains("active")); const inactive = buttons.filter(button => button !== active); const visibleBorder = button => { const style = getComputedStyle(button); return style.borderTopWidth === "1px" && style.borderTopStyle === "solid" && style.borderTopColor !== "rgba(0, 0, 0, 0)"; }; return { inactive: inactive.length > 0 && inactive.every(visibleBorder), activeTransparent: active ? getComputedStyle(active).borderTopColor === "rgba(0, 0, 0, 0)" : false }; })()');
    check('Settings navigation gives every inactive destination a visible individual frame', settingsNavigationBorders.inactive && settingsNavigationBorders.activeTransparent);

    await wc.executeJavaScript('window.__uiSettingsIndicatorStart = document.querySelector(".settings-nav-indicator")?.getBoundingClientRect().top; document.querySelector("[data-settings-page=backup]")?.click()');
    await new Promise(resolve => setTimeout(resolve, 90));
    const settingsIndicatorMovingDown = await wc.executeJavaScript('(() => { const indicator = document.querySelector(".settings-nav-indicator"); const target = document.querySelector("[data-settings-page=backup]"); const start = window.__uiSettingsIndicatorStart; if (!indicator || !target || !Number.isFinite(start)) return false; const current = indicator.getBoundingClientRect().top; const targetTop = target.getBoundingClientRect().top; return current > start + 2 && current < targetTop - 2; })()');
    check('Settings indicator remains visibly in motion while gliding down', settingsIndicatorMovingDown === true);
    await new Promise(resolve => setTimeout(resolve, 170));
    const settingsIndicatorAtBackup = await wc.executeJavaScript('(() => { const indicator = document.querySelector(".settings-nav-indicator"); const target = document.querySelector("[data-settings-page=backup]"); if (!indicator || !target) return "missing"; const indicatorRect = indicator.getBoundingClientRect(); const targetRect = target.getBoundingClientRect(); window.__uiSettingsIndicatorBackupTop = indicatorRect.top; return [Math.abs(indicatorRect.top - targetRect.top) <= 1, Math.abs(indicatorRect.height - targetRect.height) <= 1].join("|"); })()');
    check('Settings indicator glides to a lower category', settingsIndicatorAtBackup === 'true|true');
    await wc.executeJavaScript('document.querySelector("[data-settings-page=allgemein]")?.click()');
    await new Promise(resolve => setTimeout(resolve, 90));
    const settingsIndicatorMovingUp = await wc.executeJavaScript('(() => { const indicator = document.querySelector(".settings-nav-indicator"); const target = document.querySelector("[data-settings-page=allgemein]"); const start = window.__uiSettingsIndicatorBackupTop; if (!indicator || !target || !Number.isFinite(start)) return false; const current = indicator.getBoundingClientRect().top; const targetTop = target.getBoundingClientRect().top; return current < start - 2 && current > targetTop + 2; })()');
    check('Settings indicator remains visibly in motion while gliding up', settingsIndicatorMovingUp === true);
    await new Promise(resolve => setTimeout(resolve, 170));

    await wc.executeJavaScript('document.querySelector("[data-settings-page=backup]")?.click()');
    await new Promise(resolve => setTimeout(resolve, 240));
    await wc.executeJavaScript('window.__uiSettingsSearchStart = document.querySelector(".settings-nav-indicator")?.getBoundingClientRect().top; (() => { const input = document.getElementById("settingsSearchInput"); input.value = "backup"; input.dispatchEvent(new Event("input", { bubbles: true })); })()');
    await new Promise(resolve => setTimeout(resolve, 90));
    const settingsSearchMovingUp = await wc.executeJavaScript('(() => { const indicator = document.querySelector(".settings-nav-indicator"); const target = document.querySelector("[data-settings-page=backup]"); const start = window.__uiSettingsSearchStart; if (!indicator || !target || !Number.isFinite(start)) return false; const current = indicator.getBoundingClientRect().top; const targetTop = target.getBoundingClientRect().top; return current < start - 2 && current > targetTop + 2; })()');
    check('Settings indicator remains visibly in motion when search reflows the active destination upward', settingsSearchMovingUp === true);
    await new Promise(resolve => setTimeout(resolve, 170));
    await wc.executeJavaScript('window.__uiSettingsFilteredTop = document.querySelector(".settings-nav-indicator")?.getBoundingClientRect().top; (() => { const input = document.getElementById("settingsSearchInput"); input.value = ""; input.dispatchEvent(new Event("input", { bubbles: true })); })()');
    await new Promise(resolve => setTimeout(resolve, 90));
    const settingsSearchMovingDown = await wc.executeJavaScript('(() => { const indicator = document.querySelector(".settings-nav-indicator"); const target = document.querySelector("[data-settings-page=backup]"); const start = window.__uiSettingsFilteredTop; if (!indicator || !target || !Number.isFinite(start)) return false; const current = indicator.getBoundingClientRect().top; const targetTop = target.getBoundingClientRect().top; return current > start + 2 && current < targetTop - 2; })()');
    check('Settings indicator remains visibly in motion when clearing search restores its position', settingsSearchMovingDown === true);
    await new Promise(resolve => setTimeout(resolve, 170));

    await wc.executeJavaScript('document.querySelector("[data-settings-page=\\\'automatik\\\']")?.click()');
    const automationInputAlignment = await wc.executeJavaScript('(() => { const first = document.getElementById("autoRetryRoundsInput")?.getBoundingClientRect(); const second = document.getElementById("autoRetryDelayMinInput")?.getBoundingClientRect(); const firstHintEl = document.getElementById("autoRetryRoundsInput")?.closest(".automation-retry-row")?.querySelector(".hint"); const secondHintEl = document.getElementById("autoRetryDelayMinInput")?.closest(".automation-retry-row")?.querySelector(".hint"); const firstHint = firstHintEl?.getBoundingClientRect(); const secondHint = secondHintEl?.getBoundingClientRect(); if (!first || !second || !firstHint || !secondHint || !firstHintEl || !secondHintEl) return "missing"; const firstTextLeft = firstHint.left + parseFloat(getComputedStyle(firstHintEl).paddingLeft); const secondTextLeft = secondHint.left + parseFloat(getComputedStyle(secondHintEl).paddingLeft); return [Math.round(Math.abs(first.left - second.left)), Math.round(first.width), Math.round(second.width), firstHint.top >= first.bottom + 6, secondHint.top >= second.bottom + 6, Math.round(Math.abs(firstTextLeft - first.left)) <= 1, Math.round(Math.abs(secondTextLeft - second.left)) <= 1].join("|"); })()');
    check('Automation retry hints start directly below their aligned inputs', automationInputAlignment === '0|100|100|true|true|true|true');
    const uploadScheduleSettings = await wc.executeJavaScript(\`(async () => {
      document.querySelector('[data-settings-page="automatik"]')?.click();
      const toggle = document.getElementById('uploadScheduleEnabledInput');
      const start = document.getElementById('uploadScheduleStartInput');
      const end = document.getElementById('uploadScheduleEndInput');
      const days = [...document.querySelectorAll('[data-upload-schedule-day]')];
      const panel = document.querySelector('.upload-schedule-panel');
      const initial = {
        present: Boolean(toggle && start && end && days.length === 7),
        dependentDisabled: days.every(input => input.disabled) && start.disabled && end.disabled,
        contained: panel.scrollWidth <= panel.clientWidth + 1
      };
      toggle.checked = true;
      toggle.dispatchEvent(new Event('change', { bubbles: true }));
      days.forEach(input => { input.checked = false; });
      start.value = '22:00';
      end.value = '06:00';
      syncUploadScheduleControls();
      const invalid = {
        status: document.getElementById('uploadScheduleStatus')?.textContent.trim(),
        badge: document.getElementById('uploadScheduleStatusBadge')?.textContent.trim(),
        saveRejected: await performSaveSettings().then(() => false, () => true)
      };
      days.find(input => input.value === '1').checked = true;
      syncUploadScheduleControls();
      await saveSettings({ feedbackText: 'Gespeichert' });
      const saved = (await window.api.getGlobalSettings()).uploadSchedule;
      setUiLanguage('en');
      syncUploadScheduleControls();
      const english = {
        heading: document.getElementById('uploadScheduleEnabledInput')?.closest('.settings-option')?.querySelector('label')?.textContent.trim(),
        badge: document.getElementById('uploadScheduleStatusBadge')?.textContent.trim(),
        status: document.getElementById('uploadScheduleStatus')?.textContent.trim()
      };
      setUiLanguage('de');
      toggle.checked = false;
      toggle.dispatchEvent(new Event('change', { bubbles: true }));
      await saveSettings({ feedbackText: 'Gespeichert' });
      return { initial, invalid, saved, english, restored: (await window.api.getGlobalSettings()).uploadSchedule.enabled === false };
    })()\`);
    check('Automation exposes a contained seven-day upload schedule with dependent controls disabled by default', uploadScheduleSettings.initial.present && uploadScheduleSettings.initial.dependentDisabled && uploadScheduleSettings.initial.contained);
    check('Invalid upload schedules are explained and rejected before persistence', uploadScheduleSettings.invalid.badge === 'Ungültig' && uploadScheduleSettings.invalid.status.includes('mindestens einen Wochentag') && uploadScheduleSettings.invalid.saveRejected);
    check('Valid overnight schedules persist with the selected originating weekday', uploadScheduleSettings.saved.enabled === true && uploadScheduleSettings.saved.start === '22:00' && uploadScheduleSettings.saved.end === '06:00' && uploadScheduleSettings.saved.weekdays.join(',') === '1');
    check('Upload schedule status and controls switch fully to English without restart', uploadScheduleSettings.english.heading === 'Start new uploads only during the schedule' && ['Open', 'Closed'].includes(uploadScheduleSettings.english.badge) && /^(Open|Closed)\./.test(uploadScheduleSettings.english.status) && uploadScheduleSettings.restored);
    await captureVisual('03-automation.png');
    await wc.executeJavaScript('document.querySelector("[data-settings-page=allgemein]")?.click()');
    const updateActionAlignment = await wc.executeJavaScript('(() => { const row = document.querySelector(".program-update-row")?.getBoundingClientRect(); const button = document.getElementById("manualUpdateCheckBtn")?.getBoundingClientRect(); return row && button ? [Math.abs(row.right - button.right) <= 16, button.bottom <= row.bottom, button.left > row.left + row.width / 2].join("|") : "missing"; })()');
    check('Program update action sits at the lower right of its card', updateActionAlignment === 'true|true|true');
    const updateCardContract = await wc.executeJavaScript('(() => { const card = document.querySelector(".program-update-card"); const title = card?.querySelector(".program-update-title"); const description = card?.querySelector(".program-update-description"); const button = document.getElementById("manualUpdateCheckBtn"); if (!card || !title || !description || !button) return "missing"; const cardRect = card.getBoundingClientRect(); const titleRect = title.getBoundingClientRect(); const descriptionRect = description.getBoundingClientRect(); const buttonRect = button.getBoundingClientRect(); const center = rect => rect.top + rect.height / 2; return [title.textContent.trim(), description.textContent.trim(), titleRect.top < descriptionRect.top, Math.abs(center(buttonRect) - center(cardRect)) <= 2, buttonRect.right <= cardRect.right - 10, titleRect.left >= cardRect.left + 10].join("|"); })()');
    check('Program update card uses a clear title, description and vertically centered action', updateCardContract === 'Nach neuer Version suchen|Verfügbare Updates werden zusammen mit dem Changelog angezeigt.|true|true|true|true');
    await wc.executeJavaScript('document.querySelector("[data-settings-page=logs]")?.click()');
    const logPathAlignment = await wc.executeJavaScript('(() => { const row = document.querySelector(".log-file-path-row")?.getBoundingClientRect(); const input = document.getElementById("logFilePathInput")?.getBoundingClientRect(); const choose = document.getElementById("chooseLogFilePathBtn")?.getBoundingClientRect(); const open = document.getElementById("openLogFolderBtn")?.getBoundingClientRect(); if (!row || !input || !choose || !open) return "missing"; const center = rect => rect.top + rect.height / 2; return [Math.abs(center(input) - center(choose)) <= 1, Math.abs(center(choose) - center(open)) <= 1, open.left > choose.right, open.right <= row.right + 1].join("|"); })()');
    check('FileUploader Log actions stay in one row with Open on the right', logPathAlignment === 'true|true|true|true');
    const verboseLoggingLayout = await wc.executeJavaScript('(() => { const option = document.querySelector(".verbose-logging-option"); const copy = option?.querySelector(".settings-option-copy"); const input = document.getElementById("logVerboseInput"); const label = option?.querySelector("label[for=logVerboseInput]"); if (!option || !copy || !input || !label) return "missing"; const optionRect = option.getBoundingClientRect(); const copyRect = copy.getBoundingClientRect(); const inputRect = input.getBoundingClientRect(); const center = rect => rect.top + rect.height / 2; return [input.parentElement === option, inputRect.left > copyRect.right, Math.abs(center(inputRect) - center(optionRect)) <= 1, inputRect.right <= optionRect.right - 10].join("|"); })()');
    check('Verbose logging follows the shared settings option layout with its checkbox on the right', verboseLoggingLayout === 'true|true|true|true');

    const settingsSidebarInformation = await wc.executeJavaScript('(() => { const feedback = document.getElementById("saveFeedback"); const sidebar = document.querySelector(".settings-sidebar"); const status = document.querySelector(".settings-sidebar-status"); return Boolean(feedback && sidebar?.contains(feedback) && status && !document.querySelector(".settings-header #saveFeedback")); })()');
    check('Settings sidebar owns the persistent save information', settingsSidebarInformation === true);
    const settingsSearchPadding = await wc.executeJavaScript('parseFloat(getComputedStyle(document.getElementById("settingsSearchInput")).paddingLeft)');
    check('Settings search text clears the search icon', settingsSearchPadding >= 24);
    const settingsSearchIconAlignment = await wc.executeJavaScript('(() => { const icon = document.querySelector(".settings-search-icon"); const style = getComputedStyle(icon); return [style.display, style.alignItems, Boolean(icon?.querySelector("svg"))].join("|"); })()');
    check('Settings search icon aligns to the input text line', settingsSearchIconAlignment === 'flex|center|true');
    const settingsSearchControlGeometry = await wc.executeJavaScript('(() => { const control = document.querySelector(".settings-search-control"); const input = document.getElementById("settingsSearchInput"); const icon = document.querySelector(".settings-search-icon"); const svg = icon?.querySelector("svg"); if (!control || !input || !icon || !svg) return "missing"; const controlRect = control.getBoundingClientRect(); const inputRect = input.getBoundingClientRect(); const iconRect = icon.getBoundingClientRect(); const inputStyle = getComputedStyle(input); const iconStyle = getComputedStyle(icon); return [Math.round(controlRect.height), Math.round(inputRect.height), Math.round(Math.abs((inputRect.top + inputRect.height / 2) - (iconRect.top + iconRect.height / 2))), svg.getAttribute("viewBox"), inputStyle.lineHeight, inputStyle.paddingTop, inputStyle.paddingBottom, iconStyle.display, iconStyle.alignItems].join("|"); })()');
    check('Settings search control keeps icon and text on one shared center line', settingsSearchControlGeometry === '44|44|0|0 0 24 24|18px|0px|0px|flex|center');
    const settingsSearchPlaceholderFit = await wc.executeJavaScript('(() => { const input = document.getElementById("settingsSearchInput"); if (!input) return false; const style = getComputedStyle(input); const canvas = document.createElement("canvas"); const context = canvas.getContext("2d"); context.font = style.font; const available = input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight); return ["Einstellungen durchsuchen", "Search settings"].every(text => context.measureText(text).width <= available - 12); })()');
    check('Settings search placeholders retain visible right-side breathing room', settingsSearchPlaceholderFit === true);

    await wc.executeJavaScript('document.querySelector("[data-settings-page=\\'logs\\']")?.click()');
    await new Promise(resolve => setTimeout(resolve, 100));
    const logPathLayout = await wc.executeJavaScript('(() => { const block = document.getElementById("logPathsBlock")?.getBoundingClientRect(); const rows = [...document.querySelectorAll("#logPathsList > div")]; const visible = rows.length > 0 && rows.every(row => { const rect = row.getBoundingClientRect(); const code = row.querySelector("code")?.getBoundingClientRect(); const button = row.querySelector("button")?.getBoundingClientRect(); return block && rect.right <= block.right + 1 && code && button && code.right <= button.left - 6 && button.right <= block.right + 1; }); return [rows.length, visible].join("|"); })()');
    check('Log file rows keep paths and buttons inside the Diagnose panel', logPathLayout === '5|true');

    await wc.executeJavaScript('document.querySelector("[data-settings-page=\\'remote\\']")?.click()');
    const remoteSettingsSpacing = await wc.executeJavaScript('(() => { const grid = document.querySelector("[data-subpage=remote] .settings-grid-mini")?.getBoundingClientRect(); const port = document.getElementById("remotePortInput")?.closest(".settings-row")?.getBoundingClientRect(); return grid && port ? Math.round(port.top - grid.bottom) : -1; })()');
    check('Remote settings keep space before Port', remoteSettingsSpacing >= 8);

    await wc.executeJavaScript('document.querySelector("[data-settings-page=\\'diagnose\\']")?.click()');
    const diagnoseSettingsSpacing = await wc.executeJavaScript('(() => { const grid = document.querySelector("[data-subpage=diagnose] .settings-grid-mini")?.getBoundingClientRect(); const port = document.getElementById("diagPortInput")?.closest(".settings-row")?.getBoundingClientRect(); return grid && port ? Math.round(port.top - grid.bottom) : -1; })()');
    check('Diagnose settings keep space before Port', diagnoseSettingsSpacing >= 8);
    const diagnosticsLoopbackContract = await wc.executeJavaScript('(() => { const page = document.querySelector("[data-subpage=diagnose]"); const text = page?.innerText || ""; return { hasMode: Boolean(document.getElementById("diagBindModeInput")), hasAllowlist: Boolean(document.getElementById("diagAllowlistInput")), address: document.getElementById("diagBindAddress")?.textContent?.trim(), hasTunnel: /Tunnel/.test(text), hasNetworkChoice: /0\.0\.0\.0|Im Netzwerk|Allowlist/.test(text) }; })()');
    check('Diagnostics exposes only fixed loopback access through a tunnel', diagnosticsLoopbackContract.hasMode === false && diagnosticsLoopbackContract.hasAllowlist === false && diagnosticsLoopbackContract.address === '127.0.0.1' && diagnosticsLoopbackContract.hasTunnel && diagnosticsLoopbackContract.hasNetworkChoice === false);

    let resolveStaleDiagnosticsSettings = null;
    ipcMain.removeHandler('diagnostics:get-settings');
    ipcMain.handle('diagnostics:get-settings', () => new Promise(resolve => { resolveStaleDiagnosticsSettings = resolve; }));
    await wc.executeJavaScript('renderSettings()');
    await waitUntil(() => resolveStaleDiagnosticsSettings);
    await wc.executeJavaScript('document.querySelector("[data-settings-page=diagnose]")?.click(); (() => { const input = document.getElementById("diagPortInput"); input.value = "9222"; input.dispatchEvent(new Event("input", { bubbles: true })); })()');
    resolveStaleDiagnosticsSettings({ enabled: true, port: 9110, bindMode: 'network', publicHost: 'diagnostics.example.test', allowlist: ['100.64.0.0/10'] });
    await new Promise(resolve => setTimeout(resolve, 80));
    const staleDiagnosticsState = await wc.executeJavaScript('(() => ({ port: document.getElementById("diagPortInput")?.value, enabled: document.getElementById("diagEnabledInput")?.checked, bindAddress: document.getElementById("diagBindAddress")?.textContent?.trim(), hasPublicHostControl: Boolean(document.getElementById("diagPublicHostInput")), hasModeControl: Boolean(document.getElementById("diagBindModeInput")), hasAllowlistControl: Boolean(document.getElementById("diagAllowlistInput")) }))()');
    check('A late legacy network response cannot restore non-loopback diagnostics controls', staleDiagnosticsState.port === '9222' && staleDiagnosticsState.enabled === true && staleDiagnosticsState.bindAddress === '127.0.0.1' && staleDiagnosticsState.hasPublicHostControl === false && staleDiagnosticsState.hasModeControl === false && staleDiagnosticsState.hasAllowlistControl === false);
    restoreInitialIpcHandler('diagnostics:get-settings');
    await wc.executeJavaScript('renderSettings(); document.querySelector("[data-settings-page=diagnose]")?.click()');
    await new Promise(resolve => setTimeout(resolve, 80));

    const diagnosticsDirtyTracking = await wc.executeJavaScript('(async () => { const original = await window.api.diagnosticsGetSettings(); const input = document.getElementById("diagPortInput"); establishSettingsBaseline(); input.value = String(original.port === 9223 ? 9224 : 9223); input.dispatchEvent(new Event("input", { bubbles: true })); const expectedPort = Number(input.value); const button = document.getElementById("saveSettingsBtn"); const enabled = button.disabled === false && button.classList.contains("btn-success"); if (enabled) await saveSettings({ feedbackText: "Gespeichert" }); const persisted = await window.api.diagnosticsGetSettings(); await saveDiagnosticsSettingsTracked({ ...original, bindMode: "local", publicHost: "127.0.0.1", allowlist: [] }); input.value = String(original.port || 9110); establishSettingsBaseline(); return { enabled, expectedPort, persisted }; })()');
    check('Diagnostics changes persist a loopback-only contract with the full settings form', diagnosticsDirtyTracking.enabled === true && diagnosticsDirtyTracking.persisted.port === diagnosticsDirtyTracking.expectedPort && diagnosticsDirtyTracking.persisted.publicHost === '127.0.0.1' && diagnosticsDirtyTracking.persisted.bindMode === 'local' && Array.isArray(diagnosticsDirtyTracking.persisted.allowlist) && diagnosticsDirtyTracking.persisted.allowlist.length === 0);

    await captureVisual('03-settings.png');

    await wc.executeJavaScript('document.querySelector("[data-settings-page=\\'uploads\\']")?.click()');
    const uploadSettingsState = await wc.executeJavaScript('(() => { const activePage = document.querySelector(".settings-subpage.active"); return [activePage?.dataset.subpage, activePage?.querySelector("h3")?.textContent.trim(), document.querySelector("label[for=removeFromQueueOnDoneInput]")?.textContent.trim(), document.getElementById("removeFromQueueOnDoneInput")?.closest(".settings-option")?.querySelector(".settings-option-description")?.textContent.trim()].join("|"); })()');
    check('Upload completion behavior is immediately findable', uploadSettingsState === 'uploads|Upload-Verhalten|Nach Abschluss aus der Liste entfernen|Erfolgreich hochgeladene Dateien verschwinden automatisch aus der Upload-Liste.');
    const filenameFilterControls = await wc.executeJavaScript('(() => ({ api: typeof window.FilenameFilter?.applyFilenameFilter, enabled: document.getElementById("filenameFilterEnabledInput")?.checked, action: document.getElementById("filenameFilterActionInput")?.value, match: document.getElementById("filenameFilterMatchModeInput")?.value, rows: document.querySelectorAll("[data-filename-filter-condition]").length, add: Boolean(document.getElementById("addFilenameFilterConditionBtn")) }))()');
    check('Filename filter starts disabled with a complete rule builder', filenameFilterControls.api === 'function' && filenameFilterControls.enabled === false && filenameFilterControls.action === 'include' && filenameFilterControls.match === 'all' && filenameFilterControls.rows === 1 && filenameFilterControls.add === true);
    const filenameFilterGeometry = await wc.executeJavaScript('(() => { const rect = selector => { const r = document.querySelector(selector)?.getBoundingClientRect(); return r ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height } : null; }; const valueLabel = rect("[data-filename-filter-value-label]"); const operatorLabel = rect("[data-filename-filter-operator-label]"); const value = rect("[data-filename-filter-value]"); const operator = rect("[data-filename-filter-operator]"); const remove = rect("[data-filename-filter-remove]"); const modeLabel = rect("label[for=filenameFilterMatchModeInput]"); const mode = rect("#filenameFilterMatchModeInput"); const actionLabel = rect("label[for=filenameFilterActionInput]"); const action = rect("#filenameFilterActionInput"); return { ruleLabelsAbove: valueLabel && operatorLabel && value && operator && valueLabel.bottom <= value.top - 4 && operatorLabel.bottom <= operator.top - 4, inputBeforeOperator: value && operator && value.left < operator.left, compactRule: value && operator && remove && operator.left - value.right >= 6 && operator.left - value.right <= 16 && remove.left - operator.right >= 6 && remove.left - operator.right <= 16, alignedRule: value && operator && remove && Math.abs(value.top - operator.top) <= 2 && Math.abs(operator.top - remove.top) <= 2 && Math.abs(value.height - operator.height) <= 2 && Math.abs(operator.height - remove.height) <= 2, policyBelowRule: value && mode && action && mode.top > value.bottom && action.top > value.bottom, policyOrder: mode && action && mode.left < action.left, policyLabelsAbove: modeLabel && mode && actionLabel && action && modeLabel.bottom <= mode.top - 4 && actionLabel.bottom <= action.top - 4, equalPolicyWidths: mode && action && Math.abs(mode.width - action.width) <= 2 }; })()');
    check('Filename filter follows value, comparison, conditions, then action', filenameFilterGeometry.ruleLabelsAbove && filenameFilterGeometry.inputBeforeOperator && filenameFilterGeometry.compactRule && filenameFilterGeometry.alignedRule && filenameFilterGeometry.policyBelowRule && filenameFilterGeometry.policyOrder && filenameFilterGeometry.policyLabelsAbove && filenameFilterGeometry.equalPolicyWidths);
    const filenameFilterPersistence = await wc.executeJavaScript('(async () => { const enabled = document.getElementById("filenameFilterEnabledInput"); enabled.checked = true; enabled.dispatchEvent(new Event("change", { bubbles: true })); const first = document.querySelector("[data-filename-filter-condition]"); first.querySelector("[data-filename-filter-operator]").value = "contains"; first.querySelector("[data-filename-filter-value]").value = "720p"; first.querySelector("[data-filename-filter-value]").dispatchEvent(new Event("input", { bubbles: true })); document.getElementById("addFilenameFilterConditionBtn").click(); const rows = [...document.querySelectorAll("[data-filename-filter-condition]")]; rows[1].querySelector("[data-filename-filter-operator]").value = "notContains"; rows[1].querySelector("[data-filename-filter-value]").value = "sample"; rows[1].querySelector("[data-filename-filter-value]").dispatchEvent(new Event("input", { bubbles: true })); const dirty = document.getElementById("saveSettingsBtn").disabled === false; await saveSettings({ feedbackText: "Gespeichert" }); const saved = (await window.api.getGlobalSettings()).filenameFilter; return { dirty, saved }; })()');
    check('Filename filter conditions participate in dirty tracking and persist canonically', filenameFilterPersistence.dirty === true && filenameFilterPersistence.saved?.enabled === true && filenameFilterPersistence.saved?.action === 'include' && filenameFilterPersistence.saved?.matchMode === 'all' && JSON.stringify(filenameFilterPersistence.saved?.conditions) === JSON.stringify([{ operator: 'contains', value: '720p' }, { operator: 'notContains', value: 'sample' }]));
    const importPreflightFolder = fs.mkdtempSync(path.join(app.getPath('temp'), 'mhu-import-preflight-'));
    const importPreflightFixtures = {
      existing: path.join(importPreflightFolder, 'Existing.720p.bin'),
      accepted: path.join(importPreflightFolder, 'Episode.720p.mkv'),
      large: path.join(importPreflightFolder, 'Large.720p.custom'),
      sample: path.join(importPreflightFolder, 'Episode.720p.Sample.mkv'),
      filtered: path.join(importPreflightFolder, 'Episode.1080p.mkv'),
      empty: path.join(importPreflightFolder, 'Empty.720p.bin'),
      missing: path.join(importPreflightFolder, 'Missing.720p.bin'),
      floatingAccepted: path.join(importPreflightFolder, 'Floating.720p.mkv'),
      floatingFiltered: path.join(importPreflightFolder, 'Floating.1080p.mkv'),
      desktopAccepted: path.join(importPreflightFolder, 'Desktop.720p.mkv'),
      desktopFiltered: path.join(importPreflightFolder, 'Desktop.1080p.mkv'),
      rejected: path.join(importPreflightFolder, 'Only.1080p.mkv')
    };
    for (const filePath of Object.values(importPreflightFixtures)) {
      if (filePath === importPreflightFixtures.missing) continue;
      fs.writeFileSync(filePath, filePath === importPreflightFixtures.empty ? Buffer.alloc(0) : Buffer.from('fixture'));
    }
    fs.writeFileSync(importPreflightFixtures.large, Buffer.alloc(2 * 1024 * 1024));
    const filenameFilterImport = await wc.executeJavaScript('(async () => { const fixtures = ' + JSON.stringify(importPreflightFixtures) + '; selectedFiles = [{ path: fixtures.existing, name: "Existing.720p.bin", size: 7 }]; _pendingFiles = []; _pendingImportInspection = null; queueJobs = []; rebuildJobIndex(); const available = getAvailableHosters().slice(0, 1).map(item => item.name); selectedUploadHosters = available; window.__importPreflightHosterSettings = hosterSettings; hosterSettings = { ...hosterSettings, [available[0]]: { ...(hosterSettings[available[0]] || {}), maxSizeMb: 1 } }; await addPathsToQueue([fixtures.existing, fixtures.accepted, fixtures.large, fixtures.sample, fixtures.filtered, fixtures.empty, fixtures.missing]); const read = () => Object.fromEntries(["Candidates", "Duplicates", "Filtered", "Unavailable", "Accepted", "Targets", "Jobs", "SizeLimited"].map(key => [key, Number(document.getElementById("importPlan" + key)?.textContent)])); const initial = read(); const inputs = [...document.querySelectorAll("input[data-hoster-modal]")]; inputs[0]?.click(); const reduced = read(); inputs[0]?.click(); const restored = read(); setUiLanguage("en"); const englishLabels = [...document.querySelectorAll("#importPlanSummary dt")].map(node => node.textContent.trim()); setUiLanguage("de"); return { modal: document.getElementById("hosterModal")?.style.display, description: document.getElementById("hosterModalDescription")?.textContent, pending: _pendingFiles.map(file => file.name).sort(), available, initial, reduced, restored, englishLabels }; })()');
    if (!(filenameFilterImport.modal === 'flex' && filenameFilterImport.available.length === 1 && filenameFilterImport.pending.join('|') === ['Episode.720p.mkv', 'Large.720p.custom'].sort().join('|') && JSON.stringify(filenameFilterImport.initial) === JSON.stringify({ Candidates: 7, Duplicates: 1, Filtered: 2, Unavailable: 2, Accepted: 2, Targets: 1, Jobs: 1, SizeLimited: 1 }) && JSON.stringify(filenameFilterImport.reduced) === JSON.stringify({ Candidates: 7, Duplicates: 1, Filtered: 2, Unavailable: 2, Accepted: 2, Targets: 0, Jobs: 0, SizeLimited: 0 }) && JSON.stringify(filenameFilterImport.restored) === JSON.stringify(filenameFilterImport.initial))) console.log('Import preflight state: ' + JSON.stringify(filenameFilterImport));
    check('Import preflight reports every exclusion and configured size-limit job exactly', filenameFilterImport.modal === 'flex' && filenameFilterImport.available.length === 1 && filenameFilterImport.pending.join('|') === ['Episode.720p.mkv', 'Large.720p.custom'].sort().join('|') && JSON.stringify(filenameFilterImport.initial) === JSON.stringify({ Candidates: 7, Duplicates: 1, Filtered: 2, Unavailable: 2, Accepted: 2, Targets: 1, Jobs: 1, SizeLimited: 1 }) && JSON.stringify(filenameFilterImport.reduced) === JSON.stringify({ Candidates: 7, Duplicates: 1, Filtered: 2, Unavailable: 2, Accepted: 2, Targets: 0, Jobs: 0, SizeLimited: 0 }) && JSON.stringify(filenameFilterImport.restored) === JSON.stringify(filenameFilterImport.initial));
    check('Import preflight copy switches completely to English without a restart', filenameFilterImport.englishLabels.join('|') === 'Candidates|Already present / duplicated|Excluded by filename filter|Missing / unreadable / empty|Accepted files|Selected destinations|Resulting jobs|Jobs omitted by configured size limits');
    const importPreflightBounds = win.getBounds();
    await setWindowBounds({ ...importPreflightBounds, width: 800, height: 550 });
    const importPreflightMinimumFit = await wc.executeJavaScript('(() => { const card = document.querySelector("#hosterModal .modal-card"); const summary = document.getElementById("importPlanSummary"); const cardRect = card?.getBoundingClientRect(); return Boolean(cardRect && summary && cardRect.left >= 0 && cardRect.right <= innerWidth && cardRect.top >= 0 && cardRect.bottom <= innerHeight && summary.scrollWidth <= summary.clientWidth + 1 && [...summary.querySelectorAll("dd")].every(value => value.getBoundingClientRect().width > 0)); })()');
    await setWindowBounds(importPreflightBounds);
    check('Import preflight remains contained and readable at the minimum window size', importPreflightMinimumFit === true);
    const importPreflightAdmission = await wc.executeJavaScript('(async () => { await applyHosterSelection(); return { selected: selectedFiles.map(file => file.name), jobs: queueJobs.map(job => ({ file: job.fileName, hoster: job.hoster, status: job.status })) }; })()');
    check('Configured size-limit pairs never create preview jobs and fully ineligible files leave no selected-file residue', importPreflightAdmission.selected.length === 2 && importPreflightAdmission.selected.includes('Existing.720p.bin') && importPreflightAdmission.selected.includes('Episode.720p.mkv') && !importPreflightAdmission.selected.includes('Large.720p.custom') && importPreflightAdmission.jobs.length === 2 && importPreflightAdmission.jobs.every(job => job.file !== 'Large.720p.custom' && job.hoster === filenameFilterImport.available[0] && job.status === 'preview'));
    const explicitEmptyHosterSelection = await wc.executeJavaScript('(async () => { const fixtures = ' + JSON.stringify(importPreflightFixtures) + '; cancelHosterModal(); selectedFiles = []; _pendingFiles = []; _pendingImportInspection = null; queueJobs = []; rebuildJobIndex(); selectedUploadHosters = getAvailableHosters().slice(0, 1).map(item => item.name); const inspect = entries => ({ candidateCount: entries.length, duplicateCount: 0, filteredCount: 0, unavailableCount: 0, acceptedCount: entries.length, accepted: entries.map(entry => ({ path: entry.path, name: entry.name, size: entry.size })), duplicates: [], filtered: [], unavailable: [] }); await coordinateImportEntries([{ path: fixtures.floatingAccepted, name: "Floating.720p.mkv", size: 7 }], async entries => inspect(entries)); const selected = document.querySelector("input[data-hoster-modal]:checked"); selected?.click(); let releaseSecond; const second = coordinateImportEntries([{ path: fixtures.desktopAccepted, name: "Desktop.720p.mkv", size: 7 }], async entries => new Promise(resolve => { releaseSecond = () => resolve(inspect(entries)); })); const disabledWhilePending = document.getElementById("confirmHosterModalBtn").disabled; for (let index = 0; index < 20 && !releaseSecond; index++) await Promise.resolve(); releaseSecond?.(); await second; return { disabledWhilePending, checked: [...document.querySelectorAll("input[data-hoster-modal]:checked")].map(input => input.dataset.hosterModal), targets: Number(document.getElementById("importPlanTargets").textContent) }; })()');
    check('A later inspection preserves an explicitly empty hoster selection and confirmation stays disabled while it is pending', explicitEmptyHosterSelection.disabledWhilePending === true && explicitEmptyHosterSelection.checked.length === 0 && explicitEmptyHosterSelection.targets === 0);
    const zeroDestinationImportGuard = await wc.executeJavaScript('(async () => { const snapshot = () => ({ pending: _pendingFiles.map(file => ({ path: file.path, name: file.name, size: file.size })), inspection: _pendingImportInspection ? JSON.parse(JSON.stringify(_pendingImportInspection)) : null, summary: getImportPlanSummary(), checked: [...document.querySelectorAll("input[data-hoster-modal]")].map(input => ({ hoster: input.dataset.hosterModal, checked: input.checked })), modal: document.getElementById("hosterModal")?.style.display, selected: selectedFiles.map(file => file.path), jobs: queueJobs.map(job => job.id) }); const disabled = document.getElementById("confirmHosterModalBtn").disabled; const before = snapshot(); const result = await applyHosterSelection(); const after = snapshot(); return { disabled, result, before, after }; })()');
    if (!(zeroDestinationImportGuard.disabled === true && zeroDestinationImportGuard.result === false && JSON.stringify(zeroDestinationImportGuard.after) === JSON.stringify(zeroDestinationImportGuard.before))) console.log('Zero destination import guard: ' + JSON.stringify(zeroDestinationImportGuard));
    check('Zero-destination import confirmation is disabled and direct invocation preserves the pending modal state', zeroDestinationImportGuard.disabled === true && zeroDestinationImportGuard.result === false && zeroDestinationImportGuard.before.summary?.jobCount === 0 && zeroDestinationImportGuard.before.summary?.targetCount === 0 && JSON.stringify(zeroDestinationImportGuard.after) === JSON.stringify(zeroDestinationImportGuard.before));
    const allSizeLimitedImportGuard = await wc.executeJavaScript('(async () => { const fixtures = ' + JSON.stringify(importPreflightFixtures) + '; cancelHosterModal(); selectedFiles = []; _pendingFiles = []; _pendingImportInspection = null; queueJobs = []; rebuildJobIndex(); const available = getAvailableHosters().slice(0, 1).map(item => item.name); selectedUploadHosters = available; hosterSettings = { ...hosterSettings, [available[0]]: { ...(hosterSettings[available[0]] || {}), maxSizeMb: 1 } }; await addPathsToQueue([fixtures.large]); const snapshot = () => ({ pending: _pendingFiles.map(file => ({ path: file.path, name: file.name, size: file.size })), inspection: _pendingImportInspection ? JSON.parse(JSON.stringify(_pendingImportInspection)) : null, summary: getImportPlanSummary(), checked: [...document.querySelectorAll("input[data-hoster-modal]")].map(input => ({ hoster: input.dataset.hosterModal, checked: input.checked })), modal: document.getElementById("hosterModal")?.style.display, selected: selectedFiles.map(file => file.path), jobs: queueJobs.map(job => job.id) }); const disabled = document.getElementById("confirmHosterModalBtn").disabled; const before = snapshot(); const result = await applyHosterSelection(); const after = snapshot(); return { disabled, result, before, after }; })()');
    if (!(allSizeLimitedImportGuard.disabled === true && allSizeLimitedImportGuard.result === false && JSON.stringify(allSizeLimitedImportGuard.after) === JSON.stringify(allSizeLimitedImportGuard.before))) console.log('All size-limited import guard: ' + JSON.stringify(allSizeLimitedImportGuard));
    check('Fully size-limited import confirmation is disabled and direct invocation preserves the pending modal state', allSizeLimitedImportGuard.disabled === true && allSizeLimitedImportGuard.result === false && allSizeLimitedImportGuard.before.summary?.jobCount === 0 && allSizeLimitedImportGuard.before.summary?.targetCount === 1 && allSizeLimitedImportGuard.before.summary?.sizeLimitedJobCount === 1 && JSON.stringify(allSizeLimitedImportGuard.after) === JSON.stringify(allSizeLimitedImportGuard.before));
    const cancelledImportGeneration = await wc.executeJavaScript('(async () => { const fixtures = ' + JSON.stringify(importPreflightFixtures) + '; cancelHosterModal(); selectedFiles = []; _pendingFiles = []; _pendingImportInspection = null; queueJobs = []; rebuildJobIndex(); selectedUploadHosters = getAvailableHosters().slice(0, 1).map(item => item.name); const result = entry => ({ candidateCount: 1, duplicateCount: 0, filteredCount: 0, unavailableCount: 0, acceptedCount: 1, accepted: [{ path: entry.path, name: entry.name, size: entry.size }], duplicates: [], filtered: [], unavailable: [] }); let runningCalls = 0; let queuedCalls = 0; let releaseRunning; const runningEntry = { path: fixtures.floatingAccepted, name: "Floating.720p.mkv", size: 7 }; const queuedEntry = { path: fixtures.desktopAccepted, name: "Desktop.720p.mkv", size: 7 }; const running = coordinateImportEntries([runningEntry], async () => { runningCalls++; return new Promise(resolve => { releaseRunning = () => resolve(result(runningEntry)); }); }); for (let index = 0; index < 20 && !releaseRunning; index++) await Promise.resolve(); const queued = coordinateImportEntries([queuedEntry], async () => { queuedCalls++; return result(queuedEntry); }); const disabledWhilePending = document.getElementById("confirmHosterModalBtn").disabled; cancelHosterModal(); releaseRunning?.(); await Promise.all([running, queued]); await new Promise(resolve => setTimeout(resolve, 25)); return { runningCalls, queuedCalls, disabledWhilePending, modal: document.getElementById("hosterModal").style.display, pending: _pendingFiles.length, inspection: _pendingImportInspection }; })()');
    check('Cancelling invalidates running and queued results from the old import generation', cancelledImportGeneration.runningCalls === 1 && cancelledImportGeneration.queuedCalls === 0 && cancelledImportGeneration.disabledWhilePending === true && cancelledImportGeneration.modal !== 'flex' && cancelledImportGeneration.pending === 0 && cancelledImportGeneration.inspection === null);
    const filenameFilterDropPaths = await wc.executeJavaScript('(async () => { const fixtures = ' + JSON.stringify(importPreflightFixtures) + '; cancelHosterModal(); await addDropTargetEntries([{ path: fixtures.floatingAccepted }, { path: fixtures.floatingFiltered }]); const floating = _pendingFiles.map(file => file.name); cancelHosterModal(); await addDroppedFiles([{ path: fixtures.desktopAccepted, name: "Desktop.720p.mkv", size: 7, type: "video/x-matroska" }, { path: fixtures.desktopFiltered, name: "Desktop.1080p.mkv", size: 7, type: "video/x-matroska" }]); const desktop = _pendingFiles.map(file => file.name); cancelHosterModal(); return { floating, desktop }; })()');
    check('Filename filter applies identically to floating and native desktop drops', JSON.stringify(filenameFilterDropPaths.floating) === JSON.stringify(['Floating.720p.mkv']) && JSON.stringify(filenameFilterDropPaths.desktop) === JSON.stringify(['Desktop.720p.mkv']));
    await wc.executeJavaScript('(() => { selectedFiles = []; _pendingFiles = []; queueJobs = []; rebuildJobIndex(); const toast = document.getElementById("copyToast"); toast.textContent = ""; toast.classList.remove("show"); config.globalSettings.folderMonitor = { ...(config.globalSettings.folderMonitor || {}), hosters: ["voe.sx"], autoStart: false }; })()');
    wc.send('folder-monitor:new-files', ['C:/filter/Watched.720p.mkv', 'C:/filter/Watched.1080p.mkv']);
    await waitUntil(() => wc.executeJavaScript('selectedFiles.length === 1'));
    const filenameFilterFolderMonitor = await wc.executeJavaScript('(() => ({ files: selectedFiles.map(file => file.name), jobs: queueJobs.map(job => job.fileName), modal: document.getElementById("hosterModal")?.style.display, toast: document.getElementById("copyToast")?.textContent }))()');
    check('Filename filter also applies to monitored folders with preset destinations', JSON.stringify(filenameFilterFolderMonitor.files) === JSON.stringify(['Watched.720p.mkv']) && filenameFilterFolderMonitor.jobs.every(name => name === 'Watched.720p.mkv') && filenameFilterFolderMonitor.modal !== 'flex' && /1 von 2/.test(filenameFilterFolderMonitor.toast || ''));
    await wc.executeJavaScript('selectedFiles = []; queueJobs = []; rebuildJobIndex(); updateUploadView()');
    const filenameFilterRejectAll = await wc.executeJavaScript('(async () => { const rejected = ' + JSON.stringify(importPreflightFixtures.rejected) + '; cancelHosterModal(); const toast = document.getElementById("copyToast"); toast.textContent = ""; toast.classList.remove("show"); const action = document.getElementById("filenameFilterActionInput"); action.value = "exclude"; action.dispatchEvent(new Event("change", { bubbles: true })); const rows = [...document.querySelectorAll("[data-filename-filter-condition]")]; rows[0].querySelector("[data-filename-filter-value]").value = "1080p"; rows[0].querySelector("[data-filename-filter-value]").dispatchEvent(new Event("input", { bubbles: true })); rows.slice(1).forEach(row => row.querySelector("[data-filename-filter-remove]")?.click()); config.globalSettings.filenameFilter = readFilenameFilterSettings(); await addPathsToQueue([{ path: rejected, name: "Only.1080p.mkv", size: 7 }]); const german = toast.textContent; setUiLanguage("en"); toast.textContent = ""; toast.classList.remove("show"); await addPathsToQueue([{ path: rejected, name: "Only.1080p.mkv", size: 7 }]); const english = toast.textContent; setUiLanguage("de"); return { modal: document.getElementById("hosterModal")?.style.display, pending: _pendingFiles.length, german, english, shown: toast.classList.contains("show") }; })()');
    check('A fully excluded import stays out of the queue and keeps an exact bilingual balance visible', filenameFilterRejectAll.modal !== 'flex' && filenameFilterRejectAll.pending === 0 && filenameFilterRejectAll.shown === true && filenameFilterRejectAll.german === 'Kandidaten: 1 · Bereits vorhanden / dupliziert: 0 · Durch Dateinamenfilter ausgeschlossen: 1 · Fehlend / unlesbar / leer: 0 · Akzeptierte Dateien: 0' && filenameFilterRejectAll.english === 'Candidates: 1 · Already present / duplicated: 0 · Excluded by filename filter: 1 · Missing / unreadable / empty: 0 · Accepted files: 0');
    await wc.executeJavaScript('hosterSettings = window.__importPreflightHosterSettings; delete window.__importPreflightHosterSettings; true');
    fs.rmSync(importPreflightFolder, { recursive: true, force: true });
    await wc.executeJavaScript('(() => { const enabled = document.getElementById("filenameFilterEnabledInput"); enabled.checked = false; enabled.dispatchEvent(new Event("change", { bubbles: true })); return saveSettings({ feedbackText: "Gespeichert" }); })()');
    const plaintextCredentialOverride = await wc.executeJavaScript('(() => ({ control: document.getElementById("allowPlaintextCredentialStorageInput"), copy: document.body.textContent.includes("Unsichere Klartext-Speicherung"), bridge: typeof window.api.getSecretStoreStatus }))()');
    check('Settings expose no plaintext credential storage override', plaintextCredentialOverride.control === null && plaintextCredentialOverride.copy === false && plaintextCredentialOverride.bridge === 'undefined');
    const settingsTypography = await wc.executeJavaScript('(() => { const size = selector => parseFloat(getComputedStyle(document.querySelector(selector)).fontSize); return { heading: size(".settings-subpage.active .settings-page-header h3"), intro: size(".settings-subpage.active .settings-page-header p"), section: size(".settings-subpage.active .settings-section-label"), rowLabel: size(".settings-subpage.active .settings-row > label"), hint: size(".settings-subpage.active .hint"), optionLabel: size(".settings-subpage.active .settings-option-copy label"), optionDescription: size(".settings-subpage.active .settings-option-description"), navigation: size(".settings-nav-button"), search: size("#settingsSearchInput") }; })()');
    check('Settings use the enlarged readable typography scale', settingsTypography.heading >= 22 && settingsTypography.intro >= 14 && settingsTypography.section >= 12 && settingsTypography.rowLabel >= 14 && settingsTypography.hint >= 12 && settingsTypography.optionLabel >= 14 && settingsTypography.optionDescription >= 12 && settingsTypography.navigation >= 13 && settingsTypography.search >= 11);
    const settingsSelection = await wc.executeJavaScript('(() => ({ heading: getComputedStyle(document.querySelector(".settings-subpage.active .settings-page-header h3")).userSelect, hint: getComputedStyle(document.querySelector(".settings-subpage.active .hint")).userSelect, input: getComputedStyle(document.getElementById("globalMaxSpeedMbsInput")).userSelect }))()');
    check('Settings interface copy cannot be selected while input values remain selectable', settingsSelection.heading === 'none' && settingsSelection.hint === 'none' && settingsSelection.input === 'text');
    const enlargedSettingsFit = await wc.executeJavaScript('(() => { const results = [...document.querySelectorAll(".settings-nav-button")].map(button => { button.click(); const page = document.querySelector(".settings-subpage.active"); return Boolean(page && page.scrollWidth <= page.clientWidth + 1); }); document.querySelector("[data-settings-page=uploads]")?.click(); return results.every(Boolean); })()');
    check('Enlarged settings pages stay horizontally contained', enlargedSettingsFit === true);
    const sourceDeleteWarning = await wc.executeJavaScript('(() => { const option = document.querySelector(".source-delete-option"); const style = option && getComputedStyle(option); if (!style) return { visible: false }; const channels = style.borderTopColor.match(/[0-9.]+/g)?.map(Number) || []; return { visible: style.borderTopStyle === "solid" && parseFloat(style.borderTopWidth) >= 1, red: channels.length >= 3 && channels[0] > channels[1] * 1.25 && channels[0] > channels[2] * 1.15 }; })()');
    check('Permanent source deletion is visibly framed as a danger setting', sourceDeleteWarning.visible && sourceDeleteWarning.red);
    const sourceDeleteSafety = await wc.executeJavaScript('(async () => { const input = document.getElementById("deleteSourceAfterSuccessfulUploadInput"); const initial = input.checked; input.click(); await new Promise(resolve => setTimeout(resolve, 25)); const dialog = document.getElementById("appAlertModal"); const visible = dialog.style.display === "flex"; const danger = document.getElementById("appAlertConfirmBtn").classList.contains("btn-danger"); document.getElementById("appAlertCancelBtn").click(); await new Promise(resolve => setTimeout(resolve, 25)); return { initial, visible, danger, cancelled: input.checked === false }; })()');
    check('Permanent source deletion defaults off and requires a danger confirmation', sourceDeleteSafety.initial === false && sourceDeleteSafety.visible && sourceDeleteSafety.danger && sourceDeleteSafety.cancelled);
    const sourceDeletePersistence = await wc.executeJavaScript('(async () => { const input = document.getElementById("deleteSourceAfterSuccessfulUploadInput"); input.click(); await new Promise(resolve => setTimeout(resolve, 25)); document.getElementById("appAlertConfirmBtn").click(); await new Promise(resolve => setTimeout(resolve, 25)); const dirty = document.getElementById("saveSettingsBtn").disabled === false; await saveSettings({ feedbackText: "Gespeichert" }); const enabled = (await window.api.getGlobalSettings()).deleteSourceAfterSuccessfulUpload === true; input.checked = false; input.dispatchEvent(new Event("change", { bubbles: true })); await saveSettings({ feedbackText: "Gespeichert" }); const restored = (await window.api.getGlobalSettings()).deleteSourceAfterSuccessfulUpload === false; return { dirty, enabled, restored }; })()');
    check('Confirmed source deletion persists and can be safely disabled again', sourceDeletePersistence.dirty && sourceDeletePersistence.enabled && sourceDeletePersistence.restored);

    const settingsReadingWidth = await wc.executeJavaScript('(() => { const activePage = document.querySelector(".settings-subpage.active"); if (!activePage) return 0; return activePage.getBoundingClientRect().width; })()');
    check('Active settings page keeps a readable content width', settingsReadingWidth > 0 && settingsReadingWidth <= 820);

    const settingsFrameFit = await wc.executeJavaScript('(() => { const view = document.getElementById("settings-view")?.getBoundingClientRect(); return Boolean(view && view.bottom <= window.innerHeight + 1); })()');
    check('Settings view fits inside the viewport', settingsFrameFit === true);

    if (process.env.MHU_SETTINGS_SCREENSHOT) {
      const screenshotPage = process.env.MHU_SETTINGS_SCREENSHOT_PAGE;
      if (screenshotPage) await wc.executeJavaScript('document.querySelector("[data-settings-page=" + ' + JSON.stringify(screenshotPage) + ' + "]")?.click()');
      await new Promise(resolve => setTimeout(resolve, 150));
      const screenshot = await wc.capturePage();
      fs.writeFileSync(process.env.MHU_SETTINGS_SCREENSHOT, screenshot.toPNG());
    }

    const settingsSearchState = await wc.executeJavaScript('(() => { const search = document.getElementById("settingsSearchInput"); if (!search) return "missing"; search.value = "fertig"; search.dispatchEvent(new Event("input", { bubbles: true })); const visible = [...document.querySelectorAll(".settings-nav-button")].filter(button => !button.hidden); return [visible.map(button => button.dataset.settingsPage).join(","), document.querySelector(".settings-nav-button.active")?.dataset.settingsPage].join("|"); })()');
    check('Settings search routes completion terms to Uploads first', settingsSearchState === 'uploads,benachrichtigungen|uploads');

    const settingsSearchRecovery = await wc.executeJavaScript('(() => { const search = document.getElementById("settingsSearchInput"); search.value = "kein-passender-treffer"; search.dispatchEvent(new Event("input", { bubbles: true })); const emptyVisible = !document.getElementById("settingsSearchEmpty").hidden; search.value = ""; search.dispatchEvent(new Event("input", { bubbles: true })); return [emptyVisible, document.querySelector(".settings-subpage.active")?.dataset.subpage, document.getElementById("settingsSearchEmpty").hidden].join("|"); })()');
    check('Clearing an empty settings search restores the current page', settingsSearchRecovery === 'true|uploads|true');

    const filteredOnlineRestoreNavigation = await wc.executeJavaScript('(() => { const search = document.getElementById("settingsSearchInput"); search.value = "fertig"; search.dispatchEvent(new Event("input", { bubbles: true })); _handleMenuAction("online-backup-restore"); return [search.value, document.querySelector(".settings-nav-button.active")?.dataset.settingsPage, document.activeElement?.id].join("|"); })()');
    check('Online restore navigation clears filters and opens Backup', filteredOnlineRestoreNavigation === '|backup|onlineBackupKeyInput');

    const accountSettingsPointer = await wc.executeJavaScript('document.querySelector(".settings-hoster-pointer")?.textContent');
    check('Hoster settings point to Accounts tab', accountSettingsPointer && accountSettingsPointer.includes('Accounts'));

    const parallel = await wc.executeJavaScript('document.getElementById("parallelUploadCountInput")?.value');
    check('Global parallel uploads default 0', parallel === '0');

    await wc.executeJavaScript('document.querySelector("[data-settings-page=\\'backup\\']")?.click()');
    const onlineBackupControls = await wc.executeJavaScript('["createOnlineBackupBtn", "onlineBackupKeyOutput", "copyOnlineBackupKeyBtn", "onlineBackupKeyInput", "restoreOnlineBackupBtn", "onlineBackupStatus"].every(id => Boolean(document.getElementById(id)))');
    check('Online backup controls exist', onlineBackupControls);

    const onlineBackupKeyContract = await wc.executeJavaScript('document.getElementById("onlineBackupKeyInput")?.maxLength + "|" + document.getElementById("onlineBackupKeyInput")?.getAttribute("pattern")');
    check('Online backup input enforces the 75-character MHU key format', onlineBackupKeyContract === '75|MHU2-[A-Za-z0-9_-]{70}');

    const onlineBackupBridge = await wc.executeJavaScript('typeof window.api.createOnlineBackup + "|" + typeof window.api.restoreOnlineBackup');
    check('Online backup uses a narrow preload bridge', onlineBackupBridge === 'function|function');

    const invalidOnlineBackup = await wc.executeJavaScript('document.getElementById("onlineBackupKeyInput").value = "MHU2-short"; document.getElementById("onlineBackupKeyInput").dispatchEvent(new Event("input", { bubbles: true })); document.getElementById("restoreOnlineBackupBtn").disabled + "|" + document.getElementById("onlineBackupStatus").textContent');
    check('Invalid online backup keys stay blocked with visible guidance', invalidOnlineBackup === 'true|Der Schlüssel muss exakt 75 Zeichen lang sein.');

    const validOnlineBackup = await wc.executeJavaScript('document.getElementById("onlineBackupKeyInput").value = "MHU2-" + "A".repeat(70); document.getElementById("onlineBackupKeyInput").dispatchEvent(new Event("input", { bubbles: true })); document.getElementById("restoreOnlineBackupBtn").disabled');
    check('Valid 75-character online backup keys enable restore', validOnlineBackup === false);

    const onlineRestoreNavigation = await wc.executeJavaScript('_handleMenuAction("online-backup-restore"); document.activeElement?.id + "|" + document.querySelector(".settings-nav-button.active")?.dataset.settingsPage');
    check('Online restore menu opens the backup page and focuses the key', onlineRestoreNavigation === 'onlineBackupKeyInput|backup');

    // Test save
    await wc.executeJavaScript('document.getElementById("alwaysOnTopInput").click(); document.getElementById("saveSettingsBtn").click()');
    let feedback = '';
    for (let attempt = 0; attempt < 50; attempt++) {
      feedback = await wc.executeJavaScript('document.getElementById("saveFeedback")?.textContent');
      if (feedback === 'Gespeichert!') break;
      await new Promise(r => setTimeout(r, 50));
    }
    check('Save shows Gespeichert!', feedback === 'Gespeichert!');
    check('Always-on-top settings never affect the native UI smoke window', hiddenWindowHarness.isAlwaysOnTopRequested(win) === true && hiddenWindowHarness.isNativeSurfaceSuppressed(win));

    const originalShowSaveDialog = dialog.showSaveDialog;
    const originalShowOpenDialog = dialog.showOpenDialog;
    const selectedBrowseDirectory = path.join(app.getPath('userData'), 'selected-upload-directory');
    const selectedBrowseFile = path.join(selectedBrowseDirectory, 'video.mp4');
    fs.mkdirSync(selectedBrowseDirectory, { recursive: true });
    fs.writeFileSync(selectedBrowseFile, 'video', 'utf-8');
    const browseDialogStarts = [];
    dialog.showOpenDialog = async (_window, options) => {
      browseDialogStarts.push(options.defaultPath);
      return browseDialogStarts.length === 1
        ? { canceled: false, filePaths: [selectedBrowseFile] }
        : { canceled: true, filePaths: [] };
    };
    const selectedBrowseFiles = await wc.executeJavaScript('window.api.selectFiles()');
    const canceledBrowseFiles = await wc.executeJavaScript('window.api.selectFiles()');
    const persistedBrowseDirectory = (await wc.executeJavaScript('window.api.getConfig()')).globalSettings.lastBrowseDirectory;
    check('File picker starts in Downloads and reopens in the last selected directory', browseDialogStarts[0] === app.getPath('downloads') && browseDialogStarts[1] === selectedBrowseDirectory && selectedBrowseFiles?.[0] === selectedBrowseFile && canceledBrowseFiles === null && persistedBrowseDirectory === selectedBrowseDirectory);
    dialog.showOpenDialog = originalShowOpenDialog;
    try { fs.rmSync(selectedBrowseDirectory, { recursive: true, force: true }); } catch {}
    const exportRacePath = path.join(app.getPath('userData'), 'ui-export-race.json');
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: exportRacePath });
    const exportRaceConfig = await wc.executeJavaScript('window.api.getConfig()');
    const exportRaceSettings = { ...(exportRaceConfig.globalSettings || {}), webhookUrl: 'https://export-race.invalid/current' };
    blockedWriteMarker = 'https://export-race.invalid/current';
    blockedWriteStarted = false;
    releaseBlockedWrite = null;
    const delayedExportSave = wc.executeJavaScript('window.api.saveGlobalSettings(' + JSON.stringify(exportRaceSettings) + ')');
    for (let attempt = 0; attempt < 100 && !blockedWriteStarted; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    let exportSettled = false;
    const pendingFileExport = wc.executeJavaScript('window.api.exportBackup()').then(result => { exportSettled = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 80));
    const exportSettledBeforeWrite = exportSettled;
    releaseBlockedWrite?.();
    const [exportSaveResult, exportResult] = await Promise.all([delayedExportSave, pendingFileExport]);
    const exportedRaceConfig = JSON.parse(fs.readFileSync(exportRacePath, 'utf-8'));
    check('File backup waits for the ConfigStore write queue', exportSaveResult === true && exportResult?.ok === true && exportSettledBeforeWrite === false && exportedRaceConfig.globalSettings.webhookUrl === 'https://export-race.invalid/current');
    blockedWriteMarker = '';
    try { fs.unlinkSync(exportRacePath); } catch {}

    const historyExportRacePath = path.join(app.getPath('userData'), 'ui-history-export-race.json');
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: historyExportRacePath });
    activeConfigStore._historyMigrated = true;
    fs.writeFileSync(activeConfigStore.historyPath, '[]', 'utf-8');
    blockedHistoryWriteMarker = 'ui-history-export-race';
    blockedHistoryWriteStarted = false;
    releaseBlockedHistoryWrite = null;
    const delayedHistoryExportWrite = activeConfigStore.appendHistory({ id: 'ui-history-export-race', files: [] });
    for (let attempt = 0; attempt < 100 && !blockedHistoryWriteStarted; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    let historyExportSettled = false;
    const pendingHistoryExport = wc.executeJavaScript('window.api.exportBackup()').then(result => { historyExportSettled = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 80));
    const historyExportSettledBeforeWrite = historyExportSettled;
    releaseBlockedHistoryWrite?.();
    const [historyExportWriteResult, historyExportResult] = await Promise.all([delayedHistoryExportWrite.then(() => true), pendingHistoryExport]);
    check('File backup waits for the ConfigStore history queue', historyExportWriteResult === true && historyExportResult?.ok === true && historyExportSettledBeforeWrite === false);
    blockedHistoryWriteMarker = '';
    try { fs.unlinkSync(historyExportRacePath); } catch {}

    const importRaceConfig = await wc.executeJavaScript('window.api.getConfig()');
    for (const hoster of Object.keys(importRaceConfig.hosters || {})) importRaceConfig.hosters[hoster] = [];
    importRaceConfig.hosters['byse.sx'] = [{ id: 'ui-imported-race-account', enabled: true, authType: 'api', apiKey: 'ui-imported-key' }];
    importRaceConfig.globalSettings = { ...(importRaceConfig.globalSettings || {}), alwaysOnTop: false, webhookUrl: 'https://import-race.invalid/imported' };
    const importRacePath = path.join(app.getPath('userData'), 'ui-import-race.json');
    fs.writeFileSync(importRacePath, JSON.stringify(importRaceConfig), 'utf-8');
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [importRacePath] });
    blockedHistoryWriteMarker = 'ui-history-import-race';
    blockedHistoryWriteStarted = false;
    releaseBlockedHistoryWrite = null;
    const delayedHistoryImportWrite = activeConfigStore.appendHistory({ id: 'ui-history-import-race', files: [] });
    for (let attempt = 0; attempt < 100 && !blockedHistoryWriteStarted; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    blockedWriteMarker = 'ui-imported-race-account';
    blockedWriteStarted = false;
    releaseBlockedWrite = null;
    const pendingImport = wc.executeJavaScript('window.api.importBackup()');
    await new Promise(resolve => setTimeout(resolve, 80));
    const importStartedBeforeHistoryWrite = blockedWriteStarted;
    releaseBlockedHistoryWrite?.();
    await delayedHistoryImportWrite;
    for (let attempt = 0; attempt < 100 && !blockedWriteStarted; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    const dryRunPruneResult = await wc.executeJavaScript('window.api.pruneHistory("all", { dryRun: true }).then(() => ({ ok: true }), error => ({ ok: false, error: error.message }))');
    const staleSettings = { ...(importRaceConfig.globalSettings || {}), alwaysOnTop: true, webhookUrl: 'https://import-race.invalid/stale' };
    const staleSave = wc.executeJavaScript('window.api.saveGlobalSettings(' + JSON.stringify(staleSettings) + ').then(() => ({ ok: true }), error => ({ ok: false, error: error.message }))');
    const stalePrune = wc.executeJavaScript('window.api.pruneHistory("all").then(() => ({ ok: true }), error => ({ ok: false, error: error.message }))');
    await new Promise(resolve => setTimeout(resolve, 80));
    releaseBlockedWrite?.();
    const [importResult, staleSaveResult, stalePruneResult] = await Promise.all([pendingImport, staleSave, stalePrune]);
    const configAfterImportRace = await wc.executeJavaScript('window.api.getConfig()');
    check('Import drains the ConfigStore history queue before replacement', importStartedBeforeHistoryWrite === false && importResult?.ok === true);
    check('Import allows dry history previews but rejects mutating prune calls', dryRunPruneResult?.ok === true && stalePruneResult?.ok === false);
    check('Import rejects stale config saves for the complete transition', staleSaveResult?.ok === false && configAfterImportRace.hosters['byse.sx']?.[0]?.id === 'ui-imported-race-account' && configAfterImportRace.globalSettings.alwaysOnTop === false && configAfterImportRace.globalSettings.webhookUrl === 'https://import-race.invalid/imported');

    blockedWriteMarker = '';
    blockedHistoryWriteMarker = '';
    const importEpochWrites = await wc.executeJavaScript(\`(async () => {
      beginConfigImport();
      let releaseB;
      const barrier = new Promise(resolve => { releaseB = resolve; });
      const base = { ...(config.globalSettings || {}) };
      const first = saveGlobalSettingsTracked({ ...base, webhookUrl: 'https://import-epoch.invalid/a' }).then(() => ({ ok: true }), error => ({ ok: false, code: error.code }));
      const between = enqueueConfigWriteOperation(() => barrier).promise;
      const second = saveGlobalSettingsTracked({ ...base, webhookUrl: 'https://import-epoch.invalid/b' }).then(() => ({ ok: true }), error => ({ ok: false, code: error.code }));
      const firstResult = await first;
      endConfigImport();
      releaseB();
      await between;
      const secondResult = await second;
      return { firstResult, secondResult, gateOpen: configImportInProgress === false };
    })()\`);
    check('Import epoch rejects queued writes even when the gate ends between them', importEpochWrites.firstResult?.code === 'CONFIG_WRITE_SUPERSEDED' && importEpochWrites.secondResult?.code === 'CONFIG_WRITE_SUPERSEDED' && importEpochWrites.gateOpen === true);

    const importEpochConfig = structuredClone(configAfterImportRace);
    for (const hoster of Object.keys(importEpochConfig.hosters || {})) importEpochConfig.hosters[hoster] = [];
    importEpochConfig.hosters['byse.sx'] = [{ id: 'ui-import-epoch-account', enabled: true, authType: 'api', apiKey: 'ui-import-epoch-key' }];
    importEpochConfig.globalSettings = { ...(importEpochConfig.globalSettings || {}), webhookUrl: 'https://import-epoch.invalid/imported' };
    const importEpochPath = path.join(app.getPath('userData'), 'ui-import-epoch.json');
    fs.writeFileSync(importEpochPath, JSON.stringify(importEpochConfig), 'utf-8');
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [importEpochPath] });
    blockedWriteMarker = 'ui-import-epoch-account';
    blockedWriteStarted = false;
    releaseBlockedWrite = null;
    const initialPendingQueueHandler = initialIpcHandlers.get('save-pending-queue');
    let finalImportQueueStarted = false;
    let releaseFinalImportQueue = null;
    ipcMain.removeHandler('save-pending-queue');
    ipcMain.handle('save-pending-queue', (event, pendingQueue) => {
      if (!finalImportQueueStarted) {
        finalImportQueueStarted = true;
        return new Promise((resolve, reject) => {
          releaseFinalImportQueue = () => Promise.resolve(initialPendingQueueHandler(event, pendingQueue)).then(resolve, reject);
        });
      }
      return initialPendingQueueHandler(event, pendingQueue);
    });
    const pendingImportEpoch = wc.executeJavaScript('doBackupImport()');
    for (let attempt = 0; attempt < 100 && !blockedWriteStarted; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    releaseBlockedWrite?.();
    for (let attempt = 0; attempt < 100 && !finalImportQueueStarted; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    const importStateDuringFinalQueuePersist = await wc.executeJavaScript('({ gateClosed: configImportInProgress, webhookUrl: config.globalSettings.webhookUrl, accountId: config.hosters["byse.sx"]?.[0]?.id })');
    const staleImportWriteStart = await wc.executeJavaScript('(() => { const settings = saveGlobalSettingsTracked({ ...(config.globalSettings || {}), webhookUrl: "https://import-epoch.invalid/stale-after-commit" }).then(() => ({ ok: true }), error => ({ ok: false, code: error.code })); const accounts = saveConfigTracked({ hosters: { ...(config.hosters || {}), "byse.sx": [{ id: "ui-stale-account", enabled: true, authType: "api", apiKey: "stale" }] } }).then(() => ({ ok: true }), error => ({ ok: false, code: error.code })); window.__uiStaleImportWrites = Promise.all([settings, accounts]); return { gateClosed: configImportInProgress }; })()');
    releaseFinalImportQueue?.();
    const [staleImportSettingsResult, staleImportAccountsResult] = await wc.executeJavaScript('window.__uiStaleImportWrites.then(results => { delete window.__uiStaleImportWrites; return results; })');
    await pendingImportEpoch;
    const configAfterImportEpoch = await wc.executeJavaScript('window.api.getConfig()');
    check('Import keeps its gate closed through apply and final queue persistence', importStateDuringFinalQueuePersist.gateClosed === true && importStateDuringFinalQueuePersist.webhookUrl === 'https://import-epoch.invalid/imported' && importStateDuringFinalQueuePersist.accountId === 'ui-import-epoch-account');
    check('Import rejects stale settings and account writes until the full transition finishes', staleImportWriteStart.gateClosed === true && staleImportSettingsResult.code === 'CONFIG_WRITE_SUPERSEDED' && staleImportAccountsResult.code === 'CONFIG_WRITE_SUPERSEDED' && configAfterImportEpoch.hosters['byse.sx']?.[0]?.id === 'ui-import-epoch-account' && configAfterImportEpoch.globalSettings.webhookUrl === 'https://import-epoch.invalid/imported');

    restoreInitialIpcHandler('save-pending-queue');
    const importPersistFailureConfig = structuredClone(configAfterImportEpoch);
    importPersistFailureConfig.globalSettings = { ...(importPersistFailureConfig.globalSettings || {}), webhookUrl: 'https://import-persist-failure.invalid/imported' };
    const importPersistFailurePath = path.join(app.getPath('userData'), 'ui-import-persist-failure.json');
    fs.writeFileSync(importPersistFailurePath, JSON.stringify(importPersistFailureConfig), 'utf-8');
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [importPersistFailurePath] });
    let importQueueFailureAttempts = 0;
    ipcMain.removeHandler('save-pending-queue');
    ipcMain.handle('save-pending-queue', (event, pendingQueue) => {
      importQueueFailureAttempts++;
      if (importQueueFailureAttempts === 1) throw new Error('final queue persistence failed');
      return initialPendingQueueHandler(event, pendingQueue);
    });
    await wc.executeJavaScript('doBackupImport()');
    const importAfterQueueFailure = await wc.executeJavaScript('({ webhookUrl: config.globalSettings.webhookUrl, gateOpen: configImportInProgress === false, toast: document.getElementById("copyToast")?.textContent || "" })');
    await wc.executeJavaScript('flushConfigWrites()');
    check('Committed import remains applied when final queue persistence fails', importAfterQueueFailure.webhookUrl === 'https://import-persist-failure.invalid/imported' && importAfterQueueFailure.gateOpen === true && importAfterQueueFailure.toast.includes('Warteschlange') && importQueueFailureAttempts >= 2);
    restoreInitialIpcHandler('save-pending-queue');

    blockedWriteMarker = '';
    blockedHistoryWriteMarker = '';
    dialog.showSaveDialog = originalShowSaveDialog;
    dialog.showOpenDialog = originalShowOpenDialog;
    try { fs.unlinkSync(importRacePath); } catch {}
    try { fs.unlinkSync(importEpochPath); } catch {}
    try { fs.unlinkSync(importPersistFailurePath); } catch {}

    const occupiedRemotePortServer = net.createServer();
    await listenOnLoopback(occupiedRemotePortServer);
    const occupiedRemoteBindAddress = occupiedRemotePortServer.address().address;
    const occupiedRemotePort = occupiedRemotePortServer.address().port;
    const configBeforeRemoteFailure = JSON.parse(fs.readFileSync(activeConfigStore.filePath, 'utf-8'));
    const alwaysOnTopAfterRemoteFailure = !Boolean(configBeforeRemoteFailure.globalSettings.alwaysOnTop);
    const occupiedRemoteSettings = {
      ...(configBeforeRemoteFailure.globalSettings.remote || {}),
      enabled: true,
      allowInput: true,
      port: occupiedRemotePort,
      token: 'ui-occupied-port-token'
    };
    const remoteSaveOutcome = await wc.executeJavaScript('saveRemoteSettingsTracked(' + JSON.stringify(occupiedRemoteSettings) + ').then(value => ({ resolved: true, value }), error => ({ resolved: false, error: error.message }))');
    const configAfterRemoteFailure = JSON.parse(fs.readFileSync(activeConfigStore.filePath, 'utf-8'));
    const followUpRemoteWrite = await wc.executeJavaScript('setAlwaysOnTopTracked(' + JSON.stringify(alwaysOnTopAfterRemoteFailure) + ').then(() => ({ ok: true }), error => ({ ok: false, error: error.message }))');
    const configAfterRemoteFollowUp = JSON.parse(fs.readFileSync(activeConfigStore.filePath, 'utf-8'));
    const reportedRemoteRuntimeFailure = remoteSaveOutcome.resolved === true
      && remoteSaveOutcome.value?.saved === true
      && typeof remoteSaveOutcome.value.runtimeError === 'string'
      && remoteSaveOutcome.value.runtimeError.length > 0;
    check('Remote runtime activation failure preserves settings without poisoning later writes', configAfterRemoteFailure.globalSettings.remote?.enabled === true && configAfterRemoteFailure.globalSettings.remote?.port === occupiedRemotePort && reportedRemoteRuntimeFailure === true && followUpRemoteWrite.ok === true && configAfterRemoteFollowUp.globalSettings.alwaysOnTop === alwaysOnTopAfterRemoteFailure);
    await new Promise(resolve => occupiedRemotePortServer.close(resolve));
    const restoredRemoteSettings = { ...occupiedRemoteSettings, enabled: false };
    await wc.executeJavaScript('saveRemoteSettingsTracked(' + JSON.stringify(restoredRemoteSettings) + ').catch(() => {})');
    await wc.executeJavaScript('setAlwaysOnTopTracked(' + JSON.stringify(Boolean(configBeforeRemoteFailure.globalSettings.alwaysOnTop)) + ').catch(() => {})');

    const generatedRemoteSettings = await wc.executeJavaScript('saveRemoteSettingsTracked(' + JSON.stringify({ ...restoredRemoteSettings, enabled: true, token: '' }) + ')');
    const generatedRemoteToken = generatedRemoteSettings?.settings?.token || '';
    check('Electron UI smoke keeps every network listener on loopback', occupiedRemoteBindAddress === '127.0.0.1' && uiRemoteBindAddresses.length > 0 && uiRemoteBindAddresses.every(address => address === '127.0.0.1'));
    const canonicalRemoteAfterFullSave = await wc.executeJavaScript('(async () => { config.globalSettings = { ...(config.globalSettings || {}), remote: { ...' + JSON.stringify(restoredRemoteSettings) + ', enabled: false, token: "" } }; renderSettings(); const tokenInput = document.getElementById("remoteTokenInput"); if (tokenInput) tokenInput.value = ""; await saveSettings({ feedbackText: "Gespeichert" }); return config.globalSettings.remote?.token || ""; })()');
    const configAfterGeneratedTokenSave = JSON.parse(fs.readFileSync(activeConfigStore.filePath, 'utf-8'));
    check('Full settings save preserves the canonical remote token', generatedRemoteToken.length > 0 && canonicalRemoteAfterFullSave === generatedRemoteToken && configAfterGeneratedTokenSave.globalSettings.remote?.token === generatedRemoteToken);
    await wc.executeJavaScript('saveRemoteSettingsTracked(' + JSON.stringify({ ...restoredRemoteSettings, enabled: false, token: generatedRemoteToken }) + ').catch(() => {})');

    let directConfigWriteRelease = null;
    let directConfigWriteStarted = false;
    let rendererExportCalls = 0;
    ipcMain.removeHandler('save-config');
    ipcMain.handle('save-config', () => {
      directConfigWriteStarted = true;
      return new Promise(resolve => { directConfigWriteRelease = () => resolve(true); });
    });
    ipcMain.removeHandler('export-backup');
    ipcMain.handle('export-backup', () => { rendererExportCalls++; return { ok: true, path: 'ui-renderer-export.mhu' }; });
    await wc.executeJavaScript('(() => { HOSTERS.forEach(name => { config.hosters[name] = []; }); config.hosters["byse.sx"] = [{ id: "ui-tracked-account", enabled: true, authType: "api", apiKey: "tracked-key" }]; accountStatuses = { "ui-tracked-account": { status: "ok", message: "Bereit" } }; renderAccounts(); toggleAccount("ui-tracked-account"); })()');
    for (let attempt = 0; attempt < 100 && !directConfigWriteStarted; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    const pendingRendererExport = wc.executeJavaScript('doBackupExport()');
    await new Promise(resolve => setTimeout(resolve, 80));
    const rendererExportBeforeWrite = rendererExportCalls;
    directConfigWriteRelease?.();
    await pendingRendererExport;
    check('Renderer export awaits direct account writes', directConfigWriteStarted === true && rendererExportBeforeWrite === 0 && rendererExportCalls === 1);

    const failedSaveRepairOrder = [];
    const failedSavePayloads = [];
    let failedSaveAttempts = 0;
    let fullSnapshotRepairCalls = 0;
    ipcMain.removeHandler('save-global-settings');
    ipcMain.handle('save-global-settings', (_event, payload) => {
      failedSavePayloads.push(payload);
      failedSaveAttempts++;
      if (failedSaveAttempts === 1) {
        failedSaveRepairOrder.push('failed-save');
        throw new Error('tracked settings save failed');
      }
      failedSaveRepairOrder.push('retry-same-save');
      return true;
    });
    ipcMain.removeHandler('save-config');
    ipcMain.handle('save-config', () => {
      fullSnapshotRepairCalls++;
      failedSaveRepairOrder.push('full-snapshot');
      return true;
    });
    ipcMain.removeHandler('export-backup');
    ipcMain.handle('export-backup', () => {
      failedSaveRepairOrder.push('export');
      return { ok: true, path: 'ui-repaired-export.mhu' };
    });
    const failedSaveRepairAlert = await wc.executeJavaScript('(() => { const originalSettingsPayload = { ...(config.globalSettings || {}), alwaysOnTop: true, webhookUrl: "https://repair-export.invalid/original" }; config.globalSettings = originalSettingsPayload; window.__failedSaveRepairAlert = ""; window.alert = message => { window.__failedSaveRepairAlert = String(message); }; return saveGlobalSettingsTracked(originalSettingsPayload).catch(() => {}).then(() => { originalSettingsPayload.alwaysOnTop = false; originalSettingsPayload.webhookUrl = "https://repair-export.invalid/newer"; config.globalSettings = { ...originalSettingsPayload }; return doBackupExport(); }).then(() => window.__failedSaveRepairAlert); })()');
    const failedSavePayloadRetriedExactly = failedSavePayloads.length === 2
      && JSON.stringify(failedSavePayloads[0]) === JSON.stringify(failedSavePayloads[1])
      && failedSavePayloads[1].alwaysOnTop === true
      && failedSavePayloads[1].webhookUrl === 'https://repair-export.invalid/original';
    check('Renderer retries the exact failed settings save before export without a full snapshot', failedSavePayloadRetriedExactly && fullSnapshotRepairCalls === 0 && failedSaveRepairOrder.join('|') === 'failed-save|retry-same-save|export' && failedSaveRepairAlert === '');

    restoreInitialIpcHandler('save-global-settings');
    restoreInitialIpcHandler('save-pending-queue');
    const initialSaveGlobalSettingsHandler = initialIpcHandlers.get('save-global-settings');
    const settingsRunnerMarker = 'https://runner-recovery.invalid/current';
    let settingsRunnerAttempts = 0;
    ipcMain.removeHandler('save-global-settings');
    ipcMain.handle('save-global-settings', (event, payload) => {
      if (payload?.webhookUrl === settingsRunnerMarker) {
        settingsRunnerAttempts++;
        if (settingsRunnerAttempts === 1) throw new Error('transient settings runner failure');
      }
      return initialSaveGlobalSettingsHandler(event, payload);
    });
    const settingsRunnerRecovery = await wc.executeJavaScript('(() => { const input = document.getElementById("webhookUrlInput"); input.value = "' + settingsRunnerMarker + '"; return saveSettings({ feedbackText: "Gespeichert" }).then(() => ({ firstFailed: false }), () => ({ firstFailed: true })).then(async result => { try { await flushPendingSettingsSaves(); result.flushOk = true; } catch (error) { result.flushOk = false; result.error = error.message; } return result; }); })()');
    const configAfterSettingsRunnerRecovery = JSON.parse(fs.readFileSync(activeConfigStore.filePath, 'utf-8'));
    check('Close flush recovers a rejected serialized settings runner', settingsRunnerRecovery.firstFailed === true && settingsRunnerRecovery.flushOk === true && settingsRunnerAttempts >= 2 && configAfterSettingsRunnerRecovery.globalSettings.webhookUrl === settingsRunnerMarker);
    restoreInitialIpcHandler('save-global-settings');

    const retainedWriteOrder = [];
    let retainedOldAttempts = 0;
    ipcMain.removeHandler('save-global-settings');
    ipcMain.handle('save-global-settings', (_event, payload) => {
      if (payload.webhookUrl === 'https://retry-queue.invalid/old') {
        retainedOldAttempts++;
        retainedWriteOrder.push('old-' + retainedOldAttempts);
        if (retainedOldAttempts < 3) throw new Error('old write still failing');
      } else if (payload.webhookUrl === 'https://retry-queue.invalid/new') {
        retainedWriteOrder.push('new');
      }
      return true;
    });
    ipcMain.removeHandler('export-backup');
    ipcMain.handle('export-backup', () => {
      retainedWriteOrder.push('export');
      return { ok: true, path: 'ui-retained-write-export.mhu' };
    });
    await wc.executeJavaScript('(() => { const oldSettings = { ...(config.globalSettings || {}), webhookUrl: "https://retry-queue.invalid/old" }; const newSettings = { ...oldSettings, webhookUrl: "https://retry-queue.invalid/new" }; return saveGlobalSettingsTracked(oldSettings).catch(() => {}).then(() => saveGlobalSettingsTracked(newSettings).catch(() => {})).then(() => doBackupExport()); })()');
    check('Renderer retains newer writes when an older retry fails again', retainedWriteOrder.join('|') === 'old-1|old-2|old-3|new|export');

    const importGateRetryOrder = [];
    let importGateActive = true;
    ipcMain.removeHandler('save-global-settings');
    ipcMain.handle('save-global-settings', () => {
      if (importGateActive) {
        importGateRetryOrder.push('blocked-stale');
        throw new Error('Einstellungen werden gerade importiert');
      }
      importGateRetryOrder.push('replayed-stale');
      return true;
    });
    ipcMain.removeHandler('set-always-on-top');
    ipcMain.handle('set-always-on-top', () => {
      importGateRetryOrder.push('imported-state');
      return true;
    });
    await wc.executeJavaScript('saveGlobalSettingsTracked({ ...(config.globalSettings || {}), webhookUrl: "https://import-gate.invalid/stale" }).catch(() => {})');
    importGateActive = false;
    await wc.executeJavaScript('setAlwaysOnTopTracked(false)');
    check('Renderer never retries a settings write rejected by the import gate', importGateRetryOrder.join('|') === 'blocked-stale|imported-state');

    const queueImportOrder = [];
    const queueImportSnapshots = [];
    let queueImportStarted = false;
    let releaseQueueImport = null;
    ipcMain.removeHandler('save-pending-queue');
    ipcMain.handle('save-pending-queue', (_event, pendingQueue) => {
      queueImportOrder.push('queue-save');
      queueImportSnapshots.push(pendingQueue);
      return true;
    });
    ipcMain.removeHandler('import-backup');
    ipcMain.handle('import-backup', () => {
      queueImportOrder.push('import');
      queueImportStarted = true;
      return new Promise(resolve => { releaseQueueImport = () => resolve({ ok: false, canceled: true }); });
    });
    const pendingQueueImport = wc.executeJavaScript('(() => { selectedFiles = []; selectedUploadHosters = []; queueJobs = [{ id: "ui-queue-flush", file: "C:/ui/queue-flush.bin", fileName: "queue-flush.bin", hoster: "byse.sx", status: "preview", bytesTotal: 1 }]; rebuildJobIndex(); persistQueueStateSoon(false); return doBackupImport(); })()');
    for (let attempt = 0; attempt < 100 && !queueImportStarted; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    const queueWriteDuringImport = await wc.executeJavaScript('(() => { queueJobs = [{ id: "ui-import-dialog-terminal", file: "C:/ui/import-dialog-terminal.bin", fileName: "import-dialog-terminal.bin", hoster: "byse.sx", status: "done", bytesTotal: 10, bytesUploaded: 10, result: { download_url: "https://example.invalid/done" } }]; rebuildJobIndex(); return persistQueueStateNow().then(() => ({ ok: true }), error => ({ ok: false, error: error.message })); })()');
    const terminalClearedBeforeImportFinished = queueImportSnapshots.some(snapshot => snapshot === null);
    releaseQueueImport?.();
    await pendingQueueImport;
    await new Promise(resolve => setTimeout(resolve, 100));
    const terminalClearedAfterCancel = queueImportSnapshots.some(snapshot => snapshot === null);
    check('Import flushes the throttled queue save before invoking main', queueImportOrder[0] === 'queue-save' && queueImportOrder[1] === 'import');
    check('Queue progress stays persistable while an import dialog is open', queueWriteDuringImport.ok === true && terminalClearedBeforeImportFinished === true && terminalClearedAfterCancel === true);

    const importedQueueMerge = await wc.executeJavaScript('(() => { queueJobs = [{ id: "ui-live-queue-after-import", file: "C:/ui/live-after-import.bin", fileName: "live-after-import.bin", hoster: "byse.sx", status: "queued", bytesTotal: 12 }]; rebuildJobIndex(); const imported = structuredClone(config); imported.globalSettings = { ...(imported.globalSettings || {}), webhookUrl: "https://queue-merge.invalid/imported", pendingQueue: { savedAt: 1, queueJobs: [{ id: "ui-stale-import-queue" }] } }; applyImportedConfig(imported, "Importiert"); return { webhookUrl: config.globalSettings.webhookUrl, ids: config.globalSettings.pendingQueue?.queueJobs?.map(job => job.id) || [] }; })()');
    check('Imported settings keep the live local queue in renderer memory', importedQueueMerge.webhookUrl === 'https://queue-merge.invalid/imported' && importedQueueMerge.ids.join('|') === 'ui-live-queue-after-import');
    const sourceCleanupDisabledRetry = await wc.executeJavaScript('(() => { const previousSetting = config.globalSettings?.deleteSourceAfterSuccessfulUpload; config.globalSettings = { ...(config.globalSettings || {}), deleteSourceAfterSuccessfulUpload: false }; queueJobs = [{ id: "ui-cleanup-disabled-retry", file: "C:/ui/cleanup-disabled.bin", fileName: "cleanup-disabled.bin", hoster: "voe.sx", status: "preview", bytesTotal: 10, sourceCleanupMetadataVersion: 2, sourceCleanupToken: "ui-cleanup-disabled-token", sourceCleanupRequiredHosters: ["voe.sx"], sourceCleanupConfirmedHosters: ["voe.sx"] }]; rebuildJobIndex(); const preparation = prepareSourceCleanup(queueJobs); config.globalSettings.deleteSourceAfterSuccessfulUpload = previousSetting; return { groups: preparation.groups.length, revokedHosters: preparation.revokedHosters || [], confirmedHosters: queueJobs[0].sourceCleanupConfirmedHosters || [] }; })()');
    check('Retry revokes a confirmed cleanup hoster even while source deletion is disabled', sourceCleanupDisabledRetry.groups === 0 && sourceCleanupDisabledRetry.revokedHosters.join('|') === 'voe.sx' && sourceCleanupDisabledRetry.confirmedHosters.length === 0);
    let sourceCleanupRevocationSaveCalls = 0;
    ipcMain.removeHandler('save-pending-queue');
    ipcMain.handle('save-pending-queue', async () => {
      sourceCleanupRevocationSaveCalls++;
      if (sourceCleanupRevocationSaveCalls === 1) throw new Error('injected cleanup revocation save failure');
      return true;
    });
    const sourceCleanupRevocationRetry = await wc.executeJavaScript('(async () => { queueJobs = [{ id: "ui-cleanup-revocation-retry", file: "C:/ui/cleanup-revocation-retry.bin", fileName: "cleanup-revocation-retry.bin", hoster: "voe.sx", status: "preview", bytesTotal: 10, sourceCleanupMetadataVersion: 2, sourceCleanupToken: "ui-cleanup-revocation-retry-token", sourceCleanupRequiredHosters: ["voe.sx"], sourceCleanupConfirmedHosters: ["voe.sx"] }]; rebuildJobIndex(); const firstPreparation = prepareSourceCleanup(queueJobs); let firstFailed = false; try { await persistSourceCleanupRevocations(firstPreparation); } catch { firstFailed = true; } const secondPreparation = prepareSourceCleanup(queueJobs); let secondSucceeded = true; try { await persistSourceCleanupRevocations(secondPreparation); } catch { secondSucceeded = false; } return { firstFailed, secondSucceeded, secondRevocations: secondPreparation.revokedHosters || [] }; })()');
    const sourceCleanupRevocationCallsBeforeRecovery = sourceCleanupRevocationSaveCalls;
    restoreInitialIpcHandler('save-pending-queue');
    await wc.executeJavaScript('flushConfigWrites()');
    check('A failed cleanup revocation save stays mandatory for the next start attempt', sourceCleanupRevocationRetry.firstFailed === true && sourceCleanupRevocationRetry.secondSucceeded === true && sourceCleanupRevocationRetry.secondRevocations.length === 0 && sourceCleanupRevocationCallsBeforeRecovery >= 2);
    const initialStartUploadHandler = initialIpcHandlers.get('start-upload');
    const initialStartQueueHandler = initialIpcHandlers.get('save-pending-queue');
    const runFreshStartPersistenceBarrier = async mode => {
      await wc.executeJavaScript('queuePersistThrottle.cancel(); flushConfigWrites()');
      const order = [];
      const snapshots = [];
      const payloads = [];
      ipcMain.removeHandler('save-pending-queue');
      ipcMain.handle('save-pending-queue', (_event, pendingQueue) => {
        order.push('save');
        snapshots.push(structuredClone(pendingQueue));
        return true;
      });
      ipcMain.removeHandler('start-upload');
      ipcMain.handle('start-upload', (_event, payload) => {
        order.push('start');
        payloads.push(structuredClone(payload));
        return { skippedJobs: [], sourceCleanupFingerprints: {} };
      });
      const invocation = mode === 'all' ? 'startUpload()' : 'startSelectedUpload([queueJobs[0]])';
      const outcome = await wc.executeJavaScript('(async () => { queuePersistThrottle.cancel(); uploading = false; selectedUploadHosters = ["voe.sx"]; selectedFiles = []; config.globalSettings = { ...(config.globalSettings || {}), deleteSourceAfterSuccessfulUpload: false }; queueJobs = [{ id: "ui-fresh-' + mode + '-start", file: "C:/ui/fresh-' + mode + '-start.bin", fileName: "fresh-' + mode + '-start.bin", hoster: "voe.sx", status: "preview", bytesTotal: 42 }]; rebuildJobIndex(); const startedAt = performance.now(); await ' + invocation + '; return { elapsed: performance.now() - startedAt, uploading }; })()');
      await wc.executeJavaScript('queuePersistThrottle.cancel(); uploading = false; selectedFiles = []; queueJobs = []; rebuildJobIndex(); updateQueueActionButtons(); updateStatusBar()');
      ipcMain.removeHandler('save-pending-queue');
      if (initialStartQueueHandler) registerIpcHandler('save-pending-queue', initialStartQueueHandler);
      ipcMain.removeHandler('start-upload');
      if (initialStartUploadHandler) registerIpcHandler('start-upload', initialStartUploadHandler);
      return { order, snapshots, payloads, outcome };
    };
    const freshAllStartBarrier = await runFreshStartPersistenceBarrier('all');
    const freshSelectedStartBarrier = await runFreshStartPersistenceBarrier('selected');
    const hasCompleteStartDescriptor = (run, id) => {
      const jobs = run.snapshots[0]?.queueJobs || [];
      const job = jobs.find(candidate => candidate.id === id);
      return Boolean(job && job.file === 'C:/ui/' + id.replace(/^ui-/, '') + '.bin' && job.fileName === id.replace(/^ui-/, '') + '.bin' && job.hoster === 'voe.sx');
    };
    check('Every fresh upload start durably saves complete job descriptors before invoking main', freshAllStartBarrier.order.join('|') === 'save|start' && freshSelectedStartBarrier.order.join('|') === 'save|start' && hasCompleteStartDescriptor(freshAllStartBarrier, 'ui-fresh-all-start') && hasCompleteStartDescriptor(freshSelectedStartBarrier, 'ui-fresh-selected-start'));
    check('Fresh upload starts remain inside the previous 500 ms persistence window', freshAllStartBarrier.outcome.elapsed < 500 && freshSelectedStartBarrier.outcome.elapsed < 500 && freshAllStartBarrier.payloads.length === 1 && freshSelectedStartBarrier.payloads.length === 1);

    await wc.executeJavaScript('flushConfigWrites()');
    let failedFreshStartCalls = 0;
    let failedFreshSaveCalls = 0;
    ipcMain.removeHandler('save-pending-queue');
    ipcMain.handle('save-pending-queue', () => {
      failedFreshSaveCalls++;
      throw new Error('injected fresh start persistence failure');
    });
    ipcMain.removeHandler('start-upload');
    ipcMain.handle('start-upload', () => {
      failedFreshStartCalls++;
      return { skippedJobs: [], sourceCleanupFingerprints: {} };
    });
    await wc.executeJavaScript('(() => { queuePersistThrottle.cancel(); uploading = false; selectedUploadHosters = ["voe.sx"]; selectedFiles = []; config.globalSettings = { ...(config.globalSettings || {}), deleteSourceAfterSuccessfulUpload: false }; queueJobs = [{ id: "ui-fresh-start-rejected", file: "C:/ui/fresh-start-rejected.bin", fileName: "fresh-start-rejected.bin", hoster: "voe.sx", status: "preview", bytesTotal: 42 }]; rebuildJobIndex(); window.__uiFreshStartFailure = startUpload(); })()');
    await waitUntil(() => wc.executeJavaScript('document.getElementById("appAlertModal")?.style.display === "flex"'));
    await wc.executeJavaScript('document.getElementById("appAlertConfirmBtn")?.click(); window.__uiFreshStartFailure.then(() => { delete window.__uiFreshStartFailure; })');
    check('A rejected fresh queue save prevents main from starting any upload', failedFreshSaveCalls > 0 && failedFreshStartCalls === 0);
    ipcMain.removeHandler('save-pending-queue');
    if (initialStartQueueHandler) registerIpcHandler('save-pending-queue', initialStartQueueHandler);
    ipcMain.removeHandler('start-upload');
    if (initialStartUploadHandler) registerIpcHandler('start-upload', initialStartUploadHandler);
    await wc.executeJavaScript('queuePersistThrottle.cancel(); uploading = false; selectedFiles = []; queueJobs = []; rebuildJobIndex(); flushConfigWrites()');

    const activeDescriptorOrder = [];
    const activeDescriptorSnapshots = [];
    let activeDescriptorAddCalls = 0;
    ipcMain.removeHandler('save-pending-queue');
    ipcMain.handle('save-pending-queue', (_event, pendingQueue) => {
      activeDescriptorOrder.push('save');
      activeDescriptorSnapshots.push(structuredClone(pendingQueue));
      return true;
    });
    ipcMain.removeHandler('add-jobs-to-batch');
    ipcMain.handle('add-jobs-to-batch', () => {
      activeDescriptorOrder.push('add');
      activeDescriptorAddCalls++;
      return { added: 1, skippedJobs: [], sourceCleanupFingerprints: {} };
    });
    const activeDescriptorStart = await wc.executeJavaScript('(async () => { queuePersistThrottle.cancel(); setUiLanguage("en"); uploading = true; selectedFiles = []; config.globalSettings = { ...(config.globalSettings || {}), deleteSourceAfterSuccessfulUpload: false }; queueJobs = [{ id: "ui-active-descriptor", file: "C:/ui/active-descriptor.bin", fileName: "active-descriptor.bin", hoster: "byse.sx", status: "preview", bytesTotal: 77 }]; rebuildJobIndex(); const startedAt = performance.now(); await startSelectedUpload([queueJobs[0]]); return { elapsed: performance.now() - startedAt, toast: document.getElementById("copyToast")?.textContent }; })()');
    const activePersistedDescriptor = activeDescriptorSnapshots[0]?.queueJobs?.find(job => job.id === 'ui-active-descriptor');
    check('Active-batch additions save the complete new descriptor before main receives it', activeDescriptorOrder.join('|') === 'save|add' && activeDescriptorAddCalls === 1 && activeDescriptorStart.elapsed < 500 && activePersistedDescriptor?.file === 'C:/ui/active-descriptor.bin' && activePersistedDescriptor?.fileName === 'active-descriptor.bin' && activePersistedDescriptor?.hoster === 'byse.sx');
    check('Active-batch addition feedback is localized dynamically', activeDescriptorStart.toast === 'Jobs: 1 added');
    restoreInitialIpcHandler('save-pending-queue');
    restoreInitialIpcHandler('add-jobs-to-batch');
    await wc.executeJavaScript('queuePersistThrottle.cancel(); uploading = false; selectedFiles = []; queueJobs = []; rebuildJobIndex(); flushConfigWrites()');
    const localizedResumeAndInvalidSelection = await wc.executeJavaScript('(async () => { setUiLanguage("en"); uploading = true; queueJobs = [{ id: "ui-invalid-selection", file: "C:/ui/invalid-selection.bin", fileName: "invalid-selection.bin", hoster: "voe.sx", status: "done", bytesTotal: 1 }]; rebuildJobIndex(); selectedJobIds.clear(); selectedJobIds.add("ui-invalid-selection"); await startSelectedUpload(); const invalid = document.getElementById("copyToast")?.textContent; showCopyToast("3 unterbrochene Uploads können fortgesetzt werden."); const resume = document.getElementById("copyToast")?.textContent; setUiLanguage("de"); uploading = false; queueJobs = []; selectedJobIds.clear(); rebuildJobIndex(); return { invalid, resume }; })()');
    check('Resume and invalid queue selection feedback render in the active language', localizedResumeAndInvalidSelection.invalid === 'No startable jobs selected because all are already running or completed.' && localizedResumeAndInvalidSelection.resume === '3 interrupted uploads can be resumed.');
    const activeBatchSeed = async (file, token, mode) => {
      const seed = JSON.stringify({ file, token, mode });
      const result = await wc.executeJavaScript('(() => { try { const seed = ' + seed + '; queuePersistThrottle.cancel(); selectedFiles = []; _pendingFiles = []; selectedUploadHosters = ["voe.sx"]; uploading = true; config.globalSettings = { ...(config.globalSettings || {}), deleteSourceAfterSuccessfulUpload: true, folderMonitor: { ...(config.globalSettings?.folderMonitor || {}), hosters: ["voe.sx"], autoStart: false } }; queueJobs = [{ id: "ui-active-existing-" + seed.mode, file: seed.file, fileName: "active-existing.bin", hoster: "byse.sx", status: "error", bytesTotal: 10, sourceCleanupMetadataVersion: 2, sourceCleanupToken: seed.token, sourceCleanupRequiredHosters: ["voe.sx", "byse.sx"], sourceCleanupConfirmedHosters: ["voe.sx"] }]; rebuildJobIndex(); if (seed.mode === "selection") { const list = document.getElementById("hosterModalList"); const input = document.createElement("input"); input.type = "checkbox"; input.dataset.hosterModal = "voe.sx"; input.checked = true; list.replaceChildren(input); _pendingFiles = [{ path: seed.file, name: "active-selection.bin", size: 10 }]; } return { ok: true }; } catch (error) { return { ok: false, error: String(error && (error.stack || error.message) || error) }; } })()');
      if (!result?.ok) throw new Error('Active-batch seed failed: ' + result?.error);
    };
    const runActiveBatchBarrierSuccess = async (mode) => {
      const file = 'C:/ui/active-' + mode + '-barrier.bin';
      await wc.executeJavaScript('flushConfigWrites()');
      await activeBatchSeed(file, 'ui-active-' + mode + '-barrier-token', mode);
      const order = [];
      let addCalls = 0;
      let saveCalls = 0;
      let releaseSave = null;
      ipcMain.removeHandler('save-pending-queue');
      ipcMain.handle('save-pending-queue', () => {
        saveCalls++;
        order.push('save-start-' + saveCalls);
        if (saveCalls !== 1) {
          order.push('save-done-' + saveCalls);
          return true;
        }
        return new Promise(resolve => {
          releaseSave = () => {
            order.push('save-done-1');
            resolve(true);
          };
        });
      });
      ipcMain.removeHandler('add-jobs-to-batch');
      ipcMain.handle('add-jobs-to-batch', () => {
        addCalls++;
        order.push('add');
        return { added: 1, skippedJobs: [], sourceCleanupFingerprints: {} };
      });
      if (mode === 'folder') wc.send('folder-monitor:new-files', [file]);
      else await wc.executeJavaScript('void applyHosterSelection()');
      await waitUntil(() => releaseSave !== null);
      const blockedBeforeSave = addCalls === 0;
      releaseSave?.();
      await waitUntil(() => addCalls === 1);
      await new Promise(resolve => setTimeout(resolve, 50));
      return { blockedBeforeSave, addCalls, order };
    };
    const folderBarrierSuccess = await runActiveBatchBarrierSuccess('folder');
    check('Folder monitor active-batch add waits for cleanup revocation persistence', folderBarrierSuccess.blockedBeforeSave === true && folderBarrierSuccess.addCalls === 1 && folderBarrierSuccess.order.indexOf('save-done-1') < folderBarrierSuccess.order.indexOf('add'));
    restoreInitialIpcHandler('save-pending-queue');
    restoreInitialIpcHandler('add-jobs-to-batch');
    await wc.executeJavaScript('persistSourceCleanupRevocations({ revokedHosters: [] })');
    const selectionBarrierSuccess = await runActiveBatchBarrierSuccess('selection');
    check('Hoster selection active-batch add waits for cleanup revocation persistence', selectionBarrierSuccess.blockedBeforeSave === true && selectionBarrierSuccess.addCalls === 1 && selectionBarrierSuccess.order.indexOf('save-done-1') < selectionBarrierSuccess.order.indexOf('add'));
    restoreInitialIpcHandler('save-pending-queue');
    restoreInitialIpcHandler('add-jobs-to-batch');
    await wc.executeJavaScript('persistSourceCleanupRevocations({ revokedHosters: [] })');
    const runActiveBatchBarrierFailure = async (mode) => {
      const file = 'C:/ui/active-' + mode + '-rejected.bin';
      await wc.executeJavaScript('flushConfigWrites()');
      await activeBatchSeed(file, 'ui-active-' + mode + '-rejected-token', mode);
      let addCalls = 0;
      let saveCalls = 0;
      ipcMain.removeHandler('save-pending-queue');
      ipcMain.handle('save-pending-queue', () => {
        saveCalls++;
        throw new Error('injected active-batch revocation save failure');
      });
      ipcMain.removeHandler('add-jobs-to-batch');
      ipcMain.handle('add-jobs-to-batch', () => {
        addCalls++;
        return { added: 1, skippedJobs: [], sourceCleanupFingerprints: {} };
      });
      if (mode === 'folder') wc.send('folder-monitor:new-files', [file]);
      else await wc.executeJavaScript('void applyHosterSelection()');
      await waitUntil(() => saveCalls > 0);
      await new Promise(resolve => setTimeout(resolve, 100));
      return { addCalls, saveCalls };
    };
    const folderBarrierFailure = await runActiveBatchBarrierFailure('folder');
    check('Rejected folder monitor cleanup revocation save prevents the active-batch add', folderBarrierFailure.saveCalls > 0 && folderBarrierFailure.addCalls === 0);
    restoreInitialIpcHandler('save-pending-queue');
    restoreInitialIpcHandler('add-jobs-to-batch');
    await wc.executeJavaScript('persistSourceCleanupRevocations({ revokedHosters: [] })');
    const selectionBarrierFailure = await runActiveBatchBarrierFailure('selection');
    check('Rejected hoster selection cleanup revocation save prevents the active-batch add', selectionBarrierFailure.saveCalls > 0 && selectionBarrierFailure.addCalls === 0);
    restoreInitialIpcHandler('save-pending-queue');
    restoreInitialIpcHandler('add-jobs-to-batch');
    await wc.executeJavaScript('persistSourceCleanupRevocations({ revokedHosters: [] }); uploading = false; selectedFiles = []; _pendingFiles = []; queueJobs = []; rebuildJobIndex()');
    const sourceCleanupFinalizationGate = await wc.executeJavaScript('(async () => { if (typeof sourceCleanupFinalizationPending === "undefined") return { available: false }; queueJobs = [{ id: "ui-cleanup-finalizing", file: "C:/ui/cleanup-finalizing.bin", fileName: "cleanup-finalizing.bin", hoster: "voe.sx", status: "done", bytesTotal: 10, result: { download_url: "https://example.invalid/finalizing" } }]; rebuildJobIndex(); selectedJobIds.clear(); selectedJobIds.add(queueJobs[0].id); sourceCleanupFinalizationPending = true; updateQueueActionButtons(); const disabled = document.getElementById("reuploadSelectedBtn")?.disabled === true; await retrySelectedJobs(); const status = queueJobs[0].status; sourceCleanupFinalizationPending = false; selectedJobIds.clear(); updateQueueActionButtons(); return { available: true, disabled, status }; })()');
    check('Final cleanup persistence blocks a new retry until the handshake settles', sourceCleanupFinalizationGate.available === true && sourceCleanupFinalizationGate.disabled === true && sourceCleanupFinalizationGate.status === 'done');
    let sourceCleanupFinalizationPayload = null;
    ipcMain.removeHandler('complete-upload-finalization');
    ipcMain.handle('complete-upload-finalization', (_event, payload) => {
      sourceCleanupFinalizationPayload = payload;
      return false;
    });
    const sourceCleanupRollback = await wc.executeJavaScript('(async () => { queuePersistThrottle.cancel(); await flushConfigWrites(); queueJobs = [{ id: "ui-cleanup-voe", file: "C:/ui/cleanup-round.bin", fileName: "cleanup-round.bin", hoster: "voe.sx", status: "preview", bytesTotal: 10 }, { id: "ui-cleanup-byse", file: "C:/ui/cleanup-round.bin", fileName: "cleanup-round.bin", hoster: "byse.sx", status: "error", bytesTotal: 10 }]; rebuildJobIndex(); window.SourceCleanupPolicy.prepareGroups(queueJobs, queueJobs, () => "ui-cleanup-token", "win32"); queueJobs[0].status = "done"; window.SourceCleanupPolicy.markCompleted(queueJobs, queueJobs[0], "win32"); const before = buildPersistedQueueState(); if (typeof completeSourceCleanupFinalization !== "function") return { available: false, before }; const result = await completeSourceCleanupFinalization({ finalizationId: "ui-cleanup-finalization", deliveryId: "ui-cleanup-delivery", historyPersisted: true }); const after = buildPersistedQueueState(); return { available: true, result, before, after }; })()');
    const sourceCleanupBeforeJobs = sourceCleanupRollback.before?.queueJobs || [];
    const sourceCleanupAfterJobs = sourceCleanupRollback.after?.queueJobs || [];
    const sourceCleanupPromotedJobs = sourceCleanupFinalizationPayload?.pendingQueue?.queueJobs || [];
    const sourceCleanupRollbackOk = sourceCleanupRollback.available === true
      && sourceCleanupRollback.result === false
      && sourceCleanupFinalizationPayload?.deliveryId === 'ui-cleanup-delivery'
      && sourceCleanupBeforeJobs.length === 1
      && sourceCleanupBeforeJobs[0]?.id === 'ui-cleanup-byse'
      && !Object.prototype.hasOwnProperty.call(sourceCleanupBeforeJobs[0], 'sourceCleanupProvisionalHosters')
      && !Object.prototype.hasOwnProperty.call(sourceCleanupBeforeJobs[0], 'sourceCleanupCompletedHosters')
      && (sourceCleanupBeforeJobs[0]?.sourceCleanupRequiredHosters || []).join('|') === 'voe.sx|byse.sx'
      && (sourceCleanupBeforeJobs[0]?.sourceCleanupStartedHosters || []).join('|') === 'voe.sx|byse.sx'
      && (sourceCleanupBeforeJobs[0]?.sourceCleanupConfirmedHosters || []).length === 0
      && sourceCleanupPromotedJobs.length === 1
      && sourceCleanupPromotedJobs[0]?.id === 'ui-cleanup-byse'
      && (sourceCleanupPromotedJobs[0]?.sourceCleanupRequiredHosters || []).join('|') === 'voe.sx|byse.sx'
      && (sourceCleanupPromotedJobs[0]?.sourceCleanupStartedHosters || []).join('|') === 'voe.sx|byse.sx'
      && (sourceCleanupPromotedJobs[0]?.sourceCleanupConfirmedHosters || []).join('|') === 'voe.sx'
      && sourceCleanupAfterJobs.length === 1
      && sourceCleanupAfterJobs[0]?.id === 'ui-cleanup-byse'
      && (sourceCleanupAfterJobs[0]?.sourceCleanupRequiredHosters || []).join('|') === 'voe.sx|byse.sx'
      && (sourceCleanupAfterJobs[0]?.sourceCleanupStartedHosters || []).join('|') === 'voe.sx|byse.sx'
      && (sourceCleanupAfterJobs[0]?.sourceCleanupConfirmedHosters || []).length === 0;
    check('Final queue persistence promotes only inside the handshake and rolls back failed saves', sourceCleanupRollbackOk);
    const terminalRecoveryState = await wc.executeJavaScript('(() => { selectedFiles = []; queueJobs = [{ id: "ui-terminal-done", file: "C:/ui/terminal-done.bin", fileName: "terminal-done.bin", hoster: "voe.sx", status: "done", bytesTotal: 41, error: null, result: { download_url: "https://example.invalid/terminal-done", embed_url: "https://example.invalid/embed-terminal-done", file_code: "terminal-code" } }, { id: "ui-terminal-skipped", file: "C:/ui/terminal-skipped.bin", fileName: "terminal-skipped.bin", hoster: "byse.sx", status: "skipped", bytesTotal: 42, error: "Size limit", result: null }]; rebuildJobIndex(); return { normal: buildPersistedQueueState(), recovery: buildPersistedQueueState({ historyPersisted: false }) }; })()');
    const terminalRecoveryJobs = terminalRecoveryState.recovery?.queueJobs || [];
    check('History failure keeps terminal queue results and links restart-recoverable', terminalRecoveryState.normal === null && terminalRecoveryState.recovery !== null && terminalRecoveryState.recovery.selectedFiles.length === 2 && terminalRecoveryJobs.length === 2 && terminalRecoveryJobs[0].id === 'ui-terminal-done' && terminalRecoveryJobs[0].status === 'done' && terminalRecoveryJobs[0].result?.download_url === 'https://example.invalid/terminal-done' && terminalRecoveryJobs[0].result?.embed_url === 'https://example.invalid/embed-terminal-done' && terminalRecoveryJobs[0].result?.file_code === 'terminal-code' && terminalRecoveryJobs[1].status === 'skipped' && terminalRecoveryJobs[1].error === 'Size limit');
    const legacyCleanupRoundTrip = await wc.executeJavaScript(\`(() => {
      const originalGlobalSettings = structuredClone(config.globalSettings || {});
      selectedFiles = [];
      queueJobs = [{ id: 'ui-legacy-cleanup-done', file: 'C:/ui/legacy-cleanup.bin', fileName: 'legacy-cleanup.bin', hoster: 'doodstream.com', status: 'done', bytesTotal: 20, sourceCleanupMetadataVersion: 2, sourceCleanupToken: 'ui-legacy-cleanup-token', sourceCleanupRequiredHosters: ['doodstream.com', 'voe.sx'], sourceCleanupConfirmedHosters: ['doodstream.com'] }, { id: 'ui-legacy-cleanup-preview', file: 'C:/ui/legacy-cleanup.bin', fileName: 'legacy-cleanup.bin', hoster: 'voe.sx', status: 'preview', bytesTotal: 20, sourceCleanupMetadataVersion: 2, sourceCleanupToken: 'ui-legacy-cleanup-token', sourceCleanupRequiredHosters: ['doodstream.com', 'voe.sx'], sourceCleanupConfirmedHosters: ['doodstream.com'] }];
      rebuildJobIndex();
      const snapshot = JSON.parse(JSON.stringify(buildPersistedQueueState()));
      const persistedMissing = snapshot.queueJobs.every(job => !Object.prototype.hasOwnProperty.call(job, 'sourceCleanupStartedHosters'));
      config.globalSettings = { ...originalGlobalSettings, resumeQueueOnLaunch: true, pendingQueue: snapshot, uploadRecovery: null };
      queueJobs = [];
      rebuildJobIndex();
      restoreQueueStateFromConfig();
      const restoredMissing = queueJobs.every(job => !Array.isArray(job.sourceCleanupStartedHosters));
      const touched = window.SourceCleanupPolicy.removeRequirement(queueJobs, queueJobs.find(job => job.id === 'ui-legacy-cleanup-preview'), 'win32');
      const requiredPreserved = queueJobs.every(job => (job.sourceCleanupRequiredHosters || []).join('|') === 'doodstream.com|voe.sx');
      config.globalSettings = originalGlobalSettings;
      selectedFiles = [];
      queueJobs = [];
      rebuildJobIndex();
      return { persistedMissing, restoredMissing, touched: touched.length, requiredPreserved };
    })()\`);
    check('Legacy cleanup metadata stays fail-closed through queue persistence and restart', legacyCleanupRoundTrip.persistedMissing === true && legacyCleanupRoundTrip.restoredMissing === true && legacyCleanupRoundTrip.touched === 0 && legacyCleanupRoundTrip.requiredPreserved === true);
    const uncertainRetryState = await wc.executeJavaScript(\`(async () => {
      const originalGlobalSettings = structuredClone(config.globalSettings || {});
      const originalLanguage = document.documentElement.lang;
      config.globalSettings = { ...originalGlobalSettings, uploadRecovery: null, resumeQueueOnLaunch: true };
      setUiLanguage('en');
      selectedFiles = [];
      queueJobs = [{ id: 'ui-uncertain-retry', file: 'C:/ui/uncertain.bin', fileName: 'uncertain.bin', hoster: 'voe.sx', status: 'error', error: 'Connection lost', remoteCommitUncertain: true, bytesTotal: 77 }];
      rebuildJobIndex();
      const automaticCount = _collectAutoRetryableJobs().length;
      const snapshot = buildPersistedQueueState();
      config.globalSettings.pendingQueue = structuredClone(snapshot);
      queueJobs = [];
      rebuildJobIndex();
      restoreQueueStateFromConfig();
      const restored = queueJobs[0]?.remoteCommitUncertain === true;
      uploadSidebarFilter = 'all';
      queueSearchQuery = '';
      queueHosterFilter = '';
      queueStatusFilter = '';
      renderQueueTable();
      selectedJobIds.clear();
      selectedJobIds.add('ui-uncertain-retry');
      const retryPromise = retrySelectedJobs();
      await Promise.resolve();
      const dialogTitle = document.getElementById('appAlertTitle')?.textContent.trim();
      const dialogDanger = document.getElementById('appAlertConfirmBtn')?.classList.contains('btn-danger') === true;
      document.getElementById('appAlertCancelBtn')?.click();
      await retryPromise;
      const statusAfterCancel = queueJobs[0]?.status;
      const uncertainAfterCancel = queueJobs[0]?.remoteCommitUncertain === true;
      config.globalSettings = originalGlobalSettings;
      setUiLanguage(originalLanguage);
      selectedJobIds.clear();
      selectedFiles = [];
      queueJobs = [];
      rebuildJobIndex();
      return { automaticCount, restored, dialogTitle, dialogDanger, statusAfterCancel, uncertainAfterCancel };
    })()\`);
    check('Uncertain remote commits survive restart, never auto-retry, and require explicit dangerous confirmation', uncertainRetryState.automaticCount === 0 && uncertainRetryState.restored === true && uncertainRetryState.dialogTitle === 'The upload status could not be confirmed' && uncertainRetryState.dialogDanger === true && uncertainRetryState.statusAfterCancel === 'error' && uncertainRetryState.uncertainAfterCancel === true);
    const lateTerminalProgress = await wc.executeJavaScript(\`(() => {
      queueJobs = [{ id: 'ui-late-terminal', uploadId: 'ui-late-terminal-upload', file: 'C:/ui/late-terminal.bin', fileName: 'late-terminal.bin', hoster: 'voe.sx', status: 'error', error: 'Remote result uncertain', failureDetails: { phase: 'response' }, remoteCommitUncertain: true, bytesUploaded: 50, bytesTotal: 100, progress: .5 }];
      rebuildJobIndex();
      _handleProgressImpl({ jobId: 'ui-late-terminal', uploadId: 'ui-late-terminal-upload', fileName: 'late-terminal.bin', hoster: 'voe.sx', status: 'uploading', error: null, failureDetails: null, remoteCommitUncertain: false, bytesUploaded: 90, bytesTotal: 100, progress: .9 });
      const job = queueJobs[0];
      return { status: job.status, error: job.error, phase: job.failureDetails?.phase, uncertain: job.remoteCommitUncertain, bytesUploaded: job.bytesUploaded, progress: job.progress };
    })()\`);
    check('Late progress cannot overwrite a terminal uncertain upload result', lateTerminalProgress.status === 'error' && lateTerminalProgress.error === 'Remote result uncertain' && lateTerminalProgress.phase === 'response' && lateTerminalProgress.uncertain === true && lateTerminalProgress.bytesUploaded === 50 && lateTerminalProgress.progress === .5);
    let uncertainStartCalls = 0;
    ipcMain.removeHandler('start-upload');
    ipcMain.handle('start-upload', () => {
      uncertainStartCalls++;
      return uncertainStartCalls === 1
        ? { error: 'Injected start rejection' }
        : { started: true, taskCount: 1, skippedJobs: [] };
    });
    const rejectedUncertainStartPromise = wc.executeJavaScript(\`(() => {
      uploading = false;
      selectedUploadHosters = ['voe.sx'];
      selectedFiles = [];
      queueJobs = [{ id: 'ui-normal-uncertain-start', file: 'C:/ui/normal-uncertain.bin', fileName: 'normal-uncertain.bin', hoster: 'voe.sx', status: 'error', error: 'Remote result uncertain', remoteCommitUncertain: true, bytesTotal: 12 }];
      rebuildJobIndex();
      return startUpload().then(() => ({ status: queueJobs[0].status, uncertain: queueJobs[0].remoteCommitUncertain === true }));
    })()\`);
    await waitUntil(() => wc.executeJavaScript('document.getElementById("appAlertCancelBtn")?.hidden === false'));
    await wc.executeJavaScript('document.getElementById("appAlertConfirmBtn")?.click()');
    await waitUntil(() => wc.executeJavaScript('document.getElementById("appAlertCancelBtn")?.hidden === true && document.getElementById("appAlertModal")?.style.display === "flex"'));
    await wc.executeJavaScript('document.getElementById("appAlertConfirmBtn")?.click()');
    const rejectedUncertainStart = await rejectedUncertainStartPromise;
    const acceptedUncertainStartPromise = wc.executeJavaScript('startUpload().then(() => { uploading = false; return { status: queueJobs[0].status, uncertain: queueJobs[0].remoteCommitUncertain === true }; })');
    await waitUntil(() => wc.executeJavaScript('document.getElementById("appAlertCancelBtn")?.hidden === false'));
    await wc.executeJavaScript('document.getElementById("appAlertConfirmBtn")?.click()');
    const acceptedUncertainStart = await acceptedUncertainStartPromise;
    const confirmedUncertainRetry = await wc.executeJavaScript('(() => { _handleProgressImpl({ jobId: "ui-normal-uncertain-start", uploadId: "ui-normal-uncertain-start-upload", fileName: "normal-uncertain.bin", hoster: "voe.sx", status: "done", result: { download_url: "https://voe.sx/e/confirmed", file_code: "confirmed" }, bytesUploaded: 12, bytesTotal: 12, progress: 1 }); return queueJobs[0]?.remoteCommitUncertain === true; })()');
    check('Normal start preserves the duplicate warning until a confirmed terminal retry result', uncertainStartCalls === 2 && rejectedUncertainStart.uncertain === true && acceptedUncertainStart.uncertain === true && confirmedUncertainRetry === false);
    let bucketRetryPayload = null;
    ipcMain.removeHandler('start-upload');
    ipcMain.handle('start-upload', (_event, payload) => {
      bucketRetryPayload = payload;
      return { started: true, taskCount: payload.jobs.length, skippedJobs: [] };
    });
    const bucketRetryState = await wc.executeJavaScript(\`(async () => {
      uploading = false;
      queueJobs = [{ id: 'ui-bucket-first', file: 'C:/ui/a/shared.bin', fileName: 'shared.bin', hoster: 'voe.sx', status: 'error', error: 'Network failed', bytesTotal: 13 }, { id: 'ui-bucket-second', file: 'C:/ui/b/shared.bin', fileName: 'shared.bin', hoster: 'voe.sx', status: 'error', error: 'Network failed', bytesTotal: 14 }, { id: 'ui-bucket-unrelated', file: 'C:/ui/c/other.bin', fileName: 'other.bin', hoster: 'voe.sx', status: 'error', error: 'Network failed', bytesTotal: 15 }];
      rebuildJobIndex();
      const started = await _retryFailedFromBuckets({ network: [{ jobId: 'ui-bucket-first', fileName: 'shared.bin', hoster: 'voe.sx' }, { jobId: 'ui-bucket-second', fileName: 'shared.bin', hoster: 'voe.sx' }] }, true);
      uploading = false;
      return { started, statuses: queueJobs.map(job => [job.id, job.status]) };
    })()\`);
    const bucketRetryIds = bucketRetryPayload?.jobs?.map(job => job.id).sort() || [];
    check('Batch retry uses exact job IDs and starts only the requested duplicate-name jobs', bucketRetryState.started === true && bucketRetryIds.join('|') === 'ui-bucket-first|ui-bucket-second' && bucketRetryState.statuses.find(entry => entry[0] === 'ui-bucket-unrelated')?.[1] === 'error');
    restoreInitialIpcHandler('start-upload');
    const failedHistoryRetention = await wc.executeJavaScript(\`(() => {
      const originalGlobalSettings = structuredClone(config.globalSettings || {});
      const summaryFor = jobs => ({ files: jobs.map(job => ({ name: job.fileName, size: job.bytesTotal, results: [{ jobId: job.id, hoster: job.hoster, status: 'done', download_url: 'https://example.invalid/' + job.id }] })) });
      config.globalSettings = { ...originalGlobalSettings, removeFromQueueOnDone: true };
      queueJobs = [{ id: 'ui-history-auto-remove', file: 'C:/ui/history-auto-remove.bin', fileName: 'history-auto-remove.bin', hoster: 'voe.sx', status: 'preview', bytesTotal: 91 }];
      selectedFiles = [];
      rebuildJobIndex();
      handleBatchDone(summaryFor(queueJobs), { deferPersistence: true, historyPersisted: false });
      const autoRemoveSnapshot = buildPersistedQueueState();
      const autoRemoveProtected = queueJobs.length === 1 && queueJobs[0].historyPending === true && autoRemoveSnapshot?.queueJobs?.[0]?.historyPending === true && autoRemoveSnapshot.queueJobs[0].result?.download_url === 'https://example.invalid/ui-history-auto-remove';
      config.globalSettings.pendingQueue = structuredClone(autoRemoveSnapshot);
      queueJobs = [];
      rebuildJobIndex();
      restoreQueueStateFromConfig();
      const restartProtected = queueJobs.length === 1 && queueJobs[0].historyPending === true && queueJobs[0].result?.download_url === 'https://example.invalid/ui-history-auto-remove';
      config.globalSettings = { ...originalGlobalSettings, removeFromQueueOnDone: false };
      queueJobs = Array.from({ length: 501 }, (_, index) => ({ id: 'ui-history-large-' + index, file: 'C:/ui/history-large-' + index + '.bin', fileName: 'history-large-' + index + '.bin', hoster: 'byse.sx', status: 'preview', bytesTotal: index + 1 }));
      selectedFiles = [];
      rebuildJobIndex();
      handleBatchDone(summaryFor(queueJobs), { deferPersistence: true, historyPersisted: false });
      const largeSnapshot = buildPersistedQueueState();
      const largeProtected = queueJobs.length === 501 && queueJobs.every(job => job.historyPending === true) && largeSnapshot?.queueJobs?.length === 501 && largeSnapshot.queueJobs[0].id === 'ui-history-large-0';
      const protectedJob = queueJobs[0];
      const originalPersistSoon = persistQueueStateSoon;
      const originalClearSoon = clearPersistedQueueStateSoon;
      let persistCalls = 0;
      let clearCalls = 0;
      persistQueueStateSoon = () => { persistCalls++; };
      clearPersistedQueueStateSoon = () => { clearCalls++; };
      const laterJob = { id: 'ui-history-later-batch', file: 'C:/ui/history-later.bin', fileName: 'history-later.bin', hoster: 'voe.sx', status: 'preview', bytesTotal: 92 };
      queueJobs.push(laterJob);
      rebuildJobIndex();
      handleBatchDone(summaryFor([laterJob]), { historyPersisted: true });
      persistQueueStateSoon = originalPersistSoon;
      clearPersistedQueueStateSoon = originalClearSoon;
      const laterBatchProtected = queueJobs.includes(protectedJob) && protectedJob.historyPending === true && persistCalls === 1 && clearCalls === 0;
      config.globalSettings = originalGlobalSettings;
      selectedFiles = [];
      queueJobs = [];
      rebuildJobIndex();
      renderQueueTable();
      return { autoRemoveProtected, restartProtected, largeProtected, laterBatchProtected };
    })()\`);
    check('Failed history persistence protects terminal results from auto-remove, restart loss, later batches, and 500-row pruning', failedHistoryRetention.autoRemoveProtected === true && failedHistoryRetention.restartProtected === true && failedHistoryRetention.largeProtected === true && failedHistoryRetention.laterBatchProtected === true);
    const finalSummaryCorrelation = await wc.executeJavaScript('(() => { queueJobs = [{ id: "summary-exact-a", file: "C:/ui/shared-a.bin", fileName: "shared.bin", hoster: "voe.sx", status: "preview", bytesTotal: 10 }, { id: "summary-exact-b", file: "C:/ui/shared-b.bin", fileName: "shared.bin", hoster: "voe.sx", status: "preview", bytesTotal: 11 }, { id: "summary-ambiguous", file: "C:/ui/shared-c.bin", fileName: "shared.bin", hoster: "voe.sx", status: "preview", bytesTotal: 12 }, { id: "summary-legacy-unique", file: "C:/ui/unique.bin", fileName: "unique.bin", hoster: "byse.sx", status: "preview", bytesTotal: 13 }]; rebuildJobIndex(); applySummaryResults({ files: [{ name: "shared.bin", size: 10, results: [{ jobId: "summary-exact-a", hoster: "voe.sx", status: "done", download_url: "https://example.invalid/exact-a" }, { jobId: "missing-summary-id", hoster: "voe.sx", status: "error", error: "Must not use legacy fallback" }, { hoster: "voe.sx", status: "error", error: "Ambiguous legacy result" }] }, { name: "different-name.bin", size: 11, results: [{ jobId: "summary-exact-b", hoster: "different.invalid", status: "done", download_url: "https://example.invalid/exact-b" }] }, { name: "unique.bin", size: 13, results: [{ hoster: "byse.sx", status: "done", download_url: "https://example.invalid/legacy-unique" }] }] }); const result = queueJobs.map(job => ({ id: job.id, status: job.status, error: job.error || null, link: job.result?.download_url || null })); queueJobs = []; selectedFiles = []; rebuildJobIndex(); renderQueueTable(); return result; })()');
    check('Final summary correlates by exact jobId and uses legacy identity only for one unique candidate', finalSummaryCorrelation[0].status === 'done' && finalSummaryCorrelation[0].link === 'https://example.invalid/exact-a' && finalSummaryCorrelation[1].status === 'done' && finalSummaryCorrelation[1].link === 'https://example.invalid/exact-b' && finalSummaryCorrelation[2].status === 'preview' && finalSummaryCorrelation[2].error === null && finalSummaryCorrelation[3].status === 'done' && finalSummaryCorrelation[3].link === 'https://example.invalid/legacy-unique');
    const completionIdentityRaces = await wc.executeJavaScript(\`(() => {
      const run = (jobs, event, deletedJobId = '') => {
        queueJobs = jobs;
        rebuildJobIndex();
        _deletedJobIds.clear();
        if (deletedJobId) _deletedJobIds.add(deletedJobId);
        _handleProgressImpl(event);
        return queueJobs.map(job => ({ id: job.id, uploadId: job.uploadId || null, status: job.status, link: job.result?.download_url || null }));
      };
      const exact = run([
        { id: 'completion-exact-a', fileName: 'same.bin', hoster: 'voe.sx', status: 'queued', bytesTotal: 10 },
        { id: 'completion-exact-b', fileName: 'same.bin', hoster: 'voe.sx', status: 'queued', bytesTotal: 10 }
      ], { jobId: 'completion-exact-b', fileName: 'same.bin', hoster: 'voe.sx', status: 'done', result: { download_url: 'https://example.invalid/exact-b' } });
      const missingExact = run([
        { id: 'completion-live', fileName: 'same.bin', hoster: 'voe.sx', status: 'queued', bytesTotal: 10 }
      ], { jobId: 'completion-missing', fileName: 'same.bin', hoster: 'voe.sx', status: 'done', result: { download_url: 'https://example.invalid/missing' } });
      const deletedExact = run([
        { id: 'completion-survivor', fileName: 'same.bin', hoster: 'voe.sx', status: 'queued', bytesTotal: 10 }
      ], { jobId: 'completion-deleted', fileName: 'same.bin', hoster: 'voe.sx', status: 'done', result: { download_url: 'https://example.invalid/deleted' } }, 'completion-deleted');
      const deletedUploadLegacy = run([
        { id: 'completion-replacement', fileName: 'reused.bin', hoster: 'voe.sx', status: 'queued', bytesTotal: 10 }
      ], { uploadId: 'completion-deleted-upload', fileName: 'reused.bin', hoster: 'voe.sx', status: 'done', result: { download_url: 'https://example.invalid/deleted-upload' } }, 'completion-deleted-upload');
      const liveIndexedUpload = run([
        { id: 'completion-live-indexed', uploadId: 'completion-live-upload', fileName: 'indexed.bin', hoster: 'voe.sx', status: 'queued', bytesTotal: 10 }
      ], { uploadId: 'completion-live-upload', fileName: 'different.bin', hoster: 'different.invalid', status: 'done', result: { download_url: 'https://example.invalid/live-upload' } });
      const ambiguousLegacy = run([
        { id: 'completion-legacy-a', fileName: 'legacy.bin', hoster: 'byse.sx', status: 'queued', bytesTotal: 10 },
        { id: 'completion-legacy-b', fileName: 'legacy.bin', hoster: 'byse.sx', status: 'preview', bytesTotal: 10 }
      ], { fileName: 'legacy.bin', hoster: 'byse.sx', status: 'done', result: { download_url: 'https://example.invalid/ambiguous' } });
      const uniqueLegacy = run([
        { id: 'completion-legacy-unique', fileName: 'unique.bin', hoster: 'byse.sx', status: 'queued', bytesTotal: 10 }
      ], { fileName: 'unique.bin', hoster: 'byse.sx', status: 'done', result: { download_url: 'https://example.invalid/unique' } });
      queuePersistThrottle.cancel();
      queueJobs = [];
      selectedFiles = [];
      _deletedJobIds.clear();
      rebuildJobIndex();
      return { exact, missingExact, deletedExact, deletedUploadLegacy, liveIndexedUpload, ambiguousLegacy, uniqueLegacy };
    })()\`);
    check('Completion events with jobId update only their exact live job', completionIdentityRaces.exact[0].status === 'queued' && completionIdentityRaces.exact[1].status === 'done' && completionIdentityRaces.exact[1].link === 'https://example.invalid/exact-b');
    check('Missing or deleted exact completion IDs never fall back to another job', completionIdentityRaces.missingExact.length === 1 && completionIdentityRaces.missingExact[0].status === 'queued' && completionIdentityRaces.deletedExact.length === 1 && completionIdentityRaces.deletedExact[0].status === 'queued');
    check('Deleted legacy upload IDs never bind to a unique replacement job', completionIdentityRaces.deletedUploadLegacy.length === 1 && completionIdentityRaces.deletedUploadLegacy[0].status === 'queued' && completionIdentityRaces.deletedUploadLegacy[0].uploadId === null && completionIdentityRaces.deletedUploadLegacy[0].link === null);
    check('Live indexed upload IDs retain precedence over legacy visible identity', completionIdentityRaces.liveIndexedUpload.length === 1 && completionIdentityRaces.liveIndexedUpload[0].status === 'done' && completionIdentityRaces.liveIndexedUpload[0].uploadId === 'completion-live-upload' && completionIdentityRaces.liveIndexedUpload[0].link === 'https://example.invalid/live-upload');
    check('Legacy completion identity applies only to one unambiguous candidate', completionIdentityRaces.ambiguousLegacy.every(job => job.status !== 'done') && completionIdentityRaces.uniqueLegacy.length === 1 && completionIdentityRaces.uniqueLegacy[0].status === 'done' && completionIdentityRaces.uniqueLegacy[0].link === 'https://example.invalid/unique');
    restoreInitialIpcHandler('complete-upload-finalization');

    await wc.executeJavaScript('queuePersistThrottle.cancel(); flushConfigWrites()');
    const allSkippedOriginalConfig = await wc.executeJavaScript('structuredClone(config)');
    await wc.executeJavaScript('config = { ...config, hosters: { ...(config.hosters || {}), "clouddrop.cc": [] } }; hosterSettings = config.hosterSettings || {}; saveConfigTracked(config)');
    const originalAppendHistoryForSkippedBatch = activeConfigStore.appendHistory.bind(activeConfigStore);
    let skippedBatchHistoryFailures = 0;
    activeConfigStore.appendHistory = async summary => {
      if (String(summary?.id || '').startsWith('skipped-')) {
        skippedBatchHistoryFailures++;
        throw new Error('injected skipped batch history failure');
      }
      return originalAppendHistoryForSkippedBatch(summary);
    };
    let allSkippedFinalizationPayload = null;
    const initialCompleteUploadFinalization = initialIpcHandlers.get('complete-upload-finalization');
    ipcMain.removeHandler('complete-upload-finalization');
    ipcMain.handle('complete-upload-finalization', async (event, payload) => {
      allSkippedFinalizationPayload = structuredClone(payload);
      return initialCompleteUploadFinalization(event, payload);
    });
    const allSkippedRendererState = await wc.executeJavaScript('(async () => { queuePersistThrottle.cancel(); await flushConfigWrites(); uploading = false; selectedFiles = []; selectedUploadHosters = ["clouddrop.cc"]; queueJobs = [{ id: "ui-all-skipped", file: "C:/ui/all-skipped.bin", fileName: "all-skipped.bin", hoster: "clouddrop.cc", status: "preview", bytesTotal: 64 }]; rebuildJobIndex(); await startUpload(); await new Promise(resolve => setTimeout(resolve, 700)); queuePersistThrottle.flushSync(); await flushConfigWrites(); return { status: queueJobs[0]?.status, uploading }; })()');
    const allSkippedPersistedQueue = activeConfigStore.load().globalSettings?.pendingQueue;
    activeConfigStore.appendHistory = originalAppendHistoryForSkippedBatch;
    restoreInitialIpcHandler('complete-upload-finalization');
    await wc.executeJavaScript('config = ' + JSON.stringify(allSkippedOriginalConfig) + '; hosterSettings = config.hosterSettings || {}; selectedFiles = []; selectedUploadHosters = []; queueJobs = []; rebuildJobIndex(); queuePersistThrottle.cancel(); saveConfigTracked(config)');
    const allSkippedPayloadJobs = allSkippedFinalizationPayload?.pendingQueue?.queueJobs || [];
    const allSkippedPersistedJobs = allSkippedPersistedQueue?.queueJobs || [];
    check('A history failure in an all-skipped batch retains the terminal queue through the finalization barrier', skippedBatchHistoryFailures === 1 && allSkippedFinalizationPayload?.historyPersisted === false && typeof allSkippedFinalizationPayload?.deliveryId === 'string' && allSkippedPayloadJobs.length === 1 && allSkippedPayloadJobs[0].id === 'ui-all-skipped' && allSkippedPayloadJobs[0].status === 'skipped' && allSkippedPersistedJobs.length === 1 && allSkippedPersistedJobs[0].id === 'ui-all-skipped' && allSkippedPersistedJobs[0].status === 'skipped' && allSkippedRendererState.status === 'skipped' && allSkippedRendererState.uploading === false);
    await wc.executeJavaScript('document.getElementById("copyToast")?.classList.remove("show")');

    console.log('\\n=== History View ===');

    let historyFixture = [{
      timestamp: '2026-08-10T10:00:00.000Z',
      files: [
        { name: 'ok.bin', results: [{ status: 'done', hoster: 'voe.sx', download_url: 'https://example.invalid/ok' }] },
        { name: 'bad.bin', results: [{ status: 'error', hoster: 'byse.sx', error: 'Zugang abgelehnt' }] },
        { name: 'stopped.bin', results: [{ status: 'aborted', hoster: 'doodstream.com' }] }
      ]
    }];
    ipcMain.removeHandler('get-history');
    ipcMain.handle('get-history', () => historyFixture);
    let clearHistoryCallCount = 0;
    ipcMain.removeHandler('clear-history');
    ipcMain.handle('clear-history', () => {
      clearHistoryCallCount++;
      historyFixture = [];
      return true;
    });

    await wc.executeJavaScript('_historyDirty = true; document.querySelector(".tab[data-view=\\'history\\']").click()');
    await new Promise(r => setTimeout(r, 1000)); // Wait for async loadHistory

    const historyActive = await wc.executeJavaScript('document.getElementById("history-view")?.classList.contains("active")');
    check('History tab active', historyActive);

    const historyRaceResolvers = [];
    ipcMain.removeHandler('get-history');
    ipcMain.handle('get-history', () => new Promise(resolve => { historyRaceResolvers.push(resolve); }));
    const staleHistoryLoad = wc.executeJavaScript('loadHistory()');
    await waitUntil(() => historyRaceResolvers.length === 1);
    const latestHistoryLoad = wc.executeJavaScript('loadHistory()');
    await waitUntil(() => historyRaceResolvers.length === 2);
    historyRaceResolvers[1]([{ timestamp: '2026-08-10T10:00:01.000Z', files: [{ name: 'latest-history.bin', results: [{ status: 'done', hoster: 'voe.sx', download_url: 'https://example.invalid/latest' }] }] }]);
    await latestHistoryLoad;
    historyRaceResolvers[0]([{ timestamp: '2026-08-10T10:00:00.000Z', files: [{ name: 'stale-history.bin', results: [{ status: 'done', hoster: 'voe.sx', download_url: 'https://example.invalid/stale' }] }] }]);
    await staleHistoryLoad;
    const historyRaceResult = await wc.executeJavaScript('[...document.querySelectorAll("#historyBody .history-row .col-filename")].map(cell => cell.textContent.trim()).join("|")');
    check('A late stale history response cannot overwrite the latest rendered history', historyRaceResult === 'latest-history.bin');
    ipcMain.removeHandler('get-history');
    ipcMain.handle('get-history', () => historyFixture);
    await wc.executeJavaScript('loadHistory()');

    const historyFixtureBeforeLifetimeCheck = historyFixture;
    historyFixture = [{
      timestamp: '2026-08-10T10:05:00.000Z',
      files: [{ name: 'lifetime.bin', results: [{ status: 'done', hoster: 'voe.sx', download_url: 'https://example.invalid/lifetime' }] }]
    }];
    await wc.executeJavaScript(\`(() => {
      HOSTERS.forEach(name => { config.hosters[name] = []; });
      config.hosters['voe.sx'] = [{ id: 'ui-lifetime-account', enabled: true, authType: 'login', username: 'lifetime@example.invalid', password: 'fictional-password' }];
      accountStatuses = { 'ui-lifetime-account': { status: 'ok', message: 'Bereit' } };
      window._historyForStats = [];
      _invalidateHosterLifetimeCache();
      renderAccounts();
      window.__uiLifetimeGroup = document.querySelector('[data-hoster-group="voe.sx"]');
    })()\`);
    await wc.executeJavaScript('loadHistory()');
    const lifetimeRefreshState = await wc.executeJavaScript(\`(() => {
      const group = document.querySelector('[data-hoster-group="voe.sx"]');
      const meta = group?.querySelector('[data-hoster-lifetime="voe.sx"]');
      const healthSample = document.querySelector('[data-hoster-health-row="voe.sx"] [data-health="sample"]')?.textContent.trim() || '';
      return { sameGroup: group === window.__uiLifetimeGroup, visible: Boolean(meta && !meta.hidden), text: meta?.textContent.trim() || '', healthSample };
    })()\`);
    check('Loaded history refreshes hoster lifetime success and health without replacing the account group', lifetimeRefreshState.sameGroup && lifetimeRefreshState.visible && lifetimeRefreshState.text === '100% ok (1)' && lifetimeRefreshState.healthSample === '1');
    historyFixture = historyFixtureBeforeLifetimeCheck;
    await wc.executeJavaScript('loadHistory()');
    await wc.executeJavaScript('HOSTERS.forEach(name => { config.hosters[name] = []; }); accountStatuses = {}; renderAccounts()');

    const historyWorkspaceLayout = await wc.executeJavaScript('(() => { const view = document.getElementById("history-view"); const sidebar = view?.querySelector(":scope > .view-sidebar"); const main = view?.querySelector(":scope > .view-main"); if (!sidebar || !main) return false; const sidebarRect = sidebar.getBoundingClientRect(); const mainRect = main.getBoundingClientRect(); return sidebarRect.width > 0 && mainRect.width > 0 && sidebarRect.right <= mainRect.left; })()');
    check('History view separates sidebar and main workspace', historyWorkspaceLayout === true);

    const singleRecentLinkContextLabel = await wc.executeJavaScript('(() => { selectedRecentIds.clear(); const row = document.createElement("tr"); row.dataset.order = "1001"; showRecentContextMenu(row, 8, 8); const label = document.querySelector("#recentContextMenu [data-action=recent-copy-links]")?.textContent?.trim(); hideContextMenu(); return label; })()');
    check('Recent upload context menu uses singular copy text for one link', singleRecentLinkContextLabel === 'Link kopieren');

    const copyableLinkContextLabels = await wc.executeJavaScript(\`(() => {
      const previousJobs = queueJobs;
      const previousRecent = sessionFilesData;
      queueJobs = [
        { id: 'copyable-link', status: 'done', result: { download_url: 'https://example.invalid/copyable' } },
        { id: 'missing-link', status: 'done', result: null }
      ];
      rebuildJobIndex();
      selectedJobIds.clear();
      selectedJobIds.add('copyable-link');
      selectedJobIds.add('missing-link');
      showContextMenu(8, 8);
      const queueLabel = document.querySelector('#contextMenu [data-action=copy-links]')?.textContent?.trim();
      hideContextMenu();
      sessionFilesData = [
        { order: 2001, link: 'https://example.invalid/recent', isError: false },
        { order: 2002, link: '', isError: true }
      ];
      selectedRecentIds.clear();
      selectedRecentIds.add(2001);
      selectedRecentIds.add(2002);
      const row = document.createElement('tr');
      row.dataset.order = '2001';
      showRecentContextMenu(row, 8, 8);
      const recentLabel = document.querySelector('#recentContextMenu [data-action=recent-copy-links]')?.textContent?.trim();
      hideContextMenu();
      queueJobs = previousJobs;
      sessionFilesData = previousRecent;
      selectedJobIds.clear();
      selectedRecentIds.clear();
      rebuildJobIndex();
      return { queueLabel, recentLabel };
    })()\`);
    check('Copy-link context labels count only links that can actually be copied', copyableLinkContextLabels.queueLabel === 'Link kopieren' && copyableLinkContextLabels.recentLabel === 'Link kopieren');
    const singularCopyFeedback = await wc.executeJavaScript(\`(async () => {
      const previousJobs = queueJobs;
      const previousRecent = sessionFilesData;
      setUiLanguage('de');
      sessionFilesData = [{ order: 2101, link: 'https://example.invalid/recent-one', isError: false }, { order: 2102, link: '', isError: true }];
      selectedRecentIds.clear();
      selectedRecentIds.add(2101);
      selectedRecentIds.add(2102);
      copySelectedRecentLinks();
      const recentGerman = document.getElementById('copyToast')?.textContent.trim();
      setUiLanguage('en');
      copySelectedRecentLinks();
      const recentEnglish = document.getElementById('copyToast')?.textContent.trim();
      queueJobs = [{ id: 'queue-copy-one', status: 'done', result: { download_url: 'https://example.invalid/queue-one' } }, { id: 'queue-copy-empty', status: 'done', result: null }];
      rebuildJobIndex();
      setUploadSidebarFilter('all');
      selectedJobIds.clear();
      selectedJobIds.add('queue-copy-one');
      selectedJobIds.add('queue-copy-empty');
      await handleContextAction('copy-links');
      const queueEnglish = document.getElementById('copyToast')?.textContent.trim();
      setUiLanguage('de');
      await handleContextAction('copy-links');
      const queueGerman = document.getElementById('copyToast')?.textContent.trim();
      queueJobs = previousJobs;
      sessionFilesData = previousRecent;
      selectedJobIds.clear();
      selectedRecentIds.clear();
      rebuildJobIndex();
      return { recentGerman, recentEnglish, queueGerman, queueEnglish };
    })()\`);
    check('One actually copied link uses singular feedback in queue and recent views in both languages', singularCopyFeedback.recentGerman === '1 Link kopiert' && singularCopyFeedback.recentEnglish === '1 link copied' && singularCopyFeedback.queueGerman === '1 Link kopiert' && singularCopyFeedback.queueEnglish === '1 link copied');

    let exportErrorDetail = 'Zugriff verweigert';
    ipcMain.removeHandler('save-text-file');
    ipcMain.handle('save-text-file', () => { throw new Error(exportErrorDetail); });
    await wc.executeJavaScript('setUiLanguage("en"); sessionFilesData = [{ order: 2201, timestamp: "2030-01-02T03:04:05.000Z", host: "voe.sx", link: "https://example.invalid/export", filename: "export.bin", isError: false }]; void (window.__uiExportErrorPromise = exportAllRecentFiles())');
    await waitUntil(() => wc.executeJavaScript('document.getElementById("appAlertModal")?.style.display === "flex"'));
    const englishExportError = await wc.executeJavaScript('document.getElementById("appAlertMessage")?.textContent?.trim()');
    await wc.executeJavaScript('document.getElementById("appAlertConfirmBtn")?.click(); window.__uiExportErrorPromise');
    exportErrorDetail = 'Access denied';
    await wc.executeJavaScript('setUiLanguage("de"); void (window.__uiExportErrorPromise = exportAllRecentFiles())');
    await waitUntil(() => wc.executeJavaScript('document.getElementById("appAlertModal")?.style.display === "flex"'));
    const germanExportError = await wc.executeJavaScript('document.getElementById("appAlertMessage")?.textContent?.trim()');
    await wc.executeJavaScript('document.getElementById("appAlertConfirmBtn")?.click(); window.__uiExportErrorPromise; delete window.__uiExportErrorPromise');
    restoreInitialIpcHandler('save-text-file');
    check('Dynamic export errors never mix German and English interface text', englishExportError === 'Export failed: Unknown error' && germanExportError === 'Export fehlgeschlagen: Unbekannter Fehler');

    const initialSessionReportHandler = initialIpcHandlers.get('export-session-report');
    let sessionReportResult = { ok: true, totalRows: 2 };
    ipcMain.removeHandler('export-session-report');
    ipcMain.handle('export-session-report', () => sessionReportResult);
    await wc.executeJavaScript('setUiLanguage("en"); document.getElementById("exportSessionReportBtn")?.click()');
    await waitUntil(() => wc.executeJavaScript('document.getElementById("appAlertModal")?.style.display === "flex"'));
    await wc.executeJavaScript('document.getElementById("appAlertConfirmBtn")?.click()');
    const sessionReportSuccess = await waitUntil(() => wc.executeJavaScript('document.getElementById("copyToast")?.textContent === "Session report with 2 uploads exported" ? document.getElementById("copyToast").textContent : null'));
    sessionReportResult = { ok: false };
    await wc.executeJavaScript('document.getElementById("exportSessionReportBtn")?.click()');
    await waitUntil(() => wc.executeJavaScript('document.getElementById("appAlertModal")?.style.display === "flex"'));
    await wc.executeJavaScript('document.getElementById("appAlertConfirmBtn")?.click()');
    await waitUntil(() => wc.executeJavaScript('document.getElementById("appAlertModal")?.style.display === "flex"'));
    const sessionReportFailure = await wc.executeJavaScript('document.getElementById("appAlertMessage")?.textContent');
    await wc.executeJavaScript('document.getElementById("appAlertConfirmBtn")?.click(); setUiLanguage("de")');
    ipcMain.removeHandler('export-session-report');
    if (initialSessionReportHandler) registerIpcHandler('export-session-report', initialSessionReportHandler);
    check('Session report success and failure feedback follows the active language', sessionReportSuccess === 'Session report with 2 uploads exported' && sessionReportFailure === 'The session report could not be exported.');

    const historySidebarInformation = await wc.executeJavaScript('(() => { const sidebar = document.querySelector("#history-view > .view-sidebar")?.getBoundingClientRect(); const section = document.querySelector("#history-view .view-sidebar-section")?.getBoundingClientRect(); const retention = document.getElementById("historySidebarRetention")?.textContent?.trim(); return Boolean(sidebar && section && section.top >= sidebar.top + sidebar.height * 0.55 && retention === "Alles behalten"); })()');
    check('History sidebar shows the active retention in its lower area', historySidebarInformation === true);

    const historyRetentionPickerContract = await wc.executeJavaScript('(() => { const label = document.querySelector(".history-retention-label"); const value = document.getElementById("historyRetentionValue"); const select = document.getElementById("historyRetentionSelect"); const trigger = document.getElementById("historyRetentionTrigger"); const menu = document.getElementById("historyRetentionMenu"); const exportButton = document.getElementById("exportHistoryBtn"); if (!label || !value || !select || !trigger || !menu || !exportButton) return "missing"; const textRect = element => { const range = document.createRange(); range.selectNodeContents(element); return range.getBoundingClientRect(); }; const labelTextRect = textRect(label); const valueTextRect = textRect(value); const triggerRect = trigger.getBoundingClientRect(); const exportRect = exportButton.getBoundingClientRect(); const textAligned = Math.abs(labelTextRect.bottom - valueTextRect.bottom) <= .5; return [select.hidden, trigger.textContent.trim(), menu.querySelectorAll("[role=option]").length, trigger.getAttribute("aria-haspopup"), trigger.getAttribute("aria-expanded"), parseFloat(getComputedStyle(label).fontSize), parseFloat(getComputedStyle(trigger).fontSize), textAligned, Math.abs(triggerRect.height - exportRect.height) <= 1].join("|"); })()');
    check('History retention uses a compact accessible picker with aligned text and export action', historyRetentionPickerContract === 'true|Alles behalten|6|listbox|false|13|13|true|true');

    await wc.executeJavaScript('document.getElementById("historyRetentionTrigger")?.click()');
    await new Promise(resolve => setTimeout(resolve, 60));
    const historyRetentionOpening = await wc.executeJavaScript('(() => { const menu = document.getElementById("historyRetentionMenu"); if (!menu) return "missing"; const style = getComputedStyle(menu); const clip = style.clipPath; return [style.display !== "none", menu.classList.contains("menu-opening"), clip !== "none" && !/^inset\\(0(px)?\\)$/.test(clip), parseFloat(style.animationDuration) >= .12, document.getElementById("historyRetentionTrigger")?.getAttribute("aria-expanded")].join("|"); })()');
    check('History retention menu visibly unfolds from top to bottom', historyRetentionOpening === 'true|true|true|true|true');
    await new Promise(resolve => setTimeout(resolve, 160));
    await captureVisual('04-history-retention-open.png');
    await wc.executeJavaScript('document.getElementById("historyRetentionTrigger")?.click()');
    await new Promise(resolve => setTimeout(resolve, 60));
    const historyRetentionClosing = await wc.executeJavaScript('(() => { const menu = document.getElementById("historyRetentionMenu"); if (!menu) return "missing"; const style = getComputedStyle(menu); const clip = style.clipPath; return [style.display !== "none", menu.classList.contains("menu-closing"), clip !== "none" && !/^inset\\(0(px)?\\)$/.test(clip), document.getElementById("historyRetentionTrigger")?.getAttribute("aria-expanded")].join("|"); })()');
    check('History retention menu remains visible while folding from bottom to top', historyRetentionClosing === 'true|true|true|false');
    await new Promise(resolve => setTimeout(resolve, 160));
    const historyRetentionClosed = await wc.executeJavaScript('document.getElementById("historyRetentionMenu") ? getComputedStyle(document.getElementById("historyRetentionMenu")).display : "missing"');
    check('History retention menu is hidden after its closing motion', historyRetentionClosed === 'none');

    await wc.executeJavaScript('document.getElementById("historyRetentionTrigger")?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))');
    await new Promise(resolve => setTimeout(resolve, 200));
    const historyRetentionKeyboardOpen = await wc.executeJavaScript('(() => { const trigger = document.getElementById("historyRetentionTrigger"); const selected = document.querySelector("#historyRetentionMenu [aria-selected=true]"); return [trigger?.getAttribute("aria-expanded"), document.activeElement === selected].join("|"); })()');
    check('History retention picker opens from the keyboard and focuses the selected option', historyRetentionKeyboardOpen === 'true|true');
    await wc.executeJavaScript('document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
    await new Promise(resolve => setTimeout(resolve, 200));
    const historyRetentionKeyboardClosed = await wc.executeJavaScript('(() => { const trigger = document.getElementById("historyRetentionTrigger"); const menu = document.getElementById("historyRetentionMenu"); return [trigger?.getAttribute("aria-expanded"), getComputedStyle(menu).display, document.activeElement === trigger].join("|"); })()');
    check('Escape closes the history retention picker and restores trigger focus', historyRetentionKeyboardClosed === 'false|none|true');

    await wc.executeJavaScript('document.getElementById("historyRetentionTrigger")?.click()');
    await new Promise(resolve => setTimeout(resolve, 200));
    await wc.executeJavaScript('document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))');
    await new Promise(resolve => setTimeout(resolve, 60));
    const historyRetentionOutsideClosing = await wc.executeJavaScript('document.getElementById("historyRetentionMenu")?.classList.contains("menu-closing")');
    check('Clicking outside starts the history retention closing motion', historyRetentionOutsideClosing === true);
    await new Promise(resolve => setTimeout(resolve, 160));

    const historyClearAction = await wc.executeJavaScript('(() => { const button = document.getElementById("clearHistoryBtn"); window.__historyOriginalConfirm = window.confirm; window.__historyNativeConfirmCalls = 0; window.confirm = () => { window.__historyNativeConfirmCalls++; return false; }; button?.click(); const modal = document.getElementById("historyClearModal"); return [button?.classList.contains("btn-danger"), button?.disabled, window.__historyNativeConfirmCalls, modal?.style.display, modal?.getAttribute("aria-hidden"), document.getElementById("historyClearModalTitle")?.textContent?.trim(), document.activeElement?.id].join("|"); })()');
    check('History clear uses a red enabled action and opens the styled confirmation dialog with safe default focus', historyClearAction === 'true|false|0|flex|false|Verlauf löschen?|cancelHistoryClearBtn');
    const historyClearMessage = await wc.executeJavaScript('document.getElementById("historyClearModalMessage")?.textContent?.trim()');
    check('History clear dialog explains that deletion is permanent', historyClearMessage === 'Alle Verlaufseinträge werden dauerhaft gelöscht. Dieser Vorgang kann nicht rückgängig gemacht werden.');
    const historyClearModalKeyboard = await wc.executeJavaScript('(() => { const modal = document.getElementById("historyClearModal"); const close = document.getElementById("closeHistoryClearModalBtn"); const confirm = document.getElementById("confirmHistoryClearBtn"); const backgroundInert = document.querySelector(".app-header")?.inert === true && document.getElementById("history-view")?.inert === true; confirm.focus(); confirm.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })); const forwardFocus = document.activeElement?.id; close.focus(); close.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })); return { backgroundInert, forwardFocus, backwardFocus: document.activeElement?.id, inside: modal?.contains(document.activeElement) }; })()');
    check('History clear dialog traps keyboard focus and isolates the background', historyClearModalKeyboard.backgroundInert && historyClearModalKeyboard.forwardFocus === 'closeHistoryClearModalBtn' && historyClearModalKeyboard.backwardFocus === 'confirmHistoryClearBtn' && historyClearModalKeyboard.inside);
    const historyClearEscapeState = await wc.executeJavaScript('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); (() => ({ display: document.getElementById("historyClearModal")?.style.display, focus: document.activeElement?.id, headerInert: document.querySelector(".app-header")?.inert, viewInert: document.getElementById("history-view")?.inert }))()');
    check('Closing the history clear dialog restores its trigger focus and background', historyClearEscapeState.display === 'none' && historyClearEscapeState.focus === 'clearHistoryBtn' && historyClearEscapeState.headerInert === false && historyClearEscapeState.viewInert === false);
    await wc.executeJavaScript('document.getElementById("clearHistoryBtn")?.click()');
    await captureVisual('04-history-clear-modal.png');
    await wc.executeJavaScript('document.getElementById("confirmHistoryClearBtn")?.click(); true');
    await waitUntil(() => wc.executeJavaScript('document.getElementById("clearHistoryBtn")?.disabled'));
    const clearedHistoryState = await wc.executeJavaScript('(() => { const modal = document.getElementById("historyClearModal"); const button = document.getElementById("clearHistoryBtn"); button?.click(); return [modal?.style.display, modal?.getAttribute("aria-hidden"), button?.disabled, document.querySelector("#historyContainer .empty-state")?.textContent?.trim()].join("|"); })()');
    check('Clearing history closes the dialog and disables the action for the empty state', clearHistoryCallCount === 1 && clearedHistoryState === 'none|true|true|Noch keine Uploads.');
    await captureVisual('04-history-empty.png');
    historyFixture = [{ timestamp: '2026-08-10T10:00:00.000Z', files: [{ name: 'ok.bin', results: [{ status: 'done', hoster: 'voe.sx', download_url: 'https://example.invalid/ok' }] }, { name: 'bad.bin', results: [{ status: 'error', hoster: 'byse.sx', error: 'Zugang abgelehnt' }] }, { name: 'stopped.bin', results: [{ status: 'aborted', hoster: 'doodstream.com' }] }, { name: 'large.bin', results: [{ status: 'skipped', hoster: 'vidmoly.me', error: 'Datei zu groß' }] }] }];
    await wc.executeJavaScript('loadHistory().then(() => { window.confirm = window.__historyOriginalConfirm; delete window.__historyOriginalConfirm; })');

    const historyFrameFit = await wc.executeJavaScript('(() => { const view = document.getElementById("history-view")?.getBoundingClientRect(); return Boolean(view && view.bottom <= window.innerHeight + 1); })()');
    check('History view fits inside the viewport', historyFrameFit === true);

    await captureVisual('04-history.png');

    const emptyState = await wc.executeJavaScript('document.querySelector("#historyContainer .empty-state")?.textContent');
    check('Empty state or history table shown', emptyState === 'Noch keine Uploads.' || emptyState === undefined);

    const historyFilterState = await wc.executeJavaScript(\`(() => {
      const inspect = (value) => {
        document.querySelector('[data-history-filter="' + value + '"]').click();
        return {
          rows: [...document.querySelectorAll('#historyBody .history-row')].map(row => row.querySelector('.col-filename')?.textContent).sort(),
          errors: document.querySelectorAll('#historyBody .history-row.error').length,
          pressed: [...document.querySelectorAll('[data-history-filter]')].filter(button => button.getAttribute('aria-pressed') === 'true').map(button => button.dataset.historyFilter),
          active: [...document.querySelectorAll('[data-history-filter].active')].map(button => button.dataset.historyFilter)
        };
      };
      const initial = {
        data: historyRowsData.length,
        rows: [...document.querySelectorAll('#historyBody .history-row')].map(row => row.querySelector('.col-filename')?.textContent).sort(),
        errors: document.querySelectorAll('#historyBody .history-row.error').length,
        counts: ['historySidebarAllCount', 'historySidebarSuccessCount', 'historySidebarErrorCount', 'historySidebarSkippedCount'].map(id => document.getElementById(id)?.textContent)
      };
      const success = inspect('success');
      const error = inspect('error');
      const skipped = inspect('skipped');
      const all = inspect('all');
      return { initial, success, error, skipped, all, sourceLength: historyRowsData.length };
    })()\`);
    check('History keeps failed and skipped results in the renderer data model and All view', historyFilterState.initial.data === 4 && historyFilterState.initial.rows.join('|') === 'bad.bin|large.bin|ok.bin|stopped.bin' && historyFilterState.initial.errors === 2 && historyFilterState.initial.counts.join('|') === '4|1|2|1');
    check('History sidebar filters successful, failed, and skipped rows without dropping source data', historyFilterState.success.rows.join('|') === 'ok.bin' && historyFilterState.success.errors === 0 && historyFilterState.error.rows.join('|') === 'bad.bin|stopped.bin' && historyFilterState.error.errors === 2 && historyFilterState.skipped.rows.join('|') === 'large.bin' && historyFilterState.all.rows.length === 4 && historyFilterState.sourceLength === 4);
    check('History sidebar exposes exactly one pressed filter', historyFilterState.success.pressed.join('|') === 'success' && historyFilterState.success.active.join('|') === 'success' && historyFilterState.error.pressed.join('|') === 'error' && historyFilterState.error.active.join('|') === 'error' && historyFilterState.skipped.pressed.join('|') === 'skipped' && historyFilterState.skipped.active.join('|') === 'skipped' && historyFilterState.all.pressed.join('|') === 'all' && historyFilterState.all.active.join('|') === 'all');

    const skippedHistoryPresentation = await wc.executeJavaScript('(() => { document.querySelector("[data-history-filter=skipped]")?.click(); const row = document.querySelector("#historyBody .history-row.skipped"); return [row?.querySelector(".col-filename")?.textContent, row?.querySelector(".history-link-text")?.textContent, Boolean(row?.querySelector(".history-copy-link"))].join("|"); })()');
    check('Skipped history rows show their reason without a link-copy action', skippedHistoryPresentation === 'large.bin|Datei zu groß|false');
    await wc.executeJavaScript('document.querySelector("[data-history-filter=all]")?.click()');

    const historyCopyControls = await wc.executeJavaScript('(() => { const rows = [...document.querySelectorAll("#historyBody .history-row")]; const buttons = rows.map(row => row.querySelector(".history-copy-link")).filter(Boolean); const inside = buttons.every(button => { const cell = button.closest(".col-link"); const cellRect = cell?.getBoundingClientRect(); const buttonRect = button.getBoundingClientRect(); return cellRect && buttonRect && buttonRect.right <= cellRect.right + 1 && buttonRect.left >= cellRect.left; }); return [buttons.length, buttons.every(button => button.getAttribute("aria-label") === "Link kopieren"), inside].join("|"); })()');
    check('Successful history links expose an in-cell copy action', historyCopyControls === '1|true|true');
    const historyCopyAction = await wc.executeJavaScript('document.querySelector(".history-copy-link")?.click(); document.getElementById("copyToast")?.textContent?.trim()');
    check('History copy action confirms the copied link', historyCopyAction === 'Link kopiert');
    await wc.executeJavaScript('document.getElementById("copyToast")?.classList.remove("show")');

    const historyErrorContrast = await wc.executeJavaScript(\`(() => {
      document.querySelector('[data-history-filter="error"]').click();
      const row = document.querySelector('#historyBody .history-row.error');
      if (!row) return 0;
      const parse = value => (value.match(/[0-9.]+/g) || []).slice(0, 3).map(Number);
      const foreground = parse(getComputedStyle(row).color);
      let node = row;
      let background = [32, 32, 32];
      while (node) {
        const value = getComputedStyle(node).backgroundColor;
        if (value && value !== 'rgba(0, 0, 0, 0)' && value !== 'transparent') {
          background = parse(value);
          break;
        }
        node = node.parentElement;
      }
      const opacity = Number(getComputedStyle(row).opacity);
      const effective = foreground.map((channel, index) => channel * opacity + background[index] * (1 - opacity));
      const luminance = rgb => {
        const values = rgb.map(channel => {
          const value = channel / 255;
          return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2];
      };
      const foregroundLuminance = luminance(effective);
      const backgroundLuminance = luminance(background);
      return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
    })()\`);
    check('Failed history rows keep readable text contrast (' + historyErrorContrast.toFixed(2) + ':1)', historyErrorContrast >= 4.5);

    await wc.executeJavaScript('setUiLanguage("en")');
    const dynamicEnglishValues = await wc.executeJavaScript('(() => { const values = []; const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let node = walker.nextNode(); while (node) { const value = node.nodeValue.trim(); if (value) values.push(value); node = walker.nextNode(); } values.push(...[...document.querySelectorAll("[title],[aria-label],[placeholder],[data-tooltip]")].flatMap(element => [element.title, element.getAttribute("aria-label"), element.getAttribute("placeholder"), element.getAttribute("data-tooltip")])); return [...new Set(values.filter(Boolean))]; })()');
    const dynamicEnglishResidue = dynamicEnglishValues.filter(containsGermanTerm);
    if (dynamicEnglishResidue.length) console.log('Dynamic English residue: ' + JSON.stringify(dynamicEnglishResidue, null, 2));
    check('English translation covers dynamically rendered interface states', dynamicEnglishResidue.length === 0);

    const explicitDynamicEnglish = await wc.executeJavaScript(\`(() => {
      queueJobs = [
        { id: 'ui-waiting', file: 'C:/ui/waiting.bin', fileName: 'waiting.bin', hoster: 'byse.sx', status: 'queued', bytesUploaded: 0, bytesTotal: 100, progress: 0 },
        { id: 'ui-aborted', file: 'C:/ui/aborted.bin', fileName: 'aborted.bin', hoster: 'byse.sx', status: 'aborted', error: 'Abgebrochen', bytesUploaded: 0, bytesTotal: 100, progress: 0 },
        { id: 'ui-failed', file: 'C:/ui/failed.bin', fileName: 'failed.bin', hoster: 'byse.sx', status: 'error', error: 'Fehlgeschlagen: Verbindung verloren', bytesUploaded: 0, bytesTotal: 100, progress: 0 }
      ];
      rebuildJobIndex();
      setUploadSidebarFilter('all');
      updateUploadView();
      renderQueueTable();
      showCopyToast('Link kopiert', 5000);
      handleShutdownCountdown({ mode: 'sleep', seconds: 30 });
      const values = [...document.querySelectorAll('#queueBody .col-status')].map(cell => cell.textContent.trim());
      const titles = [...document.querySelectorAll('#queueBody .col-status')].map(cell => cell.title);
      const result = { values, titles, toast: document.getElementById('copyToast').textContent.trim(), shutdown: document.getElementById('shutdownMessage').textContent.trim() };
      clearInterval(shutdownCountdownInterval);
      shutdownCountdownInterval = null;
      modalController.close('shutdownOverlay', { restoreFocus: false });
      document.getElementById('copyToast').classList.remove('show');
      return result;
    })()\`);
    const expectedDynamicEnglish = ['Waiting', 'Canceled', 'Failed: Connection lost'].sort().join('|');
    const explicitDynamicEnglishValid = [...explicitDynamicEnglish.values].sort().join('|') === expectedDynamicEnglish && [...explicitDynamicEnglish.titles].sort().join('|') === expectedDynamicEnglish && explicitDynamicEnglish.toast === 'Link copied' && explicitDynamicEnglish.shutdown === 'Sleep in 30s...';
    if (!explicitDynamicEnglishValid) console.log('Explicit dynamic English: ' + JSON.stringify(explicitDynamicEnglish));
    check('English runtime statuses, status tooltips, toast, and shutdown copy are localized', explicitDynamicEnglishValid);

    const englishSettingsSearch = await wc.executeJavaScript(\`(() => {
      document.querySelector('.tab[data-view="settings"]').click();
      const search = document.getElementById('settingsSearchInput');
      const inspect = value => {
        search.value = value;
        search.dispatchEvent(new Event('input', { bubbles: true }));
        return [...document.querySelectorAll('.settings-nav-button')].filter(button => !button.hidden).map(button => button.dataset.settingsPage);
      };
      const notifications = inspect('notifications');
      const windowSettings = inspect('window');
      search.value = '';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      return { notifications, windowSettings };
    })()\`);
    check('English settings search finds localized concepts', englishSettingsSearch.notifications.includes('benachrichtigungen') && englishSettingsSearch.windowSettings.includes('allgemein'));

    const productNaming = await wc.executeJavaScript(\`(() => ({
      title: document.title,
      brand: document.querySelector('.app-brand-name')?.textContent.trim(),
      label: document.querySelector('.app-brand')?.getAttribute('aria-label')
    }))()\`);
    check('User-visible product naming is consistent', productNaming.title === 'Multi Hoster Uploader' && productNaming.brand === 'MULTI HOSTER UPLOADER' && productNaming.label === 'Multi Hoster Uploader');
    await wc.executeJavaScript('setUiLanguage("de")');

    console.log('\\n=== Global UI ===');

    const shutdownHidden = await wc.executeJavaScript('document.getElementById("shutdownOverlay")?.style.display');
    check('Shutdown overlay hidden', shutdownHidden === 'none');

    const toastHidden = await wc.executeJavaScript('!document.getElementById("copyToast")?.classList.contains("show")');
    check('Copy toast hidden', toastHidden);

    const toastSemantics = await wc.executeJavaScript('document.getElementById("copyToast")?.getAttribute("role") + "|" + document.getElementById("copyToast")?.getAttribute("aria-live")');
    check('Copy toast exposes polite status semantics', toastSemantics === 'status|polite');

    const emptyActionState = await wc.executeJavaScript(\`(() => {
      queueJobs = [];
      sessionFilesData = [];
      historyRowsData = [];
      rebuildJobIndex();
      renderQueueTable();
      renderRecentUploadsPanel();
      syncHistoryClearAction();
      return [
        document.getElementById('copyAllLinksBtn')?.disabled,
        document.getElementById('clearRecentFilesBtn')?.disabled,
        document.getElementById('exportRecentFilesBtn')?.disabled,
        document.getElementById('exportHistoryBtn')?.disabled,
        document.getElementById('clearHistoryBtn')?.disabled
      ].join('|');
    })()\`);
    check('Unavailable recent, queue, and history actions are disabled', emptyActionState === 'true|true|true|true|true');

    const recentLocaleState = await wc.executeJavaScript(\`(() => {
      const timestamp = Date.UTC(2026, 7, 10, 13, 14, 15);
      setUiLanguage('de');
      sessionFilesData = [{ date: formatDateTime(timestamp).text, dateTs: timestamp, filename: 'locale.bin', host: 'voe.sx', link: 'https://example.invalid/locale', isError: false, order: 1 }];
      _recentDataVersion++;
      renderRecentUploadsPanel();
      const german = document.querySelector('#recentFilesBody .recent-file-row td')?.textContent.trim();
      setUiLanguage('en');
      const english = document.querySelector('#recentFilesBody .recent-file-row td')?.textContent.trim();
      const expectedEnglish = formatDateTime(timestamp).text;
      setUiLanguage('de');
      sessionFilesData = [];
      _recentDataVersion++;
      renderRecentUploadsPanel();
      return { german, english, expectedEnglish };
    })()\`);
    check('Recent upload timestamps immediately follow the selected interface language', recentLocaleState.german !== recentLocaleState.english && recentLocaleState.english === recentLocaleState.expectedEnglish);

    const recentCapScrollState = await wc.executeJavaScript(\`(() => {
      document.querySelector('.tab[data-view="upload"]')?.click();
      queueJobs = [{ id: 'ui-recent-cap', file: 'C:/ui/recent-cap.bin', fileName: 'recent-cap.bin', hoster: 'byse.sx', status: 'queued', bytesUploaded: 0, bytesTotal: 100, progress: 0 }];
      rebuildJobIndex();
      updateUploadView();
      renderQueueTable();
      recentSortState.key = 'date';
      recentSortState.direction = 'desc';
      sessionFilesData = Array.from({ length: SESSION_FILES_CAP }, (_, index) => ({
        date: String(index),
        dateTs: index,
        filename: 'cap-' + index + '.bin',
        host: 'byse.sx',
        link: 'https://example.invalid/cap-' + index,
        isError: false,
        order: index
      }));
      _recentDataVersion++;
      renderRecentUploadsPanel();
      const wrap = document.querySelector('.recent-files-table-wrap');
      wrap.scrollTop = 560;
      const before = wrap.scrollTop;
      sessionFilesData = sessionFilesData.slice(1);
      sessionFilesData.push({ date: 'new', dateTs: SESSION_FILES_CAP + 1, filename: 'cap-new.bin', host: 'byse.sx', link: 'https://example.invalid/cap-new', isError: false, order: SESSION_FILES_CAP + 1 });
      _recentPendingAppends = 1;
      _recentDataVersion++;
      renderRecentUploadsPanel();
      const after = wrap.scrollTop;
      sessionFilesData = [];
      _recentPendingAppends = 0;
      _recentDataVersion++;
      renderRecentUploadsPanel();
      queueJobs = [];
      rebuildJobIndex();
      updateUploadView();
      renderQueueTable();
      return { before, after, delta: after - before };
    })()\`);
    if (!(recentCapScrollState.before > 0 && Math.abs(recentCapScrollState.delta - 28) <= 1)) console.log('Recent cap scroll state: ' + JSON.stringify(recentCapScrollState));
    check('A capped recent-upload list preserves the visible rows when a new item arrives', recentCapScrollState.before > 0 && Math.abs(recentCapScrollState.delta - 28) <= 1);

    const keyboardInteractionContract = await wc.executeJavaScript(\`(() => {
      HOSTERS.forEach(name => { config.hosters[name] = []; });
      config.hosters['byse.sx'] = [{ id: 'ui-keyboard-account', enabled: true, authType: 'api', apiKey: 'keyboard-key' }];
      accountStatuses = { 'ui-keyboard-account': { status: 'ok', message: 'Bereit' } };
      renderAccounts();
      queueJobs = [{ id: 'ui-keyboard-row', file: 'C:/ui/keyboard.bin', fileName: 'keyboard.bin', hoster: 'byse.sx', status: 'queued', bytesUploaded: 0, bytesTotal: 100, progress: 0 }];
      selectedJobIds.clear();
      rebuildJobIndex();
      setUploadSidebarFilter('all');
      updateUploadView();
      renderQueueTable();
      const row = document.querySelector('#queueBody .queue-row');
      row?.focus();
      row?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      const sortable = [...document.querySelectorAll('#queueTable th.sortable')];
      row?.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }));
      const queueMenuKeyboard = document.getElementById('contextMenu')?.style.display === 'block' && document.activeElement?.closest('#contextMenu') !== null;
      document.getElementById('contextMenu')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      const recentSortable = [...document.querySelectorAll('#recentFilesHead th.sortable')];
      const historySortable = [...document.querySelectorAll('#historyContainer th.sortable')];
      const accountAccordions = [...document.querySelectorAll('[data-hoster-toggle], [data-hoster-settings-toggle]')];
      const priorityHandles = [...document.querySelectorAll('.account-card-drag-handle')];
      const submenuTrigger = document.querySelector('.menu-submenu-trigger');
      return {
        rowFocusable: row?.tabIndex === 0,
        rowSelected: selectedJobIds.has('ui-keyboard-row'),
        sortableKeyboard: sortable.every(header => header.tabIndex === 0 && header.hasAttribute('aria-sort')),
        dropzoneButton: document.getElementById('dropZone')?.getAttribute('role') === 'button' && document.getElementById('dropZone')?.tabIndex === 0,
        menus: document.getElementById('contextMenu')?.getAttribute('role') === 'menu' && [...document.querySelectorAll('#contextMenu .ctx-item')].every(item => item.getAttribute('role') === 'menuitem' && item.tabIndex === -1),
        queueMenuKeyboard,
        secondarySortKeyboard: [...recentSortable, ...historySortable].every(header => header.tabIndex === 0 && header.hasAttribute('aria-sort')),
        accountKeyboard: accountAccordions.length > 0 && accountAccordions.every(header => header.getAttribute('role') === 'button' && header.tabIndex === 0) && priorityHandles.length > 0 && priorityHandles.every(handle => handle.getAttribute('role') === 'button' && handle.tabIndex === 0),
        submenuExpanded: submenuTrigger?.hasAttribute('aria-expanded') && submenuTrigger?.getAttribute('aria-haspopup') === 'menu'
      };
    })()\`);
    check('Queue, sorting, dropzone, context menus, and backup submenu expose keyboard interaction', Object.values(keyboardInteractionContract).every(Boolean));

    const dialogContract = await wc.executeJavaScript(\`showAppConfirm({ title: 'Prüfung', message: 'Wirklich fortfahren?', confirmText: 'Fortfahren', danger: true }).then(result => window.__appDialogResult = result); (() => {
      const modal = document.getElementById('appAlertModal');
      const dialog = modal?.querySelector('[role="dialog"]');
      const backgroundInert = document.querySelector('.app-header')?.inert === true && document.querySelector('.view.active')?.inert === true;
      return [modal?.style.display, dialog?.getAttribute('aria-modal'), document.activeElement?.id, backgroundInert].join('|');
    })()\`);
    check('Styled app dialog focuses the safe action and makes background inert', dialogContract === 'flex|true|appAlertCancelBtn|true');
    await wc.executeJavaScript('document.getElementById("appAlertCancelBtn")?.click()');

    const initialJobLogHandler = initialIpcHandlers.get('get-job-log');
    const jobLogRequests = [];
    ipcMain.removeHandler('get-job-log');
    ipcMain.handle('get-job-log', (_event, jobId) => new Promise(resolve => jobLogRequests.push({ jobId, resolve })));
    await wc.executeJavaScript(\`(() => {
      setUiLanguage('en');
      queueJobs = [
        { id: 'ui-job-log-a', file: 'C:/ui/job-log-a.bin', fileName: 'job-log-a.bin', hoster: 'voe.sx', status: 'error', error: 'stale-job-error', failureDetails: { status: 500 }, attempt: 1, maxAttempts: 3 },
        { id: 'ui-job-log-b', file: 'C:/ui/job-log-b.bin', fileName: 'job-log-b.bin', hoster: 'byse.sx', status: 'error', error: 'current-job-error', failureDetails: { status: 503 }, attempt: 2, maxAttempts: 3 }
      ];
      rebuildJobIndex();
      selectedJobIds.clear();
      selectedJobIds.add('ui-job-log-a');
      document.getElementById('addFilesBtn')?.focus();
      void showJobLogModal();
    })()\`);
    await waitUntil(() => jobLogRequests.length === 1);
    await wc.executeJavaScript('selectedJobIds.clear(); selectedJobIds.add("ui-job-log-b"); void showJobLogModal()');
    await waitUntil(() => jobLogRequests.length === 2);
    jobLogRequests[0].resolve([{ ts: Date.now(), kind: 'progress', status: 'error', error: 'stale-only' }]);
    await new Promise(resolve => setTimeout(resolve, 50));
    const staleJobLogResponse = await wc.executeJavaScript('({ title: document.getElementById("jobLogTitle")?.textContent, body: document.getElementById("jobLogBody")?.textContent })');
    jobLogRequests[1].resolve([{ ts: Date.now(), kind: 'progress', status: 'error', error: 'current-only' }]);
    await waitUntil(() => wc.executeJavaScript('document.getElementById("jobLogBody")?.textContent.includes("current-only")'));
    const currentJobLogResponse = await wc.executeJavaScript('({ title: document.getElementById("jobLogTitle")?.textContent, body: document.getElementById("jobLogBody")?.textContent, focusInside: document.getElementById("jobLogModal")?.contains(document.activeElement), ariaHidden: document.getElementById("jobLogModal")?.getAttribute("aria-hidden") })');
    check('Late job-log responses cannot overwrite the newer selected job', staleJobLogResponse.title === 'Log · job-log-b.bin' && !staleJobLogResponse.body.includes('stale-only') && currentJobLogResponse.title === 'Log · job-log-b.bin' && currentJobLogResponse.body.includes('current-only'));
    check('English multiline job logs localize every user-facing label', currentJobLogResponse.body.includes('Host: byse.sx') && currentJobLogResponse.body.includes('Account:') && currentJobLogResponse.body.includes('Attempt: 2 / 3') && currentJobLogResponse.body.includes('Failed: current-job-error') && currentJobLogResponse.body.includes('Diagnostics:\\nstatus: 503'));
    check('Job-log dialog opens accessibly with focus inside', currentJobLogResponse.focusInside === true && currentJobLogResponse.ariaHidden === 'false');
    await wc.executeJavaScript('selectedJobIds.clear(); selectedJobIds.add("ui-job-log-a"); void showJobLogModal()');
    await waitUntil(() => jobLogRequests.length === 3);
    const jobLogBodyBeforeClose = await wc.executeJavaScript('document.getElementById("jobLogBody")?.textContent');
    await wc.executeJavaScript('hideJobLogModal()');
    jobLogRequests[2].resolve([{ ts: Date.now(), kind: 'progress', status: 'done', error: 'closed-only' }]);
    await new Promise(resolve => setTimeout(resolve, 50));
    const closedJobLogResponse = await wc.executeJavaScript('({ display: document.getElementById("jobLogModal")?.style.display, ariaHidden: document.getElementById("jobLogModal")?.getAttribute("aria-hidden"), body: document.getElementById("jobLogBody")?.textContent, restoredFocus: document.activeElement?.id })');
    check('Closing the job log invalidates pending responses and restores focus', closedJobLogResponse.display === 'none' && closedJobLogResponse.ariaHidden === 'true' && closedJobLogResponse.body === jobLogBodyBeforeClose && closedJobLogResponse.restoredFocus === 'addFilesBtn');
    ipcMain.removeHandler('get-job-log');
    if (initialJobLogHandler) registerIpcHandler('get-job-log', initialJobLogHandler);

    const sharedModalLifecycle = await wc.executeJavaScript(\`(async () => {
      const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const opener = document.getElementById('addFilesBtn');
      const focusable = overlay => [...overlay.querySelectorAll('button:not([disabled]):not([hidden]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')].filter(element => !element.hidden && getComputedStyle(element).display !== 'none' && getComputedStyle(element).visibility !== 'hidden');
      setUiLanguage('de');
      opener.focus();
      openHosterModal();
      await settle();
      const hoster = document.getElementById('hosterModal');
      const hosterFocusable = focusable(hoster);
      const hosterOpened = { ariaHidden: hoster.getAttribute('aria-hidden'), focusInside: hoster.contains(document.activeElement), backgroundInert: document.querySelector('.app-header')?.inert === true && document.querySelector('.view.active')?.inert === true };
      hosterFocusable.at(-1)?.focus();
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
      const hosterTrap = document.activeElement === hosterFocusable[0];
      void showAppAlert('Obere Ebene');
      await settle();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      const topmost = document.getElementById('appAlertModal').style.display === 'none' && hoster.style.display === 'flex';
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await settle();
      const hosterClosed = hoster.style.display === 'none' && hoster.getAttribute('aria-hidden') === 'true' && document.activeElement === opener;

      const previousAccounts = config.hosters['byse.sx'];
      config.hosters['byse.sx'] = [{ id: 'ui-modal-delete-account', enabled: true, authType: 'api', apiKey: 'ui-modal-key' }];
      opener.focus();
      openDeleteAccountModal('ui-modal-delete-account');
      await settle();
      const deleteModal = document.getElementById('deleteAccountModal');
      const deleteOpened = { ariaHidden: deleteModal.getAttribute('aria-hidden'), focus: document.activeElement?.id, backgroundInert: document.querySelector('.app-header')?.inert === true };
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await settle();
      const deleteClosed = deleteModal.style.display === 'none' && deleteModal.getAttribute('aria-hidden') === 'true' && document.activeElement === opener;
      if (deleteModal.style.display !== 'none') closeDeleteModal();
      config.hosters['byse.sx'] = previousAccounts;

      opener.focus();
      document.getElementById('shutdownMessage').innerHTML = 'System wird heruntergefahren in <span id="shutdownSeconds">60</span>s...';
      handleShutdownCountdown({ mode: 'shutdown', seconds: 30 });
      await settle();
      const shutdown = document.getElementById('shutdownOverlay');
      const shutdownOpened = { ariaHidden: shutdown.getAttribute('aria-hidden'), focus: document.activeElement?.id, backgroundInert: document.querySelector('.app-header')?.inert === true };
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await new Promise(resolve => setTimeout(resolve, 50));
      const shutdownClosed = shutdown.style.display === 'none' && shutdown.getAttribute('aria-hidden') === 'true' && document.activeElement === opener;
      if (shutdown.style.display !== 'none') document.getElementById('cancelShutdownBtn')?.click();

      queueJobs = [];
      selectedFiles = [];
      selectedJobIds.clear();
      rebuildJobIndex();
      return { hosterOpened, hosterTrap, topmost, hosterClosed, deleteOpened, deleteClosed, shutdownOpened, shutdownClosed };
    })()\`);
    check('Shared modal behavior isolates and traps the hoster dialog with topmost Escape semantics', sharedModalLifecycle.hosterOpened.ariaHidden === 'false' && sharedModalLifecycle.hosterOpened.focusInside === true && sharedModalLifecycle.hosterOpened.backgroundInert === true && sharedModalLifecycle.hosterTrap === true && sharedModalLifecycle.topmost === true && sharedModalLifecycle.hosterClosed === true);
    check('Delete-account modal uses safe focus, background isolation, Escape, and focus restoration', sharedModalLifecycle.deleteOpened.ariaHidden === 'false' && sharedModalLifecycle.deleteOpened.focus === 'cancelDeleteBtn' && sharedModalLifecycle.deleteOpened.backgroundInert === true && sharedModalLifecycle.deleteClosed === true);
    check('Shutdown modal uses safe focus, background isolation, Escape, and focus restoration', sharedModalLifecycle.shutdownOpened.ariaHidden === 'false' && sharedModalLifecycle.shutdownOpened.focus === 'cancelShutdownBtn' && sharedModalLifecycle.shutdownOpened.backgroundInert === true && sharedModalLifecycle.shutdownClosed === true);

    const modalSemantics = await wc.executeJavaScript(\`(() => [
      [...document.querySelectorAll('[role="dialog"]')].length,
      [...document.querySelectorAll('[role="dialog"]')].every(dialog => dialog.getAttribute('aria-modal') === 'true' && dialog.tabIndex === -1),
      [...document.querySelectorAll('[role="dialog"]')].every(dialog => dialog.parentElement?.getAttribute('aria-hidden') === 'true')
    ].join('|'))()\`);
    check('Every renderer dialog has complete hidden modal semantics', modalSemantics === '8|true|true');

    const rapidViewStability = await wc.executeJavaScript(\`(async () => {
      const sequence = ['upload', 'accounts', 'settings', 'history', 'settings', 'accounts', 'upload', 'history', 'upload', 'accounts', 'history', 'settings'];
      const samples = [];
      for (const target of sequence) {
        document.querySelector('.tab[data-view="' + target + '"]')?.click();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const activeViews = [...document.querySelectorAll('.view.active')];
        const activeTabs = [...document.querySelectorAll('.tab.active')];
        const viewRect = activeViews[0]?.getBoundingClientRect();
        const speedRect = document.getElementById('uploadSpeedSparkline')?.getBoundingClientRect();
        const indicatorRect = document.querySelector('.tab-indicator')?.getBoundingClientRect();
        samples.push({
          target,
          activeViews: activeViews.length,
          activeTabs: activeTabs.length,
          activeView: activeViews[0]?.id,
          activeTab: activeTabs[0]?.dataset.view,
          viewVisible: Boolean(viewRect && viewRect.width > 0 && viewRect.height > 0),
          speedVisible: Boolean(speedRect && speedRect.width > 0 && speedRect.height > 0),
          indicatorVisible: Boolean(indicatorRect && indicatorRect.width > 0 && indicatorRect.height > 0),
          horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
        });
      }
      document.querySelector('.tab[data-view="upload"]')?.click();
      return samples;
    })()\`);
    const invalidViewFrames = rapidViewStability.filter(sample => sample.activeViews !== 1 || sample.activeTabs !== 1 || sample.activeView !== sample.target + '-view' || sample.activeTab !== sample.target || !sample.viewVisible || !sample.speedVisible || !sample.indicatorVisible || sample.horizontalOverflow);
    check('Rapid main-view switches never paint a blank, duplicate, or overflowing active view', rapidViewStability.length === 12 && invalidViewFrames.length === 0);

    const languageFrameStability = await wc.executeJavaScript(\`(async () => {
      const previousJobs = queueJobs;
      queueJobs = Array.from({ length: 1234 }, (_, index) => ({ id: 'ui-language-frame-done-' + index, status: 'done' }));
      _queueStatsCache = null;
      const languages = ['en', 'de', 'en', 'de', 'en', 'de', 'en', 'de', 'en', 'de', 'en', 'de'];
      const samples = [];
      for (const language of languages) {
        setUiLanguage(language);
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const metric = document.getElementById('uploadTelemetryCompleted');
        samples.push({
          requested: language,
          active: document.documentElement.lang,
          tabs: [...document.querySelectorAll('.tab')].map(tab => tab.textContent.trim()).join('|'),
          settingsTitle: document.querySelector('[data-subpage="allgemein"] .settings-page-header h3')?.textContent.trim(),
          uploadKicker: document.querySelector('#upload-view .view-sidebar-kicker')?.textContent.trim(),
          metricValues: [...(metric?.querySelectorAll(':scope > span') || [])].map(span => span.textContent.trim()),
          metricLabel: metric?.getAttribute('aria-label')
        });
      }
      queueJobs = previousJobs;
      _queueStatsCache = null;
      updateStatusBar();
      return samples;
    })()\`);
    const invalidLanguageFrames = languageFrameStability.filter(sample => sample.requested === 'en'
      ? sample.active !== 'en' || sample.tabs !== 'Upload|Accounts|Settings|History' || sample.settingsTitle !== 'General' || sample.uploadKicker !== 'Workspace' || sample.metricLabel !== '1,234' || sample.metricValues.length === 0 || sample.metricValues.some(value => value !== '0' && value !== '1,234')
      : sample.active !== 'de' || sample.tabs !== 'Upload|Accounts|Einstellungen|Verlauf' || sample.settingsTitle !== 'Allgemein' || sample.uploadKicker !== 'Arbeitsbereich' || sample.metricLabel !== '1.234' || sample.metricValues.length === 0 || sample.metricValues.some(value => value !== '0' && value !== '1.234'));
    if (invalidLanguageFrames.length) console.log('Invalid language frames: ' + JSON.stringify(invalidLanguageFrames));
    check('Rapid language switches expose only complete, locale-consistent painted frames', languageFrameStability.length === 12 && invalidLanguageFrames.length === 0);

    const rollingMetricStability = await wc.executeJavaScript(\`(async () => {
      setUiLanguage('de');
      await new Promise(resolve => setTimeout(resolve, 360));
      const metric = document.getElementById('uploadTelemetryCompleted');
      const initialRect = metric.getBoundingClientRect();
      const frames = [];
      const previousJobs = queueJobs;
      queueJobs = Array.from({ length: 999 }, (_, index) => ({ id: 'ui-rolling-done-' + index, status: 'done' }));
      for (let value = 1000; value <= 1020; value++) {
        queueJobs.push({ id: 'ui-rolling-done-' + value, status: 'done' });
        _queueStatsCache = null;
        updateStatusBar();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const rect = metric.getBoundingClientRect();
        frames.push({
          text: metric.textContent.trim(),
          label: metric.getAttribute('aria-label'),
          childCount: metric.querySelectorAll(':scope > span').length,
          width: rect.width,
          height: rect.height
        });
      }
      await new Promise(resolve => setTimeout(resolve, 360));
      const settled = { text: metric.textContent.trim(), label: metric.getAttribute('aria-label'), direction: metric.dataset.direction };
      queueJobs = previousJobs;
      _queueStatsCache = null;
      updateStatusBar();
      return { initialRect: { width: initialRect.width, height: initialRect.height }, frames, settled };
    })()\`);
    const invalidRollingFrames = rollingMetricStability.frames.filter(frame => !frame.text || !frame.label || frame.childCount < 1 || frame.childCount > 2 || Math.abs(frame.width - rollingMetricStability.initialRect.width) > 0.5 || Math.abs(frame.height - rollingMetricStability.initialRect.height) > 0.5);
    check('Rapid telemetry updates never expose an empty value or shift the metric layout', rollingMetricStability.frames.length === 21 && invalidRollingFrames.length === 0 && rollingMetricStability.settled.text === '1.020' && rollingMetricStability.settled.label === '1.020' && rollingMetricStability.settled.direction === 'none');

    await wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    const reducedMotionTelemetry = await wc.executeJavaScript(\`(() => {
      const metric = document.getElementById('uploadTelemetryCompleted');
      const originalAnimate = Element.prototype.animate;
      let animationCalls = 0;
      Element.prototype.animate = function (...args) {
        animationCalls++;
        return originalAnimate.apply(this, args);
      };
      metric.querySelectorAll(':scope > span').forEach(span => span.getAnimations().forEach(animation => animation.cancel()));
      metric.dataset.numericValue = '40';
      metric.setAttribute('aria-label', '40');
      metric.replaceChildren(Object.assign(document.createElement('span'), { textContent: '40' }));
      _setRollingUploadMetric('uploadTelemetryCompleted', 41);
      Element.prototype.animate = originalAnimate;
      return {
        animationCalls,
        text: metric.textContent.trim(),
        label: metric.getAttribute('aria-label'),
        direction: metric.dataset.direction,
        animations: metric.getAnimations({ subtree: true }).length
      };
    })()\`);
    check('Reduced motion renders telemetry numbers without Web Animations rolling', reducedMotionTelemetry.animationCalls === 0 && reducedMotionTelemetry.text === '41' && reducedMotionTelemetry.label === '41' && reducedMotionTelemetry.direction === 'none' && reducedMotionTelemetry.animations === 0);
    await wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });

    const virtualQueueStability = await wc.executeJavaScript(\`(async () => {
      const total = 1200;
      queueJobs = Array.from({ length: total }, (_, index) => ({
        id: 'ui-stress-' + index,
        file: 'C:/ui/stress-' + index + '.bin',
        fileName: 'stress-' + String(index).padStart(4, '0') + '.bin',
        hoster: 'byse.sx',
        status: 'uploading',
        bytesUploaded: 100,
        bytesTotal: 1000,
        speedKbs: 64,
        elapsed: 1,
        remaining: 9,
        progress: .1
      }));
      rebuildJobIndex();
      queueSortState.key = 'filename';
      queueSortState.direction = 'asc';
      setUploadSidebarFilter('all');
      updateUploadView();
      renderQueueTable();
      const container = document.getElementById('queueContainer');
      container.scrollTop = 5600;
      container.dispatchEvent(new Event('scroll'));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const tbody = document.getElementById('queueBody');
      const originalRows = [...tbody.querySelectorAll('.queue-row')];
      const originalIds = originalRows.map(row => row.dataset.jobId);
      const originalScrollTop = container.scrollTop;
      let childMutations = 0;
      let blankFrames = 0;
      let identityChanges = 0;
      const observer = new MutationObserver(records => {
        childMutations += records.filter(record => record.type === 'childList').length;
      });
      observer.observe(tbody, { childList: true });
      for (let frame = 0; frame < 36; frame++) {
        for (const id of originalIds) {
          const job = _jobIndexById.get(id);
          if (!job) continue;
          job.progress = Math.min(1, job.progress + .0005);
          job.bytesUploaded = Math.round(job.progress * job.bytesTotal);
        }
        renderQueueTable();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const rows = [...tbody.querySelectorAll('.queue-row')];
        if (!rows.length || rows.some(row => !row.querySelector('.col-filename')?.textContent.trim())) blankFrames++;
        if (rows.length !== originalRows.length || rows.some((row, index) => row !== originalRows[index])) identityChanges++;
      }
      observer.disconnect();
      const scrollDrift = Math.abs(container.scrollTop - originalScrollTop);
      const activeIds = new Set(originalIds);
      queueJobs.forEach(job => { job.status = activeIds.has(job.id) ? 'uploading' : 'done'; });
      setUploadSidebarFilter('active');
      updateUploadView();
      renderQueueTable();
      const result = {
        total,
        rendered: originalRows.length,
        childMutations,
        blankFrames,
        identityChanges,
        scrollDrift,
        filteredRows: tbody.querySelectorAll('.queue-row').length,
        filteredHasVirtualSpacer: Boolean(tbody.querySelector('.virtual-spacer'))
      };
      setUploadSidebarFilter('all');
      queueJobs = [];
      rebuildJobIndex();
      renderQueueTable();
      updateUploadView();
      updateStatusBar();
      return result;
    })()\`);
    check('High-frequency updates keep virtual queue rows mounted without blank frames or scroll jumps', virtualQueueStability.total === 1200 && virtualQueueStability.rendered > 0 && virtualQueueStability.rendered < 1200 && virtualQueueStability.childMutations === 0 && virtualQueueStability.blankFrames === 0 && virtualQueueStability.identityChanges === 0 && virtualQueueStability.scrollDrift <= 1);
    check('Switching from a virtual queue to a small filtered result removes virtual spacers', virtualQueueStability.filteredRows === virtualQueueStability.rendered && virtualQueueStability.filteredHasVirtualSpacer === false);

    await setWindowBounds({ ...win.getBounds(), width: 1100, height: 900 });
    await wc.executeJavaScript('document.querySelector(".tab[data-view=upload]")?.click(); queueJobs = [{ id: "ui-panel-resize", file: "C:/ui/panel-resize.bin", fileName: "panel-resize.bin", hoster: "byse.sx", status: "queued", bytesUploaded: 0, bytesTotal: 100, progress: 0 }]; rebuildJobIndex(); updateUploadView(); renderQueueTable(); document.getElementById("recentFilesPanel").style.flex = "0 0 600px"');
    await setWindowBounds({ ...win.getBounds(), width: 1100, height: 550 });
    const recentPanelResizeState = await wc.executeJavaScript('(() => { const panel = document.getElementById("recentFilesPanel"); const queue = document.getElementById("queueContainer"); return { panelHeight: panel.getBoundingClientRect().height, queueHeight: queue.getBoundingClientRect().height, viewportHeight: window.innerHeight }; })()');
    if (!(recentPanelResizeState.panelHeight <= recentPanelResizeState.viewportHeight * 0.7 + 1 && recentPanelResizeState.queueHeight >= 120)) console.log('Recent panel resize state: ' + JSON.stringify(recentPanelResizeState));
    check('A manually enlarged recent panel is clamped after a height-only window shrink', recentPanelResizeState.panelHeight <= recentPanelResizeState.viewportHeight * 0.7 + 1 && recentPanelResizeState.queueHeight >= 120);
    await setWindowBounds({ ...win.getBounds(), width: 1100, height: 900 });
    const initialHiddenResizeState = await wc.executeJavaScript('(() => { document.querySelector(".tab[data-view=upload]")?.click(); const panel = document.getElementById("recentFilesPanel"); panel.style.flex = "0 0 600px"; clampRecentPanelHeight(); const queue = document.getElementById("queueContainer"); return { basis: parseFloat(panel.style.flexBasis), panelHeight: panel.getBoundingClientRect().height, queueHeight: queue.getBoundingClientRect().height }; })()');
    await wc.executeJavaScript('document.querySelector(".tab[data-view=settings]")?.click()');
    await setWindowBounds({ ...win.getBounds(), width: 1100, height: 550 });
    const hiddenRecentPanelState = await wc.executeJavaScript('(() => { const panel = document.getElementById("recentFilesPanel"); return { basis: parseFloat(panel.style.flexBasis), panelHeight: panel.getBoundingClientRect().height }; })()');
    await wc.executeJavaScript('document.querySelector(".tab[data-view=upload]")?.click()');
    await new Promise(resolve => setTimeout(resolve, 140));
    const restoredRecentPanelState = await wc.executeJavaScript('(() => { const panel = document.getElementById("recentFilesPanel"); const queue = document.getElementById("queueContainer"); return { basis: parseFloat(panel.style.flexBasis), panelHeight: panel.getBoundingClientRect().height, queueHeight: queue.getBoundingClientRect().height, viewportHeight: window.innerHeight }; })()');
    const hiddenResizePreserved = hiddenRecentPanelState.panelHeight === 0 && Math.abs(hiddenRecentPanelState.basis - initialHiddenResizeState.basis) <= 0.5;
    const hiddenResizeRestored = restoredRecentPanelState.basis < initialHiddenResizeState.basis && restoredRecentPanelState.queueHeight >= 120 && restoredRecentPanelState.panelHeight <= restoredRecentPanelState.viewportHeight * 0.7 + 1;
    if (!(hiddenResizePreserved && hiddenResizeRestored)) console.log('Hidden recent panel resize state: ' + JSON.stringify({ initialHiddenResizeState, hiddenRecentPanelState, restoredRecentPanelState }));
    check('Resizing another tab preserves the requested recent height while hidden', hiddenResizePreserved);
    check('Returning to Upload reclamps the recent panel and restores queue space', hiddenResizeRestored);
    await wc.executeJavaScript('document.getElementById("recentFilesPanel").style.flex = ""; queueJobs = []; rebuildJobIndex(); updateUploadView(); renderQueueTable()');

    const resizeStability = [];
    for (let cycle = 0; cycle < 8; cycle++) {
      const width = cycle % 2 === 0 ? 800 : 1100;
      const height = cycle % 2 === 0 ? 550 : 750;
      await setWindowBounds({ ...win.getBounds(), width, height });
      resizeStability.push(await wc.executeJavaScript(\`(async () => {
        const samples = [];
        for (const target of ['upload', 'accounts', 'settings', 'history']) {
          document.querySelector('.tab[data-view="' + target + '"]')?.click();
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const active = document.querySelector('.view.active');
          const rect = active?.getBoundingClientRect();
          const settingsHeader = target === 'settings' ? document.querySelector('.settings-header') : null;
          const settingsHeaderRect = settingsHeader?.getBoundingClientRect();
          const settingsHeaderStyle = settingsHeader ? getComputedStyle(settingsHeader) : null;
          const settingsSaveButton = target === 'settings' ? document.getElementById('saveSettingsBtn') : null;
          const settingsSaveButtonStyle = settingsSaveButton ? getComputedStyle(settingsSaveButton) : null;
          samples.push({
            target,
            visible: Boolean(rect && rect.width > 0 && rect.height > 0),
            contained: Boolean(active && active.scrollWidth <= active.clientWidth + 1),
            activeViews: document.querySelectorAll('.view.active').length,
            settingsHeaderHeight: settingsHeaderRect?.height || null,
            settingsHeaderMetrics: settingsHeader ? {
              innerWidth: window.innerWidth,
              minHeight: settingsHeaderStyle.minHeight,
              saveHeight: settingsSaveButton.getBoundingClientRect().height,
              saveMinHeight: settingsSaveButtonStyle.minHeight
            } : null
          });
        }
        return {
          samples,
          documentContained: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
        };
      })()\`));
    }
    await setWindowBounds(originalBounds);
    await wc.executeJavaScript('document.querySelector(".tab[data-view=upload]")?.click()');
    const invalidResizeFrames = resizeStability.filter(cycle => !cycle.documentContained || cycle.samples.some(sample => !sample.visible || !sample.contained || sample.activeViews !== 1 || (sample.target === 'settings' && (sample.settingsHeaderHeight <= 0 || sample.settingsHeaderHeight > (sample.settingsHeaderMetrics.innerWidth <= 839 ? 58 : 64)))));
    if (invalidResizeFrames.length) console.log('Invalid resize frames: ' + JSON.stringify(invalidResizeFrames));
    check('Repeated minimum and standard resizes keep every view painted and contained', resizeStability.length === 8 && invalidResizeFrames.length === 0);
    if (rendererDiagnostics.length) console.log('Renderer diagnostics: ' + JSON.stringify(rendererDiagnostics));
    check('Dynamic rendering emits no renderer errors, failed loads, crashes, or unresponsive events', rendererDiagnostics.length === 0 && rendererUnresponsiveCount === 0);

    const updateHidden = await wc.executeJavaScript('document.getElementById("updateBanner")?.style.display');
    check('Update banner hidden', updateHidden === 'none');

    const queueProgressVisibility = {};
    for (const [label, width, height] of [['standard', 1100, 750], ['minimum', 800, 550]]) {
      await setWindowBounds({ ...win.getBounds(), width, height });
      queueProgressVisibility[label] = await wc.executeJavaScript(\`(() => {
        document.querySelector('.tab[data-view="upload"]').click();
        selectedFiles = [];
        queueJobs = [{ id: 'ui-responsive', file: 'C:/ui/responsive.bin', fileName: 'responsive.bin', hoster: 'byse.sx', status: 'uploading', bytesUploaded: 512, bytesTotal: 1024, speedKbs: 64, elapsed: 5, remaining: 5, progress: 0.5 }];
        rebuildJobIndex();
        setUploadSidebarFilter('all');
        updateUploadView();
        renderQueueTable();
        const container = document.getElementById('queueContainer');
        container.scrollLeft = 0;
        const header = document.querySelector('#queueTable thead .col-progress');
        const cell = document.querySelector('#queueBody .queue-row .col-progress');
        const row = document.querySelector('#queueBody .queue-row');
        const containerRect = container.getBoundingClientRect();
        const headerRect = header?.getBoundingClientRect();
        const cellRect = cell?.getBoundingClientRect();
        const sidebarIndicatorRect = document.querySelector('#upload-view .view-sidebar-indicator')?.getBoundingClientRect();
        const activeSidebarRect = document.querySelector('#upload-view .view-sidebar-item.active')?.getBoundingClientRect();
        return {
          headerVisible: Boolean(headerRect && headerRect.width > 0 && headerRect.left >= containerRect.left - 1 && headerRect.right <= containerRect.right + 1),
          cellVisible: Boolean(cellRect && cellRect.width > 0 && cellRect.left >= containerRect.left - 1 && cellRect.right <= containerRect.right + 1),
          containerRect: { left: containerRect.left, right: containerRect.right, width: containerRect.width },
          headerRect: headerRect ? { left: headerRect.left, right: headerRect.right, width: headerRect.width } : null,
          cellRect: cellRect ? { left: cellRect.left, right: cellRect.right, width: cellRect.width } : null,
          headerHeight: headerRect?.height,
          rowHeight: row?.getBoundingClientRect().height,
          sidebarIndicatorAligned: Boolean(sidebarIndicatorRect && activeSidebarRect && Math.abs(sidebarIndicatorRect.top - activeSidebarRect.top) <= 1 && Math.abs(sidebarIndicatorRect.width - activeSidebarRect.width) <= 1 && Math.abs(sidebarIndicatorRect.height - activeSidebarRect.height) <= 1)
        };
      })()\`);
    }
    const compactSettingsHeader = await wc.executeJavaScript('document.querySelector(".tab[data-view=settings]").click(); document.querySelector(".settings-header")?.getBoundingClientRect().height');
    const minimumResponsiveContract = await wc.executeJavaScript(\`(() => {
      const fits = element => !element || element.scrollWidth <= element.clientWidth + 1;
      const settingsSidebar = document.querySelector('.settings-sidebar');
      const settingsSearch = document.querySelector('.settings-search-control');
      document.querySelector('[data-settings-page="logs"]')?.click();
      const logRowsFit = [...document.querySelectorAll('[data-subpage="logs"] .settings-row')].every(fits);
      document.querySelector('.tab[data-view="accounts"]').click();
      const autoCheck = document.querySelector('.accounts-auto-check');
      const autoCheckVisible = Boolean(autoCheck && getComputedStyle(autoCheck).display !== 'none' && autoCheck.getBoundingClientRect().width > 0);
      const accountsMain = document.querySelector('#accounts-view .view-main');
      const accountsMainFits = fits(accountsMain);
      const healthOverview = document.getElementById('hosterHealthOverview');
      const healthScroller = healthOverview?.querySelector('.hoster-health-scroll');
      const healthRect = healthOverview?.getBoundingClientRect();
      const accountsRect = accountsMain?.getBoundingClientRect();
      const healthOverviewFits = Boolean(healthRect && accountsRect && healthRect.left >= accountsRect.left - 1 && healthRect.right <= accountsRect.right + 1 && fits(healthOverview) && healthScroller?.scrollWidth >= healthScroller?.clientWidth);
      document.querySelector('.tab[data-view="upload"]').click();
      const telemetry = document.getElementById('uploadTelemetry');
      const availability = document.getElementById('uploadAvailability');
      const speedGraphs = [...document.querySelectorAll('.tab')].map(tab => {
        tab.click();
        const header = document.querySelector('.app-header')?.getBoundingClientRect();
        const widget = document.getElementById('uploadSpeedSparkline')?.getBoundingClientRect();
        const canvas = document.getElementById('uploadSpeedCanvas')?.getBoundingClientRect();
        return Boolean(header && widget && canvas && canvas.width > 0 && canvas.height > 0 && widget.left >= header.left && widget.right <= header.right + 1);
      });
      document.querySelector('.tab[data-view="upload"]').click();
      return {
        settingsSidebarFits: fits(settingsSidebar),
        settingsSearchFits: fits(settingsSearch),
        logRowsFit,
        autoCheckVisible,
        accountsMainFits,
        healthOverviewFits,
        telemetryVisible: Boolean(telemetry && getComputedStyle(telemetry).display !== 'none'),
        availabilityVisible: Boolean(availability && getComputedStyle(availability).display !== 'none'),
        speedGraphs
      };
    })()\`);
    await setWindowBounds(originalBounds);
    await wc.executeJavaScript('queueJobs = []; rebuildJobIndex(); updateUploadView(); renderQueueTable(); updateStatusBar();');
    if (!(queueProgressVisibility.minimum.headerVisible && queueProgressVisibility.minimum.cellVisible)) console.log('Queue progress visibility: ' + JSON.stringify(queueProgressVisibility));
    check('Upload progress stays visible at the standard window size', queueProgressVisibility.standard.headerVisible && queueProgressVisibility.standard.cellVisible);
    check('Upload progress stays visible at the minimum window size', queueProgressVisibility.minimum.headerVisible && queueProgressVisibility.minimum.cellVisible);
    check('Responsive queue keeps a compact table header', queueProgressVisibility.standard.headerHeight <= 34 && queueProgressVisibility.minimum.headerHeight <= 34);
    check('Responsive queue keeps the fixed virtual row height', queueProgressVisibility.standard.rowHeight === 28 && queueProgressVisibility.minimum.rowHeight === 28);
    check('Sidebar indicator stays aligned at the standard window size', queueProgressVisibility.standard.sidebarIndicatorAligned);
    check('Sidebar indicator stays aligned at the minimum window size', queueProgressVisibility.minimum.sidebarIndicatorAligned);
    check('Minimum window keeps the settings header compact', compactSettingsHeader <= 58);
    check('Minimum settings sidebar, search, and log rows stay contained', minimumResponsiveContract.settingsSidebarFits && minimumResponsiveContract.settingsSearchFits && minimumResponsiveContract.logRowsFit);
    if (!(minimumResponsiveContract.autoCheckVisible && minimumResponsiveContract.accountsMainFits)) console.log('Minimum responsive contract: ' + JSON.stringify(minimumResponsiveContract));
    check('Minimum Accounts keeps auto-check and host health reachable with content contained', minimumResponsiveContract.autoCheckVisible && minimumResponsiveContract.accountsMainFits && minimumResponsiveContract.healthOverviewFits);
    check('Minimum Uploads preserves availability and telemetry information', minimumResponsiveContract.telemetryVisible && minimumResponsiveContract.availabilityVisible);
    check('Minimum window keeps the speed graph visible and contained on every main tab', minimumResponsiveContract.speedGraphs.length === 4 && minimumResponsiveContract.speedGraphs.every(Boolean));

    let reducedMotionState = null;
    const debuggerWasAttached = wc.debugger.isAttached();
    try {
      if (!debuggerWasAttached) wc.debugger.attach('1.3');
      await wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      reducedMotionState = await wc.executeJavaScript('(() => { const temporary = ["progress-bar-fill", "account-collapse"].map(className => { const element = document.createElement("div"); element.className = className; document.body.append(element); return element; }); const seconds = value => value.split(",").map(Number.parseFloat); const selectors = [".tab-indicator", ".view-sidebar-indicator", ".settings-nav-indicator", ".language-picker-indicator", ".progress-bar-fill", ".account-collapse"]; const elements = selectors.map(selector => document.querySelector(selector)); const transitionDurations = elements.flatMap(element => element ? seconds(getComputedStyle(element).transitionDuration) : []); const menu = document.querySelector("[data-menu-dropdown=datei]"); menu.classList.add("menu-opening"); const animationDurations = seconds(getComputedStyle(menu).animationDuration); menu.classList.remove("menu-opening"); temporary.forEach(element => element.remove()); return { media: matchMedia("(prefers-reduced-motion: reduce)").matches, missing: selectors.filter((selector, index) => !elements[index]), transitionDurations, animationDurations }; })()');
    } finally {
      await wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] }).catch(() => {});
      if (!debuggerWasAttached && wc.debugger.isAttached()) wc.debugger.detach();
    }
    check('Reduced-motion preference suppresses the central interface animations', reducedMotionState?.media === true && reducedMotionState.missing.length === 0 && reducedMotionState.transitionDurations.length > 0 && reducedMotionState.transitionDurations.every(duration => duration <= 0.001) && reducedMotionState.animationDurations.every(duration => duration <= 0.001));

    rendererInitializationFailureSignal = null;
    failNextConfigRead = true;
    const rendererInitializationFailureListeners = ipcMain.listeners('app:renderer-initialization-failed');
    ipcMain.removeAllListeners('app:renderer-initialization-failed');
    ipcMain.on('app:renderer-initialization-failed', captureRendererInitializationFailure);
    const failedInitializationLoad = new Promise(resolve => wc.once('did-finish-load', resolve));
    wc.reload();
    await failedInitializationLoad;
    await waitUntil(() => wc.executeJavaScript('document.getElementById("appAlertModal")?.style.display === "flex"'));
    await wc.executeJavaScript('document.getElementById("appAlertConfirmBtn")?.click()');
    const initializationFailureSignal = await waitUntil(() => rendererInitializationFailureSignal, 3000);
    const recoveryLoad = new Promise(resolve => wc.once('did-finish-load', resolve));
    wc.reload();
    await recoveryLoad;
    const initializationRecovery = await waitUntil(async () => {
      try {
        return await wc.executeJavaScript('typeof config === "object" && Boolean(document.querySelector(".app-header"))');
      } catch {
        return false;
      }
    }, 5000);
    ipcMain.removeAllListeners('app:renderer-initialization-failed');
    rendererInitializationFailureListeners.forEach(listener => ipcMain.on('app:renderer-initialization-failed', listener));
    check('Renderer initialization failures notify main with serializable details', typeof initializationFailureSignal?.message === 'string' && initializationFailureSignal.message.includes('Injected renderer initialization failure') && typeof initializationFailureSignal.stack === 'string');
    check('Renderer initialization failure recovery restores the real interface', initializationRecovery === true);

    const updateOverlayState = await wc.executeJavaScript('_knownUpdateInfo = { available: true, remoteVersion: "9.9.9" }; _syncHeaderUpdateState(); document.getElementById("headerUpdateBtn").focus(); showUpdateBanner({ remoteVersion: "9.9.9", releaseNotes: { de: "\\\\n\\\\n\\\\n## Neu in dieser Version\\\\n\\\\n\\\\n### Menüs und Navigation\\\\n\\\\n- Direkter Sprachwechsel hinzugefügt.\\\\n- Einstellungsdarstellung verbessert.\\\\n\\\\n\\\\n", en: "## New in this version\\\\n\\\\n### Menus and navigation\\\\n\\\\n- Added live language switching.\\\\n- Improved settings layout." } }); (() => { const overlay = document.getElementById("updateBanner"); const dialog = overlay?.querySelector(".update-dialog"); const button = document.getElementById("headerUpdateBtn"); return [overlay?.classList.contains("update-overlay"), overlay?.style.display, dialog?.getAttribute("role"), dialog?.getAttribute("aria-modal"), button?.hidden, getComputedStyle(button).display].join("|"); })()');
    check('Available update opens an accessible update dialog', updateOverlayState === 'true|flex|dialog|true|false|flex');

    await new Promise(resolve => setTimeout(resolve, 100));
    const updateModalKeyboard = await wc.executeJavaScript(\`(() => {
      const close = document.getElementById('updateCloseBtn');
      const install = document.getElementById('installUpdateBtn');
      const initialFocus = document.activeElement?.id;
      const backgroundInert = document.querySelector('.app-header')?.inert === true && document.querySelector('.view.active')?.inert === true;
      install.focus();
      install.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
      const forwardFocus = document.activeElement?.id;
      close.focus();
      close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
      const backwardFocus = document.activeElement?.id;
      return { initialFocus, backgroundInert, forwardFocus, backwardFocus };
    })()\`);
    check('Update dialog receives and traps keyboard focus', updateModalKeyboard.initialFocus === 'updateCloseBtn' && updateModalKeyboard.forwardFocus === 'updateCloseBtn' && updateModalKeyboard.backwardFocus === 'installUpdateBtn');
    check('Update dialog makes the background inert', updateModalKeyboard.backgroundInert === true);

    await captureVisual('05-update.png');

    const updateDialogCopy = await wc.executeJavaScript('(() => { const title = document.getElementById("updateDialogTitle")?.textContent?.trim(); const message = document.getElementById("updateMessage")?.textContent?.trim(); return [title, message].join("|"); })()');
    check('Update dialog names the available version', updateDialogCopy === 'Eine neue Version ist verfügbar|Update v9.9.9 verfügbar');

    const updateDialogActions = await wc.executeJavaScript('[document.getElementById("dismissUpdateBtn")?.textContent?.trim(), document.getElementById("installUpdateBtn")?.textContent?.trim()].join("|")');
    check('Update dialog offers cancel and install actions', updateDialogActions === 'Abbrechen|Jetzt installieren');
    const updateDialogChangelog = await wc.executeJavaScript('(() => { const title = document.querySelector(".update-release-notes-title"); const body = document.getElementById("updateReleaseNotesBody"); const titleRect = title?.getBoundingClientRect(); const bodyRect = body?.getBoundingClientRect(); return { hidden: document.getElementById("updateReleaseNotes")?.hidden, title: title?.textContent?.trim(), body: body?.textContent, language: body?.lang, gap: bodyRect && titleRect ? bodyRect.top - titleRect.bottom : null }; })()');
    check('German update dialog selects compact localized release notes without changing their content', updateDialogChangelog.hidden === false && updateDialogChangelog.title === 'Changelog' && updateDialogChangelog.body === 'Neu in dieser Version\\n\\nMenüs und Navigation\\n\\n• Direkter Sprachwechsel hinzugefügt.\\n• Einstellungsdarstellung verbessert.' && updateDialogChangelog.language === 'de' && updateDialogChangelog.gap <= 10);

    const updateHeaderHint = await wc.executeJavaScript('(() => { const button = document.getElementById("headerUpdateBtn"); return [button?.textContent?.trim(), button?.getAttribute("aria-label"), button?.dataset.tooltip].join("|"); })()');
    check('Available update gives the header action a matching hint', updateHeaderHint === 'Update verfügbar|Update v9.9.9 verfügbar. Klicken zum Installieren.|Update v9.9.9 verfügbar. Klicken zum Installieren.');

    const updateDialogDismissed = await wc.executeJavaScript('document.getElementById("dismissUpdateBtn")?.click(); (() => { const overlay = document.getElementById("updateBanner"); return [overlay?.style.display, overlay?.getAttribute("aria-hidden"), document.activeElement?.id, document.querySelector(".app-header")?.inert, document.querySelector(".view.active")?.inert].join("|"); })()');
    check('Update dialog closes and restores focus and background', updateDialogDismissed === 'none|true|headerUpdateBtn|false|false');

    const busyUpdateState = await wc.executeJavaScript(\`(() => {
      showUpdateBanner({ remoteVersion: '9.9.9' });
      handleUpdateProgress({ stage: 'downloading', percent: 50 });
      const overlay = document.getElementById('updateBanner');
      document.getElementById('updateCloseBtn').click();
      document.getElementById('dismissUpdateBtn').click();
      overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      const progress = document.getElementById('updateProgressBar');
      const header = document.getElementById('headerUpdateBtn');
      return {
        display: overlay.style.display,
        hidden: overlay.getAttribute('aria-hidden'),
        closeDisabled: document.getElementById('updateCloseBtn').disabled,
        dismissDisabled: document.getElementById('dismissUpdateBtn').disabled,
        headerHidden: header.hidden,
        messageHidden: document.getElementById('updateMessage').hidden,
        messageText: document.getElementById('updateMessage').textContent,
        buttonText: document.getElementById('installUpdateBtn').textContent,
        visibleProgressText: document.getElementById('updateProgressText').textContent,
        progressLabel: progress.getAttribute('aria-label'),
        progressText: progress.getAttribute('aria-valuetext')
      };
    })()\`);
    check('Busy update keeps its progress dialog open', busyUpdateState.display === 'flex' && busyUpdateState.hidden === 'false' && busyUpdateState.closeDisabled === true && busyUpdateState.dismissDisabled === true && busyUpdateState.headerHidden === false);
    check('Update progress exposes an accessible live value', busyUpdateState.progressLabel === 'Update-Fortschritt' && busyUpdateState.progressText === 'Download 50%');
    check('Busy update shows progress only below the bar', busyUpdateState.messageHidden === true && busyUpdateState.messageText === 'Update v9.9.9 verfügbar' && busyUpdateState.visibleProgressText === 'Download 50%' && busyUpdateState.buttonText === 'Jetzt installieren');

    const updateProgressSurfaces = await wc.executeJavaScript(\`(() => {
      const phases = [
        { stage: 'starting', expected: 'Download 0%' },
        { stage: 'downloading', percent: 50, expected: 'Download 50%' },
        { stage: 'verifying', expected: 'Prüfen…' },
        { stage: 'prepared', expected: 'Neustart…' },
        { stage: 'launching', expected: 'Neustart…' }
      ];
      return phases.map(phase => {
        showUpdateBanner({ remoteVersion: '9.9.9' });
        handleUpdateProgress(phase);
        const surfaces = [document.getElementById('updateProgressText'), document.getElementById('installUpdateBtn'), document.getElementById('updateMessage')];
        const visibleMatches = surfaces.filter(element => element && !element.hidden && getComputedStyle(element).display !== 'none' && element.textContent.trim() === phase.expected).length;
        return { stage: phase.stage, visibleMatches, button: document.getElementById('installUpdateBtn')?.textContent.trim() };
      });
    })()\`);
    check('Every update phase has exactly one visible progress status surface', updateProgressSurfaces.every(state => state.visibleMatches === 1 && state.button === 'Jetzt installieren'));

    const updateErrorSurface = await wc.executeJavaScript('handleUpdateProgress({ stage: "error", error: "Netzwerkfehler" }); (() => { const surfaces = [document.getElementById("updateProgressText"), document.getElementById("updateMessage")]; const visible = surfaces.filter(element => element && !element.hidden && getComputedStyle(element).display !== "none" && element.textContent.includes("Update fehlgeschlagen")); return { count: visible.length, current: visible[0]?.textContent.trim(), messageLive: document.getElementById("updateMessage")?.getAttribute("aria-live") }; })()');
    check('A failed update preparation exposes one current error status', updateErrorSurface.count === 1 && updateErrorSurface.current === 'Update fehlgeschlagen: Netzwerkfehler' && updateErrorSurface.messageLive === 'polite');

    const updateErrorRecovery = await wc.executeJavaScript('handleUpdateProgress({ stage: "error", error: "Netzwerkfehler" }); document.getElementById("dismissUpdateBtn").click(); document.getElementById("updateBanner").style.display + "|" + document.getElementById("updateCloseBtn").disabled + "|" + document.getElementById("dismissUpdateBtn").disabled + "|" + document.getElementById("headerUpdateBtn").hidden');
    check('Update errors restore all close actions', updateErrorRecovery === 'none|false|false|false');

    const initialInstallUpdateHandler = initialIpcHandlers.get('app:install-update');
    const initialUpdateQueueHandler = initialIpcHandlers.get('save-pending-queue');
    let installUpdateIpcCalls = 0;
    ipcMain.removeHandler('app:install-update');
    ipcMain.handle('app:install-update', () => {
      installUpdateIpcCalls++;
      return { started: true };
    });
    ipcMain.removeHandler('save-pending-queue');
    ipcMain.handle('save-pending-queue', () => { throw new Error('update queue save failed'); });
    const updateSaveFailure = await wc.executeJavaScript('showUpdateBanner({ remoteVersion: "9.9.9" }); installKnownUpdate().then(() => ({ busy: _updateInstallBusy, message: document.getElementById("updateMessage")?.textContent || "" }))');
    check('Update preparation stops before install IPC when queue persistence fails', installUpdateIpcCalls === 0 && updateSaveFailure.busy === false && updateSaveFailure.message === 'Update fehlgeschlagen: Unbekannter Fehler');
    await wc.executeJavaScript('handleUpdateProgress({ stage: "error", error: "Test cleanup" }); closeUpdateDialog()');
    ipcMain.removeHandler('app:install-update');
    if (initialInstallUpdateHandler) registerIpcHandler('app:install-update', initialInstallUpdateHandler);
    ipcMain.removeHandler('save-pending-queue');
    if (initialUpdateQueueHandler) registerIpcHandler('save-pending-queue', initialUpdateQueueHandler);
    await wc.executeJavaScript('flushConfigWrites()');

    const stackedDialogState = await wc.executeJavaScript(\`(() => {
      openAccountModal(null);
      showUpdateBanner({ remoteVersion: '9.9.9' });
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      const state = document.getElementById('updateBanner').style.display + '|' + document.getElementById('accountModal').style.display;
      if (document.getElementById('updateBanner').style.display !== 'none') closeUpdateDialog();
      if (document.getElementById('accountModal').style.display !== 'none') closeAccountModal();
      return state;
    })()\`);
    check('Escape closes only the topmost update dialog', stackedDialogState === 'none|flex');

    if (visualScreenshotDir) {
      await setWindowBounds({ ...win.getBounds(), width: 800, height: 550 });
      await wc.executeJavaScript('document.querySelector(".tab[data-view=\\\'settings\\\']").click(); document.querySelector("[data-settings-page=\\\'allgemein\\\']")?.click(); (() => { const search = document.getElementById("settingsSearchInput"); if (search) { search.value = ""; search.dispatchEvent(new Event("input", { bubbles: true })); } document.querySelector(".settings-content")?.scrollTo(0, 0); })()');
      await captureVisual('06-settings-800x550.png');
      await setWindowBounds(originalBounds);
    }

    restoreInitialIpcHandler('save-global-settings');
    restoreInitialIpcHandler('save-pending-queue');
    const keepaliveWindow = new globalThis.__mhuBrowserWindowConstructor({ show: false });
    realAppQuit = app.quit.bind(app);
    app.relaunch = () => { relaunchCalls++; };
    app.quit = () => {
      if (!win.isDestroyed()) win.close();
    };
    await wc.executeJavaScript('window.api.removeAllListeners()');
    await wc.executeJavaScript('window.api.restartApp()');
    await new Promise(resolve => setTimeout(resolve, 1700));
    const lostCloseRequestRecovered = !win.isDestroyed();
    await wc.executeJavaScript('window.api.onPrepareClose(prepareForWindowClose)');
    await wc.executeJavaScript('window.api.onUpdateProgress(handleUpdateProgress)');
    check('Lost restart close request leaves the window open for a later normal quit', lostCloseRequestRecovered === true);

    const originalSavePendingQueue = activeConfigStore.savePendingQueue.bind(activeConfigStore);
    let rejectHungFinalQueueWrite = null;
    let hangFinalQueueWrite = true;
    activeConfigStore.savePendingQueue = (pendingQueue, options) => {
      if (hangFinalQueueWrite && options?.allowDuringQuiesce === true) {
        hangFinalQueueWrite = false;
        return new Promise((_resolve, reject) => { rejectHungFinalQueueWrite = reject; });
      }
      return originalSavePendingQueue(pendingQueue, options);
    };
    const initialFinishCloseHandler = initialIpcHandlers.get('app:finish-close');
    let closeReadyAttempt = null;
    let closeRestoreAttempt = null;
    let restoreAckRequested = false;
    let releaseRestoreAck = null;
    ipcMain.removeHandler('app:finish-close');
    ipcMain.handle('app:finish-close', async (event, payload) => {
      const ready = payload && typeof payload === 'object' ? payload.ready !== false : payload !== false;
      if (ready) {
        closeReadyAttempt = payload && typeof payload === 'object' ? payload.attempt : null;
      } else {
        closeRestoreAttempt = payload && typeof payload === 'object' ? payload.attempt : null;
        restoreAckRequested = true;
        await new Promise(resolve => { releaseRestoreAck = resolve; });
      }
      return initialFinishCloseHandler(event, payload);
    });
    await wc.executeJavaScript('(() => { queuePersistThrottle.cancel(); selectedFiles = []; queueJobs = [{ id: "ui-close-timeout-job", file: "C:/ui/close-timeout.bin", fileName: "close-timeout.bin", hoster: "byse.sx", status: "queued", bytesUploaded: 0, bytesTotal: 1, speedKbs: 0, elapsed: 0, remaining: 0, progress: 0 }]; rebuildJobIndex(); return true; })()');
    await wc.executeJavaScript('showUpdateBanner({ remoteVersion: "9.9.9" }); installKnownUpdate()');
    await waitUntil(() => restoreAckRequested, 4000);
    const recoveryBeforeAck = await wc.executeJavaScript('({ state: closePreparationState, promiseCleared: closePreparationPromise === null, overlayVisible: document.getElementById("shutdownOverlay")?.style.display === "flex", inertRetained: document.querySelector(".app-header")?.inert === true && document.querySelector(".view.active")?.inert === true })');
    const windowStayedOpenAfterCloseFailure = !win.isDestroyed();
    rejectHungFinalQueueWrite?.(new Error('final queue write timeout'));
    releaseRestoreAck?.();
    const boundedCloseRecovery = await waitUntil(async () => {
      if (win.isDestroyed()) return null;
      const state = await wc.executeJavaScript('({ state: closePreparationState, promiseCleared: closePreparationPromise === null, overlayHidden: document.getElementById("shutdownOverlay")?.style.display === "none", modalIsolationRestored: document.querySelector(".app-header")?.inert === true && document.querySelector(".view.active")?.inert === true && document.getElementById("updateBanner")?.inert === false, failedWrites: failedConfigWriteOperations.length })');
      return state.state === 'open' && state.promiseCleared ? state : null;
    }, 4000);
    activeConfigStore.savePendingQueue = originalSavePendingQueue;
    const closeRecoveryMarker = 'https://close-recovery.invalid/after-timeout';
    const writeAfterCloseRecovery = await wc.executeJavaScript('saveGlobalSettingsTracked({ ...(config.globalSettings || {}), webhookUrl: "' + closeRecoveryMarker + '" }).then(() => ({ ok: true }), error => ({ ok: false, error: error.message }))');
    const historyAfterCloseRecovery = await activeConfigStore.appendHistory({ id: 'ui-close-recovery-history', files: [] }).then(() => ({ ok: true }), error => ({ ok: false, error: error.message }));
    const configAfterCloseRecovery = JSON.parse(fs.readFileSync(activeConfigStore.filePath, 'utf-8'));
    const recoveredQueue = configAfterCloseRecovery.globalSettings.pendingQueue?.queueJobs || [];
    const failedUpdateUi = await wc.executeJavaScript('({ busy: _updateInstallBusy, message: document.getElementById("updateMessage")?.textContent || "" })');
    const closeRecoveryEvidence = { windowStayedOpenAfterCloseFailure, recoveryBeforeAck, boundedCloseRecovery, closeReadyAttempt, closeRestoreAttempt, writesQuiesced: activeConfigStore._writesQuiesced, writeAfterCloseRecovery, historyAfterCloseRecovery, persistedWebhookUrl: configAfterCloseRecovery.globalSettings.webhookUrl, recoveredQueue: recoveredQueue.map(job => job.id), preparedUpdateMockCalls, launchedUpdateMockCalls, failedUpdateUi };
    const closeRecoveryOk = windowStayedOpenAfterCloseFailure === true && recoveryBeforeAck.state === 'recovering' && recoveryBeforeAck.promiseCleared === false && recoveryBeforeAck.overlayVisible === true && recoveryBeforeAck.inertRetained === true && boundedCloseRecovery?.state === 'open' && boundedCloseRecovery.promiseCleared === true && boundedCloseRecovery.overlayHidden === true && boundedCloseRecovery.modalIsolationRestored === true && boundedCloseRecovery.failedWrites === 0 && activeConfigStore._writesQuiesced === false && Number.isInteger(closeReadyAttempt) && closeRestoreAttempt === closeReadyAttempt && writeAfterCloseRecovery.ok === true && historyAfterCloseRecovery.ok === true && configAfterCloseRecovery.globalSettings.webhookUrl === closeRecoveryMarker && recoveredQueue.some(job => job.id === 'ui-close-timeout-job') && preparedUpdateMockCalls === 1 && launchedUpdateMockCalls === 0 && failedUpdateUi.busy === false && failedUpdateUi.message.includes('nicht gestartet');
    if (!closeRecoveryOk) console.log('Close recovery evidence: ' + JSON.stringify(closeRecoveryEvidence));
    check('Close recovery waits for its correlated restore ACK and drains retained writes before reopening', closeRecoveryOk);
    restoreInitialIpcHandler('app:finish-close');

    const closeSnapshotWebhook = 'https://close-persist.invalid/current';
    const closeSnapshotJobId = 'ui-close-persist-job';
    activeConfigStore._historyMigrated = true;
    blockedHistoryWriteMarker = 'ui-close-history-write';
    blockedHistoryWriteStarted = false;
    releaseBlockedHistoryWrite = null;
    const pendingCloseHistoryWrite = activeConfigStore.appendHistory({ id: 'ui-close-history-write', files: [] });
    await waitUntil(() => blockedHistoryWriteStarted);
    await wc.executeJavaScript('(() => { config.globalSettings = { ...(config.globalSettings || {}), webhookUrl: "' + closeSnapshotWebhook + '" }; const webhookInput = document.getElementById("webhookUrlInput"); if (webhookInput) webhookInput.value = "' + closeSnapshotWebhook + '"; selectedFiles = []; queueJobs = [{ id: "' + closeSnapshotJobId + '", file: "C:/ui/close-persist.bin", fileName: "close-persist.bin", hoster: "byse.sx", status: "queued", bytesUploaded: 0, bytesTotal: 4096, speedKbs: 0, elapsed: 0, remaining: 0, progress: 0 }]; rebuildJobIndex(); markSettingsDirty(); persistQueueStateSoon(false); return saveSettings({ feedbackText: "Gespeichert!" }); })()');
    let mainWindowClosed = false;
    win.once('closed', () => { mainWindowClosed = true; });
    await wc.executeJavaScript('showUpdateBanner({ remoteVersion: "9.9.9" }); installKnownUpdate()');
    const rendererCloseSealed = await waitUntil(async () => !win.isDestroyed() && await wc.executeJavaScript('closePreparationState === "sealed"'));
    const windowStayedOpenForClosePersistence = blockedHistoryWriteStarted === true && !win.isDestroyed();
    const closeUiQuiesced = await wc.executeJavaScript('document.getElementById("shutdownOverlay")?.style.display === "flex" && document.querySelector(".app-header")?.inert === true && document.querySelector(".view.active")?.inert === true');
    const postSealMainWrite = await wc.executeJavaScript('window.api.saveGlobalSettings({ ...(config.globalSettings || {}), webhookUrl: "https://close-persist.invalid/post-seal" }).then(() => ({ ok: true }), error => ({ ok: false, error: error.message }))');
    await wc.executeJavaScript('(() => { queueJobs.push({ id: "ui-post-seal-job", file: "C:/ui/post-seal.bin", fileName: "post-seal.bin", hoster: "byse.sx", status: "queued", bytesUploaded: 0, bytesTotal: 1 }); rebuildJobIndex(); persistQueueStateSoon(false); scheduleSettingsSave(); return true; })()');
    await new Promise(resolve => setTimeout(resolve, 650));
    releaseBlockedHistoryWrite?.();
    await pendingCloseHistoryWrite;
    await waitUntil(() => mainWindowClosed);
    const closePersistedConfig = JSON.parse(fs.readFileSync(activeConfigStore.filePath, 'utf-8'));
    const closePersistedQueue = closePersistedConfig.globalSettings.pendingQueue?.queueJobs || [];
    check('Window close waits for asynchronous persistence of the latest renderer snapshot', keepaliveWindow.isDestroyed() === false && blockedHistoryWriteStarted === true && windowStayedOpenForClosePersistence === true && mainWindowClosed === true && closePersistedConfig.globalSettings.webhookUrl === closeSnapshotWebhook && closePersistedQueue.some(job => job.id === closeSnapshotJobId));
    check('Window close seals renderer writes before the final snapshot is committed', rendererCloseSealed === true && closeUiQuiesced === true && !closePersistedQueue.some(job => job.id === 'ui-post-seal-job'));
    check('Main rejects config producers after the close snapshot is sealed', postSealMainWrite.ok === false);

  } catch (err) {
    console.log('Test error:', err && err.stack ? err.stack : err.message);
    failed++;
  }

  check('Every UI smoke window remains offscreen after every interaction', hiddenWindowHarness.areNativeSurfacesSuppressed(hiddenWindowHarness.getWindows()));
  const printResults = () => {
    console.log('\\n=== Results ===');
    results.forEach(r => console.log(r));
    console.log('\\nTotal: ' + (passed + failed) + ' | Passed: ' + passed + ' | Failed: ' + failed);
  };
  if (realAppQuit) {
    app.once('will-quit', event => {
      event.preventDefault();
      check('Lost restart intent does not relaunch during the later normal quit', relaunchCalls === 0);
      check('Approved update launches its prepared installer exactly once', preparedUpdateMockCalls === 2 && launchedUpdateMockCalls === 1);
      printResults();
      app.exit(failed > 0 ? 1 : 0);
    });
    realAppQuit();
    return;
  }
  printResults();
  app.exit(failed > 0 ? 1 : 0);
}, 5000);
`;

try {
  fs.writeFileSync(injectPath, testScript, 'utf-8');
  execFileSync(process.execPath, ['--check', injectPath], { cwd: path.join(__dirname, '..'), stdio: 'pipe' });
  const electronPath = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe');
  const mainPath = path.join(__dirname, '..', 'main.js');

  const result = execFileSync(
    electronPath,
    [`--user-data-dir=${userDataPath}`, '--require', injectPath, mainPath, '--dev'],
    { cwd: path.join(__dirname, '..'), timeout: 180000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
  );
  console.log(result);
  const isolatedConfigPath = path.join(userDataPath, 'electron-config.json');
  if (!fs.existsSync(isolatedConfigPath)) throw new Error(`Isolated UI config was not created: ${isolatedConfigPath}`);
} catch (err) {
  // timeout or exit code - still print output
  if (err.stdout) console.log(err.stdout);
  if (err.stderr) {
    const stderr = Buffer.isBuffer(err.stderr) ? err.stderr.toString('utf-8') : String(err.stderr);
    const filtered = stderr.split('\n')
      .filter(l => !l.includes('cache_util') && !l.includes('disk_cache') && !l.includes('gpu_disk_cache'))
      .join('\n');
    if (filtered.trim()) console.error(filtered);
  }
  process.exitCode = Number.isInteger(err.status) && err.status !== 0 ? err.status : 1;
} finally {
  try { fs.unlinkSync(injectPath); } catch {}
  try { fs.rmSync(userDataPath, { recursive: true, force: true }); } catch {}
}
