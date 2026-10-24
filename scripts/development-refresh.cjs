const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');

class DevelopmentRefresh {
  constructor(actions) { this.actions = actions; this.pending = new Map(); this.sequence = 0; this.running = false; }
  changed(file) {
    const normalized = file.replace(/\\/g, '/');
    const kind = normalized.startsWith('renderer/') && normalized.endsWith('.css') ? 'styles'
      : normalized.startsWith('renderer/') ? 'document'
      : /^(main\.js|preload(?:-drop-target)?\.js|package\.json|lib\/|scripts\/development-|scripts\/dev-runner)/.test(normalized) ? 'restart' : null;
    if (kind) this.pending.set(kind, ++this.sequence);
  }
  async flush() {
    if (this.running || !this.pending.size) return;
    this.running = true;
    try {
      const kind = this.pending.has('restart') ? 'restart' : this.pending.has('document') ? 'document' : 'styles';
      const sequence = this.sequence;
      if (kind !== 'styles' && await this.actions.busy()) {
        if (this.pending.has('styles')) {
          const stylesSequence = this.pending.get('styles');
          await this.actions.styles();
          if (this.pending.get('styles') === stylesSequence) this.pending.delete('styles');
        }
        return;
      }
      await this.actions[kind]();
      for (const [key, value] of this.pending) if (value <= sequence) this.pending.delete(key);
    } finally { this.running = false; }
  }
}

