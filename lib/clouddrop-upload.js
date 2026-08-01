const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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

// Cap concurrent TCP connections to clouddrop.cc at 50 to stay well under
// the server's per-IP limit of 100 concurrent connections (cd_conn).
// Shared across all ClouddropUploader instances via module-level agent.
const clouddropAgent = new Agent({
  connections: 50,
  pipelining: 1,
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 60_000
});

/**
 * Clouddrop.cc uploader — uses API Key (Bearer) authentication.
 * Files > 16 MB use the chunked protocol, smaller files use simple upload.
 * After upload, a share link is created and returned as download_url.
 */
class ClouddropUploader {
  constructor(apiKey) {
    this.apiKey = String(apiKey || '').trim();
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

  /**
   * Upload a file. Returns { download_url, embed_url, file_code }.
   */
  async upload(filePath, progressCb, signal, throttle) {
    if (!this.apiKey) throw new Error('Clouddrop: API-Key fehlt');
    const fileName = path.basename(filePath);
    let fileSize = 0;
    try { fileSize = fs.statSync(filePath).size; }
    catch { throw new Error(`Clouddrop: Datei nicht lesbar: ${fileName}`); }
    if (fileSize <= 0) throw new Error('Clouddrop: Datei ist leer');

    let fileId;
    if (fileSize <= SIMPLE_UPLOAD_LIMIT) {
      fileId = await this._uploadSimple(filePath, fileName, fileSize, progressCb, signal, throttle);
    } else {
      fileId = await this._uploadChunked(filePath, fileName, fileSize, progressCb, signal, throttle);
    }

    return {
      download_url: `${BASE_URL}/share/${fileId}`,
      embed_url: null,
      file_code: fileId
    };
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
      const fileStream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
      for await (const chunk of fileStream) {
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
      dispatcher: clouddropAgent,
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

  /**
   * Chunked upload for files > 16 MB.
   * Flow: POST /upload/init → PUT /upload/:sessionId/chunk/:n (0-based) → POST /upload/:sessionId/complete
   */
  async _uploadChunked(filePath, fileName, fileSize, progressCb, signal, throttle) {
    // 1. Init session
    const initRes = await request(`${API_BASE}/upload/init`, {
      method: 'POST',
      dispatcher: clouddropAgent,
      signal,
      headers: this._headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ filename: fileName, size: fileSize, parentId: null }),
      headersTimeout: INIT_TIMEOUT,
      bodyTimeout: INIT_TIMEOUT
    });
    const initPayload = await this._parseJsonResponse(initRes);
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
          dispatcher: clouddropAgent,
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
        dispatcher: clouddropAgent,
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

  /**
   * Lightweight auth check — GET /api/cloud/files (list root, small response).
   */
  async checkAuth(signal) {
    if (!this.apiKey) throw new Error('Clouddrop: API-Key fehlt');
    const res = await request(`${API_BASE}/files/?limit=1`, {
      method: 'GET',
      dispatcher: clouddropAgent,
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
