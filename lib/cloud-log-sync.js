const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { ClouddropLogApi, CloudLogError } = require('./clouddrop-log-api');
const { iterateUploadLogEntries } = require('./upload-log');

const MAX_DOCUMENT_BYTES = 4000000;
const hash = value => createHash('sha256').update(value).digest('hex');
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const blocksRetry = code => ['INVALID_KEY', 'ACCESS_DENIED', 'UNRESTRICTED_KEY_REQUIRED',
  'LOCAL_STATE_INVALID', 'REMOTE_CONTENT_CHANGED', 'REVISION_REQUIRED'].includes(code);

class CloudLogSync extends EventEmitter {
  constructor({ directory, loadSettings, saveSettings, apiFactory, now = Date.now, delayMs = 750 }) {
    super();
    this.directory = directory;
    this.loadSettings = loadSettings;
    this.saveSettings = saveSettings;
    this.apiFactory = apiFactory || (key => new ClouddropLogApi(key));
    this.now = now;
    this.delayMs = delayMs;
    this.documents = new Map();
    this.dirty = new Set();
    this.localWrites = Promise.resolve();
    this.diskWrites = Promise.resolve();
    this.control = Promise.resolve();
    this.ready = null;
    this.connection = null;
    this.timer = null;
    this.worker = null;
    this.controller = null;
    this.phase = 'disabled';
    this.errorCode = '';
    this.failures = 0;
    this.closed = false;
    this.retryBlocked = false;
    this.documentTime = 0;
    this.backfillJob = null;
    this.backfillContext = null;
    this.backfillResult = null;
  }

  async initialize() {
    if (!this.ready) this.ready = this._load();
    await this.ready;
  }

  async _load() {
    await fs.mkdir(this.directory, { recursive: true });
    for (const name of await fs.readdir(this.directory)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      let doc;
      try { doc = JSON.parse(await fs.readFile(path.join(this.directory, name), 'utf8')); }
      catch { throw new CloudLogError('LOCAL_STATE_INVALID'); }
      if (doc.id + '.json' !== name || !validId(doc.accountId) || typeof doc.content !== 'string'
        || Buffer.byteLength(doc.content) > MAX_DOCUMENT_BYTES || !validId(doc.folderId)
        || !/^[a-f0-9]{64}$/.test(doc.source) || typeof doc.filename !== 'string') {
        throw new CloudLogError('LOCAL_STATE_INVALID');
      }
      this.documents.set(doc.id, doc);
      doc.contentHash = hash(doc.content);
      this.documentTime = Math.max(this.documentTime, Number(doc.createdAt) || 0);
    }
  }

  status() {
    const settings = this.loadSettings() || {};
    const accountId = this.connection?.accountId || settings.accountId;
    const docs = [...this.documents.values()].filter(doc => doc.accountId === accountId && doc.source !== hash('connection-check'));
    const pending = docs.filter(doc => doc.syncedHash !== doc.contentHash);
    return {
      enabled: settings.enabled === true, hasApiKey: Boolean(settings.apiKey),
      phase: this.phase, errorCode: this.errorCode,
      ip: this.connection?.ip || settings.ip || '',
      pendingFiles: pending.length,
      lastSyncedAt: Math.max(0, ...docs.map(doc => Number(doc.lastSyncedAt) || 0)),
      fileCount: docs.length,
      backfillRunning: Boolean(this.backfillJob),
      backfillResult: this.backfillResult ? { ...this.backfillResult } : null
    };
  }

  notify() { this.emit('status', this.status()); }

  configure({ apiKey, enabled }) {
    const operation = this.control.then(() => this._configure(apiKey, enabled));
    this.control = operation.catch(() => {});
    return operation;
  }

