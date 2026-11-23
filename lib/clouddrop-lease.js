const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('node:stream');
const { Worker } = require('node:worker_threads');
const { performance } = require('node:perf_hooks');
const { setTimeout: delay } = require('node:timers/promises');
const { request, Agent } = require('undici');
const { planChunks, condenseMacs, e64, d64 } = require('./clouddrop-lease-crypto');

const MIB = 1024 * 1024;
const LEASE_PATH = '/api/cloud/mega-lease';
const RETRYABLE_MEGA_CODES = new Set([-3, -4, -6]);
const DEFAULTS = Object.freeze({
  connections: 12,
  chunkSize: 8 * MIB,
  minStartRate: 0,
  relativeStartRatio: 0.25,
  maxSlowRestarts: 4,
  maxPartAttempts: 4,
  maxChunkRetries: 6,
  warmupMs: 5000,
  windowMs: 4000,
  requestTimeoutMs: 120000,
  heartbeatMs: 5000,
  apiTimeoutMs: 180000,
  maxInflightChunks: 64,
});

const megaAgent = new Agent({ connections: 64, pipelining: 1, keepAliveTimeout: 30_000, keepAliveMaxTimeout: 60_000 });

class Semaphore {
  constructor(count) {
    this.count = count;
    this.waiters = [];
  }
  async acquire(signal) {
    if (this.count > 0) { this.count--; return; }
    await new Promise((resolve, reject) => {
      const entry = { resolve, reject };
      this.waiters.push(entry);
      if (signal) {
        const onAbort = () => {
          const index = this.waiters.indexOf(entry);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(signal.reason || new Error('Aborted'));
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }
  release() {
    const next = this.waiters.shift();
    if (next) next.resolve();
    else this.count++;
  }
}

class CryptoPool {
  constructor(size) {
    this.size = size;
    this.workers = [];
    this.idle = [];
    this.queue = [];
    this.pending = new Map();
    this.nextId = 1;
  }

  _spawn() {
    const worker = new Worker(path.join(__dirname, 'clouddrop-lease-worker.js'));
    worker.on('message', (message) => this._onMessage(worker, message));
    worker.on('error', (error) => this._onError(worker, error));
    worker.on('exit', () => {
      this.workers = this.workers.filter(item => item !== worker);
      this.idle = this.idle.filter(item => item !== worker);
    });
    worker.unref();
    this.workers.push(worker);
    this.idle.push(worker);
  }

  encrypt(job) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.queue.push({ id, ...job });
      if (!this.idle.length && this.workers.length < this.size) this._spawn();
      this._drain();
    });
  }

  _drain() {
    while (this.idle.length && this.queue.length) {
      const worker = this.idle.pop();
      const job = this.queue.shift();
      worker.currentJob = job.id;
      worker.postMessage(job, [job.data]);
    }
  }

  _onMessage(worker, message) {
    worker.currentJob = null;
    this.idle.push(worker);
    const entry = this.pending.get(message.id);
    this.pending.delete(message.id);
    if (entry) {
      if (message.error) {
        const error = new Error(message.error);
        error.plain = message.plain;
        entry.reject(error);
      } else {
        entry.resolve({ cipher: Buffer.from(message.cipher), macs: Buffer.from(message.macs), plain: message.plain });
      }
    }
    this._drain();
  }

  _onError(worker, error) {
    const id = worker.currentJob;
    if (id && this.pending.has(id)) {
      this.pending.get(id).reject(error);
      this.pending.delete(id);
    }
  }
}

let sharedPool = null;
let sharedSlots = null;
const lineStats = { bestRate: 0, peakAggregate: 0, active: new Map() };

function cryptoPool() {
  if (!sharedPool) sharedPool = new CryptoPool(Math.max(1, Math.min(6, os.cpus().length - 1)));
  return sharedPool;
}

function chunkSlots() {
  if (!sharedSlots) sharedSlots = new Semaphore(DEFAULTS.maxInflightChunks);
  return sharedSlots;
}

class PartFailure extends Error {
  constructor(message, details = {}) {
    super(message);
    this.details = details;
  }
}

function megaCode(body) {
  const text = body.toString('utf8').trim();
  return /^-\d{1,3}$/.test(text) ? Number(text) : null;
}

function bodyStream(buffer, onSent) {
  return Readable.from((function* slices() {
    for (let offset = 0; offset < buffer.length; offset += MIB) {
      const slice = buffer.subarray(offset, Math.min(offset + MIB, buffer.length));
      onSent(slice.length);
      yield slice;
    }
  })(), { objectMode: false });
}

async function readFully(handle, target, length, position) {
  let done = 0;
  while (done < length) {
    const { bytesRead } = await handle.read(target, done, length - done, position + done);
    if (bytesRead <= 0) throw new Error(`Clouddrop: Datei endet unerwartet bei Byte ${position + done}`);
    done += bytesRead;
  }
}

function leaseError(prefix, reply) {
  const payload = reply.payload;
  const error = new Error(`Clouddrop: ${prefix}${payload && payload.error ? `: ${payload.error}` : ` (HTTP ${reply.status})`}`);
  error.status = reply.status;
  if (payload && typeof payload.code === 'string') error.code = payload.code;
  if (payload && typeof payload.reason === 'string') error.reason = payload.reason;
  return error;
}

class LeaseClient {
  constructor({ apiKey, baseUrl, dispatcher, userAgent, sleep, now }) {
    this.apiKey = apiKey;
    this.base = `${baseUrl}${LEASE_PATH}`;
    this.dispatcher = dispatcher;
    this.userAgent = userAgent;
    this.sleep = sleep || ((ms, signal) => delay(ms, undefined, { signal }));
    this.now = now || Date.now;
  }

