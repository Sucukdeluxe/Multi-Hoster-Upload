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
    this._scanGeneration = null;
    this._followUpRequested = false;
    this._followUpOptions = null;
    this._paused = false;
    this._reachable = null;
    this._scanning = false;
    this._lastScanAt = null;
    this._lastScanTrigger = '';
    this._lastError = '';
    this._generation = 0;
  }

  get running() {
    return !!this._watcher;
  }

  start(settings) {
    return this._start(settings, false);
  }

  stop() {
    this._deactivate({ clearSeen: true, paused: false });
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
    const generation = this._generation;
    if (!request.emitFiles) return this._performDryScan(request, generation);
    if (this._paused) return Promise.resolve(this._cancelledResult(request.trigger));
    if (this._scanPromise && this._scanGeneration === generation) {
      this._followUpRequested = true;
      this._followUpOptions = { emitFiles: true, trigger: request.trigger };
      return this._scanPromise;
    }
    let promise;
    promise = this._runProductiveScans(request, generation).finally(() => {
      if (this._scanPromise === promise) {
        this._scanPromise = null;
        this._scanGeneration = null;
      }
    });
    this._scanPromise = promise;
    this._scanGeneration = generation;
    return promise;
  }

  async pause() {
    const changed = !!(this._watcher || this._reconcileTimer || this._batchTimer || this._scanPromise || !this._paused);
    const watcher = this._invalidateLifecycle(true);
    if (watcher) {
      try {
        await watcher.close();
      } catch {}
    }
    if (changed) this._emitStatus(this._generation);
  }

  async resume(settings = this._settings) {
    if (!settings) throw new Error('Keine Ordnerkonfiguration vorhanden');
    this._start(settings, true);
    return this.scan({ emitFiles: true, trigger: 'resume' });
  }

  _start(settings, preserveSeen) {
    this._deactivate({ clearSeen: !preserveSeen, paused: false });
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

    const generation = this._generation;
    this._watcher = this._watch(folderPath, watchOptions);
    if (includeInitial) {
      this._watcher.once('ready', () => {
        if (this._acceptCallback(generation)) this._emitEvent('initial-scan-complete', [], generation);
      });
    }
    this._watcher.on('add', (filePath) => this._onNewFile(filePath, generation));
    this._watcher.on('unlink', (filePath) => {
      if (this._acceptCallback(generation)) this._seenFiles.delete(this._normalizePath(filePath));
    });
    this._watcher.on('error', (error) => {
      if (!this._acceptCallback(generation)) return;
      this._lastError = 'Ordnerüberwachung fehlgeschlagen';
      this._emitStatus(generation);
      this._emitEvent('error', [error], generation);
    });
    const intervalMinutes = Number(settings.reconcileIntervalMinutes) || 5;
    this._reconcileTimer = this._setInterval(
      () => this._reconcile(generation).catch((error) => this._publishBackgroundError(error, generation)),
      intervalMinutes * 60 * 1000
    );
    this._emitStatus(generation);
    return { includesExisting: includeInitial };
  }

  _deactivate({ clearSeen, paused }) {
    const changed = !!(
      this._watcher
      || this._reconcileTimer
      || this._batchTimer
      || this._batchBuffer.length
      || this._scanPromise
      || (clearSeen && this._seenFiles.size)
      || this._paused !== paused
    );
    const watcher = this._invalidateLifecycle(paused);
    if (watcher) {
      try {
        Promise.resolve(watcher.close()).catch(() => {});
      } catch {}
    }
    if (clearSeen) this._seenFiles = new Set();
    if (changed) this._emitStatus(this._generation);
  }

  _invalidateLifecycle(paused) {
    this._generation++;
    if (paused) {
      for (const filePath of this._batchBuffer) this._seenFiles.delete(this._normalizePath(filePath));
    }
    this._paused = paused;
    this._scanning = false;
    this._followUpRequested = false;
    this._followUpOptions = null;
    this._scanPromise = null;
    this._scanGeneration = null;
    const watcher = this._watcher;
    this._watcher = null;
    if (this._reconcileTimer) {
      this._clearInterval(this._reconcileTimer);
      this._reconcileTimer = null;
    }
    if (this._batchTimer) {
      this._clearTimeout(this._batchTimer);
      this._batchTimer = null;
    }
    this._batchBuffer = [];
    return watcher;
  }

  _onNewFile(filePath, generation) {
    if (!this._acceptCallback(generation)) return;
    if (!this._classifyPath(filePath, this._settings).allowed || !this._acceptPath(filePath)) return;
    this._batchBuffer.push(filePath);
    if (this._batchTimer) this._clearTimeout(this._batchTimer);
    this._batchTimer = this._setTimeout(() => {
      if (!this._acceptCallback(generation)) return;
      const files = this._batchBuffer.splice(0);
      this._batchTimer = null;
      if (files.length === 0) return;
      const listenerError = this._emitEvent('new-files', [files], generation);
      if (listenerError && this._acceptCallback(generation)) {
        this._lastError = 'Ordnerüberwachung fehlgeschlagen';
        this._emitStatus(generation);
      }
    }, 200);
  }

  async _runProductiveScans(initialRequest, generation) {
    let request = initialRequest;
    let result = this._cancelledResult(request.trigger);
    do {
      this._followUpRequested = false;
      this._followUpOptions = null;
      result = await this._performProductiveScan(request, generation);
      if (!this._isCurrent(generation)) return this._cancelledResult(request.trigger);
      request = this._followUpOptions || request;
    } while (this._followUpRequested);
    return result;
  }

  async _performProductiveScan({ trigger }, generation) {
    if (!this._settings) throw new Error('Keine Ordnerkonfiguration vorhanden');
    if (!this._isCurrent(generation) || this._paused) return this._cancelledResult(trigger);
    const settings = this._settings;
    this._scanning = true;
    this._lastScanTrigger = trigger;
    const startListenerError = this._emitStatus(generation);
    if (startListenerError) return this._finishProductiveError(startListenerError, generation, trigger, this._reachable);
    const wasReachable = this._reachable;
    try {
      await this._access(settings.folderPath);
    } catch {
      if (!this._isCurrent(generation)) return this._cancelledResult(trigger);
      this._reachable = false;
      this._lastScanAt = this._now();
      this._lastError = 'Ordner nicht erreichbar';
      this._scanning = false;
      this._emitStatus(generation);
      return this._result([], false, false, trigger, { error: this._lastError });
    }
    if (!this._isCurrent(generation)) return this._cancelledResult(trigger);
    try {
      const files = await this._discoverFiles(settings, generation);
      if (!this._isCurrent(generation)) return this._cancelledResult(trigger);
      const emittedFiles = files.filter((file) => this._acceptPath(file.path));
      if (emittedFiles.length > 0) {
        const listenerError = this._emitEvent('new-files', [emittedFiles.map((file) => file.path)], generation);
        if (listenerError) return this._finishProductiveError(listenerError, generation, trigger, true);
      }
      if (!this._isCurrent(generation)) return this._cancelledResult(trigger);
      this._reachable = true;
      this._lastScanAt = this._now();
      this._lastError = '';
      this._scanning = false;
      const statusListenerError = this._emitStatus(generation);
      if (statusListenerError) return this._finishProductiveError(statusListenerError, generation, trigger, true);
      return this._result(files, true, wasReachable === false, trigger);
    } catch (error) {
      return this._finishProductiveError(error, generation, trigger, true);
    }
  }

  async _performDryScan({ trigger }, generation) {
    if (!this._settings) throw new Error('Keine Ordnerkonfiguration vorhanden');
    const settings = this._settings;
    try {
      await this._access(settings.folderPath);
    } catch {
      if (!this._isCurrent(generation)) return this._cancelledResult(trigger);
      return this._result([], false, false, trigger);
    }
    if (!this._isCurrent(generation)) return this._cancelledResult(trigger);
    try {
      const files = await this._discoverFiles(settings, generation);
      if (!this._isCurrent(generation)) return this._cancelledResult(trigger);
      return this._result(files, true, this._reachable === false, trigger);
    } catch {
      if (!this._isCurrent(generation)) return this._cancelledResult(trigger);
      return this._result([], true, false, trigger, { error: 'Ordnerscan fehlgeschlagen' });
    }
  }

  async _discoverFiles(settings, generation) {
    const discovered = await this._walkFolder(settings.folderPath, { recursive: !!settings.recursive });
    if (!this._isCurrent(generation)) return [];
    const files = [];
    for (const descriptor of discovered) {
      if (!this._isCurrent(generation)) return [];
      if (!settings.recursive && this._isNestedPath(descriptor.path, settings.folderPath)) continue;
      if (!this._classifyPath(descriptor.path, settings).allowed) continue;
      let mtimeMs = 0;
      try {
        mtimeMs = Number((await this._stat(descriptor.path)).mtimeMs) || 0;
      } catch {}
      if (!this._isCurrent(generation)) return [];
      files.push(Object.freeze({
        path: descriptor.path,
        name: descriptor.name || path.basename(descriptor.path),
        size: Number(descriptor.size) || 0,
        mtimeMs
      }));
    }
    return files;
  }

  _finishProductiveError(error, generation, trigger, reachable) {
    if (!this._isCurrent(generation)) return this._cancelledResult(trigger);
    this._reachable = reachable;
    this._lastScanAt = this._now();
    this._lastError = 'Ordnerscan fehlgeschlagen';
    this._scanning = false;
    this._emitStatus(generation);
    return this._result([], reachable === true, false, trigger, { error: this._lastError });
  }

  async _reconcile(generation) {
    if (!this._acceptCallback(generation)) return;
    const trigger = this._reachable === false ? 'reconnect' : 'interval';
    await this.scan({ emitFiles: true, trigger });
  }

  _publishBackgroundError(error, generation) {
    if (!this._acceptCallback(generation)) return;
    this._lastScanAt = this._now();
    this._lastError = 'Ordnerscan fehlgeschlagen';
    this._scanning = false;
    this._emitStatus(generation);
  }

  _extensionSet(settings) {
    return new Set(String(settings?.extensions || '')
      .split(',')
      .map((extension) => extension.trim().toLowerCase().replace(/^\./, ''))
      .filter(Boolean));
  }

  _classifyPath(filePath, settings) {
    const extension = path.extname(filePath).replace(/^\./, '').toLowerCase();
    const extensions = this._extensionSet(settings);
    const matches = extensions.size === 0 || extensions.has(extension);
    const allowed = settings?.filterMode === 'exclude' ? !matches : matches;
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

  _isNestedPath(filePath, folderPath) {
    const relativePath = path.relative(folderPath, filePath);
    return relativePath.split(/[\\/]/).length > 1;
  }

  _acceptCallback(generation) {
    return this._isCurrent(generation) && !this._paused;
  }

  _isCurrent(generation) {
    return this._generation === generation;
  }

  _emitStatus(generation) {
    if (!this._isCurrent(generation)) return null;
    return this._emitEvent('status', [this.status()], generation);
  }

  _emitEvent(eventName, args, generation) {
    let firstError = null;
    for (const listener of this.rawListeners(eventName)) {
      if (!this._isCurrent(generation)) break;
      try {
        listener.apply(this, args);
      } catch (error) {
        if (!firstError) firstError = error;
      }
    }
    return firstError;
  }

  _result(files, reachable, reconnected, trigger, extra = {}) {
    return Object.freeze({
      files: Object.freeze(files),
      reachable,
      reconnected,
      trigger,
      ...extra
    });
  }

  _cancelledResult(trigger) {
    return this._result([], this._reachable === true, false, trigger, { cancelled: true });
  }
}

module.exports = FolderMonitor;
