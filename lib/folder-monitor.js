const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const { walkFolderAsync } = require('./file-discovery');

class FolderMonitor extends EventEmitter {
  constructor({
    watch = chokidar.watch,
    walkFolder = walkFolderAsync,
    access = fs.promises.access,
    stat = fs.promises.stat,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    now = Date.now
  } = {}) {
    super();
    this._watch = watch;
    this._walkFolder = walkFolder;
    this._access = access;
    this._stat = stat;
    this._setTimeout = setTimeoutFn;
    this._clearTimeout = clearTimeoutFn;
    this._setInterval = setIntervalFn;
    this._clearInterval = clearIntervalFn;
    this._now = now;
    this._watcher = null;
    this._settings = null;
    this._seenFiles = new Set();
    this._batchBuffer = [];
    this._batchTimer = null;
    this._initialScopes = new Set();
    this._reconcileTimer = null;
    this._scanPromise = null;
    this._followUpRequested = false;
    this._followUpOptions = null;
    this._paused = false;
    this._reachable = null;
    this._scanning = false;
    this._lastScanAt = null;
    this._lastScanTrigger = '';
    this._lastError = '';
  }

  get running() {
    return !!this._watcher;
  }

  start(settings) {
    this.stop();
    this._settings = settings;
    this._paused = false;
    this._reachable = null;
    this._lastError = '';

    const folderPath = String(settings.folderPath || '').trim();
    if (!folderPath) throw new Error('Kein Ordnerpfad angegeben');

    const scope = JSON.stringify([
      path.resolve(folderPath).toLowerCase(),
      !!settings.recursive,
      String(settings.filterMode || 'include'),
      String(settings.extensions || '').trim().toLowerCase()
    ]);
    const includeInitial = !!settings.includeExisting && !this._initialScopes.has(scope);
    if (includeInitial) this._initialScopes.add(scope);

    const watchOptions = {
      persistent: true,
      ignoreInitial: !includeInitial,
      depth: settings.recursive ? undefined : 0,
      awaitWriteFinish: {
        stabilityThreshold: Math.max(1000, (settings.delaySec || 3) * 1000),
        pollInterval: 500
      }
    };

    this._watcher = this._watch(folderPath, watchOptions);
    if (includeInitial) {
      this._watcher.once('ready', () => this.emit('initial-scan-complete'));
    }
    this._watcher.on('add', (filePath) => this._onNewFile(filePath));
    this._watcher.on('unlink', (filePath) => {
      this._seenFiles.delete(this._normalizePath(filePath));
    });
    this._watcher.on('error', (err) => {
      this._lastError = err instanceof Error ? err.message : String(err);
      this._emitStatus();
      this.emit('error', err);
    });
    const intervalMinutes = Number(settings.reconcileIntervalMinutes) || 5;
    this._reconcileTimer = this._setInterval(() => this._reconcile(), intervalMinutes * 60 * 1000);
    this._emitStatus();
    return { includesExisting: includeInitial };
  }

  stop() {
    const changed = !!(this._watcher || this._reconcileTimer || this._batchTimer || this._batchBuffer.length || this._seenFiles.size);
    if (this._watcher) {
      this._watcher.close().catch(() => {});
      this._watcher = null;
    }
    if (this._reconcileTimer) {
      this._clearInterval(this._reconcileTimer);
      this._reconcileTimer = null;
    }
    if (this._batchTimer) {
      this._clearTimeout(this._batchTimer);
      this._batchTimer = null;
    }
    this._batchBuffer = [];
    this._seenFiles = new Set();
    if (changed) this._emitStatus();
  }

  status() {
    return Object.freeze({
      running: this.running,
      paused: this._paused,
      reachable: this._reachable,
      scanning: this._scanning,
      folderPath: this._settings ? this._settings.folderPath : '',
      seenCount: this._seenFiles.size,
      lastScanAt: this._lastScanAt,
      lastScanTrigger: this._lastScanTrigger,
      error: this._lastError
    });
  }

  scan({ emitFiles = true, trigger = 'manual' } = {}) {
    const request = { emitFiles: !!emitFiles, trigger: String(trigger || 'manual') };
    if (this._scanPromise) {
      this._followUpRequested = true;
      this._followUpOptions = {
        emitFiles: !!(this._followUpOptions?.emitFiles || request.emitFiles),
        trigger: request.trigger
      };
      return this._scanPromise;
    }
    this._scanPromise = this._runScans(request).finally(() => {
      this._scanPromise = null;
    });
    return this._scanPromise;
  }

