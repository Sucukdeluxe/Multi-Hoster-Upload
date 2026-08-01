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

// Create a temp script that the real Electron app will execute via --eval
const testScript = `
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

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

    const isolationRoot = process.env.UI_SMOKE_ISOLATION_ROOT || '';
    const isolatedRootReady = path.isAbsolute(isolationRoot) && fs.existsSync(isolationRoot);
    const isolatedAppData = isolatedRootReady && path.isAbsolute(process.env.APPDATA || '') && fs.existsSync(process.env.APPDATA) && path.resolve(process.env.APPDATA).toLowerCase() === path.resolve(isolationRoot, 'appdata').toLowerCase();
    const isolatedLocalAppData = isolatedRootReady && path.isAbsolute(process.env.LOCALAPPDATA || '') && fs.existsSync(process.env.LOCALAPPDATA) && path.resolve(process.env.LOCALAPPDATA).toLowerCase() === path.resolve(isolationRoot, 'localappdata').toLowerCase();
    const isolatedUserData = isolatedRootReady && path.isAbsolute(app.getPath('userData')) && fs.existsSync(app.getPath('userData')) && path.resolve(app.getPath('userData')).toLowerCase() === path.resolve(isolationRoot, 'user-data').toLowerCase();
    console.log('Isolation: APPDATA=' + process.env.APPDATA + ' | LOCALAPPDATA=' + process.env.LOCALAPPDATA + ' | userData=' + app.getPath('userData'));
    check('APPDATA, LOCALAPPDATA and Electron userData use isolated directories', isolatedAppData && isolatedLocalAppData && isolatedUserData);
    check('Forced failure propagation', process.env.UI_SMOKE_FORCE_FAILURE !== '1');

    const tabCount = await wc.executeJavaScript('document.querySelectorAll(".tab-bar > .tab").length');
    check('4 main tabs exist', tabCount === 4);

    const tabLabels = await wc.executeJavaScript('Array.from(document.querySelectorAll(".tab-bar > .tab"), el => el.textContent.trim()).join("|")');
    check('Main tabs expose current views', tabLabels === 'Upload|Accounts|Einstellungen|Verlauf');

    const activeTab = await wc.executeJavaScript('document.querySelector(".tab.active")?.textContent?.trim()');
    check('Upload tab active by default', activeTab === 'Upload');

    const dropVisible = await wc.executeJavaScript('document.getElementById("dropZone")?.style.display !== "none"');
    check('Drop zone visible (no files)', dropVisible);

    const queueHidden = await wc.executeJavaScript('document.getElementById("queueShell")?.style.display');
    check('Queue hidden (no files)', queueHidden === 'none');

    const queueControlCount = await wc.executeJavaScript('document.querySelectorAll("#queueCommandBar .toolbar-btn").length');
    check('10 queue controls exist', queueControlCount === 10);

    const hosterSummary = await wc.executeJavaScript('document.getElementById("hosterSummary")?.textContent');
    check('Hoster summary reflects empty account state', hosterSummary === 'Keine Upload-Ziele ausgewählt');

    const hosterOptionCount = await wc.executeJavaScript('document.querySelectorAll("#hosterModalList .hoster-option").length');
    check('No selectable hosters without accounts', hosterOptionCount === 0);

    const hosterHint = await wc.executeJavaScript('document.getElementById("hosterModalHint")?.textContent');
    check('Hoster selection explains missing credentials', hosterHint && hosterHint.includes('Keine Hoster mit Zugangsdaten'));

    const startDisabled = await wc.executeJavaScript('document.getElementById("startUploadBtn")?.disabled');
    check('Start button disabled initially', startDisabled === true);

    const sbState = await wc.executeJavaScript('document.getElementById("sbState")?.textContent');
    check('Statusbar: Bereit', sbState === 'Bereit');

    const version = await wc.executeJavaScript('document.getElementById("versionLabel")?.textContent');
    check('Product version label present', version === 'v3.3.108');

    const ctxHidden = await wc.executeJavaScript('document.getElementById("contextMenu")?.style.display');
    check('Context menu hidden', ctxHidden === 'none');

    console.log('\\n=== Accounts View ===');

    await wc.executeJavaScript('document.querySelector(".tab[data-view=\\'accounts\\']").click()');
    await new Promise(r => setTimeout(r, 300));

    const accountsActive = await wc.executeJavaScript('document.getElementById("accounts-view")?.classList.contains("active")');
    check('Accounts tab active', accountsActive);

    const accountsEmpty = await wc.executeJavaScript('document.querySelector("#accountsList .accounts-empty p")?.textContent');
    check('Accounts show privacy-safe empty state', accountsEmpty === 'Keine Accounts vorhanden');

    await wc.executeJavaScript('document.getElementById("addAccountBtn").click()');
    await new Promise(r => setTimeout(r, 200));

    const accountModalVisible = await wc.executeJavaScript('document.getElementById("accountModal")?.style.display');
    check('Add-account modal opens', accountModalVisible === 'flex');

    const accountHosterOptions = await wc.executeJavaScript('document.querySelectorAll("#accountHosterSelect option").length');
    check('7 current hoster/auth options exist', accountHosterOptions === 7);

    const accountFieldsEmpty = await wc.executeJavaScript('["accField_label","accField_username","accField_password","accField_apiKey"].filter(id => document.getElementById(id)).every(id => document.getElementById(id).value === "")');
    check('Account fields start empty', accountFieldsEmpty);

    await wc.executeJavaScript('document.getElementById("closeAccountModalBtn").click()');
    await new Promise(r => setTimeout(r, 100));

    console.log('\\n=== Settings View ===');

    await wc.executeJavaScript('document.querySelector(".tab[data-view=\\'settings\\']").click()');
    await new Promise(r => setTimeout(r, 300));

    const settingsActive = await wc.executeJavaScript('document.getElementById("settings-view")?.classList.contains("active")');
    check('Settings tab active', settingsActive);

    const settingsSubtabs = await wc.executeJavaScript('document.querySelectorAll(".settings-subtab").length');
    check('6 settings subtabs exist', settingsSubtabs === 6);

    const parallel = await wc.executeJavaScript('document.getElementById("parallelUploadCountInput")?.value');
    check('Global parallel upload default is unlimited', parallel === '0');

    const settingsPointer = await wc.executeJavaScript('document.querySelector(".settings-hoster-pointer")?.textContent');
    check('Settings points hoster controls to Accounts', settingsPointer && settingsPointer.includes('Accounts'));

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

let injectRoot;
let injectPath;
let isolationRoot;
let runProvenSuccessful = false;
let childStarted = false;
let childStartTimeMs = 0;
let logSnapshots;
const appPath = path.resolve(__dirname, '..');
const protectedLogPaths = [path.join(appPath, 'crash.log'), path.join(appPath, 'upload-debug.log')];

function removeTempTree(target, prefix) {
  if (!target) return;
  const resolvedTarget = path.resolve(target);
  const resolvedTemp = path.resolve(os.tmpdir());
  const validParent = path.dirname(resolvedTarget).toLowerCase() === resolvedTemp.toLowerCase();
  const validName = path.basename(resolvedTarget).startsWith(prefix);
  if (!validParent || !validName) {
    throw new Error('Refusing to remove unexpected UI smoke path: ' + resolvedTarget);
  }
  fs.rmSync(resolvedTarget, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function captureLogSnapshot(filePath) {
  try {
    const stats = fs.lstatSync(filePath);
    if (!stats.isFile()) throw new Error('UI smoke protected log is not a regular file: ' + filePath);
    return {
      filePath,
      existed: true,
      bytes: fs.readFileSync(filePath),
      mode: stats.mode,
      atimeMs: stats.atimeMs,
      mtimeMs: stats.mtimeMs,
    };
  } catch (err) {
    if (err.code === 'ENOENT') return { filePath, existed: false };
    throw err;
  }
}

function restoreLogSnapshot(snapshot) {
  let currentStats;
  try {
    currentStats = fs.lstatSync(snapshot.filePath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  if (snapshot.existed) {
    if (currentStats && !currentStats.isFile()) throw new Error('UI smoke cannot restore non-file log path: ' + snapshot.filePath);
    fs.writeFileSync(snapshot.filePath, snapshot.bytes, currentStats ? undefined : { flag: 'wx', mode: snapshot.mode });
    fs.chmodSync(snapshot.filePath, snapshot.mode);
    fs.utimesSync(snapshot.filePath, snapshot.atimeMs / 1000, snapshot.mtimeMs / 1000);
    const restoredBytes = fs.readFileSync(snapshot.filePath);
    const restoredStats = fs.statSync(snapshot.filePath);
    if (!restoredBytes.equals(snapshot.bytes)) throw new Error('UI smoke log byte restoration failed: ' + snapshot.filePath);
    if ((restoredStats.mode & 0o777) !== (snapshot.mode & 0o777)) throw new Error('UI smoke log mode restoration failed: ' + snapshot.filePath);
    if (Math.abs(restoredStats.mtimeMs - snapshot.mtimeMs) > 1) throw new Error('UI smoke log mtime restoration failed: ' + snapshot.filePath);
    return 'restored';
  }

  if (!currentStats) return 'unchanged';
  const writtenDuringChild = childStarted && childStartTimeMs > 0 && currentStats.mtimeMs >= childStartTimeMs - 1000;
  if (!writtenDuringChild || !currentStats.isFile()) throw new Error('UI smoke refuses to remove unproven generated log: ' + snapshot.filePath);
  fs.unlinkSync(snapshot.filePath);
  return 'removed';
}

try {
  logSnapshots = protectedLogPaths.map(captureLogSnapshot);
  isolationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mhu-ui-smoke-state-'));
  const appDataDir = path.join(isolationRoot, 'appdata');
  const localAppDataDir = path.join(isolationRoot, 'localappdata');
  const userDataDir = path.join(isolationRoot, 'user-data');
  for (const directory of [appDataDir, localAppDataDir, userDataDir]) {
    fs.mkdirSync(directory);
    if (!path.isAbsolute(directory) || fs.readdirSync(directory).length !== 0) {
      throw new Error('UI smoke isolation directory is not new, empty and absolute: ' + directory);
    }
  }

  injectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mhu-ui-smoke-inject-'));
  injectPath = path.join(injectRoot, 'ui-inject.js');
  fs.writeFileSync(injectPath, testScript, 'utf-8');

  if (process.env.UI_SMOKE_FORCE_SETUP_FAILURE === '1') {
    throw new Error('Forced UI smoke setup failure');
  }
  const electronPath = process.env.UI_SMOKE_FORCE_SPAWN_FAILURE === '1'
    ? path.join(isolationRoot, 'missing-electron.exe')
    : require('electron');
  const childEnv = {
    ...process.env,
    APPDATA: appDataDir,
    LOCALAPPDATA: localAppDataDir,
    ELECTRON_USER_DATA_DIR: userDataDir,
    UI_SMOKE_ISOLATION_ROOT: isolationRoot,
  };
  childStartTimeMs = Date.now();
  let result;
  try {
    result = execFileSync(
      electronPath,
      [`--user-data-dir=${userDataDir}`, '--require', injectPath, appPath],
      { cwd: isolationRoot, env: childEnv, timeout: process.env.UI_SMOKE_FORCE_TIMEOUT === '1' ? 1000 : 20000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    childStarted = true;
  } catch (err) {
    childStarted = (Number.isInteger(err.pid) && err.pid > 0) || Number.isInteger(err.status) || Boolean(err.signal);
    throw err;
  }
  console.log(result);
  runProvenSuccessful = true;
} catch (err) {
  if (err.stdout) console.log(err.stdout);
  if (err.stderr) {
    const filtered = err.stderr.split('\n')
      .filter(l => !l.includes('cache_util') && !l.includes('disk_cache') && !l.includes('gpu_disk_cache'))
      .join('\n');
    if (filtered.trim()) console.error(filtered);
  }
  if (!err.stdout && !err.stderr) console.error(err.message);
  process.exitCode = Number.isInteger(err.status) && err.status > 0 && err.status <= 255 ? err.status : 1;
} finally {
  if (logSnapshots) {
    const cleanupResults = [];
    for (const snapshot of logSnapshots) {
      try {
        cleanupResults.push(path.basename(snapshot.filePath) + '=' + restoreLogSnapshot(snapshot));
      } catch (err) {
        console.error(err.message);
        process.exitCode = 1;
      }
    }
    if (cleanupResults.length) console.log('UI smoke log cleanup: ' + cleanupResults.join(', '));
  }
  for (const [target, prefix] of [[injectRoot, 'mhu-ui-smoke-inject-'], [isolationRoot, 'mhu-ui-smoke-state-']]) {
    try {
      removeTempTree(target, prefix);
    } catch (err) {
      console.error(err.message);
      process.exitCode = 1;
    }
  }
}

if (!runProvenSuccessful && (!process.exitCode || process.exitCode === 0)) process.exitCode = 1;
