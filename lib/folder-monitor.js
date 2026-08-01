const { EventEmitter } = require('events');
const path = require('path');
const chokidar = require('chokidar');

class FolderMonitor extends EventEmitter {
  constructor() {
    super();
    this._watcher = null;
    this._settings = null;
    this._seenFiles = new Set();
    this._batchBuffer = [];
    this._batchTimer = null;
  }

  get running() {
    return !!this._watcher;
  }

  start(settings) {
    this.stop();
    this._settings = settings;

    const folderPath = String(settings.folderPath || '').trim();
    if (!folderPath) throw new Error('Kein Ordnerpfad angegeben');

    const watchOptions = {
      persistent: true,
      ignoreInitial: true,
      depth: settings.recursive ? undefined : 0,
      awaitWriteFinish: {
        stabilityThreshold: Math.max(1000, (settings.delaySec || 3) * 1000),
        pollInterval: 500
      }
    };

    this._watcher = chokidar.watch(folderPath, watchOptions);
    this._watcher.on('add', (filePath) => this._onNewFile(filePath));
    this._watcher.on('unlink', (filePath) => {
      // Allow re-added files (e.g. re-encoded) to be detected again
      const normalized = filePath.replace(/\\/g, '/').toLowerCase();
      this._seenFiles.delete(normalized);
    });
    this._watcher.on('error', (err) => this.emit('error', err));
  }

  stop() {
    if (this._watcher) {
      this._watcher.close().catch(() => {});
      this._watcher = null;
    }
    if (this._batchTimer) {
      clearTimeout(this._batchTimer);
      this._batchTimer = null;
    }
    this._batchBuffer = [];
    this._seenFiles = new Set();
  }

  status() {
    return {
      running: this.running,
      folderPath: this._settings ? this._settings.folderPath : '',
      seenCount: this._seenFiles.size
    };
  }

  _onNewFile(filePath) {
    const settings = this._settings;
    if (!settings) return;

    // Extension filter
    const ext = path.extname(filePath).replace(/^\./, '').toLowerCase();
    const rawExtensions = String(settings.extensions || '').trim();
    if (rawExtensions) {
      const extList = rawExtensions.split(',').map(e => e.trim().toLowerCase().replace(/^\./, '')).filter(Boolean);
      if (extList.length > 0) {
        const matches = extList.includes(ext);
        if (settings.filterMode === 'include' && !matches) return;
        if (settings.filterMode === 'exclude' && matches) return;
      }
    }

    // Skip duplicates (session-based)
    if (settings.skipDuplicates) {
      const normalized = filePath.replace(/\\/g, '/').toLowerCase();
      if (this._seenFiles.has(normalized)) return;
      this._seenFiles.add(normalized);
    }

    // Batch: collect files over 200ms window then emit together
    this._batchBuffer.push(filePath);
    if (this._batchTimer) clearTimeout(this._batchTimer);
    this._batchTimer = setTimeout(() => {
      const files = this._batchBuffer.splice(0);
      this._batchTimer = null;
      if (files.length > 0) {
        this.emit('new-files', files);
      }
    }, 200);
  }
}

module.exports = FolderMonitor;
