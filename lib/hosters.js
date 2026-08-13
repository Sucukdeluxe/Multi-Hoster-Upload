const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { request } = require('undici');
const { createTransportError, sanitizeRemoteText } = require('./hoster-transport-error');

const UPLOAD_TIMEOUT = 1800000; // 30 minutes
const API_TIMEOUT = 45000; // 45 seconds
const SERVER_RETRY_ATTEMPTS = 6;
const SERVER_RETRY_DELAY_MS = 2500;
const LAST_UPLOAD_SERVERS = new Map();

function appendRawQuery(url, rawQuery) {
  const parsed = new URL(url);
  const cleanQuery = String(rawQuery || '').trim().replace(/^\?+/, '');
  if (!cleanQuery) return parsed.toString();

  if (parsed.search && parsed.search.length > 1) {
    parsed.search = `${parsed.search.slice(1)}&${cleanQuery}`;
  } else {
    parsed.search = cleanQuery;
  }

  return parsed.toString();
}

function appendKeyParam(url, key) {
  const parsed = new URL(url);
  parsed.searchParams.set('key', key);
  return parsed.toString();
}

// Hoster definitions - based on official API docs
const HOSTER_CONFIGS = {
  'doodstream.com': {
    apiBase: 'https://doodapi.co',
    serverEndpoints: ['/api/upload/server'],
    // No hardcoded fallback node: that stale CDN host (tr1128ve.cloudatacdn.com)
    // accepts the bytes but returns an empty result form with no filecode, so a
    // failed server lookup must throw cleanly rather than upload ~1 GB into a
    // dead end. (Same reasoning as the web-session path's fail-fast.)
    buildUploadUrl: (url, key) => appendRawQuery(url, key),
    formFields: (key) => ({ api_key: key }),
    parseResult: parseDoodstreamResult
  },
  'voe.sx': {
    apiBase: 'https://voe.sx',
    serverEndpoints: ['/api/upload/server', '/api/v1/upload/server'],
    buildUploadUrl: (url, key) => appendKeyParam(url, key),
    formFields: () => ({}),
    parseResult: parseVoeResult
  },
  'byse.sx': {
    apiBase: 'https://api.byse.sx',
    serverEndpoints: ['/upload/server'],
    buildUploadUrl: (url, key) => appendKeyParam(url, key),
    formFields: (key) => ({ key }),
    parseResult: parseByseResult
  }
};

function normalizeAbsoluteUrl(raw, apiBase) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || /^\[object\s+Object\]$/i.test(trimmed)) return null;

  let candidate = trimmed;
  if (candidate.startsWith('//')) {
    candidate = `https:${candidate}`;
  } else if (candidate.startsWith('/')) {
    try {
      candidate = new URL(candidate, apiBase).href;
    } catch {
      return null;
    }
  } else if (!/^[a-z][a-z\d+.-]*:\/\//i.test(candidate)) {
    candidate = `https://${candidate.replace(/^\/+/, '')}`;
  }

  try {
    const parsed = new URL(candidate);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function collectUploadUrlCandidates(value, out = []) {
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }

  if (Array.isArray(value)) {
    for (const entry of value) collectUploadUrlCandidates(entry, out);
    return out;
  }

  if (value && typeof value === 'object') {
    const preferredKeys = ['upload_url', 'uploadUrl', 'url', 'server', 'srv', 'result'];
    for (const key of preferredKeys) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        collectUploadUrlCandidates(value[key], out);
      }
    }

    for (const nested of Object.values(value)) {
      if (typeof nested === 'string') out.push(nested);
    }
  }

  return out;
}

function extractUploadServerUrl(payload, apiBase) {
  const source = payload && Object.prototype.hasOwnProperty.call(payload, 'result')
    ? payload.result
    : payload;

  const candidates = collectUploadUrlCandidates(source, []);
  for (const candidate of candidates) {
    const normalized = normalizeAbsoluteUrl(candidate, apiBase);
    if (normalized) return normalized;
  }

  return null;
}