function installDevelopmentRefresh({ root, log = () => {} } = {}) {
  const { app, BrowserWindow, ipcMain } = require('electron');
  if (app.isPackaged || app.__developmentRefresh) return app.__developmentRefresh;
  const chokidar = require('chokidar');
  const target = pathToFileURL(path.join(root, 'renderer/index.html')).href;
  const currentWindow = () => BrowserWindow.getAllWindows().find(window => !window.isDestroyed() && window.webContents.getURL().split('?')[0] === target);
  const viewFile = () => path.join(app.getPath('userData'), '.development-view.json');
  let snapshot = null;
  let stopping = false;
  let watcher;
  let timer;
  let debounce;
  const execute = code => {
    const window = currentWindow();
    if (!window) return Promise.reject(new Error('Entwicklungsfenster noch nicht verfügbar'));
    return window.webContents.executeJavaScript(code);
  };
  const busyExpression = 'typeof uploading === "undefined" || uploading || healthCheckRunning || settingsDirty || settingsSaving || closePreparationState !== "open" || Boolean(config.globalSettings?.folderMonitor?.enabled) || Array.from(document.querySelectorAll(".modal-overlay")).some(element => element.getClientRects().length > 0) || Boolean(document.activeElement?.matches("input,textarea,[contenteditable=true]"))';
  const capture = () => execute([
    '(async () => { if (' + busyExpression + ') return null;',
    'const inert = document.body.inert; document.body.inert = true;',
    'try { await flushConfigWrites(); await persistQueueStateNow(); await flushConfigWrites();',
    'if (uploading || healthCheckRunning) return null;',
    'return {view: document.querySelector(".tab.active")?.dataset.view,',
    'range: document.querySelector("[data-statistics-range].active")?.dataset.statisticsRange || "session",',
    'history: !document.getElementById("history-view")?.classList.contains("statistics-mode"), historyFilter: historySidebarFilter,',
    'queueJobs, selectedFiles, sessionFilesData,',
    'counters: [_sessionTotalBytes, _sessionUploadedBytes, _sessionDoneCount, _sessionErrorCount],',
    'sets: [Array.from(_sessionTrackedJobs), Array.from(_sessionDoneJobs), Array.from(_completedUploadKeys), Array.from(_sessionFileKeys)],',
    'scroll: Array.from(document.querySelectorAll("[id]")).filter(e => e.scrollTop || e.scrollLeft).map(e => [e.id,e.scrollTop,e.scrollLeft])};',
    '} finally {document.body.inert = inert;} })()'
  ].join('\n'));
  const actions = {
    busy: async () => stopping || !currentWindow() || Boolean(await execute(busyExpression)),
    styles: async () => {
      await execute('Promise.all(Array.from(document.querySelectorAll("link[rel=stylesheet]")).map(link => new Promise((resolve,reject) => { const replacement=link.cloneNode(); const url=new URL(link.href); url.searchParams.set("development-refresh",String(Date.now())); replacement.href=url.href; replacement.onload=()=>{link.remove();resolve();}; replacement.onerror=()=>{replacement.remove();reject(new Error("Stylesheet konnte nicht geladen werden"));};link.after(replacement); })))');
      log('development-refresh styles');
    },
    document: async () => {
      const saved = await capture();
      if (!saved) throw new Error('Entwicklungsansicht ist beschäftigt');
      snapshot = saved;
      const window = currentWindow();
      await new Promise((resolve,reject) => {
        const timeout=setTimeout(()=>{cleanup();reject(new Error('Entwicklungsansicht wurde nicht neu geladen'));},15000);
        const finished=()=>{cleanup();resolve();};
        const failed=()=>{cleanup();reject(new Error('Entwicklungsansicht konnte nicht geladen werden'));};
        const cleanup=()=>{clearTimeout(timeout);window.webContents.removeListener('did-finish-load',finished);window.webContents.removeListener('did-fail-load',failed);};
        window.webContents.once('did-finish-load',finished);
        window.webContents.once('did-fail-load',failed);
        window.webContents.reloadIgnoringCache();
      });
      log('development-refresh document');
    },
    restart: async () => {
      const saved=await capture();
      if (!saved) throw new Error('Entwicklungsansicht ist beschäftigt');
      await fs.writeFile(viewFile(),JSON.stringify({view:saved.view,range:saved.range,history:saved.history,historyFilter:saved.historyFilter}));
      log('development-refresh restart');
      await execute('window.api.restartApp()');
    }
  };
  const refresh = new DevelopmentRefresh(actions);
  app.__developmentRefresh = refresh;
  const restore = async (event,phase) => {
    if (phase !== 'initialized' || event.sender !== currentWindow()?.webContents) return;
    let saved=snapshot;
    snapshot=null;
    if (!saved) {
      try { saved=JSON.parse(await fs.readFile(viewFile(),'utf8')); await fs.unlink(viewFile()); } catch { return; }
    }
    try {
      await execute([
        '(() => { const saved=' + JSON.stringify(saved) + ';',
        'if(saved.queueJobs){queueJobs=saved.queueJobs;selectedFiles=saved.selectedFiles;sessionFilesData=saved.sessionFilesData;',
        '[_sessionTotalBytes,_sessionUploadedBytes,_sessionDoneCount,_sessionErrorCount]=saved.counters;',
        'const sets=[_sessionTrackedJobs,_sessionDoneJobs,_completedUploadKeys,_sessionFileKeys];sets.forEach((set,i)=>{set.clear();saved.sets[i].forEach(value=>set.add(value));});',
        'rebuildJobIndex();updateUploadView({rebuildPreview:false});renderQueueTable();renderRecentUploadsPanel();updateStatusBar();}',
        'Array.from(document.querySelectorAll(".tab")).find(tab=>tab.dataset.view===saved.view)?.click();',
        'if(saved.view==="history"){if(saved.history)setHistorySidebarFilter(saved.historyFilter||"all");else window.UploadStatisticsView?.selectRange(saved.range||"session");}',
        'requestAnimationFrame(()=>(saved.scroll||[]).forEach(([id,top,left])=>{const e=document.getElementById(id);if(e){e.scrollTop=top;e.scrollLeft=left;}}));})()'
      ].join('\n'));
      log('development-refresh restored');
    } catch(error) { log('development-refresh restore failed: '+error.message); }
  };
  ipcMain.on('app:startup-phase',restore);
  app.whenReady().then(()=>{
    watcher=chokidar.watch(['renderer','lib','main.js','preload.js','preload-drop-target.js','package.json','scripts/development-refresh.cjs','scripts/development-bootstrap.cjs','scripts/dev-runner.cjs'].map(file=>path.join(root,file)),{ignoreInitial:true,usePolling:true,interval:250,awaitWriteFinish:{stabilityThreshold:350,pollInterval:100}});
    watcher.on('all',(_event,file)=>{refresh.changed(path.relative(root,file));clearTimeout(debounce);debounce=setTimeout(()=>{void refresh.flush().catch(error=>log('development-refresh waiting: '+error.message));},500);});
    timer=setInterval(()=>{void refresh.flush().catch(error=>log('development-refresh waiting: '+error.message));},1000);timer.unref();
    log('development-refresh ready');
  });
  app.on('will-quit',()=>{stopping=true;clearInterval(timer);clearTimeout(debounce);void watcher?.close();ipcMain.removeListener('app:startup-phase',restore);});
  return refresh;
}
module.exports = { DevelopmentRefresh, installDevelopmentRefresh };
