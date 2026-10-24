const fs = require('fs');
const { statUploadFile, readUploadFile } = require('./upload-file-io');
const path = require('path');
const crypto = require('crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { request, Agent } = require('undici');

const BASE_URL = 'https://clouddrop.cc';
const API_BASE = `${BASE_URL}/api/cloud`;
const CHUNK_UPLOAD_BASE = 'https://upload.clouddrop.cc/api/cloud';
const USER_AGENT = 'multi-hoster-uploader/1.0';

const SIMPLE_UPLOAD_LIMIT = 16 * 1024 * 1024; // 16 MB
const CHUNK_SIZE = 16 * 1024 * 1024; // 16 MB — server's fixed chunk size
const INIT_TIMEOUT = 60_000;
const CHUNK_TIMEOUT = 30 * 60_000; // 30 min per chunk
const COMPLETE_TIMEOUT = 5 * 60_000;
const SIMPLE_UPLOAD_TIMEOUT = 30 * 60_000;
const STATUS_TIMEOUT = 60_000;
const JOB_POLL_TIMEOUT = 60_000;

const RETRY_WINDOW_MS = 10 * 60_000;
const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 60_000;
const RETRYABLE_STATUSES = new Set([429, 502, 503, 507]);
const RETRYABLE_CHUNK_CODES = new Set(['CHUNK_IN_PROGRESS', 'CHUNK_HASH_MISMATCH', 'CHUNK_INCOMPLETE']);
const TICKET_CODES = new Set(['TICKET_EXPIRED', 'TICKET_INVALID']);
const RESTART_CODES = new Set(['UPLOAD_SESSION_GONE', 'TICKET_SESSION_MISMATCH', 'EXPRESS_RELAY_REVOKED']);
const MAX_FILE_RESTARTS = 2;
const MAX_TICKET_REFRESHES = 3;
const MAX_MISSING_CHUNK_RESENDS = 3;
const JOB_POLL_INTERVAL_MS = 5_000;
const JOB_POLL_MAX_INTERVAL_MS = 30_000;
const JOB_POLL_ERROR_MAX_DELAY_MS = 60_000;
const JOB_POLL_MAX_MS = 24 * 60 * 60_000;
const EXPRESS_REUPLOAD_ERROR = /^dead:(?:express_[a-z_]+|relay_chunks_missing)$/;

// Cap concurrent TCP connections to clouddrop.cc at 50 to stay well under
// the server's per-IP limit of 100 concurrent connections (cd_conn).
// Shared across all ClouddropUploader instances via module-level agent.
const clouddropAgent = new Agent({
  connections: 50,
  pipelining: 1,
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 60_000
});

function isExpressSession(initPayload) {
  return initPayload.completed === true
    || (typeof initPayload.uploadBaseUrl === 'string' && initPayload.uploadBaseUrl !== '');
}

function expressBaseUrl(value) {
  let url = null;
  try { url = new URL(String(value)); } catch {}
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || !/(^|\.)clouddrop\.cc$/i.test(url.hostname)) {
    throw new Error('Clouddrop: Ungültige Express-Upload-Adresse');
  }
  return url.href.replace(/\/+$/, '');
}

function retryAfterMs(headers) {
  const raw = headers ? headers['retry-after'] : undefined;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === null || String(value).trim() === '') return 0;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.min(Math.max(0, ms), RETRY_WINDOW_MS) : 0;
}

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function shareResult(fileId) {
  return {
    download_url: `${BASE_URL}/share/${fileId}`,
    embed_url: null,
    file_code: fileId
  };
}

function markRestart(error) {
  error.restartFile = true;
  return error;
}

/**
 * Clouddrop.cc uploader — uses API Key (Bearer) authentication.
 * Files > 16 MB use the chunked protocol, smaller files use simple upload.
 * After upload, a share link is created and returned as download_url.
 */
class ClouddropUploader {
  constructor(apiKey, options = {}) {
    this.apiKey = String(apiKey || '').trim();
    this.dispatcher = options.dispatcher || clouddropAgent;
    this.sleep = options.sleep || ((ms, signal) => delay(ms, undefined, { signal }));
    this.now = options.now || Date.now;
  }

  _headers(extra) {
    return {
      'Authorization': `Bearer ${this.apiKey}`,
      'User-Agent': USER_AGENT,
      'Accept': 'application/json',
      ...(extra || {})
    };
  }