  async _configure(apiKey, enabled) {
    await this.initialize();
    clearTimeout(this.timer);
    this.timer = null;
    this.controller?.abort();
    if (this.worker) await this.worker;
    await this.flushLocal();
    const previous = this.loadSettings() || {};
    this.retryBlocked = false;
    this.connection = null;
    if (!enabled) {
      await this.saveSettings({ ...previous, enabled: false });
      this.phase = 'disabled';
      this.errorCode = '';
      this.notify();
      return this.status();
    }
    this.phase = 'checking';
    this.errorCode = '';
    this.notify();
    const key = String(apiKey || previous.apiKey || '').trim();
    const api = this.apiFactory(key);
    const controller = new AbortController();
    this.controller = controller;
    try {
      const identity = await api.identify(controller.signal);
      if (!validId(identity.accountId)) throw new CloudLogError('INVALID_RESPONSE');
      const folderId = await api.ensureFolder(identity.folderName, controller.signal);
      if (!validId(folderId)) throw new CloudLogError('INVALID_RESPONSE');
      const connection = { ...identity, folderId, api };
      const source = hash('connection-check');
      let probe = [...this.documents.values()].find(doc => doc.accountId === identity.accountId
        && doc.folderId === folderId && doc.source === source);
      if (!probe) {
        probe = this._newDocument(connection, source, 'fileuploader-connection', '');
        await this._saveDocument(probe);
        this.documents.set(probe.id, probe);
      }
      if (!probe.remoteId) {
        probe.remoteId = await api.createFile(folderId, probe.filename, probe.id, controller.signal);
        await this._saveDocument(probe);
      }
      await api.writeFile(probe.remoteId, '', controller.signal);
      const verification = await api.readFile(probe.remoteId, controller.signal);
      if (verification.content !== '') throw new CloudLogError('VERIFICATION_FAILED');
      probe.syncedHash = hash('');
      probe.lastSyncedAt = this.now();
      await this._saveDocument(probe);
      await this.saveSettings({ enabled: true, apiKey: key, accountId: identity.accountId, ip: identity.ip, folderId });
      this.connection = connection;
      this.phase = 'ready';
      this.failures = 0;
      this.notify();
      this.schedule();
      return this.status();
    } catch (error) {
      this.phase = 'error';
      this.errorCode = this._errorCode(error);
      this.retryBlocked = blocksRetry(this.errorCode);
      this.notify();
      throw new CloudLogError(this.errorCode);
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }

  async start() {
    try {
      await this.initialize();
      if (this.loadSettings()?.enabled) await this.configure({ enabled: true });
    } catch (error) {
      this.phase = 'error';
      this.errorCode = this._errorCode(error);
      this.retryBlocked = blocksRetry(this.errorCode);
      this.notify();
      if (!this.closed && !blocksRetry(this.errorCode)) {
        this.timer = setTimeout(() => { this.timer = null; void this.start(); }, 30000);
        this.timer.unref?.();
      }
    }
  }

  _newDocument(connection, source, stem, content) {
    const id = randomUUID();
    this.documentTime = Math.max(this.now(), this.documentTime + 1);
    return {
      id, accountId: connection.accountId, folderId: connection.folderId, source,
      filename: `${stem.replace(/[^\p{L}\p{N}._-]/gu, '_').slice(0, 110)}-${id}.txt`,
      content, contentHash: hash(content), remoteId: null, syncedHash: null, lastSyncedAt: 0, createdAt: this.documentTime
    };
  }

  async append(sourcePath, line, trackBackfill = true) {
    await this.initialize();
    const settings = this.loadSettings() || {};
    if (!settings.enabled || !settings.accountId || typeof line !== 'string' || !line) return;
    if (Buffer.byteLength(line) > MAX_DOCUMENT_BYTES) {
      this.errorCode = 'LINE_TOO_LARGE';
      this.phase = 'error';
      this.notify();
      return;
    }
    const connection = this.connection || {
      accountId: settings.accountId, folderId: settings.folderId, ip: settings.ip
    };
    const known = [...this.documents.values()].filter(doc => doc.accountId === settings.accountId && doc.source !== hash('connection-check'));
    if (!connection.folderId) connection.folderId = [...this.documents.values()]
      .find(doc => doc.accountId === settings.accountId && doc.source === hash('connection-check'))?.folderId;
    if (!connection.folderId) return;
    const source = hash(`${sourcePath}|${connection.ip}|${connection.folderId}`);
    const backfill = this.backfillContext;
    if (trackBackfill && backfill?.folderId === connection.folderId && backfill.accountId === settings.accountId) {
      for (const entry of line.split(/\r?\n/).filter(Boolean)) {
        backfill.counts.set(entry, (backfill.counts.get(entry) || 0) + 1);
      }
    }
    let doc = known.filter(item => item.source === source).sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!doc || Buffer.byteLength(doc.content) + Buffer.byteLength(line) > MAX_DOCUMENT_BYTES) {
      doc = this._newDocument(connection, source, path.basename(sourcePath, path.extname(sourcePath)), '');
      this.documents.set(doc.id, doc);
    }
    doc.content += line;
    doc.contentHash = hash(doc.content);
    this.dirty.add(doc.id);
    await this.flushLocal().then(() => this.schedule()).catch(error => {
      this.phase = 'error';
      this.errorCode = this._errorCode(error);
      this.notify();
      this.schedule();
      if (!trackBackfill) throw new CloudLogError('LOCAL_WRITE_FAILED');
    });
  }

