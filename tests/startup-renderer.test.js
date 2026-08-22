const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStartupWindow, resolveStartupLanguage, createStartupQuery } = require('../lib/startup-renderer');

class TestBrowserWindow extends EventEmitter {
  constructor(options) {
    super();
    this.webContents = new EventEmitter();
    this.options = options;
    this.showCalls = 0;
    this.startupEvents = [];
    this.loadError = new Error('renderer load failed');
    this.loadOptions = null;
  }

  once(eventName, listener) {
    this.startupEvents.push(`listen:${eventName}`);
    return super.once(eventName, listener);
  }

  show() {
    this.showCalls++;
  }

  loadFile(target, options) {
    this.startupEvents.push(`load:${target}`);
    this.loadOptions = options;
    return this.loadError ? Promise.reject(this.loadError) : Promise.resolve();
  }
}

test('production startup never forces software compositing', () => {
  const projectRoot = path.join(__dirname, '..');
  const pending = [path.join(projectRoot, 'main.js'), path.join(projectRoot, 'lib')];
  const sourceFiles = [];
  while (pending.length) {
    const target = pending.pop();
    const stat = fs.statSync(target);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(target)) pending.push(path.join(target, entry));
    } else if (target.endsWith('.js')) {
      sourceFiles.push(target);
    }
  }
  for (const sourceFile of sourceFiles) {
    const source = fs.readFileSync(sourceFile, 'utf8');
    assert.doesNotMatch(source, /disableHardwareAcceleration|disable-gpu(?:-compositing)?/u, path.relative(projectRoot, sourceFile));
  }
});