function shouldRetryServerLookup(message) {
  const msg = String(message || '').toLowerCase();
  if (!msg) return true;
  if (msg.includes('invalid') && msg.includes('key')) return false;
  if (msg.includes('unauthorized') || msg.includes('forbidden')) return false;
  if (msg.includes('no servers available')) return true;
  if (msg.includes('temporar') || msg.includes('busy') || msg.includes('try again')) return true;
  return true;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      const err = new Error('Aborted');
      err.name = 'AbortError';
      reject(err);
    }

    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort);
    }
  });
}

// --- Result parsers ---

// Doodstream: { result: [{ download_url, protected_embed, filecode, protected_dl }] }
function parseDoodstreamResult(payload) {
  let item = {};
  // Defensive: also handle direct callers that bypass uploadFile's payload
  // normalisation (e.g. unit tests, future callers).
  const result = payload && payload.result;
  if (Array.isArray(result) && result.length > 0) {
    item = result[0];
  } else if (result && typeof result === 'object') {
    item = result;
  }

  const fileCode = item.filecode || item.file_code || null;
  return {
    download_url: fileCode ? `https://doodstream.com/d/${fileCode}` : null,
    embed_url: fileCode ? `https://doodstream.com/e/${fileCode}` : null,
    file_code: fileCode
  };
}

// VOE: { file: { file_code } }
function parseVoeResult(payload) {
  const source = payload && typeof payload === 'object' && payload.result && typeof payload.result === 'object'
    ? payload.result
    : payload;
  const file = source && typeof source.file === 'object' ? source.file : null;
  const file_code = file?.file_code
    || file?.filecode
    || source?.file_code
    || source?.filecode
    || null;

  return {
    download_url: file_code ? `https://voe.sx/${file_code}` : null,
    embed_url: file_code ? `https://voe.sx/e/${file_code}` : null,
    file_code
  };
}

// Byse: { files: [{ filecode, filename, status }] }
function parseByseResult(payload) {
  // Defensive: bypass-callers may pass null/non-object directly.
  if (!payload || typeof payload !== 'object') payload = {};
  let file_code = null;
  let perFileError = null;

  // Primary: files array (per official Byse API docs)
  if (Array.isArray(payload.files) && payload.files.length > 0) {
    const f = payload.files[0];
    file_code = f && (f.filecode || f.file_code) || null;
    // Byse returns HTTP 200 + msg=OK even when a specific file was rejected
    // ("Not video file format", "Duplicate", "File too small", ...). When
    // filecode is empty and status carries a non-OK message, that IS the
    // actual per-file error, not a server problem.
    if (!file_code && f && f.status && !/^(ok|success|done)$/i.test(String(f.status))) {
      perFileError = String(f.status).trim();
    }
  }
  // Fallback: result object
  if (!file_code && payload.result) {
    const result = payload.result;
    if (Array.isArray(result) && result.length > 0) {
      file_code = result[0].filecode || result[0].file_code;
    } else if (typeof result === 'object') {
      file_code = result.filecode || result.file_code;
    }
  }

  if (!file_code && perFileError) {
    // Distinguish account-level from file-level failure. "not enough disk
    // space", "quota exceeded", "storage full" etc. mean the ACCOUNT is
    // exhausted — every further file on the same account will hit the same
    // wall, so we must rotate. File-specific rejections (Duplicate, wrong
    // format, too small/large) ARE per-file and rotation is pointless.
    const accountLevel = /(not enough (disk )?(space|storage)|insufficient (disk )?space|disk (space )?full|storage (exhausted|full|voll|limit)|quota (exceeded|voll|überschritten)|account (full|voll|suspended|banned))/i.test(perFileError);
    const err = new Error(`Byse lehnte Datei ab: ${sanitizeRemoteText(perFileError)}`);
    if (accountLevel) {
      err.accountError = true;
    } else {
      err.fileRejected = true;
      // "Not video file format" is byse's known-misleading status: observed
      // live (2026-06-09) ONLY on valid MKVs >2.7 GB while the same account
      // accepted 1100+ smaller MKVs. Per-account size tiers produce it, and
      // async registration can land the file anyway. Flag it suspect so the
      // recovery poll still runs and the upload manager may try the file on
      // the remaining accounts instead of failing it everywhere.
      if (/not video file format/i.test(perFileError)) err.suspectReject = true;
    }
    throw err;
  }

  return {
    download_url: file_code ? `https://byse.sx/d/${file_code}` : null,
    embed_url: file_code ? `https://byse.sx/e/${file_code}` : null,
    file_code
  };
}

