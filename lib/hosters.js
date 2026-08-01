const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { request } = require('undici');

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

  return {
    download_url: item.download_url || item.protected_dl || null,
    embed_url: item.protected_embed || null,
    file_code: item.filecode || item.file_code || null
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
    const err = new Error(`Byse lehnte Datei ab: ${perFileError}`);
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

async function apiGet(url, signal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT);
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', onAbort);

  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'follow'
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      const err = new Error(`API-Antwort war kein JSON (HTTP ${res.status}): ${(text || '').slice(0, 200)}`);
      if (res.status >= 500) err.transientNetwork = true;
      throw err;
    }

    if (data.status && [401, 403, 429, 500].includes(data.status)) {
      const err = new Error(data.msg || data.message || JSON.stringify(data));
      if (data.status === 500) err.transientNetwork = true;
      throw err;
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

  for (let attempt = 1; attempt <= SERVER_RETRY_ATTEMPTS; attempt++) {
    for (const endpoint of hosterConfig.serverEndpoints) {
      const url = `${hosterConfig.apiBase}${endpoint}?key=${encodeURIComponent(apiKey)}`;
      try {
        const data = await apiGet(url, signal);
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
        if (err.message) lastMessage = err.message;
        if (err.transientNetwork === true) lastTransient = true;
      }
    }

    if (attempt < SERVER_RETRY_ATTEMPTS && shouldRetryServerLookup(lastMessage)) {
      await sleep(SERVER_RETRY_DELAY_MS, signal);
      continue;
    }

    break;
  }

  const cachedServer = LAST_UPLOAD_SERVERS.get(hosterName);
  if (cachedServer && shouldRetryServerLookup(lastMessage)) {
    return cachedServer;
  }

  if (shouldRetryServerLookup(lastMessage) && Array.isArray(hosterConfig.fallbackUploadServers)) {
    for (const fallback of hosterConfig.fallbackUploadServers) {
      const normalized = normalizeAbsoluteUrl(fallback, hosterConfig.apiBase);
      if (normalized) {
        LAST_UPLOAD_SERVERS.set(hosterName, normalized);
        return normalized;
      }
    }
  }

  if (lastMessage) {
    const e = new Error(`Kein Upload-Server erhalten: ${lastMessage}`);
    // "no servers available" / busy / try-again is a transient hoster-side
    // condition, not an account fault — tag it so the account isn't blacklisted.
    // Genuine auth failures (invalid key / unauthorized / forbidden) make
    // shouldRetryServerLookup return false and stay classified as account errors.
    if (shouldRetryServerLookup(lastMessage)) e.hosterTransient = true;
    if (lastTransient) e.transientNetwork = true;
    throw e;
  }
  throw new Error('Kein Upload-Server erhalten. API-Key pruefen.');
}

async function _fetchByseFileList(apiKey, signal) {
  // Byse's file-list endpoint. Returns up to 100 most-recent files — enough
  // to match the upload we just did against what the server has. The API
  // shape is typical XFS: { status, msg, result: { files: [...] } } or
  // { status, msg, files: [...] }.
  const url = `https://api.byse.sx/file/list?key=${encodeURIComponent(apiKey)}&per_page=100&sort=date&order=desc`;
  try {
    const { body, statusCode } = await request(url, {
      method: 'GET', signal,
      headers: { 'Accept': 'application/json', 'User-Agent': 'multi-hoster-uploader/1.1' },
      headersTimeout: 30_000, bodyTimeout: 30_000
    });
    const text = await body.text();
    if (statusCode < 200 || statusCode >= 300) return [];
    const data = JSON.parse(text);
    const src = Array.isArray(data.files) ? data.files
      : (data.result && Array.isArray(data.result.files) ? data.result.files
        : (Array.isArray(data.result) ? data.result : []));
    return src.map(f => ({
      file_code: String(f.file_code || f.filecode || '').trim(),
      file_name: String(f.title || f.name || f.file_name || '').trim()
    })).filter(f => f.file_code);
  } catch {
    return [];
  }
}

function _normalizeFileTitle(s) {
  return String(s || '').toLowerCase().replace(/\.[a-z0-9]+$/i, '').replace(/[^a-z0-9]+/g, '');
}

