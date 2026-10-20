const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { runtimePerformance } = require('./performance-monitor');

class BackgroundDiskReader {
  constructor({ createWorker = () => new Worker(path.join(__dirname, 'system-metrics-worker.js')), timeoutMs = 15000 } = {}) {
    this.createWorker = createWorker;
    this.timeoutMs = timeoutMs;
    this.sequence = 0;
    this.worker = null;
    this.pending = null;
  }
  connect() {
    if (this.worker) return this.worker;
    const worker = this.createWorker();
    this.worker = worker;
    worker.on('message', message => {
      if (worker !== this.worker || message.id !== this.pending?.id) return;
      const pending = this.pending;
      this.pending = null;
      if (Number.isFinite(message.spawnMs)) runtimePerformance.record('host.spawn.worker', message.spawnMs);
      pending.finish(message.error ? Error('STORAGE_QUERY_FAILED') : null, message.value);
      worker.unref();
    });
    const failed = () => {
      if (worker !== this.worker) return;
      this.worker = null;
      this.pending?.finish(Error('STORAGE_WORKER_FAILED'));
      this.pending = null;
    };
    worker.on('error', failed);
    worker.on('exit', failed);
    worker.unref();
    return worker;
  }
  read({ signal } = {}) {
    if (signal?.aborted) return Promise.reject(Error('STORAGE_QUERY_ABORTED'));
    if (this.pending) return Promise.reject(Error('STORAGE_QUERY_BUSY'));
    return new Promise((resolve, reject) => {
      const worker = this.connect();
      const id = ++this.sequence;
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(value);
      };
      const cancel = code => {
        try { worker.postMessage({ type: 'cancel', id }); } catch {}
        worker.unref();
        finish(Error(code));
      };
      const abort = () => cancel('STORAGE_QUERY_ABORTED');
      const timer = setTimeout(() => cancel('STORAGE_QUERY_TIMEOUT'), this.timeoutMs);
      this.pending = { id, finish };
      signal?.addEventListener('abort', abort, { once: true });
      worker.ref();
      try { worker.postMessage({ type: 'read', id }); }
      catch {
        this.pending = null;
        worker.unref();
        finish(Error('STORAGE_WORKER_FAILED'));
      }
    });
  }
}

const reader = new BackgroundDiskReader();
module.exports = { BackgroundDiskReader, readWindowsCountersOffThread: options => reader.read(options) };
