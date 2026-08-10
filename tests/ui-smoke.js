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
const fs = require('fs');
const net = require('net');
const path = require('path');
const ConfigStore = require(path.join(process.cwd(), 'lib', 'config-store'));
const updaterModule = require(path.join(process.cwd(), 'lib', 'updater'));
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
ipcMain.handle = (channel, listener) => {
  const registeredListener = channel === 'get-config'
    ? async (...args) => {
        const result = await listener(...args);
        if (!initialConfigReadDelayed) {
          initialConfigReadDelayed = true;
          await new Promise(resolve => setTimeout(resolve, 4000));
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
  const windows = BrowserWindow.getAllWindows();
  if (windows.length === 0) { console.log('ERROR: No windows found'); process.exit(1); }
  const win = windows[0];
  const wc = win.webContents;
  const originalBounds = win.getBounds();
  const visualScreenshotDir = ${JSON.stringify(visualScreenshotDir)};

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
    const startupUpdateState = await wc.executeJavaScript('(() => { const button = document.getElementById("headerUpdateBtn"); return [_knownUpdateInfo?.remoteVersion, button?.hidden, getComputedStyle(button).display, document.getElementById("updateBanner")?.style.display].join("|"); })()');
    check('Startup update survives pending renderer initialization', startupUpdateState === '9.9.8|false|flex|flex');
    await wc.executeJavaScript('_knownUpdateInfo = null; closeUpdateDialog(); _syncHeaderUpdateState();');

    const languageReady = await waitUntil(() => wc.executeJavaScript('Boolean(document.getElementById("languageInput"))'));
    check('Fresh profiles render in English by default', languageReady === true && await wc.executeJavaScript('document.documentElement.lang + "|" + document.getElementById("languageInput")?.value + "|" + [...document.querySelectorAll(".tab")].map(tab => tab.textContent.trim()).join(",")') === 'en|en|Upload,Accounts,Settings,History');
    await wc.executeJavaScript('document.getElementById("settings-tab").click()');
    const languagePickerContract = await wc.executeJavaScript('(() => { const picker = document.getElementById("languagePicker"); const select = document.getElementById("languageInput"); const indicator = picker?.querySelector(".language-picker-indicator"); const buttons = [...(picker?.querySelectorAll(".language-option") || [])]; return [select?.hidden, buttons.length, buttons.map(button => button.dataset.language).join(","), buttons.map(button => button.getAttribute("aria-pressed")).join(","), Boolean(buttons[0]?.querySelector(".language-flag-en") && buttons[1]?.querySelector(".language-flag-de")), indicator ? parseFloat(getComputedStyle(indicator).transitionDuration) > 0 : false].join("|"); })()');
    check('Language uses a two-option animated flag picker instead of a visible dropdown', languagePickerContract === 'true|2|en,de|true,false|true|true');
    const languagePickerMotion = await wc.executeJavaScript('(async () => { const picker = document.getElementById("languagePicker"); const indicator = picker?.querySelector(".language-picker-indicator"); if (!picker || !indicator) return null; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); const before = indicator.getBoundingClientRect().left; picker.querySelector("[data-language=de]").click(); const germanLanguage = document.documentElement.lang; await new Promise(resolve => setTimeout(resolve, 90)); const movingRight = indicator.getBoundingClientRect().left; await new Promise(resolve => setTimeout(resolve, 170)); const german = { language: germanLanguage, selected: picker.dataset.language, pressed: picker.querySelector("[data-language=de]").getAttribute("aria-pressed"), left: indicator.getBoundingClientRect().left }; picker.querySelector("[data-language=en]").click(); const englishLanguage = document.documentElement.lang; await new Promise(resolve => setTimeout(resolve, 90)); const movingLeft = indicator.getBoundingClientRect().left; await new Promise(resolve => setTimeout(resolve, 170)); const english = { language: englishLanguage, selected: picker.dataset.language, pressed: picker.querySelector("[data-language=en]").getAttribute("aria-pressed"), left: indicator.getBoundingClientRect().left }; return { before, movingRight, movingLeft, german, english }; })()');
    if (!languagePickerMotion || !(languagePickerMotion.movingRight > languagePickerMotion.before + 2 && languagePickerMotion.movingRight < languagePickerMotion.german.left - 2) || !(languagePickerMotion.movingLeft < languagePickerMotion.german.left - 2 && languagePickerMotion.movingLeft > languagePickerMotion.before + 2)) console.log('Language picker motion: ' + JSON.stringify(languagePickerMotion));
    check('Language indicator visibly slides right and left while applying both languages immediately', Boolean(languagePickerMotion && languagePickerMotion.german.language === 'de' && languagePickerMotion.german.selected === 'de' && languagePickerMotion.german.pressed === 'true' && languagePickerMotion.movingRight > languagePickerMotion.before + 2 && languagePickerMotion.movingRight < languagePickerMotion.german.left - 2 && languagePickerMotion.english.language === 'en' && languagePickerMotion.english.selected === 'en' && languagePickerMotion.english.pressed === 'true' && languagePickerMotion.movingLeft < languagePickerMotion.german.left - 2 && languagePickerMotion.movingLeft > languagePickerMotion.before + 2 && Math.abs(languagePickerMotion.english.left - languagePickerMotion.before) <= 1));
    await captureVisual('00-language-picker.png');
    await wc.executeJavaScript('document.getElementById("upload-tab").click()');
    const unchangedValues = await wc.executeJavaScript('(() => { setUiLanguage("de"); const nodes = []; const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let node = walker.nextNode(); while (node) { if (node.nodeValue.trim()) nodes.push({ node, source: node.nodeValue.trim() }); node = walker.nextNode(); } const attributes = [...document.querySelectorAll("[title],[aria-label],[placeholder],[data-tooltip]")].flatMap(element => ["title", "aria-label", "placeholder", "data-tooltip"].filter(name => element.hasAttribute(name)).map(name => ({ element, name, source: element.getAttribute(name).trim() }))); setUiLanguage("en"); const unchanged = nodes.filter(entry => entry.source === entry.node.nodeValue.trim()).map(entry => entry.source); unchanged.push(...attributes.filter(entry => entry.source === entry.element.getAttribute(entry.name).trim()).map(entry => entry.source)); return [...new Set(unchanged.filter(value => /[A-Za-zÄÖÜäöüß]{2}/.test(value)))].sort(); })()');
    const neutralUiValues = new Set(['0 kB/s', 'Accounts', 'BBCode', 'CSV', 'Changelog', 'ETA --:--', 'FileUploader Log', 'HTML', 'JSON', 'Label (optional)', 'Link', 'Log', 'Logs & Support', 'MB/s', 'MHU2-…', 'MULTI-HOSTER UPLOAD', 'Markdown', 'Multi-Hoster Upload', 'OK', 'Plaintext', 'Port', 'Server', 'Status', 'Update', 'Upload', 'Uploads', 'Verbose Logging', 'Webhook', 'account-rotation.log', 'debug.log', 'doodstream-debug.log', 'fileuploader.log', 'mp4,mkv,avi']);
    const unexpectedUnchangedValues = unchangedValues.filter(value => !neutralUiValues.has(value) && !value.includes('Multi-Hoster-Uploader'));
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
    const englishLayoutFits = await wc.executeJavaScript('(() => { const states = [...document.querySelectorAll(".tab")].map(tab => { tab.click(); const view = document.querySelector(".view.active"); return view && view.scrollWidth <= view.clientWidth + 1; }); document.querySelector(".tab[data-view=upload]")?.click(); return states.every(Boolean) && document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1; })()');
    check('English labels fit every main view without horizontal overflow', englishLayoutFits === true);
    await wc.executeJavaScript('document.querySelector(".tab[data-view=accounts]")?.click()');
    const englishEmptyAccountHosterLabel = await wc.executeJavaScript('(() => { const container = document.getElementById("accountsSidebarHosters"); return [container?.getAttribute("data-empty-label"), getComputedStyle(container, "::after").content].join("|"); })()');
    check('Empty account hoster sidebar renders its localized English label', englishEmptyAccountHosterLabel === 'No hosts yet|"No hosts yet"');
    await wc.executeJavaScript('document.querySelector(".tab[data-view=upload]")?.click()');
    const liveLanguageSwitch = await wc.executeJavaScript('(() => { const input = document.getElementById("languageInput"); input.value = "de"; input.dispatchEvent(new Event("change", { bubbles: true })); const german = [...document.querySelectorAll(".tab")].map(tab => tab.textContent.trim()).join(","); input.value = "en"; input.dispatchEvent(new Event("change", { bubbles: true })); const english = [...document.querySelectorAll(".tab")].map(tab => tab.textContent.trim()).join(","); input.value = "de"; input.dispatchEvent(new Event("change", { bubbles: true })); return [german, english, document.documentElement.lang].join("|"); })()');
    check('Language changes apply immediately in both directions', liveLanguageSwitch === 'Upload,Accounts,Einstellungen,Verlauf|Upload,Accounts,Settings,History|de');
    const germanSidebarHeadings = await wc.executeJavaScript('[...document.querySelectorAll("#upload-view, #accounts-view, #history-view")].map(view => [view.querySelector(".view-sidebar-kicker")?.textContent?.trim(), view.querySelector(".view-sidebar-title")?.textContent?.trim()].join("|"))');
    check('German sidebar hierarchy uses distinct localized kickers', germanSidebarHeadings.join('::') === 'Arbeitsbereich|Uploads::Accounts verwalten|Accounts::Archiv|Verlauf');
    const saveAfterLanguageChange = await wc.executeJavaScript('(() => { const button = document.getElementById("saveSettingsBtn"); return [button.disabled, button.classList.contains("btn-success")].join("|"); })()');
    check('Changing language enables the green save action', saveAfterLanguageChange === 'false|true');
    await wc.executeJavaScript('document.getElementById("saveSettingsBtn").click()');
    await waitUntil(() => wc.executeJavaScript('document.getElementById("saveSettingsBtn").disabled'));
    const saveAfterCommit = await wc.executeJavaScript('(() => { const button = document.getElementById("saveSettingsBtn"); return [button.disabled, button.classList.contains("btn-secondary")].join("|"); })()');
    check('Saving returns the action to its disabled gray state', saveAfterCommit === 'true|true');

    await wc.executeJavaScript('queueJobs = []; selectedFiles = []; selectedJobIds.clear(); rebuildJobIndex(); setUploadSidebarFilter("all"); updateUploadView(); renderQueueTable(); updateStatusBar();');
    console.log('\\n=== Upload View ===');

    const tabCount = await wc.executeJavaScript('document.querySelectorAll(".tab").length');
    check('4 tabs exist', tabCount === 4);

    const appHeaderExists = await wc.executeJavaScript('Boolean(document.querySelector(".app-header"))');
    check('App shell exposes the primary header', appHeaderExists);

    const appBrandText = await wc.executeJavaScript('document.querySelector(".app-brand-name")?.textContent?.trim()');
    check('App header shows the Multi-Hoster Upload brand', appBrandText === 'MULTI-HOSTER UPLOAD');

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

    const shellDensity = await wc.executeJavaScript('(() => ({ header: document.querySelector(".app-header")?.getBoundingClientRect().height, status: document.getElementById("statusbar")?.getBoundingClientRect().height, sidebar: document.querySelector("#upload-view > .view-sidebar")?.getBoundingClientRect().width }))()');
    check('App shell keeps a compact desktop density', shellDensity.header <= 50 && shellDensity.status <= 30 && shellDensity.sidebar <= 230);

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
      win.setSize(width, height);
      await new Promise(resolve => setTimeout(resolve, 80));
      submenuReachability[label] = await wc.executeJavaScript('(() => { const parent = document.querySelector("[data-menu-dropdown=datei]"); const target = document.querySelector(".menu-submenu-dropdown [data-menu-action=backup-export]"); if (!parent || !target) return "missing"; const rect = target.getBoundingClientRect(); const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2); return [getComputedStyle(parent).clipPath, hit === target || target.contains(hit)].join("|"); })()');
    }
    win.setBounds(menuWindowBounds);
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

    const startDisabled = await wc.executeJavaScript('document.getElementById("startUploadBtn")?.disabled');
    check('Start button disabled initially', startDisabled === true);

    const sbState = await wc.executeJavaScript('document.getElementById("sbState")?.textContent');
    check('Statusbar: Bereit', sbState === 'Bereit');
    const readyDotColor = await wc.executeJavaScript('getComputedStyle(document.getElementById("sbState"), "::before").backgroundColor');
    check('Ready status uses a green indicator', readyDotColor === 'rgb(67, 209, 123)');

    const version = await wc.executeJavaScript('document.getElementById("versionLabel")?.textContent');
    check('Version label present', version && version.startsWith('v'));
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

    const localizedStatusbar = await wc.executeJavaScript('["sbConnections", "sbQueueCount", "sbRemainingCount", "sbInProgressCount", "sbDoneCount", "sbErrorCount"].map(id => document.getElementById(id)?.textContent).join("|")');
    check('Statusbar labels are consistently German', localizedStatusbar === 'Verbindungen 0|Gesamt 0|Verbleibend 0|Läuft 0|Fertig 0|Fehler 0');

    const toolbarLabels = await wc.executeJavaScript('[...document.querySelectorAll("#queueCommandBar .toolbar-btn")].map(el => el.getAttribute("aria-label")).join("|")');
    check('Upload toolbar actions have German accessible names', toolbarLabels === 'Alle Uploads starten|Ausgewählte Uploads starten|Ausgewählte Datei erneut hochladen|Ausgewählten Upload abbrechen|Aktive Uploads beenden und stoppen|Alle Uploads abbrechen|Ganz nach oben|Nach oben|Nach unten|Ganz nach unten');

    const uploadWorkspaceLayout = await wc.executeJavaScript('(() => { const view = document.getElementById("upload-view"); const sidebar = view?.querySelector(":scope > .view-sidebar"); const main = view?.querySelector(":scope > .view-main"); if (!sidebar || !main) return false; const sidebarRect = sidebar.getBoundingClientRect(); const mainRect = main.getBoundingClientRect(); return sidebarRect.width > 0 && mainRect.width > 0 && sidebarRect.right <= mainRect.left; })()');
    check('Upload view separates sidebar and main workspace', uploadWorkspaceLayout === true);

    const uploadSidebarInformation = await wc.executeJavaScript('(() => { const sidebar = document.querySelector("#upload-view > .view-sidebar")?.getBoundingClientRect(); const section = document.querySelector("#upload-view .view-sidebar-section")?.getBoundingClientRect(); return Boolean(sidebar && section && section.top >= sidebar.top + sidebar.height * 0.55 && document.getElementById("uploadSidebarAccountsCount")); })()');
    check('Upload sidebar keeps availability information in its lower area', uploadSidebarInformation === true);

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

    const uploadFrameFit = await wc.executeJavaScript('(() => { const view = document.getElementById("upload-view")?.getBoundingClientRect(); const status = document.getElementById("statusbar")?.getBoundingClientRect(); return Boolean(view && status && status.height > 0 && view.bottom <= status.top + 1 && status.bottom <= window.innerHeight + 1); })()');
    check('Upload view and statusbar fit inside the viewport', uploadFrameFit === true);

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
      const track = document.createElement('div');
      track.className = 'progress-bar-bg';
      track.style.cssText = 'position:fixed;left:20px;top:20px;width:300px;';
      const fill = document.createElement('div');
      fill.className = 'progress-bar-fill status-uploading';
      fill.style.width = '10%';
      track.append(fill);
      document.body.append(track);
      const ratio = () => fill.getBoundingClientRect().width / track.getBoundingClientRect().width;
      const background = getComputedStyle(fill).backgroundImage;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const start = ratio();
      fill.style.width = '80%';
      await new Promise(resolve => setTimeout(resolve, 70));
      const middle = ratio();
      await new Promise(resolve => setTimeout(resolve, 260));
      const end = ratio();
      track.remove();
      return { background, start, middle, end };
    })()\`);
    check('Active upload progress uses the green success gradient', uploadProgressMotion.background === 'linear-gradient(90deg, rgb(117, 211, 155), rgb(156, 226, 184))');
    check('Active upload progress visibly interpolates percentage changes', uploadProgressMotion.start > 0.08 && uploadProgressMotion.start < 0.12 && uploadProgressMotion.middle > uploadProgressMotion.start + 0.02 && uploadProgressMotion.middle < 0.78 && uploadProgressMotion.end > 0.78 && uploadProgressMotion.end < 0.82);

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

    const accountsWorkspaceLayout = await wc.executeJavaScript('(() => { const view = document.getElementById("accounts-view"); const sidebar = view?.querySelector(":scope > .view-sidebar"); const main = view?.querySelector(":scope > .view-main"); if (!sidebar || !main) return false; const sidebarRect = sidebar.getBoundingClientRect(); const mainRect = main.getBoundingClientRect(); return sidebarRect.width > 0 && mainRect.width > 0 && sidebarRect.right <= mainRect.left; })()');
    check('Accounts view separates sidebar and main workspace', accountsWorkspaceLayout === true);

    const accountSidebarInformation = await wc.executeJavaScript('(() => { const sidebar = document.querySelector("#accounts-view > .view-sidebar")?.getBoundingClientRect(); const section = document.querySelector("#accounts-view .view-sidebar-hoster-section")?.getBoundingClientRect(); return Boolean(sidebar && section && section.top >= sidebar.top + sidebar.height * 0.55); })()');
    check('Account sidebar keeps hoster information in its lower area', accountSidebarInformation === true);

    const accountsFrameFit = await wc.executeJavaScript('(() => { const view = document.getElementById("accounts-view")?.getBoundingClientRect(); const status = document.getElementById("statusbar")?.getBoundingClientRect(); return Boolean(view && status && status.height > 0 && view.bottom <= status.top + 1 && status.bottom <= window.innerHeight + 1); })()');
    check('Accounts view and statusbar fit inside the viewport', accountsFrameFit === true);

    const accountHeaderControlHeights = await wc.executeJavaScript('(() => [document.getElementById("accountsRunHealthCheckBtn"), document.querySelector(".accounts-auto-check"), document.getElementById("addAccountBtn")].map(element => element?.getBoundingClientRect().height || 0))()');
    check('Accounts header actions share one rendered height', accountHeaderControlHeights.every(height => height > 0 && Math.abs(height - accountHeaderControlHeights[0]) <= 0.5));

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
    const accountModalHidden = await wc.executeJavaScript('document.getElementById("accountModal")?.style.display');
    check('Escape closes account modal', accountModalHidden === 'none');

    const restoredAccountFocus = await wc.executeJavaScript('document.activeElement?.hasAttribute("data-account-empty-add") || document.activeElement?.id === "addAccountBtn"');
    check('Account modal restores trigger focus', restoredAccountFocus === true);

    const fallbackAccountFocus = await wc.executeJavaScript('(() => { const trigger = document.querySelector("[data-account-empty-add]") || document.getElementById("addAccountBtn"); trigger.focus(); trigger.click(); document.querySelector("[data-account-empty-add]")?.remove(); document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return document.activeElement?.id; })()');
    check('Account modal restores stable focus after list rerender', fallbackAccountFocus === 'addAccountBtn');

    win.setSize(1280, 720);
    await new Promise(resolve => setTimeout(resolve, 80));

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
    win.setBounds(originalBounds);

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

    await wc.executeJavaScript('document.querySelector("[data-settings-page=\\\'automatik\\\']")?.click()');
    const automationInputAlignment = await wc.executeJavaScript('(() => { const first = document.getElementById("autoRetryRoundsInput")?.getBoundingClientRect(); const second = document.getElementById("autoRetryDelayMinInput")?.getBoundingClientRect(); const firstHintEl = document.getElementById("autoRetryRoundsInput")?.closest(".automation-retry-row")?.querySelector(".hint"); const secondHintEl = document.getElementById("autoRetryDelayMinInput")?.closest(".automation-retry-row")?.querySelector(".hint"); const firstHint = firstHintEl?.getBoundingClientRect(); const secondHint = secondHintEl?.getBoundingClientRect(); if (!first || !second || !firstHint || !secondHint || !firstHintEl || !secondHintEl) return "missing"; const firstTextLeft = firstHint.left + parseFloat(getComputedStyle(firstHintEl).paddingLeft); const secondTextLeft = secondHint.left + parseFloat(getComputedStyle(secondHintEl).paddingLeft); return [Math.round(Math.abs(first.left - second.left)), Math.round(first.width), Math.round(second.width), firstHint.top >= first.bottom + 6, secondHint.top >= second.bottom + 6, Math.round(Math.abs(firstTextLeft - first.left)) <= 1, Math.round(Math.abs(secondTextLeft - second.left)) <= 1].join("|"); })()');
    check('Automation retry hints start directly below their aligned inputs', automationInputAlignment === '0|100|100|true|true|true|true');
    await wc.executeJavaScript('document.querySelector("[data-settings-page=allgemein]")?.click()');
    const updateActionAlignment = await wc.executeJavaScript('(() => { const row = document.querySelector(".program-update-row")?.getBoundingClientRect(); const button = document.getElementById("manualUpdateCheckBtn")?.getBoundingClientRect(); return row && button ? [Math.abs(row.right - button.right) <= 12, button.bottom <= row.bottom, button.left > row.left + row.width / 2].join("|") : "missing"; })()');
    check('Program update action sits at the lower right of its card', updateActionAlignment === 'true|true|true');
    const updateCardContract = await wc.executeJavaScript('(() => { const card = document.querySelector(".program-update-card"); const title = card?.querySelector(".program-update-title"); const description = card?.querySelector(".program-update-description"); const button = document.getElementById("manualUpdateCheckBtn"); if (!card || !title || !description || !button) return "missing"; const cardRect = card.getBoundingClientRect(); const titleRect = title.getBoundingClientRect(); const descriptionRect = description.getBoundingClientRect(); const buttonRect = button.getBoundingClientRect(); const center = rect => rect.top + rect.height / 2; return [title.textContent.trim(), description.textContent.trim(), titleRect.top < descriptionRect.top, Math.abs(center(buttonRect) - center(cardRect)) <= 2, buttonRect.right <= cardRect.right - 10, titleRect.left >= cardRect.left + 10].join("|"); })()');
    check('Program update card uses a clear title, description and vertically centered action', updateCardContract === 'Nach neuer Version suchen|Verfügbare Updates werden zusammen mit dem Changelog angezeigt.|true|true|true|true');
    await wc.executeJavaScript('document.querySelector("[data-settings-page=logs]")?.click()');
    const logPathAlignment = await wc.executeJavaScript('(() => { const row = document.querySelector(".log-file-path-row")?.getBoundingClientRect(); const input = document.getElementById("logFilePathInput")?.getBoundingClientRect(); const choose = document.getElementById("chooseLogFilePathBtn")?.getBoundingClientRect(); const open = document.getElementById("openLogFolderBtn")?.getBoundingClientRect(); if (!row || !input || !choose || !open) return "missing"; const center = rect => rect.top + rect.height / 2; return [Math.abs(center(input) - center(choose)) <= 1, Math.abs(center(choose) - center(open)) <= 1, open.left > choose.right, open.right <= row.right + 1].join("|"); })()');
    check('FileUploader Log actions stay in one row with Open on the right', logPathAlignment === 'true|true|true|true');

    const settingsSidebarInformation = await wc.executeJavaScript('(() => { const feedback = document.getElementById("saveFeedback"); const sidebar = document.querySelector(".settings-sidebar"); const status = document.querySelector(".settings-sidebar-status"); return Boolean(feedback && sidebar?.contains(feedback) && status && !document.querySelector(".settings-header #saveFeedback")); })()');
    check('Settings sidebar owns the persistent save information', settingsSidebarInformation === true);
    const settingsSearchPadding = await wc.executeJavaScript('parseFloat(getComputedStyle(document.getElementById("settingsSearchInput")).paddingLeft)');
    check('Settings search text clears the search icon', settingsSearchPadding >= 24);
    const settingsSearchIconAlignment = await wc.executeJavaScript('(() => { const icon = document.querySelector(".settings-search-icon"); const style = getComputedStyle(icon); return [style.display, style.alignItems, Boolean(icon?.querySelector("svg"))].join("|"); })()');
    check('Settings search icon aligns to the input text line', settingsSearchIconAlignment === 'flex|center|true');
    const settingsSearchControlGeometry = await wc.executeJavaScript('(() => { const control = document.querySelector(".settings-search-control"); const input = document.getElementById("settingsSearchInput"); const icon = document.querySelector(".settings-search-icon"); const svg = icon?.querySelector("svg"); if (!control || !input || !icon || !svg) return "missing"; const controlRect = control.getBoundingClientRect(); const inputRect = input.getBoundingClientRect(); const iconRect = icon.getBoundingClientRect(); const inputStyle = getComputedStyle(input); const iconStyle = getComputedStyle(icon); return [Math.round(controlRect.height), Math.round(inputRect.height), Math.round(Math.abs((inputRect.top + inputRect.height / 2) - (iconRect.top + iconRect.height / 2))), svg.getAttribute("viewBox"), inputStyle.lineHeight, inputStyle.paddingTop, inputStyle.paddingBottom, iconStyle.display, iconStyle.alignItems].join("|"); })()');
    check('Settings search control keeps icon and text on one shared center line', settingsSearchControlGeometry === '40|40|0|0 0 24 24|18px|0px|0px|flex|center');

    await wc.executeJavaScript('document.querySelector("[data-settings-page=\\'logs\\']")?.click()');
    await new Promise(resolve => setTimeout(resolve, 100));
    const logPathLayout = await wc.executeJavaScript('(() => { const block = document.getElementById("logPathsBlock")?.getBoundingClientRect(); const rows = [...document.querySelectorAll("#logPathsList > div")]; const visible = rows.length > 0 && rows.every(row => { const rect = row.getBoundingClientRect(); const code = row.querySelector("code")?.getBoundingClientRect(); const button = row.querySelector("button")?.getBoundingClientRect(); return block && rect.right <= block.right + 1 && code && button && code.right <= button.left - 6 && button.right <= block.right + 1; }); return [rows.length, visible].join("|"); })()');
    check('Log file rows keep paths and buttons inside the Diagnose panel', logPathLayout === '4|true');

    await wc.executeJavaScript('document.querySelector("[data-settings-page=\\'remote\\']")?.click()');
    const remoteSettingsSpacing = await wc.executeJavaScript('(() => { const grid = document.querySelector("[data-subpage=remote] .settings-grid-mini")?.getBoundingClientRect(); const port = document.getElementById("remotePortInput")?.closest(".settings-row")?.getBoundingClientRect(); return grid && port ? Math.round(port.top - grid.bottom) : -1; })()');
    check('Remote settings keep space before Port', remoteSettingsSpacing >= 8);

    await wc.executeJavaScript('document.querySelector("[data-settings-page=\\'diagnose\\']")?.click()');
    const diagnoseSettingsSpacing = await wc.executeJavaScript('(() => { const grid = document.querySelector("[data-subpage=diagnose] .settings-grid-mini")?.getBoundingClientRect(); const port = document.getElementById("diagPortInput")?.closest(".settings-row")?.getBoundingClientRect(); return grid && port ? Math.round(port.top - grid.bottom) : -1; })()');
    check('Diagnose settings keep space before Port', diagnoseSettingsSpacing >= 8);

    await captureVisual('03-settings.png');

    await wc.executeJavaScript('document.querySelector("[data-settings-page=\\'uploads\\']")?.click()');
    const uploadSettingsState = await wc.executeJavaScript('(() => { const activePage = document.querySelector(".settings-subpage.active"); return [activePage?.dataset.subpage, activePage?.querySelector("h3")?.textContent.trim(), document.querySelector("label[for=removeFromQueueOnDoneInput]")?.textContent.trim(), document.getElementById("removeFromQueueOnDoneInput")?.closest(".settings-option")?.querySelector(".settings-option-description")?.textContent.trim()].join("|"); })()');
    check('Upload completion behavior is immediately findable', uploadSettingsState === 'uploads|Upload-Verhalten|Nach Abschluss aus der Liste entfernen|Erfolgreich hochgeladene Dateien verschwinden automatisch aus der Upload-Liste.');

    const settingsReadingWidth = await wc.executeJavaScript('(() => { const activePage = document.querySelector(".settings-subpage.active"); if (!activePage) return 0; return activePage.getBoundingClientRect().width; })()');
    check('Active settings page keeps a readable content width', settingsReadingWidth > 0 && settingsReadingWidth <= 760);

    const settingsFrameFit = await wc.executeJavaScript('(() => { const view = document.getElementById("settings-view")?.getBoundingClientRect(); const status = document.getElementById("statusbar")?.getBoundingClientRect(); return Boolean(view && status && status.height > 0 && view.bottom <= status.top + 1 && status.bottom <= window.innerHeight + 1); })()');
    check('Settings view and statusbar fit inside the viewport', settingsFrameFit === true);

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
    const staleImportSettings = wc.executeJavaScript('saveGlobalSettingsTracked({ ...(config.globalSettings || {}), webhookUrl: "https://import-epoch.invalid/stale-after-commit" }).then(() => ({ ok: true }), error => ({ ok: false, code: error.code }))');
    const staleImportAccounts = wc.executeJavaScript('saveConfigTracked({ hosters: { ...(config.hosters || {}), "byse.sx": [{ id: "ui-stale-account", enabled: true, authType: "api", apiKey: "stale" }] } }).then(() => ({ ok: true }), error => ({ ok: false, code: error.code }))');
    releaseFinalImportQueue?.();
    const [staleImportSettingsResult, staleImportAccountsResult] = await Promise.all([staleImportSettings, staleImportAccounts]);
    await pendingImportEpoch;
    const configAfterImportEpoch = await wc.executeJavaScript('window.api.getConfig()');
    check('Import keeps its gate closed through apply and final queue persistence', importStateDuringFinalQueuePersist.gateClosed === true && importStateDuringFinalQueuePersist.webhookUrl === 'https://import-epoch.invalid/imported' && importStateDuringFinalQueuePersist.accountId === 'ui-import-epoch-account');
    check('Import rejects stale settings and account writes until the full transition finishes', staleImportSettingsResult.code === 'CONFIG_WRITE_SUPERSEDED' && staleImportAccountsResult.code === 'CONFIG_WRITE_SUPERSEDED' && configAfterImportEpoch.hosters['byse.sx']?.[0]?.id === 'ui-import-epoch-account' && configAfterImportEpoch.globalSettings.webhookUrl === 'https://import-epoch.invalid/imported');

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
    await new Promise((resolve, reject) => {
      occupiedRemotePortServer.once('error', reject);
      occupiedRemotePortServer.listen(0, resolve);
    });
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
    const pendingQueueImport = wc.executeJavaScript('(() => { queueJobs = [{ id: "ui-queue-flush", file: "C:/ui/queue-flush.bin", fileName: "queue-flush.bin", hoster: "byse.sx", status: "preview", bytesTotal: 1 }]; rebuildJobIndex(); persistQueueStateSoon(false); return doBackupImport(); })()');
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

    const historyWorkspaceLayout = await wc.executeJavaScript('(() => { const view = document.getElementById("history-view"); const sidebar = view?.querySelector(":scope > .view-sidebar"); const main = view?.querySelector(":scope > .view-main"); if (!sidebar || !main) return false; const sidebarRect = sidebar.getBoundingClientRect(); const mainRect = main.getBoundingClientRect(); return sidebarRect.width > 0 && mainRect.width > 0 && sidebarRect.right <= mainRect.left; })()');
    check('History view separates sidebar and main workspace', historyWorkspaceLayout === true);

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
    check('History clear uses a red enabled action and opens the styled confirmation dialog', historyClearAction === 'true|false|0|flex|false|Verlauf löschen?|confirmHistoryClearBtn');
    const historyClearMessage = await wc.executeJavaScript('document.getElementById("historyClearModalMessage")?.textContent?.trim()');
    check('History clear dialog explains that deletion is permanent', historyClearMessage === 'Alle Verlaufseinträge werden dauerhaft gelöscht. Dieser Vorgang kann nicht rückgängig gemacht werden.');
    await captureVisual('04-history-clear-modal.png');
    await wc.executeJavaScript('document.getElementById("confirmHistoryClearBtn")?.click(); true');
    await waitUntil(() => wc.executeJavaScript('document.getElementById("clearHistoryBtn")?.disabled'));
    const clearedHistoryState = await wc.executeJavaScript('(() => { const modal = document.getElementById("historyClearModal"); const button = document.getElementById("clearHistoryBtn"); button?.click(); return [modal?.style.display, modal?.getAttribute("aria-hidden"), button?.disabled, document.querySelector("#historyContainer .empty-state")?.textContent?.trim()].join("|"); })()');
    check('Clearing history closes the dialog and disables the action for the empty state', clearHistoryCallCount === 1 && clearedHistoryState === 'none|true|true|Noch keine Uploads.');
    await captureVisual('04-history-empty.png');
    historyFixture = [{ timestamp: '2026-08-10T10:00:00.000Z', files: [{ name: 'ok.bin', results: [{ status: 'done', hoster: 'voe.sx', download_url: 'https://example.invalid/ok' }] }, { name: 'bad.bin', results: [{ status: 'error', hoster: 'byse.sx', error: 'Zugang abgelehnt' }] }, { name: 'stopped.bin', results: [{ status: 'aborted', hoster: 'doodstream.com' }] }] }];
    await wc.executeJavaScript('loadHistory().then(() => { window.confirm = window.__historyOriginalConfirm; delete window.__historyOriginalConfirm; })');

    const historyFrameFit = await wc.executeJavaScript('(() => { const view = document.getElementById("history-view")?.getBoundingClientRect(); const status = document.getElementById("statusbar")?.getBoundingClientRect(); return Boolean(view && status && status.height > 0 && view.bottom <= status.top + 1 && status.bottom <= window.innerHeight + 1); })()');
    check('History view and statusbar fit inside the viewport', historyFrameFit === true);

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
        counts: ['historySidebarAllCount', 'historySidebarSuccessCount', 'historySidebarErrorCount'].map(id => document.getElementById(id)?.textContent)
      };
      const success = inspect('success');
      const error = inspect('error');
      const all = inspect('all');
      return { initial, success, error, all, sourceLength: historyRowsData.length };
    })()\`);
    check('History keeps failed results in the renderer data model and All view', historyFilterState.initial.data === 3 && historyFilterState.initial.rows.join('|') === 'bad.bin|ok.bin|stopped.bin' && historyFilterState.initial.errors === 2 && historyFilterState.initial.counts.join('|') === '3|1|2');
    check('History sidebar filters successful and failed rows without dropping source data', historyFilterState.success.rows.join('|') === 'ok.bin' && historyFilterState.success.errors === 0 && historyFilterState.error.rows.join('|') === 'bad.bin|stopped.bin' && historyFilterState.error.errors === 2 && historyFilterState.all.rows.length === 3 && historyFilterState.sourceLength === 3);
    check('History sidebar exposes exactly one pressed filter', historyFilterState.success.pressed.join('|') === 'success' && historyFilterState.success.active.join('|') === 'success' && historyFilterState.error.pressed.join('|') === 'error' && historyFilterState.error.active.join('|') === 'error' && historyFilterState.all.pressed.join('|') === 'all' && historyFilterState.all.active.join('|') === 'all');

    const historyCopyControls = await wc.executeJavaScript('(() => { const rows = [...document.querySelectorAll("#historyBody .history-row")]; const buttons = rows.map(row => row.querySelector(".history-copy-link")); const inside = buttons.every(button => { const cell = button?.closest(".col-link"); const cellRect = cell?.getBoundingClientRect(); const buttonRect = button?.getBoundingClientRect(); return cellRect && buttonRect && buttonRect.right <= cellRect.right + 1 && buttonRect.left >= cellRect.left; }); return [buttons.length, buttons.every(button => button?.getAttribute("aria-label") === "Link kopieren"), inside].join("|"); })()');
    check('History links expose an in-cell copy action', historyCopyControls === '3|true|true');
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
    await wc.executeJavaScript('setUiLanguage("de")');

    console.log('\\n=== Global UI ===');

    const shutdownHidden = await wc.executeJavaScript('document.getElementById("shutdownOverlay")?.style.display');
    check('Shutdown overlay hidden', shutdownHidden === 'none');

    const toastHidden = await wc.executeJavaScript('!document.getElementById("copyToast")?.classList.contains("show")');
    check('Copy toast hidden', toastHidden);

    const updateHidden = await wc.executeJavaScript('document.getElementById("updateBanner")?.style.display');
    check('Update banner hidden', updateHidden === 'none');

    const queueProgressVisibility = {};
    for (const [label, width, height] of [['standard', 1100, 750], ['minimum', 800, 550]]) {
      win.setSize(width, height);
      await new Promise(resolve => setTimeout(resolve, 150));
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
          headerHeight: headerRect?.height,
          rowHeight: row?.getBoundingClientRect().height,
          sidebarIndicatorAligned: Boolean(sidebarIndicatorRect && activeSidebarRect && Math.abs(sidebarIndicatorRect.top - activeSidebarRect.top) <= 1 && Math.abs(sidebarIndicatorRect.width - activeSidebarRect.width) <= 1 && Math.abs(sidebarIndicatorRect.height - activeSidebarRect.height) <= 1)
        };
      })()\`);
    }
    const compactSettingsHeader = await wc.executeJavaScript('document.querySelector(".tab[data-view=settings]").click(); document.querySelector(".settings-header")?.getBoundingClientRect().height');
    win.setBounds(originalBounds);
    await new Promise(resolve => setTimeout(resolve, 150));
    await wc.executeJavaScript('queueJobs = []; rebuildJobIndex(); updateUploadView(); renderQueueTable(); updateStatusBar();');
    check('Upload progress stays visible at the standard window size', queueProgressVisibility.standard.headerVisible && queueProgressVisibility.standard.cellVisible);
    check('Upload progress stays visible at the minimum window size', queueProgressVisibility.minimum.headerVisible && queueProgressVisibility.minimum.cellVisible);
    check('Responsive queue keeps a compact table header', queueProgressVisibility.standard.headerHeight <= 34 && queueProgressVisibility.minimum.headerHeight <= 34);
    check('Responsive queue keeps the fixed virtual row height', queueProgressVisibility.standard.rowHeight === 28 && queueProgressVisibility.minimum.rowHeight === 28);
    check('Sidebar indicator stays aligned at the standard window size', queueProgressVisibility.standard.sidebarIndicatorAligned);
    check('Sidebar indicator stays aligned at the minimum window size', queueProgressVisibility.minimum.sidebarIndicatorAligned);
    check('Minimum window keeps the settings header compact', compactSettingsHeader <= 58);

    const updateOverlayState = await wc.executeJavaScript('_knownUpdateInfo = { available: true, remoteVersion: "9.9.9" }; _syncHeaderUpdateState(); document.getElementById("headerUpdateBtn").focus(); showUpdateBanner({ remoteVersion: "9.9.9", releaseNotes: "\\\\n\\\\n\\\\n## New in this version\\\\n\\\\n\\\\n### Menus and navigation\\\\n\\\\n- Added live language switching.\\\\n- Improved settings layout.\\\\n\\\\n\\\\n" }); (() => { const overlay = document.getElementById("updateBanner"); const dialog = overlay?.querySelector(".update-dialog"); const button = document.getElementById("headerUpdateBtn"); return [overlay?.classList.contains("update-overlay"), overlay?.style.display, dialog?.getAttribute("role"), dialog?.getAttribute("aria-modal"), button?.hidden, getComputedStyle(button).display].join("|"); })()');
    check('Available update opens an accessible update dialog', updateOverlayState === 'true|flex|dialog|true|false|flex');

    await new Promise(resolve => setTimeout(resolve, 100));
    const updateModalKeyboard = await wc.executeJavaScript(\`(() => {
      const close = document.getElementById('updateCloseBtn');
      const install = document.getElementById('installUpdateBtn');
      const initialFocus = document.activeElement?.id;
      const backgroundInert = document.querySelector('.app-header')?.inert === true && document.querySelector('.view.active')?.inert === true && document.getElementById('statusbar')?.inert === true;
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
    const updateDialogChangelog = await wc.executeJavaScript('(() => { const title = document.querySelector(".update-release-notes-title"); const body = document.getElementById("updateReleaseNotesBody"); const titleRect = title?.getBoundingClientRect(); const bodyRect = body?.getBoundingClientRect(); return { hidden: document.getElementById("updateReleaseNotes")?.hidden, title: title?.textContent?.trim(), body: body?.textContent, gap: bodyRect && titleRect ? bodyRect.top - titleRect.bottom : null }; })()');
    check('Update dialog renders a compact normalized changelog', updateDialogChangelog.hidden === false && updateDialogChangelog.title === 'Changelog' && updateDialogChangelog.body === 'New in this version\\n\\nMenus and navigation\\n\\n• Added live language switching.\\n• Improved settings layout.' && updateDialogChangelog.gap <= 10);

    const updateHeaderHint = await wc.executeJavaScript('(() => { const button = document.getElementById("headerUpdateBtn"); return [button?.textContent?.trim(), button?.getAttribute("aria-label"), button?.dataset.tooltip].join("|"); })()');
    check('Available update gives the header action a matching hint', updateHeaderHint === 'Update verfügbar|Update v9.9.9 verfügbar. Klicken zum Installieren.|Update v9.9.9 verfügbar. Klicken zum Installieren.');

    const updateDialogDismissed = await wc.executeJavaScript('document.getElementById("dismissUpdateBtn")?.click(); (() => { const overlay = document.getElementById("updateBanner"); return [overlay?.style.display, overlay?.getAttribute("aria-hidden"), document.activeElement?.id, document.querySelector(".app-header")?.inert, document.querySelector(".view.active")?.inert, document.getElementById("statusbar")?.inert].join("|"); })()');
    check('Update dialog closes and restores focus and background', updateDialogDismissed === 'none|true|headerUpdateBtn|false|false|false');

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
        progressLabel: progress.getAttribute('aria-label'),
        progressText: progress.getAttribute('aria-valuetext')
      };
    })()\`);
    check('Busy update keeps its progress dialog open', busyUpdateState.display === 'flex' && busyUpdateState.hidden === 'false' && busyUpdateState.closeDisabled === true && busyUpdateState.dismissDisabled === true && busyUpdateState.headerHidden === false);
    check('Update progress exposes an accessible live value', busyUpdateState.progressLabel === 'Update-Fortschritt' && busyUpdateState.progressText === 'Download 50%');
    check('Busy update shows progress only below the bar', busyUpdateState.messageHidden === true && busyUpdateState.messageText === 'Update v9.9.9 verfügbar');

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
    check('Update preparation stops before install IPC when queue persistence fails', installUpdateIpcCalls === 0 && updateSaveFailure.busy === false && updateSaveFailure.message.includes('update queue save failed'));
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
      win.setSize(800, 550);
      await wc.executeJavaScript('document.querySelector(".tab[data-view=\\\'settings\\\']").click(); document.querySelector("[data-settings-page=\\\'allgemein\\\']")?.click(); (() => { const search = document.getElementById("settingsSearchInput"); if (search) { search.value = ""; search.dispatchEvent(new Event("input", { bubbles: true })); } document.querySelector(".settings-content")?.scrollTo(0, 0); })()');
      await captureVisual('06-settings-800x550.png');
      win.setBounds(originalBounds);
    }

    restoreInitialIpcHandler('save-global-settings');
    restoreInitialIpcHandler('save-pending-queue');
    const keepaliveWindow = new BrowserWindow({ show: false });
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
    const recoveryBeforeAck = await wc.executeJavaScript('({ state: closePreparationState, promiseCleared: closePreparationPromise === null, overlayVisible: document.getElementById("shutdownOverlay")?.style.display === "flex", inertRetained: closePreparationInertState.length > 0 && closePreparationInertState.every(({ element }) => element.inert === true) })');
    const windowStayedOpenAfterCloseFailure = !win.isDestroyed();
    rejectHungFinalQueueWrite?.(new Error('final queue write timeout'));
    releaseRestoreAck?.();
    const boundedCloseRecovery = await waitUntil(async () => {
      if (win.isDestroyed()) return null;
      const state = await wc.executeJavaScript('({ state: closePreparationState, promiseCleared: closePreparationPromise === null, overlayHidden: document.getElementById("shutdownOverlay")?.style.display === "none", inertRestored: closePreparationInertState.length === 0, failedWrites: failedConfigWriteOperations.length })');
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
    const closeRecoveryOk = windowStayedOpenAfterCloseFailure === true && recoveryBeforeAck.state === 'recovering' && recoveryBeforeAck.promiseCleared === false && recoveryBeforeAck.overlayVisible === true && recoveryBeforeAck.inertRetained === true && boundedCloseRecovery?.state === 'open' && boundedCloseRecovery.promiseCleared === true && boundedCloseRecovery.overlayHidden === true && boundedCloseRecovery.inertRestored === true && boundedCloseRecovery.failedWrites === 0 && activeConfigStore._writesQuiesced === false && Number.isInteger(closeReadyAttempt) && closeRestoreAttempt === closeReadyAttempt && writeAfterCloseRecovery.ok === true && historyAfterCloseRecovery.ok === true && configAfterCloseRecovery.globalSettings.webhookUrl === closeRecoveryMarker && recoveredQueue.some(job => job.id === 'ui-close-timeout-job') && preparedUpdateMockCalls === 1 && launchedUpdateMockCalls === 0 && failedUpdateUi.busy === false && failedUpdateUi.message.includes('nicht gestartet');
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
    const closeUiQuiesced = await wc.executeJavaScript('document.getElementById("shutdownOverlay")?.style.display === "flex" && closePreparationInertState.length > 0 && closePreparationInertState.every(({ element }) => element.inert === true)');
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
    [`--user-data-dir=${userDataPath}`, '--require', injectPath, mainPath],
    { cwd: path.join(__dirname, '..'), timeout: 60000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
  );
  console.log(result);
  const isolatedConfigPath = path.join(userDataPath, 'electron-config.json');
  if (!fs.existsSync(isolatedConfigPath)) throw new Error(`Isolated UI config was not created: ${isolatedConfigPath}`);
} catch (err) {
  // timeout or exit code - still print output
  if (err.stdout) console.log(err.stdout);
  if (err.stderr) {
    const filtered = err.stderr.split('\n')
      .filter(l => !l.includes('cache_util') && !l.includes('disk_cache') && !l.includes('gpu_disk_cache'))
      .join('\n');
    if (filtered.trim()) console.error(filtered);
  }
  process.exitCode = Number.isInteger(err.status) && err.status !== 0 ? err.status : 1;
} finally {
  try { fs.unlinkSync(injectPath); } catch {}
  try { fs.rmSync(userDataPath, { recursive: true, force: true }); } catch {}
}