// --- Multipart upload with progress ---

function buildMultipart(filePath, formFields) {
  const boundary = '----FormBoundary' + crypto.randomBytes(16).toString('hex');
  const fileName = path.basename(filePath);
  const fileSize = fs.statSync(filePath).size;

  let preamble = '';
  for (const [key, value] of Object.entries(formFields)) {
    preamble += `--${boundary}\r\n`;
    preamble += `Content-Disposition: form-data; name="${key}"\r\n\r\n`;
    preamble += `${value}\r\n`;
  }
  preamble += `--${boundary}\r\n`;
  const safeFileName = fileName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  preamble += `Content-Disposition: form-data; name="file"; filename="${safeFileName}"\r\n`;
  preamble += `Content-Type: application/octet-stream\r\n\r\n`;

  const epilogue = `\r\n--${boundary}--\r\n`;

  const preambleBuf = Buffer.from(preamble, 'utf-8');
  const epilogueBuf = Buffer.from(epilogue, 'utf-8');
  const totalSize = preambleBuf.length + fileSize + epilogueBuf.length;

  return { boundary, preambleBuf, epilogueBuf, totalSize, fileSize };
}

function createUploadBody(filePath, formFields, onProgress, throttle, signal) {
  const { boundary, preambleBuf, epilogueBuf, totalSize, fileSize } = buildMultipart(filePath, formFields);

  let bytesRead = 0;
  const CHUNK_SIZE = 1024 * 1024;

  async function* generate() {
    yield preambleBuf;
    const fileStream = fs.createReadStream(filePath, { highWaterMark: CHUNK_SIZE });
    for await (const chunk of fileStream) {
      if (signal && signal.aborted) throw new Error('Aborted');
      if (throttle) await throttle.consume(chunk.length, signal);
      bytesRead += chunk.length;
      yield chunk;
      if (onProgress) onProgress(bytesRead, fileSize);
    }
    yield epilogueBuf;
  }

  return { iterable: generate(), boundary, totalSize };
}

// --- API helper using built-in fetch (follows redirects automatically) ---