  async call(method, route, body, { signal, retries = 4, timeoutMs = DEFAULTS.apiTimeoutMs } = {}) {
    for (let attempt = 0; ; attempt++) {
      let reply;
      try {
        const res = await request(`${this.base}${route}`, {
          method,
          dispatcher: this.dispatcher,
          signal,
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'User-Agent': this.userAgent,
            'Accept': 'application/json',
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          headersTimeout: timeoutMs,
          bodyTimeout: timeoutMs,
        });
        const text = await res.body.text();
        let payload = null;
        try { payload = text ? JSON.parse(text) : null; } catch {}
        reply = { status: res.statusCode, payload };
      } catch (error) {
        if (signal && signal.aborted) throw error;
        if (attempt >= retries) { error.transientNetwork = true; throw error; }
        await this.sleep(Math.min(30_000, 1000 * 2 ** attempt), signal);
        continue;
      }
      if (reply.status >= 200 && reply.status < 300) return reply.payload;
      const transient = reply.status >= 500 && reply.status !== 507 && !(reply.payload && reply.payload.code === 'MEGA_NODE_FAILED');
      if (transient && attempt < retries) {
        await this.sleep(Math.min(30_000, 1000 * 2 ** attempt), signal);
        continue;
      }
      const error = leaseError('Direkt-Upload abgelehnt', reply);
      if (transient || reply.status === 507) error.transientNetwork = true;
      throw error;
    }
  }
}

async function postChunk({ url, cipher, signal, timeoutMs, onSent }) {
  const res = await request(url, {
    method: 'POST',
    dispatcher: megaAgent,
    signal,
    body: bodyStream(cipher, onSent),
    headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(cipher.length) },
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
  });
  const body = Buffer.from(await res.body.arrayBuffer());
  return { status: res.statusCode, body };
}