test('Windows compositor paints the full hidden surface with an RDP session environment', { skip: process.platform !== 'win32' }, () => {
  const projectRoot = path.join(__dirname, '..');
  const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mhu-rdp-compositor-'));
  const probePath = path.join(probeRoot, 'probe.cjs');
  const preloadPath = path.join(probeRoot, 'preload.cjs');
  const outputPath = path.join(probeRoot, 'result.json');
  const userDataPath = path.join(probeRoot, 'user-data');
  fs.writeFileSync(preloadPath, `
const { contextBridge } = require('electron');
const managedOnlineBackupProbeCalls = [];
let pendingManagedOnlineBackupDelete = null;
contextBridge.exposeInMainWorld('api', {
  onUpdateAvailable() {},
  onUpdateProgress() {},
  onPrepareClose() {},
  getConfig() { return new Promise(() => {}); },
  listManagedOnlineBackups() {
    managedOnlineBackupProbeCalls.push(['list']);
    return Promise.resolve({ ok: true, entries: [
      { id: 'AAAAAAAAAAAAAAAAAAAAAA', displayKey: 'MHU2-ABCD…1234', createdAt: '2026-08-20T08:00:00.000Z' },
      { id: 'BBBBBBBBBBBBBBBBBBBBBB', displayKey: 'MHU2-ZYXW…9876', createdAt: '2026-08-22T10:00:00.000Z' }
    ] });
  },
  createManagedOnlineBackup() {
    managedOnlineBackupProbeCalls.push(['create']);
    return Promise.resolve({ ok: true, entry: { id: 'CCCCCCCCCCCCCCCCCCCCCC', displayKey: 'MHU2-QWER…4321', createdAt: '2026-08-23T12:00:00.000Z' } });
  },
  copyManagedOnlineBackup(id) {
    managedOnlineBackupProbeCalls.push(['copy', id]);
    return Promise.resolve({ ok: true });
  },
  deleteManagedOnlineBackup(id) {
    managedOnlineBackupProbeCalls.push(['delete', id]);
    return new Promise(resolve => { pendingManagedOnlineBackupDelete = { id, resolve }; });
  },
  releaseManagedOnlineBackupDelete() {
    const pending = pendingManagedOnlineBackupDelete;
    pendingManagedOnlineBackupDelete = null;
    pending.resolve({ ok: true, removedId: pending.id, notFound: false });
  },
  getManagedOnlineBackupProbeCalls() { return managedOnlineBackupProbeCalls; }
});
`, 'utf8');
  const onlineBackupBehaviorScript = `(async () => {
    const fixture = document.createElement('section');
    fixture.innerHTML = '<div id="managedOnlineBackupList"></div><div id="onlineBackupStatus"></div><button id="createOnlineBackupBtn"></button><input id="onlineBackupKeyInput"><button id="restoreOnlineBackupBtn"></button>';
    document.body.append(fixture);
    let confirmation = null;
    showAppConfirm = async options => { confirmation = options; return true; };
    flushPendingSettingsSaves = async () => {};
    openOnlineBackupView = () => {};
    await loadManagedOnlineBackups();
    const initialKeys = [...document.querySelectorAll('.online-backup-managed-key')].map(element => element.textContent);
    const maliciousEntry = { id: 'DDDDDDDDDDDDDDDDDDDDDD', displayKey: 'prefix MHU2-' + 'X'.repeat(70) + ' suffix', createdAt: '2026-08-24T12:00:00.000Z' };
    replaceManagedOnlineBackups([...managedOnlineBackups, maliciousEntry]);
    const secretRejected = !document.body.textContent.includes(maliciousEntry.displayKey) && managedOnlineBackups.every(entry => entry.displayKey !== maliciousEntry.displayKey);
    document.querySelector('.online-backup-copy-btn').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    document.querySelector('.online-backup-delete-btn').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    renderManagedOnlineBackups();
    const pendingDeleteControlsDisabled = [...document.querySelector('.online-backup-managed-row').querySelectorAll('button')].every(button => button.disabled);
    window.api.releaseManagedOnlineBackupDelete();
    await new Promise(resolve => setTimeout(resolve, 0));
    const afterDelete = [...document.querySelectorAll('.online-backup-managed-key')].map(element => element.textContent);
    await doOnlineBackupCreate();
    const afterCreate = [...document.querySelectorAll('.online-backup-managed-key')].map(element => element.textContent);
    return {
      initialKeys,
      secretRejected,
      pendingDeleteControlsDisabled,
      afterDelete,
      afterCreate,
      confirmation,
      calls: await window.api.getManagedOnlineBackupProbeCalls(),
      stateFields: Object.keys(managedOnlineBackups[0] || {}).sort(),
      secretInBody: /MHU2-[A-Za-z0-9_-]{70}/.test(document.body.textContent)
    };
  })()`;
  const onlineBackupLayoutScript = `(() => {
    const measure = language => {
      const copy = language === 'de' ? 'Schlüssel kopieren' : 'Copy key';
      const remove = language === 'de' ? 'Online-Backup löschen' : 'Delete online backup';
      document.documentElement.lang = language;
      document.body.innerHTML = '<section class="online-backup-panel"><section class="online-backup-managed"><h4>Managed</h4><div class="online-backup-managed-list"><article class="online-backup-managed-row"><span class="online-backup-managed-key">ABCDEFGH…1234</span><span class="online-backup-managed-created">22.08.2026 12:00</span><div class="online-backup-managed-actions"><button class="btn btn-secondary">' + copy + '</button><button class="btn btn-danger">' + remove + '</button></div></article><article class="online-backup-managed-row"><span class="online-backup-managed-key">ZYXWVUTS…9876</span><span class="online-backup-managed-created">21.08.2026 11:00</span><div class="online-backup-managed-actions"><button class="btn btn-secondary">' + copy + '</button><button class="btn btn-danger">' + remove + '</button></div></article></div></section><footer class="online-backup-footer"><button class="btn btn-primary">Generate new key</button></footer></section>';
      const panel = document.querySelector('.online-backup-panel');
      const panelRect = panel.getBoundingClientRect();
      const panelStyle = getComputedStyle(panel);
      const rows = [...document.querySelectorAll('.online-backup-managed-row')].map(row => {
        const key = row.querySelector('.online-backup-managed-key').getBoundingClientRect();
        const created = row.querySelector('.online-backup-managed-created').getBoundingClientRect();
        const actions = row.querySelector('.online-backup-managed-actions').getBoundingClientRect();
        return { keyLeft: key.left, createdLeft: created.left, actionsRight: actions.right };
      });
      return {
        rows,
        contentRight: panelRect.right - parseFloat(panelStyle.paddingRight),
        createRight: document.querySelector('.online-backup-footer button').getBoundingClientRect().right
      };
    };
    return { german: measure('de'), english: measure('en') };
  })()`;
  const onlineBackupNarrowLayoutScript = `(() => {
    document.body.innerHTML = '<section class="online-backup-panel"><section class="online-backup-managed"><div class="online-backup-managed-list"><article class="online-backup-managed-row"><span class="online-backup-managed-key">ABCDEFGH…1234</span><span class="online-backup-managed-created">22/08/2026, 12:00</span><div class="online-backup-managed-actions"><button class="btn btn-secondary">Copy key</button><button class="btn btn-danger">Delete online backup</button></div></article></div></section><footer class="online-backup-footer"><button class="btn btn-primary">Generate new key</button></footer></section>';
    const row = document.querySelector('.online-backup-managed-row').getBoundingClientRect();
    const key = document.querySelector('.online-backup-managed-key').getBoundingClientRect();
    const created = document.querySelector('.online-backup-managed-created').getBoundingClientRect();
    const actions = document.querySelector('.online-backup-managed-actions').getBoundingClientRect();
    const rowStyle = getComputedStyle(document.querySelector('.online-backup-managed-row'));
    const rowContentWidth = row.width - parseFloat(rowStyle.paddingLeft) - parseFloat(rowStyle.paddingRight) - parseFloat(rowStyle.borderLeftWidth) - parseFloat(rowStyle.borderRightWidth);
    const footer = document.querySelector('.online-backup-footer').getBoundingClientRect();
    const create = document.querySelector('.online-backup-footer button').getBoundingClientRect();
    return {
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      rowOverflow: document.querySelector('.online-backup-managed-row').scrollWidth > document.querySelector('.online-backup-managed-row').clientWidth + 1,
      stacked: key.top < created.top && created.top < actions.top,
      actionsStretched: Math.abs(actions.width - rowContentWidth) <= 1,
      createStretched: Math.abs(create.width - footer.width) <= 1
    };
  })()`;
  const probeSource = `
const { app, BrowserWindow, screen } = require('electron');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const outputPath = process.env.MHU_RDP_COMPOSITOR_OUTPUT;
function pixelAt(bitmap, width, x, y) {
  const offset = (y * width + x) * 4;
  return [bitmap[offset + 2], bitmap[offset + 1], bitmap[offset], bitmap[offset + 3]];
}
app.whenReady().then(async () => {
  const display = screen.getPrimaryDisplay();
  const requestedContentWidth = Math.min(2544, display.workAreaSize.width);
  const requestedContentHeight = Math.min(1353, display.workAreaSize.height);
  const window = new BrowserWindow({
    show: false,
    width: requestedContentWidth,
    height: requestedContentHeight,
    useContentSize: true,
    backgroundColor: '#0f0f0f',
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: process.env.MHU_PRELOAD_PATH }
  });
  const readyToShow = new Promise(resolve => window.once('ready-to-show', resolve));
  const document = '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#102030}.left,.right{position:fixed;top:0;bottom:0;width:8px}.left{left:0;background:#00ff00}.right{right:0;background:#ff00ff}</style></head><body><div class="left"></div><div class="right"></div></body></html>';
  await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(document));
  await readyToShow;
  await app.getGPUInfo('complete');
  const image = await window.webContents.capturePage();
  const size = image.getSize();
  const bitmap = image.toBitmap();
  const dom = await window.webContents.executeJavaScript('({ innerWidth, innerHeight, devicePixelRatio })');
  const rendererPid = window.webContents.getOSProcessId();
  const rendererCommandLine = execFileSync('powershell.exe', ['-NoProfile', '-Command', '(Get-CimInstance Win32_Process -Filter "ProcessId = ' + rendererPid + '").CommandLine'], { encoding: 'utf8' }).trim();
  const middleY = Math.floor(size.height / 2);
  await window.loadFile(process.env.MHU_RENDERER_PATH, { query: { language: 'en', version: '2.1.31' } });
  const liveSpeedChart = await window.webContents.executeJavaScript('({ baselinePresent: Boolean(document.querySelector(".upload-speed-baseline")), canvasWidth: document.getElementById("uploadSpeedCanvas")?.getBoundingClientRect().width || 0 })');
  const onlineBackupBehavior = await window.webContents.executeJavaScript(${JSON.stringify(onlineBackupBehaviorScript)});
  const onlineBackupLayout = await window.webContents.executeJavaScript(${JSON.stringify(onlineBackupLayoutScript)});
  window.setContentSize(760, Math.min(900, display.workAreaSize.height));
  await new Promise(resolve => setTimeout(resolve, 50));
  const onlineBackupNarrowLayout = await window.webContents.executeJavaScript(${JSON.stringify(onlineBackupNarrowLayoutScript)});
  fs.writeFileSync(outputPath, JSON.stringify({
    size,
    dom,
    requestedContentWidth,
    requestedContentHeight,
    displayScaleFactor: display.scaleFactor,
    gpuFeatureStatus: app.getGPUFeatureStatus(),
    rendererCommandLine,
    leftEdge: pixelAt(bitmap, size.width, 0, middleY),
    rightEdge: pixelAt(bitmap, size.width, size.width - 1, middleY),
    liveSpeedChart,
    onlineBackupBehavior,
    onlineBackupLayout,
    onlineBackupNarrowLayout
  }), 'utf8');
  window.destroy();
  app.exit(0);
}).catch(error => {
  fs.writeFileSync(outputPath, JSON.stringify({ error: error.stack || String(error) }), 'utf8');
  app.exit(1);
});
`;
  fs.writeFileSync(probePath, probeSource, 'utf8');
  try {
    const electronPath = path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
    execFileSync(electronPath, [probePath, `--user-data-dir=${userDataPath}`], {
      cwd: projectRoot,
      env: {
        ...process.env,
        SESSIONNAME: 'RDP-Tcp#12',
        MHU_RDP_COMPOSITOR_OUTPUT: outputPath,
        MHU_RENDERER_PATH: path.join(projectRoot, 'renderer', 'index.html'),
        MHU_PRELOAD_PATH: preloadPath
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000,
      windowsHide: true
    });
    const result = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    assert.equal(result.error, undefined);
    assert.doesNotMatch(result.rendererCommandLine, /--disable-gpu-compositing/u);
    assert.equal(result.size.width, Math.round(result.dom.innerWidth * result.dom.devicePixelRatio));
    assert.equal(result.size.height, Math.round(result.dom.innerHeight * result.dom.devicePixelRatio));
    assert.ok(result.requestedContentWidth > 0);
    assert.ok(result.requestedContentHeight > 0);
    if (Math.round(result.requestedContentWidth * result.displayScaleFactor) > 2048) {
      assert.ok(result.size.width > 2048);
    }
    assert.ok(result.leftEdge[1] > result.leftEdge[0] && result.leftEdge[1] > result.leftEdge[2]);
    assert.ok(result.rightEdge[0] > result.rightEdge[1] && result.rightEdge[2] > result.rightEdge[1]);
    assert.ok(result.liveSpeedChart.canvasWidth > 0);
    assert.equal(result.liveSpeedChart.baselinePresent, false);
    assert.deepEqual(result.onlineBackupBehavior.initialKeys, ['MHU2-ZYXW…9876', 'MHU2-ABCD…1234']);
    assert.equal(result.onlineBackupBehavior.secretRejected, true);
    assert.equal(result.onlineBackupBehavior.pendingDeleteControlsDisabled, true);
    assert.deepEqual(result.onlineBackupBehavior.afterDelete, ['MHU2-ABCD…1234']);
    assert.equal(result.onlineBackupBehavior.afterCreate[0], 'MHU2-QWER…4321');
    assert.equal(result.onlineBackupBehavior.afterCreate.length, 3);
    assert.deepEqual(result.onlineBackupBehavior.confirmation, {
      title: 'Online-Backup löschen',
      message: 'Dieses verschlüsselte Online-Backup wird dauerhaft vom Server gelöscht.',
      confirmText: 'Löschen',
      danger: true
    });
    assert.deepEqual(result.onlineBackupBehavior.calls, [
      ['list'],
      ['copy', 'BBBBBBBBBBBBBBBBBBBBBB'],
      ['delete', 'BBBBBBBBBBBBBBBBBBBBBB'],
      ['list'],
      ['create']
    ]);
    assert.deepEqual(result.onlineBackupBehavior.stateFields, ['createdAt', 'displayKey', 'id']);
    assert.equal(result.onlineBackupBehavior.secretInBody, false);
    assert.ok(Math.abs(result.onlineBackupLayout.german.createRight - result.onlineBackupLayout.german.contentRight) <= 1);
    assert.ok(Math.abs(result.onlineBackupLayout.english.createRight - result.onlineBackupLayout.english.contentRight) <= 1);
    for (const layout of [result.onlineBackupLayout.german, result.onlineBackupLayout.english]) {
      assert.equal(layout.rows.length, 2);
      assert.ok(Math.abs(layout.rows[0].keyLeft - layout.rows[1].keyLeft) <= 1);
      assert.ok(Math.abs(layout.rows[0].createdLeft - layout.rows[1].createdLeft) <= 1);
      assert.ok(Math.abs(layout.rows[0].actionsRight - layout.rows[1].actionsRight) <= 1);
    }
    assert.ok(Math.abs(result.onlineBackupLayout.german.rows[0].keyLeft - result.onlineBackupLayout.english.rows[0].keyLeft) <= 1);
    assert.ok(Math.abs(result.onlineBackupLayout.german.rows[0].createdLeft - result.onlineBackupLayout.english.rows[0].createdLeft) <= 1);
    assert.ok(Math.abs(result.onlineBackupLayout.german.rows[0].actionsRight - result.onlineBackupLayout.english.rows[0].actionsRight) <= 1);
    assert.equal(result.onlineBackupNarrowLayout.horizontalOverflow, false);
    assert.equal(result.onlineBackupNarrowLayout.rowOverflow, false);
    assert.equal(result.onlineBackupNarrowLayout.stacked, true);
    assert.equal(result.onlineBackupNarrowLayout.actionsStretched, true);
    assert.equal(result.onlineBackupNarrowLayout.createStretched, true);
  } finally {
    fs.rmSync(probeRoot, { recursive: true, force: true });
  }
});

test('resolveStartupLanguage accepts only the supported persisted language', () => {
  assert.equal(resolveStartupLanguage({ globalSettings: { language: 'de' } }), 'de');
  assert.equal(resolveStartupLanguage({ globalSettings: { language: 'en' } }), 'en');
  assert.equal(resolveStartupLanguage({ globalSettings: { language: 'fr' } }), 'en');
  assert.equal(resolveStartupLanguage(null), 'en');
});

test('startup query carries language and installed version into the first renderer frame', () => {
  assert.deepEqual(createStartupQuery({ globalSettings: { language: 'de' } }, '2.1.25'), {
    language: 'de',
    version: '2.1.25'
  });
  assert.deepEqual(createStartupQuery(null, 'invalid'), { language: 'en', version: '' });
});

test('createStartupWindow forces the main window to start hidden', () => {
  const startup = createStartupWindow(TestBrowserWindow, { width: 1100, show: true });

  assert.equal(startup.window.options.width, 1100);
  assert.equal(startup.window.options.show, false);
});

test('main window uses the branded application icon', () => {
  const projectRoot = path.join(__dirname, '..');
  const mainSource = fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8');
  const createWindowStart = mainSource.indexOf('function createWindow()');
  const createWindowEnd = mainSource.indexOf('\nfunction createTray()', createWindowStart);
  const createWindowSource = mainSource.slice(createWindowStart, createWindowEnd);

  assert.equal(fs.existsSync(path.join(projectRoot, 'assets', 'app_icon.ico')), true);
  assert.match(createWindowSource, /icon:\s*path\.join\(__dirname, ['"]assets['"], ['"]app_icon\.ico['"]\)/u);
});

test('startup load registers visibility before navigation and shows only once', async () => {
  const startup = createStartupWindow(TestBrowserWindow, {});
  startup.window.loadError = null;
  const loading = startup.load('renderer/index.html', () => {});

  assert.deepEqual(startup.window.startupEvents, [
    'listen:ready-to-show',
    'load:renderer/index.html'
  ]);

  startup.window.emit('ready-to-show');
  assert.equal(startup.window.showCalls, 0);
  startup.window.webContents.emit('did-finish-load');
  startup.window.emit('ready-to-show');
  startup.window.webContents.emit('did-finish-load');
  await loading;

  assert.equal(startup.window.showCalls, 1);
});

test('startup waits for native paint readiness when renderer loading finishes first', () => {
  const startup = createStartupWindow(TestBrowserWindow, {});

  startup.window.webContents.emit('did-finish-load');
  assert.equal(startup.window.showCalls, 0);
  startup.window.emit('ready-to-show');
  assert.equal(startup.window.showCalls, 1);
});

test('startup load forwards a rejected navigation to the error handler', async () => {
  const startup = createStartupWindow(TestBrowserWindow, {});
  let handledError;

  await startup.load('renderer/index.html', (err) => {
    handledError = err;
  });

  assert.equal(handledError, startup.window.loadError);
});

test('startup load forwards navigation options before the renderer becomes visible', async () => {
  const startup = createStartupWindow(TestBrowserWindow, {});
  const options = { query: { language: 'de' } };

  await startup.load('renderer/index.html', () => {}, options);

  assert.deepEqual(startup.window.loadOptions, options);
});

test('desktop drag and drop is accepted before asynchronous renderer initialization', () => {
  const projectRoot = path.join(__dirname, '..');
  const appSource = fs.readFileSync(path.join(projectRoot, 'renderer', 'app.js'), 'utf8');
  const earlyBinding = appSource.lastIndexOf('\nsetupDragDrop();');
  const initialization = appSource.lastIndexOf('\ninit().then(');

  assert.notEqual(earlyBinding, -1);
  assert.notEqual(initialization, -1);
  assert.ok(earlyBinding < initialization);
  assert.match(appSource, /dataTransfer\.dropEffect\s*=\s*['"]copy['"]/u);
});

test('upload sidebar renders and updates the remaining upload size', () => {
  const projectRoot = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(projectRoot, 'renderer', 'index.html'), 'utf8');
  const appSource = fs.readFileSync(path.join(projectRoot, 'renderer', 'app.js'), 'utf8');

  assert.match(html, /Verbleibende Größe[\s\S]*id="uploadTelemetryRemainingSize"[^>]*>0 B</u);
  assert.match(appSource, /_setUploadTelemetryText\(['"]uploadTelemetryRemainingSize['"],\s*formatBytes\(stats\.bytesRemaining\)\)/u);
});

test('header occupies its final geometry before asynchronous initialization', () => {
  const projectRoot = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(projectRoot, 'renderer', 'index.html'), 'utf8');
  const appSource = fs.readFileSync(path.join(projectRoot, 'renderer', 'app.js'), 'utf8');
  const mainSource = fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8');
  const css = fs.readFileSync(path.join(projectRoot, 'renderer', 'styles.css'), 'utf8');
  const updateButton = html.match(/<button class="header-update-button"[^>]*id="headerUpdateBtn"[^>]*>/u)?.[0] || '';
  const updateSlotIndex = html.indexOf('class="header-update-slot"');
  const speedWidgetIndex = html.indexOf('id="uploadSpeedSparkline"');
  const firstFrameInitialization = appSource.lastIndexOf('\ninitializeStaticHeader();');
  const asynchronousInitialization = appSource.lastIndexOf('\ninit().then(');

  assert.doesNotMatch(updateButton, /\shidden(?:\s|>)/u);
  assert.doesNotMatch(updateButton, /\stitle=/u);
  assert.ok(updateSlotIndex >= 0 && updateSlotIndex < speedWidgetIndex);
  assert.match(css, /\.header-update-slot\s*\{[^}]*width:\s*0;[^}]*flex:\s*0 0 0;[^}]*overflow:\s*hidden;/su);
  assert.match(css, /\.header-update-slot\.is-visible\s*\{[^}]*width:\s*146px;[^}]*flex-basis:\s*146px;/su);
  assert.match(css, /\.header-update-slot\.is-visible\s+\.header-update-button\s*\{[^}]*opacity:\s*1;[^}]*transform:\s*translateX\(0\);/su);
  assert.match(css, /\.version-badge\s*\{[^}]*min-width:\s*48px;/su);
  assert.notEqual(firstFrameInitialization, -1);
  assert.ok(firstFrameInitialization < asynchronousInitialization);
  assert.match(mainSource, /createStartupQuery\([^,]+,\s*app\.getVersion\(\)\)/u);
  assert.doesNotMatch(mainSource, /runAutomaticUpdateCheck\(true\);\s*\},\s*3000\)/u);
  assert.match(html, /class="upload-speed-baseline"/u);
  assert.match(css, /\.upload-speed-baseline\s*\{[^}]*background:\s*var\(--success\);/su);
  assert.match(css, /\.header-update-button\.update-available\s*\{[^}]*background:\s*var\(--success\);[^}]*color:\s*#000;/su);
  assert.match(css, /\.header-update-button\.update-available:hover\s*\{[^}]*background:\s*var\(--success-end\);[^}]*color:\s*#000;/su);
  assert.match(css, /\.update-dialog\s*\{[^}]*width:\s*min\(576px,\s*100%\);/su);
  assert.match(css, /\.update-release-notes\s*\{[^}]*height:\s*min\(264px,\s*48vh\);/su);
  assert.match(html, /class="update-progress-footer"[\s\S]*id="updateProgressDetails"[\s\S]*id="updateProgressSize"[\s\S]*id="updateProgressSpeed"[\s\S]*id="updateProgressEta"[\s\S]*id="updateProgressText"/u);
  assert.match(html, /id="queueFilterResetBtn"[^>]*disabled[^>]*>Filter zurücksetzen</u);
  assert.match(html, /class="queue-filter-summary"[\s\S]*id="queueActiveFilterCount"[^>]*>0</u);
  assert.match(html, /data-action="copy-failure-details"[^>]*style="display:none"[^>]*>Fehlerdetails kopieren</u);
  assert.doesNotMatch(html, /<\/div>\s*<div class="queue-filter-bar"/u);
  assert.match(css, /\.queue-filter-bar\s*\{[^}]*display:\s*flex;[^}]*margin-left:\s*auto;[^}]*border:\s*1px solid var\(--border\);[^}]*border-radius:\s*7px;/su);
  assert.match(css, /#updateProgressDetails\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*19ch 2ch 11ch 2ch 10ch;[^}]*column-gap:\s*0;[^}]*font-variant-numeric:\s*tabular-nums;/su);
  assert.match(css, /\.update-progress-separator\s*\{[^}]*display:\s*grid;[^}]*place-items:\s*center;/su);
  assert.match(css, /#updateProgressSpeed\s*\{[^}]*text-align:\s*right;/su);
  assert.match(css, /#updateProgressEta\s*\{[^}]*text-align:\s*left;/su);
  assert.match(css, /\.update-release-heading\s*\{[^}]*color:\s*var\(--success\);[^}]*font-size:\s*14px;[^}]*font-weight:\s*750;/su);
  assert.match(css, /\.update-release-category\s*\{[^}]*font-size:\s*13px;[^}]*font-weight:\s*700;/su);
  assert.match(css, /#updateProgressDetails\[hidden\]\s*\{[^}]*display:\s*none;/su);
});