  async pause() {
    this._paused = true;
    if (this._reconcileTimer) {
      this._clearInterval(this._reconcileTimer);
      this._reconcileTimer = null;
    }
    const watcher = this._watcher;
    this._watcher = null;
    if (watcher) await watcher.close().catch(() => {});
    if (this._batchTimer) {
      this._clearTimeout(this._batchTimer);
      this._batchTimer = null;
    }
    this._batchBuffer = [];
    this._emitStatus();
  }

  async resume(settings = this._settings) {
    if (!settings) throw new Error('Keine Ordnerkonfiguration vorhanden');
    this.start(settings);
    return this.scan({ emitFiles: true, trigger: 'resume' });
  }

  _onNewFile(filePath) {
    if (!this._settings || !this._classifyPath(filePath).allowed || !this._acceptPath(filePath)) return;
    this._batchBuffer.push(filePath);
    if (this._batchTimer) this._clearTimeout(this._batchTimer);
    this._batchTimer = this._setTimeout(() => {
      const files = this._batchBuffer.splice(0);
      this._batchTimer = null;
      if (files.length > 0) {
        this.emit('new-files', files);
      }
    }, 200);
  }

  async _runScans(initialRequest) {
    let request = initialRequest;
    let result;
    do {
      this._followUpRequested = false;
      this._followUpOptions = null;
      result = await this._performScan(request);
      request = this._followUpOptions || request;
    } while (this._followUpRequested);
    return result;
  }

  async _performScan({ emitFiles, trigger }) {
    if (!this._settings) throw new Error('Keine Ordnerkonfiguration vorhanden');
    this._scanning = true;
    this._lastScanTrigger = trigger;
    this._emitStatus();
    const wasReachable = this._reachable;
    try {
      await this._access(this._settings.folderPath);
    } catch (error) {
      this._reachable = false;
      this._lastScanAt = this._now();
      this._lastError = error instanceof Error ? error.message : String(error);
      this._scanning = false;
      this._emitStatus();
      return Object.freeze({ files: [], reachable: false, reconnected: false, trigger });
    }

    const discovered = await this._walkFolder(this._settings.folderPath, { recursive: !!this._settings.recursive });
    const files = [];
    for (const descriptor of discovered) {
      if (!this._settings.recursive && this._isNestedPath(descriptor.path)) continue;
      if (!this._classifyPath(descriptor.path).allowed) continue;
      let mtimeMs = 0;
      try {
        mtimeMs = Number((await this._stat(descriptor.path)).mtimeMs) || 0;
      } catch {}
      files.push(Object.freeze({
        path: descriptor.path,
        name: descriptor.name || path.basename(descriptor.path),
        size: Number(descriptor.size) || 0,
        mtimeMs
      }));
    }
    const emittedFiles = emitFiles ? files.filter((file) => this._acceptPath(file.path)) : [];
    if (emittedFiles.length > 0) this.emit('new-files', emittedFiles.map((file) => file.path));
    this._reachable = true;
    this._lastScanAt = this._now();
    this._lastError = '';
    this._scanning = false;
    this._emitStatus();
    return Object.freeze({ files: Object.freeze(files), reachable: true, reconnected: wasReachable === false, trigger });
  }

  async _reconcile() {
    if (this._paused || !this._settings) return;
    const trigger = this._reachable === false ? 'reconnect' : 'interval';
    await this.scan({ emitFiles: true, trigger });
  }

  _extensionSet() {
    return new Set(String(this._settings?.extensions || '')
      .split(',')
      .map((extension) => extension.trim().toLowerCase().replace(/^\./, ''))
      .filter(Boolean));
  }

  _classifyPath(filePath) {
    const extension = path.extname(filePath).replace(/^\./, '').toLowerCase();
    const extensions = this._extensionSet();
    const matches = extensions.size === 0 || extensions.has(extension);
    const allowed = this._settings?.filterMode === 'exclude' ? !matches : matches;
    return Object.freeze({ allowed, reason: allowed ? 'matched' : 'extension' });
  }

  _acceptPath(filePath) {
    if (!this._settings?.skipDuplicates) return true;
    const normalized = this._normalizePath(filePath);
    if (this._seenFiles.has(normalized)) return false;
    this._seenFiles.add(normalized);
    return true;
  }

  _normalizePath(filePath) {
    return String(filePath).replace(/\\/g, '/').toLowerCase();
  }

  _isNestedPath(filePath) {
    const relativePath = path.relative(this._settings.folderPath, filePath);
    return relativePath.split(/[\\/]/).length > 1;
  }

  _emitStatus() {
    this.emit('status', this.status());
  }
}

module.exports = FolderMonitor;