async function uploadViaLease({ apiKey, baseUrl, dispatcher, userAgent, filePath, fileName, fileSize, progressCb, signal, throttle, options = {}, sleep, now }) {
  const settings = { ...DEFAULTS, ...options };
  const throttled = Boolean(throttle) && !(typeof throttle.maxBps === 'number' && throttle.maxBps <= 0);
  const minStartRate = throttled ? 0 : settings.minStartRate;
  const api = new LeaseClient({ apiKey, baseUrl, dispatcher, userAgent, sleep, now });
  const started = performance.now();
  const lease = await api.call('POST', '/upload/init', {
    filename: fileName,
    size: fileSize,
    mode: 'rename',
    client: { tool: 'multi-hoster-uploader', version: options.appVersion || null, host: os.hostname(), settings: { connections: settings.connections, chunkSize: settings.chunkSize } },
  }, { signal, retries: 2 });
  const leaseId = lease.leaseId;
  const control = new AbortController();
  signal = signal ? AbortSignal.any([signal, control.signal]) : control.signal;
  const events = [];
  const event = (type, data) => events.push({ kind: 'event', type, t: Date.now(), ms: Math.round(performance.now() - started), ...data });
  const handle = await fs.promises.open(filePath, 'r');
  const pool = cryptoPool();
  const slots = chunkSlots();
  const fullHash = crypto.createHash('sha256');
  const avoidHosts = new Set();
  let hashedUpTo = 0;
  let doneBytes = 0;
  let slowRestarts = 0;
  let retries = 0;
  let reportedBytes = 0;
  const report = (partAcked) => {
    reportedBytes = Math.min(fileSize, doneBytes + partAcked);
    if (progressCb) progressCb(reportedBytes, fileSize);
  };
  let heartbeatBusy = false;
  let heartbeatPrevious = { at: performance.now(), bytes: 0 };
  const heartbeat = setInterval(async () => {
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    const at = performance.now();
    const bytes = reportedBytes;
    const seconds = (at - heartbeatPrevious.at) / 1000;
    const bytesPerSecond = seconds > 0 ? Math.max(0, Math.round((bytes - heartbeatPrevious.bytes) / seconds)) : 0;
    heartbeatPrevious = { at, bytes };
    try {
      await api.call('POST', `/upload/${leaseId}/progress`, { bytesUploaded: bytes, bytesPerSecond }, { retries: 0, timeoutMs: 15000 });
    } catch (error) {
      if (error && error.status === 410) {
        control.abort(new Error(error.reason === 'cancelled_by_admin'
          ? 'Clouddrop: Upload wurde vom Administrator abgebrochen'
          : 'Clouddrop: Upload wurde auf dem Server beendet'));
      }
    } finally {
      heartbeatBusy = false;
    }
  }, settings.heartbeatMs);
  heartbeat.unref?.();

  async function sendPart(part, target) {
    const key = d64(target.fileKey);
    const aesKey = key.subarray(0, 16);
    const nonce = key.subarray(16, 24);
    const plan = planChunks(part.size, settings.chunkSize);
    const macs = new Array(plan.chunks.length);
    const partHash = crypto.createHash('sha256');
    const partAbort = new AbortController();
    const partSignal = signal ? AbortSignal.any([signal, partAbort.signal]) : partAbort.signal;
    const local = new Semaphore(settings.connections);
    const uploadStarted = performance.now();
    const history = [];
    let sent = 0;
    let acked = 0;
    let completionHandle = null;
    let partError = null;
    const fail = (error) => { if (!partError) { partError = error; partAbort.abort(error); } };
    const monitor = setInterval(() => {
      const at = performance.now();
      history.push({ at, sent });
      while (history.length && at - history[0].at > settings.windowMs * 2) history.shift();
      const from = history.find(item => at - item.at <= settings.windowMs * 1.25 + 250) || history[0];
      const seconds = (at - from.at) / 1000;
      if (seconds < settings.windowMs / 2000) return;
      const rate = (sent - from.sent) / seconds;
      lineStats.active.set(leaseId, rate);
      const aggregate = [...lineStats.active.values()].reduce((sum, value) => sum + value, 0);
      lineStats.peakAggregate = Math.max(lineStats.peakAggregate, aggregate);
      if (at - uploadStarted < settings.warmupMs || throttled) return;
      if (slowRestarts >= settings.maxSlowRestarts || acked >= part.size * 0.15) return;
      const lineFree = lineStats.active.size <= 1 || aggregate < lineStats.peakAggregate * 0.6;
      const absoluteSlow = minStartRate > 0 && rate < minStartRate;
      const relativeSlow = lineStats.bestRate > 0 && rate < lineStats.bestRate * settings.relativeStartRatio;
      if ((absoluteSlow || relativeSlow) && lineFree) {
        event('part_slow', {
          part: part.index, host: target.host, rateBytesPerSecond: Math.round(rate), bestBytesPerSecond: Math.round(lineStats.bestRate),
          rule: absoluteSlow ? 'slow-start' : 'slow-start-relative',
        });
        fail(new PartFailure(`Clouddrop: Langsamer MEGA-Server ${target.host}`, { kind: 'slow' }));
      }
    }, 1000);
    monitor.unref?.();
    const running = [];
    try {
      for (const chunk of plan.chunks) {
        await local.acquire(partSignal).catch(error => fail(error));
        if (partError) break;
        await slots.acquire(partSignal).catch(error => fail(error));
        if (partError) { local.release(); break; }
        let plain = new ArrayBuffer(chunk.length);
        const view = Buffer.from(plain, 0, chunk.length);
        try {
          await readFully(handle, view, chunk.length, part.offset + chunk.offset);
        } catch (error) {
          slots.release();
          local.release();
          fail(error);
          break;
        }
        partHash.update(view);
        if (part.offset + chunk.offset === hashedUpTo) {
          fullHash.update(view);
          hashedUpTo += chunk.length;
        }
        running.push((async () => {
          try {
            const encrypted = await pool.encrypt({ aesKey, nonce, offset: chunk.offset, data: plain, length: chunk.length, segments: chunk.segments });
            plain = encrypted.plain;
            for (let tries = 1; ; tries++) {
              if (partSignal.aborted) throw partSignal.reason;
              if (throttle) await throttle.consume(chunk.length, partSignal);
              let result = null;
              let failure = null;
              let sentThisTry = 0;
              try {
                result = await postChunk({
                  url: `${target.uploadUrl}/${chunk.offset}`,
                  cipher: encrypted.cipher,
                  signal: partSignal,
                  timeoutMs: settings.requestTimeoutMs,
                  onSent: (bytes) => { sent += bytes; sentThisTry += bytes; },
                });
              } catch (error) {
                if (partSignal.aborted) throw partSignal.reason;
                failure = { kind: 'network', message: error.code || error.message };
              }
              if (!failure && result.status !== 200) failure = { kind: 'http', message: `HTTP ${result.status}` };
              const code = !failure && result.body.length ? megaCode(result.body) : null;
              if (!failure && code !== null) failure = { kind: 'mega', code, message: `MEGA ${code}` };
              if (!failure) {
                if (result.body.length) completionHandle = e64(result.body);
                macs[chunk.index] = encrypted.macs;
                acked += chunk.length;
                report(acked);
                return;
              }
              sent -= sentThisTry;
              retries++;
              event('chunk_retry', { part: part.index, chunk: chunk.index, try: tries, ...failure });
              if (failure.kind === 'mega' && !RETRYABLE_MEGA_CODES.has(failure.code)) throw new PartFailure(`Clouddrop: MEGA-Fehler ${failure.code}`, failure);
              if (tries > settings.maxChunkRetries) throw new PartFailure(`Clouddrop: Anfrage an MEGA nach ${tries} Versuchen fehlgeschlagen`, failure);
              await delay(Math.min(30_000, 500 * 2 ** tries), undefined, { signal: partSignal });
            }
          } catch (error) {
            fail(error);
          } finally {
            slots.release();
            local.release();
          }
        })());
      }
      await Promise.all(running);
    } finally {
      clearInterval(monitor);
      lineStats.active.delete(leaseId);
    }
    if (partError) { partError.ackedBytes = acked; throw partError; }
    if (!completionHandle) throw new PartFailure('Clouddrop: MEGA hat keine Abschluss-Kennung geliefert');
    return {
      completionHandle,
      mac: e64(condenseMacs(aesKey, macs, { trailingMac: plan.trailingMac, nonce })),
      sha256: partHash.digest('hex'),
      uploadMs: performance.now() - uploadStarted,
    };
  }

  async function completePart(part, body) {
    for (let i = 0; ; i++) {
      try {
        return await api.call('POST', `/upload/${leaseId}/parts/${part.index}/complete`, body, { signal });
      } catch (error) {
        if (error.code === 'PART_BUSY' && i < 24) { await api.sleep(5000, signal); continue; }
        throw error;
      }
    }
  }

  try {
    for (const part of lease.parts) {
      let reason = null;
      let failures = 0;
      for (let attempt = 1; ; attempt++) {
        const body = { avoidHosts: [...avoidHosts] };
        if (reason) body.reason = reason;
        let target;
        try {
          target = await api.call('POST', `/upload/${leaseId}/parts/${part.index}/target`, body, { signal, retries: 2 });
        } catch (error) {
          const nothingSent = doneBytes === 0 && attempt === 1;
          if (nothingSent && !signal.aborted && error && (error.status === 507 || error.status === 503)) error.leaseFallback = true;
          throw error;
        }
        target.host = new URL(target.uploadUrl).host;
        event('target', { part: part.index, attempt: target.attempt, host: target.host, server: target.timings });
        try {
          const sentPart = await sendPart(part, target);
          await completePart(part, {
            attempt: target.attempt,
            completionHandle: sentPart.completionHandle,
            mac: sentPart.mac,
            sha256: sentPart.sha256,
            bytes: part.size,
            stats: { uploadMs: Math.round(sentPart.uploadMs), host: target.host },
          });
          doneBytes += part.size;
          report(0);
          if (!throttled && part.size >= 64 * MIB && sentPart.uploadMs > 0) {
            lineStats.bestRate = Math.max(lineStats.bestRate, part.size / (sentPart.uploadMs / 1000));
          }
          event('part_done', { part: part.index, attempt: target.attempt, bytes: part.size, uploadMs: Math.round(sentPart.uploadMs), bytesPerSecond: Math.round(part.size / (sentPart.uploadMs / 1000)), host: target.host });
          break;
        } catch (error) {
          if (signal && signal.aborted) throw error;
          const slow = error instanceof PartFailure && error.details.kind === 'slow';
          const retryable = error instanceof PartFailure || error.code === 'MEGA_NODE_FAILED';
          if (slow) { slowRestarts++; avoidHosts.add(target.host); } else failures++;
          report(0);
          reason = String(error.message || error).slice(0, 180);
          event(slow ? 'part_retarget_slow' : 'part_failed', { part: part.index, attempt: target.attempt, error: reason });
          if (!retryable || failures >= settings.maxPartAttempts) {
            if (retryable) error.transientNetwork = true;
            throw error;
          }
          if (!slow) await api.sleep(2000 * failures, signal);
        }
      }
    }
    const final = await api.call('POST', `/upload/${leaseId}/finalize`, { sha256: fullHash.digest('hex') }, { signal });
    const durationMs = performance.now() - started;
    events.push({
      kind: 'summary', t: Date.now(), durationMs: Math.round(durationMs), ackedBytes: fileSize,
      averageBytesPerSecond: Math.round(fileSize / (durationMs / 1000)), retries, errors: 0, slowRetargets: slowRestarts,
      settings: { connections: settings.connections, chunkSize: settings.chunkSize, partSize: lease.partBytes, parallelParts: 1 },
      host: { name: os.hostname(), platform: process.platform, cpus: os.cpus().length, node: process.version },
    });
    api.call('POST', `/upload/${leaseId}/telemetry`, { records: events }, { retries: 1 }).catch(() => {});
    return final.fileId;
  } catch (error) {
    if (error && typeof error === 'object') error.leaseStarted = true;
    events.push({ kind: 'event', type: 'failed', t: Date.now(), error: String(error.message || error).slice(0, 200) });
    api.call('POST', `/upload/${leaseId}/telemetry`, { records: events }, { retries: 0 }).catch(() => {});
    api.call('POST', `/upload/${leaseId}/abort`, { reason: String(error.message || error).slice(0, 180) }, { retries: 1 }).catch(() => {});
    throw error;
  } finally {
    clearInterval(heartbeat);
    await handle.close().catch(() => {});
  }
}

module.exports = { uploadViaLease, DEFAULTS, PartFailure, _megaAgent: megaAgent, _lineStats: lineStats };
