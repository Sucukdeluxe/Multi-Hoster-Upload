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

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Create a temp script that the real Electron app will execute via --eval
const testScript = `
const { app, BrowserWindow } = require('electron');

// Monkey-patch: after the real window loads, run tests
const origReady = app.whenReady;

async function runAfterDelay(win, delayMs) {
  await new Promise(r => setTimeout(r, delayMs));
  return win;
}

// Wait for app to be ready, then wait for the real window to load
setTimeout(async () => {
  const windows = BrowserWindow.getAllWindows();
  if (windows.length === 0) { console.log('ERROR: No windows found'); process.exit(1); }
  const win = windows[0];
  const wc = win.webContents;

  // Wait for renderer init
  await new Promise(r => setTimeout(r, 2000));

  let passed = 0;
  let failed = 0;
  const results = [];

  function check(name, condition) {
    if (condition) { passed++; results.push('  PASS: ' + name); }
    else { failed++; results.push('  FAIL: ' + name); }
  }

  try {
    console.log('\\n=== Upload View ===');

    const tabCount = await wc.executeJavaScript('document.querySelectorAll(".tab").length');
    check('4 tabs exist', tabCount === 4);

    const tabLabels = await wc.executeJavaScript('[...document.querySelectorAll(".tab")].map(el => el.textContent.trim()).join("|")');
    check('Current tab labels present', tabLabels === 'Upload|Accounts|Einstellungen|Verlauf');

    const tabSemantics = await wc.executeJavaScript('document.querySelector(".tab-bar")?.getAttribute("role") + "|" + document.querySelector(".tab.active")?.getAttribute("aria-selected")');
    check('Tab navigation exposes active state', tabSemantics === 'tablist|true');

    const activeTab = await wc.executeJavaScript('document.querySelector(".tab.active")?.textContent?.trim()');
    check('Upload tab active by default', activeTab === 'Upload');

    const tabStops = await wc.executeJavaScript('[...document.querySelectorAll(".tab")].map(el => el.tabIndex).join("|")');
    check('Tab navigation exposes one keyboard stop', tabStops === '0|-1|-1|-1');

    const dropVisible = await wc.executeJavaScript('document.getElementById("dropZone")?.style.display !== "none"');
    check('Drop zone visible (no files)', dropVisible);

    const queueHidden = await wc.executeJavaScript('document.getElementById("queueShell")?.style.display');
    check('Queue hidden (no files)', queueHidden === 'none');

    const startDisabled = await wc.executeJavaScript('document.getElementById("startUploadBtn")?.disabled');
    check('Start button disabled initially', startDisabled === true);

    const sbState = await wc.executeJavaScript('document.getElementById("sbState")?.textContent');
    check('Statusbar: Bereit', sbState === 'Bereit');

    const version = await wc.executeJavaScript('document.getElementById("versionLabel")?.textContent');
    check('Version label present', version && version.startsWith('v'));

    const localizedQueueHeaders = await wc.executeJavaScript('[...document.querySelectorAll("#queueTable thead th")].map(el => el.childNodes[0]?.textContent.trim()).join("|")');
    check('Upload table labels are consistently German', localizedQueueHeaders === 'Dateiname|Hochgeladen / Größe|Hoster|Status|Zeit|Rest|Geschwindigkeit|Fortschritt');

    const localizedRecentTabs = await wc.executeJavaScript('[...document.querySelectorAll(".recent-tab")].map(el => el.textContent.trim()).join("|")');
    check('Recent panel labels are consistently German', localizedRecentTabs === 'Dateien|Statistik');

    const localizedStatusbar = await wc.executeJavaScript('["sbConnections", "sbQueueCount", "sbRemainingCount", "sbInProgressCount", "sbDoneCount", "sbErrorCount"].map(id => document.getElementById(id)?.textContent).join("|")');
    check('Statusbar labels are consistently German', localizedStatusbar === 'Verbindungen 0|Gesamt 0|Verbleibend 0|Läuft 0|Fertig 0|Fehler 0');

    const toolbarLabels = await wc.executeJavaScript('[...document.querySelectorAll("#queueCommandBar .toolbar-btn")].map(el => el.getAttribute("aria-label")).join("|")');
    check('Upload toolbar actions have German accessible names', toolbarLabels === 'Alle Uploads starten|Ausgewählte Uploads starten|Ausgewählte Datei erneut hochladen|Ausgewählten Upload abbrechen|Aktive Uploads beenden und stoppen|Alle Uploads abbrechen|Ganz nach oben|Nach oben|Nach unten|Ganz nach unten');

    const keyboardTab = await wc.executeJavaScript('document.getElementById("upload-tab").focus(); document.getElementById("upload-tab").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); document.querySelector(".tab.active")?.textContent?.trim() + "|" + document.activeElement?.id');
    check('Arrow keys move and activate main tabs', keyboardTab === 'Accounts|accounts-tab');

    const ctxHidden = await wc.executeJavaScript('document.getElementById("contextMenu")?.style.display');
    check('Context menu hidden', ctxHidden === 'none');

    console.log('\\n=== Accounts View ===');

    await wc.executeJavaScript('document.querySelector(".tab[data-view=\\'accounts\\']").click()');
    await new Promise(r => setTimeout(r, 300));

    const accountsActive = await wc.executeJavaScript('document.getElementById("accounts-view")?.classList.contains("active")');
    check('Accounts tab active', accountsActive);

    const accountListValid = await wc.executeJavaScript('Boolean(document.querySelector("#accountsList .accounts-empty") || document.querySelectorAll("#accountsList .account-hoster-group").length)');
    check('Account manager list structure rendered', accountListValid);

    const addAccountEnabled = await wc.executeJavaScript('document.getElementById("addAccountBtn")?.disabled === false');
    check('Add account button enabled', addAccountEnabled);

    const emptyAccountAction = await wc.executeJavaScript('document.querySelector("[data-account-empty-add]")?.textContent?.trim()');
    check('Empty account state offers direct action', emptyAccountAction === 'Ersten Account hinzufügen');

    await wc.executeJavaScript('document.querySelector("[data-account-empty-add]").focus(); document.querySelector("[data-account-empty-add]").click()');
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
    check('Account submit label is Prüfen und anlegen', accountSubmitLabel === 'Prüfen und anlegen');

    const credentialInputs = await wc.executeJavaScript('document.querySelectorAll("#accountCredsFields .key-input").length');
    check('Credential inputs rendered', credentialInputs === 2);

    const passwordToggleState = await wc.executeJavaScript('document.querySelector("#accountCredsFields .toggle-vis").click(); document.querySelector("#accountCredsFields .toggle-vis").getAttribute("aria-label") + "|" + document.querySelector("#accountCredsFields .toggle-vis").getAttribute("aria-pressed")');
    check('Password visibility action exposes its state', passwordToggleState === 'Passwort verbergen|true');

    await wc.executeJavaScript('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
    const accountModalHidden = await wc.executeJavaScript('document.getElementById("accountModal")?.style.display');
    check('Escape closes account modal', accountModalHidden === 'none');

    const restoredAccountFocus = await wc.executeJavaScript('document.activeElement?.hasAttribute("data-account-empty-add")');
    check('Account modal restores trigger focus', restoredAccountFocus === true);

    const fallbackAccountFocus = await wc.executeJavaScript('document.querySelector("[data-account-empty-add]").focus(); document.querySelector("[data-account-empty-add]").click(); document.querySelector("[data-account-empty-add]").remove(); document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); document.activeElement?.id');
    check('Account modal restores stable focus after list rerender', fallbackAccountFocus === 'addAccountBtn');

    console.log('\\n=== Settings View ===');

    await wc.executeJavaScript('document.querySelector(".tab[data-view=\\'settings\\']").click()');
    await new Promise(r => setTimeout(r, 300));

    const settingsActive = await wc.executeJavaScript('document.getElementById("settings-view")?.classList.contains("active")');
    check('Settings tab active', settingsActive);

    const settingsSubtabs = await wc.executeJavaScript('document.querySelectorAll(".settings-subtab").length');
    check('6 settings subtabs exist', settingsSubtabs === 6);

    const accountSettingsPointer = await wc.executeJavaScript('document.querySelector(".settings-hoster-pointer")?.textContent');
    check('Hoster settings point to Accounts tab', accountSettingsPointer && accountSettingsPointer.includes('Accounts'));

    const parallel = await wc.executeJavaScript('document.getElementById("parallelUploadCountInput")?.value');
    check('Global parallel uploads default 0', parallel === '0');

    // Test save
    await wc.executeJavaScript('document.getElementById("saveSettingsBtn").click()');
    await new Promise(r => setTimeout(r, 500));
    const feedback = await wc.executeJavaScript('document.getElementById("saveFeedback")?.textContent');
    check('Save shows Gespeichert!', feedback === 'Gespeichert!');

    console.log('\\n=== History View ===');

    await wc.executeJavaScript('document.querySelector(".tab[data-view=\\'history\\']").click()');
    await new Promise(r => setTimeout(r, 1000)); // Wait for async loadHistory

    const historyActive = await wc.executeJavaScript('document.getElementById("history-view")?.classList.contains("active")');
    check('History tab active', historyActive);

    const emptyState = await wc.executeJavaScript('document.querySelector("#historyContainer .empty-state")?.textContent');
    check('Empty state or history table shown', emptyState === 'Noch keine Uploads.' || emptyState === undefined);

    console.log('\\n=== Global UI ===');

    const shutdownHidden = await wc.executeJavaScript('document.getElementById("shutdownOverlay")?.style.display');
    check('Shutdown overlay hidden', shutdownHidden === 'none');

    const toastHidden = await wc.executeJavaScript('!document.getElementById("copyToast")?.classList.contains("show")');
    check('Copy toast hidden', toastHidden);

    const updateHidden = await wc.executeJavaScript('document.getElementById("updateBanner")?.style.display');
    check('Update banner hidden', updateHidden === 'none');

  } catch (err) {
    console.error('Test error:', err.message);
    failed++;
  }

  console.log('\\n=== Results ===');
  results.forEach(r => console.log(r));
  console.log('\\nTotal: ' + (passed + failed) + ' | Passed: ' + passed + ' | Failed: ' + failed);

  app.exit(failed > 0 ? 1 : 0);
}, 5000);
`;

// Write the injection script
const injectPath = path.join(__dirname, '_ui-inject.tmp.js');
fs.writeFileSync(injectPath, testScript, 'utf-8');

// Run the real app with the injection
try {
  const electronPath = path.join(__dirname, '..', 'node_modules', '.bin', 'electron');
  const mainPath = path.join(__dirname, '..', 'main.js');

  // We'll use --require to inject the test after the main process loads
  const result = execSync(
    `"${electronPath}" --require "${injectPath}" "${mainPath}"`,
    { cwd: path.join(__dirname, '..'), timeout: 20000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
  );
  console.log(result);
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
}