  async _saveDocument(doc) {
    const destination = path.join(this.directory, doc.id + '.json');
    const temporary = destination + '.tmp';
    const content = JSON.stringify(doc);
    const operation = this.diskWrites.then(async () => {
      await fs.writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temporary, destination);
    });
    this.diskWrites = operation.catch(() => {});
    return operation;
  }

  backfill(sourcePath) {
    if (this.backfillJob) return this.backfillJob;
    const operation = this.control.then(() => this._backfill(sourcePath));
    this.backfillJob = operation.finally(() => {
      this.backfillJob = null;
      this.backfillContext = null;
      this.notify();
    });
    this.control = this.backfillJob.catch(() => {});
    this.notify();
    return this.backfillJob;
  }

  async _backfill(sourcePath) {
    await this.initialize();
    if (this.closed || !this.loadSettings()?.enabled || !this.connection || this.retryBlocked) {
      throw new CloudLogError('CONNECTION_REQUIRED');
    }
    const connection = this.connection;
    let file;
    const result = { added: 0, skipped: 0 };
    this.backfillResult = null;
    try {
      file = await fs.open(sourcePath, 'r');
      const stat = await file.stat();
      if (!stat.isFile()) throw new CloudLogError('LOG_READ_FAILED');
      if (stat.size > 256 * 1024 * 1024) throw new CloudLogError('LOG_TOO_LARGE');
      if (stat.size === 0) {
        this.backfillResult = result;
        return result;
      }
      const counts = new Map();
      for (const doc of this.documents.values()) {
        if (doc.accountId !== connection.accountId || doc.folderId !== connection.folderId) continue;
        for (const line of doc.content.split(/\r?\n/).filter(Boolean)) {
          counts.set(line, (counts.get(line) || 0) + 1);
          if (counts.size > 250000) throw new CloudLogError('LOG_TOO_LARGE');
        }
      }
      this.backfillContext = { folderId: connection.folderId, accountId: connection.accountId, counts };
      const seen = new Map();
      let pending = '';
      let pendingLines = 0;
      const savePending = async () => {
        if (!pending) return;
        const content = pending;
        pending = '';
        pendingLines = 0;
        await this.append(sourcePath, content, false);
      };
      try {
        for await (const entry of iterateUploadLogEntries(sourcePath, {
          fs: { createReadStream: () => file.createReadStream({ encoding: 'utf8', highWaterMark: 32768, end: stat.size - 1, autoClose: false }) },
          includeLine: true, requireCompleteLines: true
        })) {
          if (this.closed) throw new CloudLogError('BACKFILL_CANCELED');
          if (!entry.confirmed) continue;
          const count = (seen.get(entry.line) || 0) + 1;
          seen.set(entry.line, count);
          if (seen.size > 250000) throw new CloudLogError('LOG_TOO_LARGE');
          if (count <= (counts.get(entry.line) || 0)) {
            result.skipped++;
            continue;
          }
          counts.set(entry.line, (counts.get(entry.line) || 0) + 1);
          pending += entry.line + '\n';
          pendingLines++;
          result.added++;
          if (pendingLines >= 100 || Buffer.byteLength(pending) >= 32768) await savePending();
        }
      } finally {
        await savePending();
      }
      this.backfillResult = result;
      this.schedule(0);
      return { ...result };
    } catch (error) {
      if (error instanceof CloudLogError) throw error;
      throw new CloudLogError(error?.code === 'ENOENT' ? 'LOG_NOT_FOUND' : 'LOG_READ_FAILED');
    } finally {
      if (file) await file.close();
    }
  }

  flushLocal() {
    const operation = this.localWrites.then(async () => {
      for (const id of [...this.dirty]) {
        const doc = this.documents.get(id);
        const content = doc.content;
        await this._saveDocument({ ...doc, content });
        if (doc.content === content) this.dirty.delete(id);
      }
    });
    this.localWrites = operation.catch(() => {});
    return operation;
  }

  schedule(delay = this.delayMs) {
    if (this.closed || this.retryBlocked || this.timer || this.worker || !this.loadSettings()?.enabled) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.connection) { void this.start(); return; }
      this.worker = this._sync().finally(() => { this.worker = null; });
    }, delay);
    this.timer.unref?.();
  }

  async _sync() {
    const connection = this.connection;
    const controller = new AbortController();
    this.controller = controller;
    try {
      await this.flushLocal();
      this.phase = 'syncing';
      this.notify();
      for (const doc of this.documents.values()) {
        if (doc.accountId !== connection.accountId || doc.syncedHash === doc.contentHash) continue;
        const content = doc.content;
        const contentHash = doc.contentHash;
        if (!doc.remoteId) {
          doc.remoteId = await connection.api.createFile(doc.folderId, doc.filename, doc.id, controller.signal);
          await this._saveDocument(doc);
        }
        await connection.api.writeFile(doc.remoteId, content, controller.signal);
        doc.syncedHash = contentHash;
        doc.lastSyncedAt = this.now();
        await this._saveDocument(doc);
        this.notify();
      }
      this.phase = 'ready';
      this.errorCode = '';
      this.failures = 0;
    } catch (error) {
      this.phase = 'error';
      this.errorCode = this._errorCode(error);
      this.failures++;
      this.retryBlocked = blocksRetry(this.errorCode);
    } finally {
      if (this.controller === controller) this.controller = null;
      this.notify();
      const pending = [...this.documents.values()].some(doc => doc.accountId === connection.accountId && doc.syncedHash !== doc.contentHash);
      if (pending && !controller.signal.aborted && !this.retryBlocked && !this.closed) {
        const delay = this.failures ? Math.min(300000, 5000 * 2 ** Math.min(this.failures - 1, 6)) : this.delayMs;
        this.timer = setTimeout(() => { this.timer = null; this.schedule(0); }, delay);
        this.timer.unref?.();
      }
    }
  }

  _errorCode(error) {
    if (error instanceof CloudLogError) return error.code;
    if (String(error?.code || '').startsWith('SECRET_STORE_')) return 'KEY_STORAGE_UNAVAILABLE';
    if (['EACCES', 'EPERM', 'ENOSPC', 'EIO'].includes(error?.code)) return 'LOCAL_WRITE_FAILED';
    return 'CONNECTION_FAILED';
  }

  async close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = null;
    this.controller?.abort();
    if (this.backfillJob) await this.backfillJob.catch(() => {});
    if (this.worker) await this.worker;
    await this.flushLocal();
    await this.diskWrites;
  }
}

module.exports = { CloudLogSync, MAX_DOCUMENT_BYTES };