async function _resolveByseUploadByName(apiKey, fileName, baselineCodes, signal) {
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
    const match = newFiles.find(f => _normalizeFileTitle(f.file_name) === expected);
    if (match) {
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

async function _fetchDoodstreamFileList(apiKey, signal) {
  // doodapi.co file list: { msg, status:200, result: { files: [{ file_code, title, uploaded, ... }] } }
  // sort=created&order=desc forces newest-first — VERIFIED against a real 90k-file
  // account, where a single page without it could miss a just-uploaded file. The
  // recovery only needs the most recent uploads, so page 1 newest-first suffices.
  const url = `https://doodapi.co/api/file/list?key=${encodeURIComponent(apiKey)}&per_page=200&sort=created&order=desc`;
  try {
    const { body, statusCode } = await request(url, {
      method: 'GET', signal,
      headers: { 'Accept': 'application/json', 'User-Agent': 'multi-hoster-uploader/1.1' },
      headersTimeout: 30_000, bodyTimeout: 30_000
    });
    const text = await body.text();
    if (statusCode < 200 || statusCode >= 300) return [];
    const data = JSON.parse(text);
    const files = data && data.result && Array.isArray(data.result.files) ? data.result.files : [];
    return files.map(f => ({
      file_code: String(f.file_code || f.filecode || '').trim(),
      file_name: String(f.title || f.file_name || f.name || '').trim()
    })).filter(f => f.file_code);
  } catch {
    return [];
  }
}

const DOODSTREAM_POLL = { attempts: 12, delayMs: 2500 }; // test-tunable via __test

async function _resolveDoodstreamUploadByName(apiKey, fileName, baselineCodes, signal) {
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
    const match = fresh.find(f => _normalizeFileTitle(f.file_name) === expected);
    if (match) {
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
  if (hosterName === 'byse.sx') {
    if (opts && opts.byseBaseline instanceof Set) {
      byseBaseline = opts.byseBaseline;
    } else {
      const baseline = await _fetchByseFileList(apiKey, signal);
      byseBaseline = new Set(baseline.map(f => f.file_code));
    }
  }
  let doodBaseline = null;
  if (hosterName === 'doodstream.com') {
    if (opts && opts.doodBaseline instanceof Set) {
      doodBaseline = opts.doodBaseline;
    } else {
      const baseline = await _fetchDoodstreamFileList(apiKey, signal);
      doodBaseline = new Set(baseline.map(f => f.file_code));
    }
  }

  // Step 1: Get upload server
  const uploadUrl = await getUploadServer(hosterName, config, apiKey, signal);

  // Step 2: Upload file with progress
  const targetUrl = config.buildUploadUrl(uploadUrl, apiKey);
  const formFields = config.formFields(apiKey);

  const { iterable, boundary, totalSize } = createUploadBody(filePath, formFields, onProgress, throttle, signal);

  const { body, statusCode, headers } = await request(targetUrl, {
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

  const rawBody = await body.text();
  let payload = null;
  try {
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    const snippet = rawBody ? rawBody.slice(0, 240).replace(/\s+/g, ' ').trim() : '';
    const err = new Error(
      `Upload-Antwort von ${hosterName} war kein JSON (HTTP ${statusCode}${snippet ? `): ${snippet}` : ')'}`
    );
    if (statusCode >= 500) err.transientNetwork = true;
    throw err;
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
    const err = new Error(
      payload.msg
      || payload.message
      || `Upload fehlgeschlagen (HTTP ${statusCode}${headers?.['content-type'] ? `, ${headers['content-type']}` : ''})`
    );
    if (statusCode >= 500) err.transientNetwork = true;
    throw err;
  }

  if (payload.status && [401, 403, 429, 500].includes(payload.status)) {
    const err = new Error(payload.msg || payload.message || JSON.stringify(payload));
    if (payload.status === 500) err.transientNetwork = true;
    throw err;
  }

  let result = null;
  let parseErr = null;
  try {
    result = config.parseResult(payload);
  } catch (err) {
    if (err && typeof err === 'object' && !err.diagnostic) {
      try {
        err.diagnostic = {
          hoster: hosterName,
          http: statusCode,
          contentType: (headers && headers['content-type']) || null,
          payloadSnippet: JSON.stringify(payload).slice(0, 1000),
          uploadUrl: targetUrl
        };
      } catch { /* JSON cycle — skip diagnostic */ }
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

  if (parseErr) throw parseErr;

  if (payload.success === false) {
    throw new Error(payload.msg || payload.message || `Upload zu ${hosterName} wurde vom Server abgelehnt.`);
  }

  // Avoid throwing a bare "OK" / "SUCCESS" as the error message — that happens
  // when the server says "msg: OK" but ships no file_code anywhere we know
  // about, typically an API change. Surface the full (trimmed) payload so
  // future logs actually show what the server returned.
  const msg = String(payload.msg || payload.message || '').trim();
  const isOkishNoPayload = /^(ok|success|done|accepted)$/i.test(msg);
  if (isOkishNoPayload || !msg) {
    const snippet = JSON.stringify(payload).slice(0, 400);
    // 2xx with no filecode: the hoster accepted the upload (bytes sent, status
    // OK) but returned no usable link. For doodstream this is the API-path
    // analog of the web empty-form — the backend file-registration timing out
    // under large-file load. It's a hoster-side flake, NOT an account problem,
    // so tag it hosterTransient: the upload-manager then fails this file WITHOUT
    // blacklisting the account (same protection the web path got in 3.3.29) and
    // the account stays usable for the next retry/batch.
    const err = new Error(
      `Upload zu ${hosterName} lieferte keine file_code-Antwort (Payload: ${snippet})`
    );
    err.hosterTransient = true;
    throw err;
  }
  throw new Error(msg);
}

async function prefetchBaseline(hosterName, apiKey, signal) {
  try {
    if (hosterName === 'byse.sx') {
      const baseline = await _fetchByseFileList(apiKey, signal);
      return new Set(baseline.map(f => f.file_code));
    }
    if (hosterName === 'doodstream.com') {
      const baseline = await _fetchDoodstreamFileList(apiKey, signal);
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