  async _parseJsonResponse(res) {
    const text = await res.body.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : {}; } catch {
      throw new Error(`Clouddrop: API-Antwort war kein JSON (HTTP ${res.statusCode}): ${text.slice(0, 200)}`);
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      const msg = (payload && (payload.error || payload.message))
        || `HTTP ${res.statusCode}`;
      const err = new Error(`Clouddrop: ${msg}`);
      err.status = res.statusCode;
      throw err;
    }
    return payload;
  }

  async _readReply(res) {
    const text = await res.body.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : {}; } catch {}
    return {
      ok: res.statusCode >= 200 && res.statusCode < 300,
      status: res.statusCode,
      headers: res.headers,
      payload: payload && typeof payload === 'object' ? payload : null,
      text
    };
  }

  _replyError(reply) {
    const payload = reply.payload;
    const error = payload
      ? new Error(`Clouddrop: ${payload.error || payload.message || `HTTP ${reply.status}`}`)
      : new Error(`Clouddrop: API-Antwort war kein JSON (HTTP ${reply.status}): ${reply.text.slice(0, 200)}`);
    error.status = reply.status;
    if (payload && typeof payload.code === 'string') error.code = payload.code;
    return error;
  }

  _retryBudget(signal) {
    let firstFailureAt = 0;
    let failures = 0;
    return async (error, minimumDelayMs = 0) => {
      if (signal && signal.aborted) throw error;
      const now = this.now();
      if (!firstFailureAt) firstFailureAt = now;
      if (now - firstFailureAt >= RETRY_WINDOW_MS) {
        error.transientNetwork = true;
        throw error;
      }
      const backoff = Math.min(RETRY_BASE_DELAY_MS * 2 ** failures, RETRY_MAX_DELAY_MS);
      failures += 1;
      await this.sleep(Math.max(backoff, minimumDelayMs), signal);
    };
  }

  /**
   * Upload a file. Returns { download_url, embed_url, file_code }.
   */
  async upload(filePath, progressCb, signal, throttle) {
    if (!this.apiKey) throw new Error('Clouddrop: API-Key fehlt');
    const fileName = path.basename(filePath);
    let fileSize = 0;
    try { fileSize = (await statUploadFile(filePath)).size; }
    catch { throw new Error(`Clouddrop: Datei nicht lesbar: ${fileName}`); }
    if (fileSize <= 0) throw new Error('Clouddrop: Datei ist leer');

    if (fileSize <= SIMPLE_UPLOAD_LIMIT) {
      return shareResult(await this._uploadSimple(filePath, fileName, fileSize, progressCb, signal, throttle));
    }
    const outcome = await this._uploadChunked(filePath, fileName, fileSize, progressCb, signal, throttle);
    return typeof outcome === 'string' ? shareResult(outcome) : outcome;
  }

  /**
   * Simple upload for files < 16 MB — single multipart POST.
   */
  async _uploadSimple(filePath, fileName, fileSize, progressCb, signal, throttle) {
    const boundary = '----FormBoundary' + crypto.randomBytes(16).toString('hex');
    const safeFileName = fileName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

    const preamble =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${safeFileName}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`;
    const epilogue = `\r\n--${boundary}--\r\n`;

    const preambleBuf = Buffer.from(preamble, 'utf-8');
    const epilogueBuf = Buffer.from(epilogue, 'utf-8');
    const totalSize = preambleBuf.length + fileSize + epilogueBuf.length;

    let bytesRead = 0;
    async function* generate() {
      yield preambleBuf;
      for await (const chunk of readUploadFile(filePath, signal)) {
        if (signal && signal.aborted) throw new Error('Aborted');
        if (throttle) await throttle.consume(chunk.length, signal);
        bytesRead += chunk.length;
        yield chunk;
        if (progressCb) progressCb(bytesRead, fileSize);
      }
      yield epilogueBuf;
    }

    const res = await request(`${API_BASE}/upload?mode=rename`, {
      method: 'POST',
      dispatcher: this.dispatcher,
      body: generate(),
      signal,
      headers: this._headers({
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(totalSize)
      }),
      headersTimeout: SIMPLE_UPLOAD_TIMEOUT,
      bodyTimeout: SIMPLE_UPLOAD_TIMEOUT
    });

    const payload = await this._parseJsonResponse(res);
    if (!payload.fileId) throw new Error(`Clouddrop: Keine fileId in Upload-Antwort`);
    return payload.fileId;
  }

  async _uploadChunked(filePath, fileName, fileSize, progressCb, signal, throttle) {
    for (let restarts = 0; ; restarts++) {
      const initPayload = await this._initSession(fileName, fileSize, restarts > 0, signal);
      if (!isExpressSession(initPayload)) {
        return this._uploadChunksToOvh(initPayload, filePath, fileSize, progressCb, signal, throttle);
      }
      try {
        return await this._uploadExpress(initPayload, filePath, fileSize, progressCb, signal, throttle);
      } catch (error) {
        if (!error || error.restartFile !== true || (signal && signal.aborted)) throw error;
        if (restarts >= MAX_FILE_RESTARTS) {
          error.transientNetwork = true;
          throw error;
        }
      }
    }
  }

  async _initSession(fileName, fileSize, forceNew, signal) {
    const body = { filename: fileName, size: fileSize, parentId: null, relayCapable: true };
    if (forceNew) body.forceNew = true;
    const initRes = await request(`${API_BASE}/upload/init`, {
      method: 'POST',
      dispatcher: this.dispatcher,
      signal,
      headers: this._headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
      headersTimeout: INIT_TIMEOUT,
      bodyTimeout: INIT_TIMEOUT
    });
    return this._parseJsonResponse(initRes);
  }

  /**
   * Chunked upload for files > 16 MB.
   * Flow: POST /upload/init → PUT /upload/:sessionId/chunk/:n (0-based) → POST /upload/:sessionId/complete
   */
  async _uploadChunksToOvh(initPayload, filePath, fileSize, progressCb, signal, throttle) {
    const sessionId = initPayload.sessionId;
    const chunkSize = initPayload.chunkSize || CHUNK_SIZE;
    const totalChunks = initPayload.totalChunks || Math.ceil(fileSize / chunkSize);
    if (!sessionId) throw new Error('Clouddrop: Keine sessionId von /upload/init');

    // 2. Read file and PUT chunks sequentially.
    // Reuse a single buffer for all chunks (only the last chunk may be smaller,
    // in which case we slice a view). Avoids 64× 16 MB allocations on a 1 GB
    // file — real GC pressure during busy uploads.
    const fh = await fs.promises.open(filePath, 'r');
    let bytesSent = 0;
    const reusableBuf = Buffer.allocUnsafe(chunkSize);
    try {
      for (let i = 0; i < totalChunks; i++) {
        if (signal && signal.aborted) throw new Error('Aborted');

        const offset = i * chunkSize;
        const remaining = fileSize - offset;
        const thisChunkSize = Math.min(chunkSize, remaining);
        await fh.read(reusableBuf, 0, thisChunkSize, offset);
        const body = thisChunkSize === chunkSize
          ? reusableBuf
          : reusableBuf.subarray(0, thisChunkSize);

        if (throttle) await throttle.consume(thisChunkSize, signal);

        const chunkRes = await request(`${CHUNK_UPLOAD_BASE}/upload/${sessionId}/chunk/${i}`, {
          method: 'PUT',
          dispatcher: this.dispatcher,
          signal,
          body,
          headers: this._headers({
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(thisChunkSize)
          }),
          headersTimeout: CHUNK_TIMEOUT,
          bodyTimeout: CHUNK_TIMEOUT
        });
        await this._parseJsonResponse(chunkRes);

        bytesSent += thisChunkSize;
        if (progressCb) progressCb(bytesSent, fileSize);
      }
    } finally {
      try { await fh.close(); } catch {}
    }

    // 3. Complete session — all bytes are already on the server at this point.
    // We MUST NOT throw here, otherwise the upload-manager would retry the entire
    // multi-GB upload. Any failure (timeout, non-JSON, missing fileId, server still
    // post-processing) is swallowed and we fall back to sessionId as file_code.
    try {
      const completeRes = await request(`${API_BASE}/upload/${sessionId}/complete`, {
        method: 'POST',
        dispatcher: this.dispatcher,
        signal,
        headers: this._headers({ 'Content-Type': 'application/json' }),
        body: '{}',
        headersTimeout: COMPLETE_TIMEOUT,
        bodyTimeout: COMPLETE_TIMEOUT
      });
      const completePayload = await this._parseJsonResponse(completeRes).catch(() => ({}));
      return completePayload.fileId || completePayload.id || sessionId;
    } catch {
      return sessionId;
    }
  }

  async _uploadExpress(initPayload, filePath, fileSize, progressCb, signal, throttle) {
    const sessionId = initPayload.sessionId;
    if (!sessionId) throw new Error('Clouddrop: Keine sessionId von /upload/init');
    const pending = this._pendingJob(initPayload.jobId || sessionId);
    if (initPayload.completed === true) return pending;

    const route = {
      sessionId,
      baseUrl: expressBaseUrl(initPayload.uploadBaseUrl),
      ticket: typeof initPayload.uploadTicket === 'string' ? initPayload.uploadTicket : ''
    };
    if (!route.ticket) await this._refreshTicket(route, signal);
    const chunkSize = initPayload.chunkSize || CHUNK_SIZE;
    const totalChunks = initPayload.totalChunks || Math.ceil(fileSize / chunkSize);

    const fh = await fs.promises.open(filePath, 'r');
    const buffer = Buffer.allocUnsafe(chunkSize);
    const readChunk = async (index) => {
      const length = Math.min(chunkSize, fileSize - index * chunkSize);
      await fh.read(buffer, 0, length, index * chunkSize);
      return buffer.subarray(0, length);
    };
    try {
      const fileHash = crypto.createHash('sha256');
      let bytesSent = 0;
      for (let index = 0; index < totalChunks; index++) {
        if (signal && signal.aborted) throw new Error('Aborted');
        const body = await readChunk(index);
        fileHash.update(body);
        if (await this._putExpressChunk(route, index, body, signal, throttle) === 'sealed') return pending;
        bytesSent += body.length;
        if (progressCb) progressCb(bytesSent, fileSize);
      }
      const clientSha256 = fileHash.digest('hex');
      for (let resends = 0; ; resends++) {
        const reply = await this._postComplete(sessionId, clientSha256, signal);
        if (reply.ok) return pending;
        const error = this._replyError(reply);
        const missing = reply.payload && Array.isArray(reply.payload.missing) ? reply.payload.missing : [];
        const resendable = error.code === 'EXPRESS_CHUNK_ACKS_INCOMPLETE'
          && missing.length > 0
          && missing.every(index => Number.isInteger(index) && index >= 0 && index < totalChunks);
        if (resendable && resends < MAX_MISSING_CHUNK_RESENDS) {
          for (const index of missing) {
            if (await this._putExpressChunk(route, index, await readChunk(index), signal, throttle) === 'sealed') return pending;
          }
          continue;
        }
        if (reply.status === 410 || RESTART_CODES.has(error.code)) throw markRestart(error);
        throw error;
      }
    } finally {
      try { await fh.close(); } catch {}
    }
  }

  async _putExpressChunk(route, index, body, signal, throttle) {
    const chunkSha256 = sha256Hex(body);
    const retry = this._retryBudget(signal);
    let ticketRefreshes = 0;
    for (;;) {
      if (throttle) await throttle.consume(body.length, signal);
      let reply;
      try {
        const res = await request(`${route.baseUrl}/upload/${route.sessionId}/chunk/${index}`, {
          method: 'PUT',
          dispatcher: this.dispatcher,
          signal,
          body,
          headers: {
            'Authorization': `Bearer ${route.ticket}`,
            'User-Agent': USER_AGENT,
            'Accept': 'application/json',
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(body.length),
            'X-Chunk-SHA256': chunkSha256
          },
          headersTimeout: CHUNK_TIMEOUT,
          bodyTimeout: CHUNK_TIMEOUT
        });
        reply = await this._readReply(res);
      } catch (error) {
        await retry(error);
        continue;
      }
      if (reply.ok) return 'stored';
      const error = this._replyError(reply);
      if (error.code === 'UPLOAD_SESSION_SEALED') return 'sealed';
      if (reply.status === 401 && TICKET_CODES.has(error.code)) {
        if (ticketRefreshes >= MAX_TICKET_REFRESHES) throw markRestart(error);
        ticketRefreshes += 1;
        await this._refreshTicket(route, signal);
        continue;
      }
      if (error.code === 'CHUNK_ALREADY_COMMITTED') {
        error.fileRejected = true;
        throw error;
      }
      if (reply.status === 410 || RESTART_CODES.has(error.code)) throw markRestart(error);
      if (RETRYABLE_STATUSES.has(reply.status) || RETRYABLE_CHUNK_CODES.has(error.code)) {
        await retry(error, retryAfterMs(reply.headers));
        continue;
      }
      error.transientNetwork = true;
      throw error;
    }
  }

  async _refreshTicket(route, signal) {
    const retry = this._retryBudget(signal);
    for (;;) {
      let reply;
      try {
        const res = await request(`${API_BASE}/upload/${route.sessionId}/status`, {
          method: 'GET',
          dispatcher: this.dispatcher,
          signal,
          headers: this._headers(),
          headersTimeout: STATUS_TIMEOUT,
          bodyTimeout: STATUS_TIMEOUT
        });
        reply = await this._readReply(res);
      } catch (error) {
        await retry(error);
        continue;
      }
      if (reply.ok && reply.payload) {
        const { uploadTicket, uploadBaseUrl } = reply.payload;
        if (typeof uploadTicket !== 'string' || uploadTicket === '') {
          throw markRestart(new Error('Clouddrop: Kein Express-Upload-Ticket erhalten'));
        }
        if (uploadBaseUrl) route.baseUrl = expressBaseUrl(uploadBaseUrl);
        route.ticket = uploadTicket;
        return;
      }
      const error = this._replyError(reply);
      if (reply.status === 404 || reply.status === 410 || RESTART_CODES.has(error.code)) throw markRestart(error);
      if (RETRYABLE_STATUSES.has(reply.status)) {
        await retry(error, retryAfterMs(reply.headers));
        continue;
      }
      throw error;
    }
  }

  async _postComplete(sessionId, clientSha256, signal) {
    const retry = this._retryBudget(signal);
    for (;;) {
      let reply;
      try {
        const res = await request(`${API_BASE}/upload/${sessionId}/complete`, {
          method: 'POST',
          dispatcher: this.dispatcher,
          signal,
          headers: this._headers({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ clientSha256 }),
          headersTimeout: COMPLETE_TIMEOUT,
          bodyTimeout: COMPLETE_TIMEOUT
        });
        reply = await this._readReply(res);
      } catch (error) {
        await retry(error);
        continue;
      }
      if (!RETRYABLE_STATUSES.has(reply.status)) return reply;
      await retry(this._replyError(reply), retryAfterMs(reply.headers));
    }
  }

  _pendingJob(jobId) {
    return { clouddropJob: { jobId, wait: (signal, onState) => this.waitForJob(jobId, signal, onState) } };
  }

  async waitForJob(jobId, signal, onState) {
    const startedAt = this.now();
    let interval = JOB_POLL_INTERVAL_MS;
    let failures = 0;
    for (;;) {
      let payload = null;
      try {
        const res = await request(`${API_BASE}/upload/jobs/${encodeURIComponent(jobId)}`, {
          method: 'GET',
          dispatcher: this.dispatcher,
          signal,
          headers: this._headers(),
          headersTimeout: JOB_POLL_TIMEOUT,
          bodyTimeout: JOB_POLL_TIMEOUT
        });
        const reply = await this._readReply(res);
        if (reply.ok) payload = reply.payload;
      } catch (error) {
        if (signal && signal.aborted) throw error;
      }
      let waitMs;
      if (payload) {
        const result = this._jobOutcome(payload);
        if (result) return result;
        if (onState) onState({ retrying: payload.retrying === true, phase: payload.relayPhase || payload.phase || null });
        failures = 0;
        waitMs = interval;
        interval = Math.min(Math.round(interval * 1.5), JOB_POLL_MAX_INTERVAL_MS);
      } else {
        failures += 1;
        waitMs = Math.min(JOB_POLL_INTERVAL_MS * 2 ** failures, JOB_POLL_ERROR_MAX_DELAY_MS);
      }
      const remaining = JOB_POLL_MAX_MS - (this.now() - startedAt);
      if (remaining <= 0) {
        const error = new Error('Status unklar: Upload nach 24 Stunden nicht abgeschlossen, Quelldatei bleibt erhalten');
        error.code = 'CLOUDDROP_JOB_UNCLEAR';
        throw error;
      }
      await this.sleep(Math.min(waitMs, remaining), signal);
    }
  }

  _jobOutcome(payload) {
    const status = payload.status;
    const terminal = typeof payload.terminal === 'boolean'
      ? payload.terminal
      : status === 'done' || status === 'failed';
    if (!terminal) return null;
    if (status === 'done') {
      const fileId = payload.result && typeof payload.result.fileId === 'string' ? payload.result.fileId : '';
      if (!fileId) throw new Error('Clouddrop: Keine fileId im Job-Ergebnis');
      return shareResult(fileId);
    }
    const reason = typeof payload.error === 'string' && payload.error ? payload.error : String(status || 'unknown');
    const error = new Error(`Clouddrop: Verarbeitung fehlgeschlagen (${reason})`);
    error.code = 'CLOUDDROP_JOB_FAILED';
    error.jobError = reason;
    error.expressReupload = EXPRESS_REUPLOAD_ERROR.test(reason);
    throw error;
  }

  /**
   * Lightweight auth check — GET /api/cloud/files (list root, small response).
   */
  async checkAuth(signal) {
    if (!this.apiKey) throw new Error('Clouddrop: API-Key fehlt');
    const res = await request(`${API_BASE}/files/?limit=1`, {
      method: 'GET',
      dispatcher: this.dispatcher,
      signal,
      headers: this._headers(),
      headersTimeout: 15_000,
      bodyTimeout: 15_000
    });
    await this._parseJsonResponse(res);
    return true;
  }
}

module.exports = ClouddropUploader;
