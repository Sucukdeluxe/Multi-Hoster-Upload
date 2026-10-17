const { performance } = require('node:perf_hooks');
const { randomUUID } = require('node:crypto');

class PerformanceMonitor {
  constructor({ now = Date.now, monotonic = () => performance.now(), cpu = () => process.cpuUsage(), memory = () => process.memoryUsage(), limit = 600 } = {}) {
    this.now = now;
    this.monotonic = monotonic;
    this.cpu = cpu;
    this.memory = memory;
    this.limit = limit;
    this.bootId = randomUUID();
    this.startedAt = now();
    this.samples = [];
    this.events = [];
    this.operations = new Map();
    this.pendingRenderer = new Map();
    this.sequence = 0;
    this.timer = null;
  }
  record(name, durationMs, failed = false) {
    if (!/^[a-z][a-z0-9_.:-]{0,79}$/.test(name) || !Number.isFinite(durationMs) || durationMs < 0) return;
    if (!this.operations.has(name) && this.operations.size >= 128) return;
    const item = this.operations.get(name) || { name, count: 0, failed: 0, totalMs: 0, maxMs: 0, active: 0 };
    item.count++;
    item.failed += Number(failed);
    item.totalMs += durationMs;
    item.maxMs = Math.max(item.maxMs, durationMs);
    item.lastMs = durationMs;
    item.lastAt = this.now();
    this.operations.set(name, item);
    if (durationMs >= 1000) this.event('operation', { name, durationMs, failed });
  }
  async measure(name, operation) {
    const started = this.monotonic();
    let failed = false;
    try { return await operation(); }
    catch (error) { failed = true; throw error; }
    finally { this.record(name, this.monotonic() - started, failed); }
  }
  event(type, details = {}) {
    this.events.push({ id: ++this.sequence, at: this.now(), type, ...details });
    if (this.events.length > this.limit) this.events.splice(0, this.events.length - this.limit);
  }
  rendererReply(id) {
    const started = this.pendingRenderer.get(id);
    if (started === undefined) return;
    this.pendingRenderer.delete(id);
    const durationMs = this.monotonic() - started;
    this.record('renderer.roundtrip', durationMs);
  }
  observeSyncFileOperations(fs) {
    const originals = new Map();
    for (const name of ['statSync', 'statfsSync', 'existsSync', 'mkdirSync', 'openSync', 'readSync', 'readFileSync', 'writeSync', 'writeFileSync', 'appendFileSync', 'fsyncSync', 'renameSync', 'unlinkSync', 'readdirSync', 'truncateSync', 'closeSync']) {
      if (typeof fs[name] !== 'function') continue;
      const original = fs[name];
      const monitor = this;
      function measured(...args) {
        const start = monitor.monotonic();
        let failed = false;
        try { return original.apply(this, args); }
        catch (error) { failed = true; throw error; }
        finally {
          const durationMs = monitor.monotonic() - start;
          if (durationMs >= 100) {
            try {
              monitor.record(`fs-sync.${name.toLowerCase()}`, durationMs, failed);
              if (durationMs >= 1000) {
                const caller = (new Error().stack || '').split('\n').slice(2)
                  .map(line => line.match(/([^/\\\s()]+\.js:\d+:\d+)\)?$/)?.[1]).find(Boolean) || null;
                monitor.event('sync-file-delay', { operation: name, durationMs, failed, caller });
              }
            } catch {}
          }
        }
      }
      originals.set(name, { original, measured });
      fs[name] = measured;
    }
    return () => {
      for (const [name, { original, measured }] of originals) if (fs[name] === measured) fs[name] = original;
    };
  }
  start({ version, getTransfers = () => null, pingRenderer = () => false } = {}) {
    if (this.timer) return;
    this.version = version;
    let previous = this.monotonic();
    let previousCpu = this.cpu();
    this.timer = setInterval(() => {
      const current = this.monotonic();
      const elapsed = current - previous;
      const currentCpu = this.cpu();
      const delayMs = Math.max(0, elapsed - 1000);
      const sample = { at: this.now(), elapsedMs: elapsed, delayMs, cpuPercent: elapsed > 0 ? (currentCpu.user + currentCpu.system - previousCpu.user - previousCpu.system) / (elapsed * 10) : 0,
        memory: this.memory(), transfers: getTransfers() };
      this.samples.push(sample);
      if (this.samples.length > this.limit) this.samples.shift();
      if (delayMs > 30000) this.event('measurement-gap', { durationMs: delayMs });
      else if (delayMs >= 1000) this.event('main-delay', { durationMs: delayMs });
      for (const [id, started] of this.pendingRenderer) if (current - started >= 5000) {
        this.pendingRenderer.delete(id);
        this.event('renderer-unanswered', { durationMs: current - started });
      }
      if (!this.pendingRenderer.size) {
        const id = ++this.sequence;
        if (pingRenderer(id)) this.pendingRenderer.set(id, current);
      }
      previous = current;
      previousCpu = currentCpu;
    }, 1000);
    this.timer.unref?.();
  }
  stop() { clearInterval(this.timer); this.timer = null; this.pendingRenderer.clear(); }
  snapshot() {
    return { bootId: this.bootId, version: this.version || null, startedAt: this.startedAt, sampledAt: this.now(), running: !!this.timer,
      samples: this.samples.slice(-300), events: this.events.slice(), operations: [...this.operations.values()].map(item => ({ ...item })) };
  }
}

const runtimePerformance = new PerformanceMonitor();
module.exports = { PerformanceMonitor, runtimePerformance };