async function apiGet(url, signal, hosterName) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT);
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', onAbort);

  try {
    let res;
    try {
      res = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        redirect: 'follow'
      });
    } catch (err) {
      if (signal && signal.aborted) throw err;
      throw createTransportError(`${hosterName}: Upload-Server-Abfrage fehlgeschlagen`, {
        phase: 'upload-server',
        endpoint: url,
        retryable: true,
        transientNetwork: true
      });
    }
    const text = await res.text();
    const contentType = res.headers && typeof res.headers.get === 'function'
      ? res.headers.get('content-type')
      : null;
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw createTransportError(`${hosterName}: Upload-Server-Antwort war kein JSON`, {
        phase: 'upload-server',
        endpoint: url,
        httpStatus: res.status,
        contentType,
        body: text,
        retryable: res.status >= 500,
        transientNetwork: res.status >= 500
      });
    }

    const apiStatus = Number(data && data.status);
    const effectiveStatus = res.status < 200 || res.status >= 300
      ? res.status
      : (apiStatus >= 400 ? apiStatus : null);
    if (effectiveStatus) {
      const retryable = effectiveStatus === 429 || effectiveStatus >= 500;
      throw createTransportError(`${hosterName}: Upload-Server-Abfrage wurde abgelehnt`, {
        phase: 'upload-server',
        endpoint: url,
        httpStatus: effectiveStatus,
        contentType,
        body: text,
        retryable,
        transientNetwork: effectiveStatus >= 500,
        accountError: effectiveStatus === 401 || effectiveStatus === 403
      });
    }
    return data;
  } finally {
    clearTimeout(timeout);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

// --- Main upload function ---

async function getUploadServer(hosterName, hosterConfig, apiKey, signal) {
  let lastMessage = '';
  let lastTransient = false;
  let lastError = null;

  for (let attempt = 1; attempt <= SERVER_RETRY_ATTEMPTS; attempt++) {
    for (const endpoint of hosterConfig.serverEndpoints) {
      const url = `${hosterConfig.apiBase}${endpoint}?key=${encodeURIComponent(apiKey)}`;
      try {
        const data = await apiGet(url, signal, hosterName);
        lastError = null;
        const uploadUrl = extractUploadServerUrl(data, hosterConfig.apiBase);
        if (uploadUrl) {
          LAST_UPLOAD_SERVERS.set(hosterName, uploadUrl);
          return uploadUrl;
        }

        const apiMessage = data && (data.msg || data.message)
          ? String(data.msg || data.message).trim()
          : '';
        if (apiMessage) lastMessage = apiMessage;
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        lastError = err;
        if (err.message) lastMessage = err.message;
        if (err.transientNetwork === true) lastTransient = true;
      }
    }

    const retryable = lastError && lastError.diagnostic
      ? lastError.diagnostic.retryable === true
      : shouldRetryServerLookup(lastMessage);
    if (attempt < SERVER_RETRY_ATTEMPTS && retryable) {
      await sleep(SERVER_RETRY_DELAY_MS, signal);
      continue;
    }

    break;
  }

  const cachedServer = LAST_UPLOAD_SERVERS.get(hosterName);
  const retryable = lastError && lastError.diagnostic
    ? lastError.diagnostic.retryable === true
    : shouldRetryServerLookup(lastMessage);
  if (cachedServer && retryable) {
    return cachedServer;
  }

  if (retryable && Array.isArray(hosterConfig.fallbackUploadServers)) {
    for (const fallback of hosterConfig.fallbackUploadServers) {
      const normalized = normalizeAbsoluteUrl(fallback, hosterConfig.apiBase);
      if (normalized) {
        LAST_UPLOAD_SERVERS.set(hosterName, normalized);
        return normalized;
      }
    }
  }

  if (lastMessage) {
    const e = lastError || createTransportError(`Kein Upload-Server für ${hosterName} erhalten`, {
      phase: 'upload-server',
      endpoint: hosterConfig.apiBase,
      retryable
    });
    if (retryable) e.hosterTransient = true;
    if (lastTransient) e.transientNetwork = true;
    throw e;
  }
  throw createTransportError(`Kein Upload-Server für ${hosterName} erhalten`, {
    phase: 'upload-server',
    endpoint: hosterConfig.apiBase
  });
}

async function _requestFileList(url, signal, phase, hosterName) {
  let response;
  try {
    response = await request(url, {
      method: 'GET', signal,
      headers: { 'Accept': 'application/json', 'User-Agent': 'multi-hoster-uploader/1.1' },
      headersTimeout: 30_000, bodyTimeout: 30_000
    });
  } catch (err) {
    if (signal && signal.aborted) throw err;
    throw createTransportError(`${hosterName}: Dateiliste konnte nicht geladen werden`, {
      phase,
      endpoint: url,
      retryable: true,
      transientNetwork: true
    });
  }

  const contentType = response.headers && response.headers['content-type'];
  let text;
  try {
    text = await response.body.text();
  } catch (err) {
    if (signal && signal.aborted) throw err;
    throw createTransportError(`${hosterName}: Dateiliste konnte nicht gelesen werden`, {
      phase,
      endpoint: url,
      httpStatus: response.statusCode,
      contentType,
      retryable: true,
      transientNetwork: true
    });
  }

  if (response.statusCode < 200 || response.statusCode >= 300) {
    const retryable = response.statusCode === 429 || response.statusCode >= 500;
    throw createTransportError(`${hosterName}: Dateiliste konnte nicht geladen werden`, {
      phase,
      endpoint: url,
      httpStatus: response.statusCode,
      contentType,
      body: text,
      retryable,
      transientNetwork: response.statusCode >= 500
    });
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw createTransportError(`${hosterName}: Dateiliste war kein JSON`, {
      phase,
      endpoint: url,
      httpStatus: response.statusCode,
      contentType,
      body: text
    });
  }

  if (!data || typeof data !== 'object') {
    throw createTransportError(`${hosterName}: Dateiliste hatte ein ungültiges Format`, {
      phase,
      endpoint: url,
      httpStatus: response.statusCode,
      contentType,
      body: text
    });
  }

  const apiStatus = Number(data && data.status);
  if (apiStatus >= 400) {
    const retryable = apiStatus === 429 || apiStatus >= 500;
    throw createTransportError(`${hosterName}: Dateiliste wurde abgelehnt`, {
      phase,
      endpoint: url,
      httpStatus: apiStatus,
      contentType,
      body: text,
      retryable,
      transientNetwork: apiStatus >= 500
    });
  }

  return data;
}

async function _fetchByseFileList(apiKey, signal, phase = 'recovery-poll') {
  // Byse's file-list endpoint. Returns up to 100 most-recent files — enough
  // to match the upload we just did against what the server has. The API
  // shape is typical XFS: { status, msg, result: { files: [...] } } or
  // { status, msg, files: [...] }.
  const url = `https://api.byse.sx/file/list?key=${encodeURIComponent(apiKey)}&per_page=100&sort=date&order=desc`;
  const data = await _requestFileList(url, signal, phase, 'Byse');
  const src = Array.isArray(data.files) ? data.files
    : (data.result && Array.isArray(data.result.files) ? data.result.files
      : (Array.isArray(data.result) ? data.result : []));
  return src.map(f => ({
    file_code: String(f.file_code || f.filecode || '').trim(),
    file_name: String(f.title || f.name || f.file_name || '').trim()
  })).filter(f => f.file_code);
}

function _normalizeFileTitle(s) {
  return String(s || '').toLowerCase().replace(/\.[a-z0-9]+$/i, '').replace(/[^a-z0-9]+/g, '');
}

async function _resolveByseUploadByName(apiKey, fileName, baselineCodes, signal) {
  if (!(baselineCodes instanceof Set)) return null;
  const expected = _normalizeFileTitle(fileName);
  const POLL_ATTEMPTS = 15;
  const POLL_DELAY_MS = 2000;
  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    if (signal && signal.aborted) return null;
    const list = await _fetchByseFileList(apiKey, signal);
    const newFiles = list.filter(f => !baselineCodes.has(f.file_code));
    // Exact-normalized filename match ONLY. The old fallback ("only one new
    // file → take it") was unsafe during parallel byse uploads: job A's
    // poller could claim job B's newly appeared file and return the wrong
    // URL. At the cost of a few false-negatives when byse mangles the
    // filename beyond our normalizer, correctness for parallel uploads wins.
    const matches = newFiles.filter(f => _normalizeFileTitle(f.file_name) === expected);
    if (matches.length > 1) return null;
    if (matches.length === 1) {
      const match = matches[0];
      return {
        download_url: `https://byse.sx/d/${match.file_code}`,
        embed_url: `https://byse.sx/e/${match.file_code}`,
        file_code: match.file_code
      };
    }
    if (i < POLL_ATTEMPTS - 1) {
      try {
        await sleep(POLL_DELAY_MS, signal);
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function _fetchDoodstreamFileList(apiKey, signal, phase = 'recovery-poll') {
  // doodapi.co file list: { msg, status:200, result: { files: [{ file_code, title, uploaded, ... }] } }
  // sort=created&order=desc forces newest-first — VERIFIED against a real 90k-file
  // account, where a single page without it could miss a just-uploaded file. The
  // recovery only needs the most recent uploads, so page 1 newest-first suffices.
  const url = `https://doodapi.co/api/file/list?key=${encodeURIComponent(apiKey)}&per_page=200&sort=created&order=desc`;
  const data = await _requestFileList(url, signal, phase, 'Doodstream');
  const files = data && data.result && Array.isArray(data.result.files) ? data.result.files : [];
  return files.map(f => ({
    file_code: String(f.file_code || f.filecode || '').trim(),
    file_name: String(f.title || f.file_name || f.name || '').trim()
  })).filter(f => f.file_code);
}

const DOODSTREAM_POLL = { attempts: 12, delayMs: 2500 }; // test-tunable via __test

async function _resolveDoodstreamUploadByName(apiKey, fileName, baselineCodes, signal) {
  if (!(baselineCodes instanceof Set)) return null;
  // Same recovery byse uses: the upload POST returned no filecode, but the file
  // may register in the account a little later. Poll the list for a NEW file
  // whose normalized title matches what we uploaded. Exact-name match only
  // (never "take the only new one") so parallel doodstream uploads can't claim
  // each other's files.
  const expected = _normalizeFileTitle(fileName);
  const POLL_ATTEMPTS = DOODSTREAM_POLL.attempts;
  const POLL_DELAY_MS = DOODSTREAM_POLL.delayMs;
  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    if (signal && signal.aborted) return null;
    const list = await _fetchDoodstreamFileList(apiKey, signal);
    const fresh = list.filter(f => !baselineCodes.has(f.file_code));
    const matches = fresh.filter(f => _normalizeFileTitle(f.file_name) === expected);
    if (matches.length > 1) return null;
    if (matches.length === 1) {
      const match = matches[0];
      return {
        download_url: `https://doodstream.com/d/${match.file_code}`,
        embed_url: `https://doodstream.com/e/${match.file_code}`,
        file_code: match.file_code
      };
    }
    if (i < POLL_ATTEMPTS - 1) {
      try {
        await sleep(POLL_DELAY_MS, signal);
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function uploadFile(hosterName, filePath, apiKey, onProgress, signal, throttle, opts) {
  const config = HOSTER_CONFIGS[hosterName];
  if (!config) throw new Error(`Unbekannter Hoster: ${hosterName}`);

  let byseBaseline = null;
  let byseBaselineError = null;
  if (hosterName === 'byse.sx') {
    if (opts && opts.byseBaseline instanceof Set) {
      byseBaseline = opts.byseBaseline;
    } else {
      try {
        const baseline = await _fetchByseFileList(apiKey, signal, 'recovery-baseline');
        byseBaseline = new Set(baseline.map(f => f.file_code));
      } catch (err) {
        if (signal && signal.aborted) throw err;
        byseBaselineError = err;
      }
    }
  }
  let doodBaseline = null;
  let doodBaselineError = null;
  if (hosterName === 'doodstream.com') {
    if (opts && opts.doodBaseline instanceof Set) {
      doodBaseline = opts.doodBaseline;
    } else {
      try {
        const baseline = await _fetchDoodstreamFileList(apiKey, signal, 'recovery-baseline');
        doodBaseline = new Set(baseline.map(f => f.file_code));
      } catch (err) {
        if (signal && signal.aborted) throw err;
        doodBaselineError = err;
      }
    }
  }

  // Step 1: Get upload server
  const uploadUrl = await getUploadServer(hosterName, config, apiKey, signal);

  // Step 2: Upload file with progress
  const targetUrl = config.buildUploadUrl(uploadUrl, apiKey);
  const formFields = config.formFields(apiKey);

  const { iterable, boundary, totalSize } = createUploadBody(filePath, formFields, onProgress, throttle, signal);

  let uploadResponse;
  try {
    uploadResponse = await request(targetUrl, {
      method: 'POST',
      body: iterable,
      signal,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(totalSize),
        'Accept': 'application/json, text/plain;q=0.9, */*;q=0.8',
        'User-Agent': 'multi-hoster-uploader/1.1'
      },
      headersTimeout: UPLOAD_TIMEOUT,
      bodyTimeout: UPLOAD_TIMEOUT
    });
  } catch (err) {
    if (signal && signal.aborted) throw err;
    throw createTransportError(`Upload zu ${hosterName} konnte nicht übertragen werden`, {
      phase: 'upload-request',
      endpoint: targetUrl,
      retryable: true,
      transientNetwork: true
    });
  }

  const { body, statusCode, headers } = uploadResponse;

  const rawBody = await body.text();
  let payload = null;
  try {
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    throw createTransportError(`Upload-Antwort von ${hosterName} war kein JSON`, {
      phase: 'upload-response',
      endpoint: targetUrl,
      httpStatus: statusCode,
      contentType: headers && headers['content-type'],
      body: rawBody,
      retryable: statusCode >= 500,
      transientNetwork: statusCode >= 500
    });
  }
  // Normalize valid-but-not-object JSON (JSON.parse('null') → null;
  // JSON.parse('"foo"') → string; JSON.parse('[1]') → array). Without this
  // the downstream `payload.msg` / `payload.status` / parseResult(payload)
  // calls crash with a confusing TypeError instead of letting the existing
  // fallback defaults kick in. Arrays from servers that return a top-level
  // list (rare but seen in the wild) are kept addressable as `payload.X`
  // → undefined, which the parsers already handle.
  if (payload === null || typeof payload !== 'object') {
    payload = {};
  }

  if (statusCode < 200 || statusCode >= 300) {
    throw createTransportError(`Upload zu ${hosterName} fehlgeschlagen`, {
      phase: 'upload-response',
      endpoint: targetUrl,
      httpStatus: statusCode,
      contentType: headers && headers['content-type'],
      body: rawBody,
      retryable: statusCode === 429 || statusCode >= 500,
      transientNetwork: statusCode >= 500
    });
  }

  if (payload.status && [401, 403, 429, 500].includes(payload.status)) {
    throw createTransportError(`Upload zu ${hosterName} wurde abgelehnt`, {
      phase: 'upload-response',
      endpoint: targetUrl,
      httpStatus: Number(payload.status),
      contentType: headers && headers['content-type'],
      body: rawBody,
      retryable: Number(payload.status) === 429 || Number(payload.status) >= 500,
      transientNetwork: Number(payload.status) >= 500
    });
  }

  let result = null;
  let parseErr = null;
  try {
    result = config.parseResult(payload);
  } catch (err) {
    if (err && typeof err === 'object' && !err.diagnostic) {
      err.diagnostic = createTransportError(`Upload zu ${hosterName} konnte nicht ausgewertet werden`, {
        phase: 'upload-result',
        endpoint: targetUrl,
        httpStatus: statusCode,
        contentType: headers && headers['content-type'],
        body: rawBody
      }).diagnostic;
    }
    parseErr = err;
  }
  if (result && (result.file_code || result.download_url || result.embed_url)) {
    return result;
  }

  // Explicit rejections skip the recovery poll — EXCEPT suspect ones
  // (byse "Not video file format", see parseByseResult): for those the file
  // may have registered asynchronously despite the rejection-looking status,
  // so the poll must still run. Without this exception the rescue below is
  // dead for the very case it documents (regression shipped in 3.3.5x).
  // When the caller's file probe positively says the upload is NOT a video
  // (opts.probeIsVideoLike === false), the rejection is genuine — skip the
  // 30s poll for it like any other explicit rejection.
  const suspectBypass = parseErr
    && parseErr.suspectReject === true
    && !(opts && opts.probeIsVideoLike === false);
  const explicitlyRejected = parseErr
    && (parseErr.fileRejected === true || parseErr.accountError === true)
    && !suspectBypass;

  // Byse-specific async handling: server accepts the file but responds with
  // filecode="" + misleading status ("Not video file format"). The file shows
  // up in the account shortly after — poll the list to claim it. User observed
  // this with 2+ GB MKV uploads that appeared as "OK" on the byse dashboard
  // even after our uploader gave up.
  if (hosterName === 'byse.sx' && byseBaseline && !explicitlyRejected) {
    const fileName = path.basename(filePath);
    const polled = await _resolveByseUploadByName(apiKey, fileName, byseBaseline, signal);
    if (polled) return polled;
  }

  // Doodstream: the doodapi upload POST returned no filecode (the same backend
  // hiccup that empties the web form). Poll the account file list by name — if
  // the file did register, claim its code instead of failing the upload.
  if (hosterName === 'doodstream.com' && doodBaseline && !explicitlyRejected) {
    const fileName = path.basename(filePath);
    const polled = await _resolveDoodstreamUploadByName(apiKey, fileName, doodBaseline, signal);
    if (polled) return polled;
  }

  if (hosterName === 'byse.sx' && byseBaselineError && !explicitlyRejected) {
    byseBaselineError.hosterTransient = true;
    throw byseBaselineError;
  }

  if (hosterName === 'doodstream.com' && doodBaselineError && !explicitlyRejected) {
    doodBaselineError.hosterTransient = true;
    throw doodBaselineError;
  }

  if (parseErr) throw parseErr;

  if (payload.success === false) {
    throw createTransportError(`Upload zu ${hosterName} wurde vom Server abgelehnt`, {
      phase: 'upload-result',
      endpoint: targetUrl,
      httpStatus: statusCode,
      contentType: headers && headers['content-type'],
      body: rawBody
    });
  }

  // Avoid throwing a bare "OK" / "SUCCESS" as the error message — that happens
  // when the server says "msg: OK" but ships no file_code anywhere we know
  // about, typically an API change. Surface safe structured response metadata
  // so future logs show what kind of response the server returned.
  const msg = String(payload.msg || payload.message || '').trim();
  const isOkishNoPayload = /^(ok|success|done|accepted)$/i.test(msg);
  if (isOkishNoPayload || !msg) {
    // 2xx with no filecode: the hoster accepted the upload (bytes sent, status
    // OK) but returned no usable link. For doodstream this is the API-path
    // analog of the web empty-form — the backend file-registration timing out
    // under large-file load. It's a hoster-side flake, NOT an account problem,
    // so tag it hosterTransient: the upload-manager then fails this file WITHOUT
    // blacklisting the account (same protection the web path got in 3.3.29) and
    // the account stays usable for the next retry/batch.
    throw createTransportError(`Upload zu ${hosterName} lieferte keine file_code-Antwort`, {
      phase: 'upload-result',
      endpoint: targetUrl,
      httpStatus: statusCode,
      contentType: headers && headers['content-type'],
      body: rawBody,
      retryable: true,
      hosterTransient: true
    });
  }
  throw createTransportError(`Upload zu ${hosterName} wurde abgelehnt`, {
    phase: 'upload-result',
    endpoint: targetUrl,
    httpStatus: statusCode,
    contentType: headers && headers['content-type'],
    body: rawBody
  });
}

async function prefetchBaseline(hosterName, apiKey, signal) {
  try {
    if (hosterName === 'byse.sx') {
      const baseline = await _fetchByseFileList(apiKey, signal, 'recovery-baseline');
      return new Set(baseline.map(f => f.file_code));
    }
    if (hosterName === 'doodstream.com') {
      const baseline = await _fetchDoodstreamFileList(apiKey, signal, 'recovery-baseline');
      return new Set(baseline.map(f => f.file_code));
    }
  } catch { /* leave caller to fall back to per-job fetch */ }
  return null;
}

module.exports = {
  uploadFile,
  prefetchBaseline,
  HOSTER_CONFIGS,
  __test: {
    extractUploadServerUrl,
    parseVoeResult,
    parseDoodstreamResult,
    parseByseResult,
    DOODSTREAM_POLL
  }
};
