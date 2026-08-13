const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { request } = require('undici');
const {
  createTransportError,
  safeEndpoint,
  sanitizeRemoteText,
  summarizeResponse
} = require('./hoster-transport-error');

const BASE_URL = 'https://doodstream.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const UPLOAD_TIMEOUT = 1800000; // 30 min

// Cap doodstream's per-hoster debug log alongside the main log files so
// dev-mode sessions don't accumulate gigabytes of upload trace.
const { maybeRotateLogFile } = require('./log-rotation');
const _DOODSTREAM_LOG_MAX_BYTES = 10 * 1024 * 1024;
const _DOODSTREAM_LOG_MAX_BACKUPS = 1;

// Resolve the log path at write-time. In a packaged build __dirname lives
// inside app.asar (read-only) — writing there fails silently and we lose every
// production trace. Prefer Electron's writable userData dir, fall back to the
// repo root only when running outside Electron (tests / plain node).
function _doodstreamLogPath() {
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      return path.join(app.getPath('userData'), 'doodstream-debug.log');
    }
  } catch { /* not running under Electron */ }
  return path.join(__dirname, '..', 'doodstream-debug.log');
}

let _debugVerbose = false;
function setDebugVerbose(v) { _debugVerbose = !!v; }

function _debugLog(msg) {
  if (!_debugVerbose) return;
  try {
    const logPath = _doodstreamLogPath();
    maybeRotateLogFile(logPath, _DOODSTREAM_LOG_MAX_BYTES, _DOODSTREAM_LOG_MAX_BACKUPS);
    const ts = new Date().toISOString();
    fs.appendFileSync(logPath, `[${ts}] ${msg}\n`);
  } catch {}
}

class DoodstreamUploader {
  constructor() {
    this.cookies = new Map();
    this.sessId = '';
    this.apiKey = ''; // optionally derived from the logged-in session (deriveApiKey)
  }

  _cookieHeader() {
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  _parseCookiesFromHeaders(headers) {
    let setCookies;
    if (typeof headers.getSetCookie === 'function') {
      setCookies = headers.getSetCookie();
    } else if (headers['set-cookie']) {
      setCookies = Array.isArray(headers['set-cookie']) ? headers['set-cookie'] : [headers['set-cookie']];
    } else {
      return;
    }
    for (const raw of setCookies) {
      const pair = raw.split(';')[0];
      const eq = pair.indexOf('=');
      if (eq > 0) {
        this.cookies.set(pair.substring(0, eq).trim(), pair.substring(eq + 1).trim());
      }
    }
  }

  async _fetch(url, opts = {}, _redirectCount = 0) {
    const MAX_REDIRECTS = 10;
    const headers = {
      'User-Agent': USER_AGENT,
      ...(opts.headers || {})
    };
    if (this.cookies.size > 0) {
      headers['Cookie'] = this._cookieHeader();
    }

    // The small discovery/result requests that bookend a multi-minute upload
    // occasionally hit a transient blip ("fetch failed", ECONNRESET, a hung TLS
    // handshake). A blip here shouldn't throw away the whole upload, so retry a
    // few times with short backoff. Each attempt gets its own 20s timeout —
    // Node's fetch has none by default, and a hung socket would otherwise stall
    // the attempt for minutes. The big file upload (undici) is retried at the
    // upload-manager level, not here.
    let res;
    for (let attempt = 1; ; attempt++) {
      const timeoutSignal = AbortSignal.timeout(20000);
      const signal = opts.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal;
      try {
        res = await fetch(url, { ...opts, headers, redirect: 'manual', signal });
        break;
      } catch (err) {
        if (opts.signal && opts.signal.aborted) throw err; // caller abort: don't retry
        if (attempt >= 3) {
          throw createTransportError('Doodstream: Webanfrage fehlgeschlagen', {
            phase: 'web-request',
            endpoint: url,
            retryable: true,
            transientNetwork: true
          });
        }
        _debugLog(`_fetch transient (${attempt}/3) ${safeEndpoint(url) || 'unknown endpoint'}: ${err && err.name ? err.name : 'network error'}; retry`);
        await new Promise(r => setTimeout(r, 400 * attempt));
      }
    }

    this._parseCookiesFromHeaders(res.headers);

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      try { await res.text(); } catch {}
      if (_redirectCount >= MAX_REDIRECTS) throw new Error('Zu viele Redirects');
      const location = res.headers.get('location');
      if (location) {
        const nextUrl = new URL(location, url).href;
        return this._fetch(nextUrl, { ...opts, method: 'GET', body: undefined }, _redirectCount + 1);
      }
    }

    return res;
  }

  /**
   * Login to DoodStream via web form
   */
  async login(username, password, otp) {
    // GET homepage first to collect cookies
    const homeRes = await this._fetch(BASE_URL);
    await homeRes.text();

    // POST login via AJAX (op in body, XHR header required for JSON response)
    const loginData = new URLSearchParams({
      op: 'login_ajax',
      login: username,
      password: password,
      loginotp: otp || ''
    });

    // Use raw fetch with redirect: 'manual' to detect success redirects
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': BASE_URL + '/',
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent': USER_AGENT
    };
    if (this.cookies.size > 0) {
      headers['Cookie'] = this._cookieHeader();
    }

    const res = await fetch(BASE_URL + '/', {
      method: 'POST',
      body: loginData.toString(),
      headers,
      redirect: 'manual'
    });

    this._parseCookiesFromHeaders(res.headers);

    // On successful login, server may redirect (3xx) to dashboard
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      try { await res.text(); } catch {}
      // Redirect means login succeeded
    } else {
      const body = await res.text();
      let json;
      try { json = JSON.parse(body); } catch { json = null; }

      if (json && json.status === 'success') {
        // Explicit success response
      } else if (json && json.message && /otp/i.test(json.message)) {
        // OTP required — signal caller to collect OTP from user
        const err = createTransportError(`Doodstream Login: ${sanitizeRemoteText(json.message)}`, {
          phase: 'login',
          endpoint: BASE_URL,
          httpStatus: res.status,
          contentType: res.headers && res.headers.get ? res.headers.get('content-type') : null,
          body
        });
        err.otpRequired = true;
        throw err;
      } else if (json && json.status === 'fail') {
        throw createTransportError(`Doodstream Login: ${sanitizeRemoteText(json.message) || 'Login fehlgeschlagen'}`, {
          phase: 'login',
          endpoint: BASE_URL,
          httpStatus: res.status,
          contentType: res.headers && res.headers.get ? res.headers.get('content-type') : null,
          body,
          accountError: true
        });
      } else if (body.includes('Dashboard')) {
        // Got dashboard HTML directly — login worked
      } else {
        const msg = sanitizeRemoteText(json && json.message) || 'Login fehlgeschlagen';
        throw createTransportError(`Doodstream Login: ${msg}`, {
          phase: 'login',
          endpoint: BASE_URL,
          httpStatus: res.status,
          contentType: res.headers && res.headers.get ? res.headers.get('content-type') : null,
          body
        });
      }
    }

    // Extract sess_id from the upload page
    await this._extractSessId();
  }

  async _extractSessId() {
    const res = await this._fetch(BASE_URL + '/?op=upload');
    const html = await res.text();

    // Hidden input: <input type="hidden" name="sess_id" value="xxx">
    const hiddenMatch = html.match(/name=["']sess_id["'][^>]*value=["']([a-zA-Z0-9]+)["']/);
    if (hiddenMatch) {
      this.sessId = hiddenMatch[1];
      return;
    }

    // Vue component prop or JS: sess_id: "xxx" or sess_id="xxx"
    const sessMatch = html.match(/sess_id['":\s]+['"]([a-zA-Z0-9]+)['"]/);
    if (sessMatch) {
      this.sessId = sessMatch[1];
      return;
    }

    // Assignment: sess_id = 'xxx'
    const altMatch = html.match(/sess_id\s*=\s*['"]([a-zA-Z0-9]+)['"]/);
    if (altMatch) {
      this.sessId = altMatch[1];
      return;
    }

    throw new Error('Doodstream: sess_id nicht gefunden nach Login');
  }

  /**
   * Get upload server URL from web interface
   */
  async _getUploadServer() {
    // Use the standard upload server endpoint
    const res = await this._fetch(BASE_URL + '/?op=upload_server');
    const text = await res.text();
    const ctype = (res.headers && res.headers.get) ? (res.headers.get('content-type') || '') : '';
    _debugLog(`upload_server: status=${res.status} ctype=${ctype} response=${summarizeResponse(text, ctype)}`);
    let json;
    try { json = JSON.parse(text); } catch { json = null; }

    if (json && json.result && /^https?:\/\//i.test(json.result)) {
      return json.result;
    }

    // Fallback: try fetching from upload page HTML
    const pageRes = await this._fetch(BASE_URL + '/?op=upload');
    const html = await pageRes.text();

    // Current doodstream format: the upload server is the action of the
    // multipart upload form, e.g.
    //   <form name="file" enctype="multipart/form-data"
    //         action="https://xxx.cloudatacdn.com/upload/01?SESSID" ...>
    //   <input type="hidden" name="sess_id" value="SESSID">
    // The node is assigned per page-load and the action carries a session token
    // in its query string that matches the page's hidden sess_id. We refresh
    // this.sessId from THIS page so the multipart sess_id field matches the node
    // URL — login-time and node tokens otherwise diverge and the upload comes
    // back with an empty filecode.
    const actionMatch = html.match(/action=["'](https?:\/\/[^"']+\/upload\/[^"']*)["']/i);
    if (actionMatch) {
      const url = actionMatch[1].replace(/&amp;/g, '&'); // un-escape HTML entities in query
      const freshSess = html.match(/name=["']sess_id["'][^>]*value=["']([a-zA-Z0-9]+)["']/);
      if (freshSess) {
        this.sessId = freshSess[1];
      } else {
        _debugLog('upload_server: form action found but no sess_id on page; keeping existing sessId');
      }
      // Capture the form's real fields so upload() submits exactly what the
      // browser would (file_title, submit_btn, …) instead of stale hardcoded ones.
      this._uploadFormFields = this._parseUploadFormFields(html);
      _debugLog(`upload_server: using form action node=${safeEndpoint(url)} sessLength=${this.sessId.length} fields=${Object.keys(this._uploadFormFields).join(',')}`);
      return url;
    }

    // Legacy fallback: srv_url JS variable (older doodstream theme).
    const srvMatch = html.match(/srv_url['":\s]+['"]?(https?:\/\/[^'">\s]+)['"]?/i);
    if (srvMatch) return srvMatch[1];

    // No upload server could be extracted. We MUST NOT silently fall back to a
    // hardcoded node: that node is stale and accepts the bytes but returns an
    // empty form (no filecode) — so the user wastes ~90s uploading 95 MB into a
    // dead end and gets a cryptic "kein Filecode" 90s later. Fail fast with
    // safe structured diagnostics.
    _debugLog(`upload_server: no server response=${summarizeResponse(text, ctype)} page=${summarizeResponse(html, pageRes.headers && pageRes.headers.get ? pageRes.headers.get('content-type') : '')}`);
    throw createTransportError('Doodstream: konnte Upload-Server nicht ermitteln', {
      phase: 'upload-server',
      endpoint: BASE_URL + '/?op=upload_server',
      httpStatus: res.status,
      contentType: ctype,
      body: text,
      retryable: res.status >= 500,
      transientNetwork: res.status >= 500,
      hosterTransient: res.status >= 500
    });
  }

  /**
   * Replicate the non-file fields of doodstream's CURRENT upload form so our
   * POST matches what the browser actually submits. Doodstream dropped the old
   * `utype` field and added file_title / fakefilepc / submit_btn; submitting a
   * stale/incomplete field set can make the node accept the bytes but skip
   * registration (→ empty result form). We parse the live form rather than
   * hardcode, so we track whatever fields doodstream uses now. The file input
   * (type=file) is excluded — the file is streamed separately.
   */
  _parseUploadFormFields(html) {
    const fields = {};
    if (!html) return fields;
    // Narrow to the upload form (its action points at a /upload/ node).
    const formMatch = html.match(/<form[^>]*\baction=["'][^"']*\/upload\/[^"']*["'][\s\S]*?<\/form>/i);
    const scope = formMatch ? formMatch[0] : html;
    const re = /<(?:input|button)\b([^>]*)>/gi;
    let m;
    while ((m = re.exec(scope)) !== null) {
      const attrs = m[1];
      const typeM = attrs.match(/\btype=["']([^"']*)["']/i);
      if (typeM && typeM[1].toLowerCase() === 'file') continue;
      const nameM = attrs.match(/\bname=["']([^"']+)["']/i);
      if (!nameM) continue;
      const valM = attrs.match(/\bvalue=["']([^"']*)["']/i);
      fields[nameM[1]] = valM ? valM[1] : '';
    }
    return fields;
  }

  /**
   * Upload file using web session
   */
  async upload(filePath, progressCb, signal, throttle) {
    const fileName = path.basename(filePath);
    const fileSize = fs.statSync(filePath).size;

    // Get upload server
    const uploadUrl = await this._getUploadServer();
    // Remember which CDN node handled this upload so a later parse failure can
    // report it — failures sometimes correlate with a specific node.
    this._lastUploadUrl = uploadUrl;

    // Build multipart form
    const boundary = `----WebKitFormBoundary${crypto.randomBytes(16).toString('hex')}`;

    // Build form parts. Submit the live form's fields (parsed in
    // _getUploadServer) so our POST matches the browser; merge in sess_id (the
    // fresh node token) and keep utype=reg as a harmless compatibility extra.
    // Falls back to the minimal known-good set if the form wasn't parsed.
    const formFields = { utype: 'reg', ...(this._uploadFormFields || {}) };
    formFields.sess_id = this.sessId;
    let preamble = '';
    for (const [name, value] of Object.entries(formFields)) {
      preamble += `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
    }
    const safeFileName = fileName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    preamble += `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeFileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`;

    const epilogue = `\r\n--${boundary}--\r\n`;
    const preambleBuf = Buffer.from(preamble, 'utf-8');
    const epilogueBuf = Buffer.from(epilogue, 'utf-8');
    const totalSize = preambleBuf.length + fileSize + epilogueBuf.length;

    const CHUNK_SIZE = 1024 * 1024;
    let bytesRead = 0;

    async function* generate() {
      yield preambleBuf;
      const fileStream = fs.createReadStream(filePath, { highWaterMark: CHUNK_SIZE });
      for await (const chunk of fileStream) {
        if (signal && signal.aborted) throw new Error('Aborted');
        if (throttle) await throttle.consume(chunk.length, signal);
        bytesRead += chunk.length;
        yield chunk;
        if (progressCb) progressCb(bytesRead, fileSize);
      }
      yield epilogueBuf;
    }

    let uploadRes;
    try {
      uploadRes = await request(uploadUrl, {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': String(totalSize),
          'User-Agent': USER_AGENT,
          'Cookie': this._cookieHeader()
        },
        body: generate(),
        signal,
        bodyTimeout: UPLOAD_TIMEOUT,
        headersTimeout: 60000
      });
    } catch {
      const mb = Math.round(bytesRead / 1048576);
      throw createTransportError(`Doodstream Upload-POST nach ${mb} MB fehlgeschlagen`, {
        phase: 'upload-request',
        endpoint: uploadUrl,
        retryable: true,
        transientNetwork: true
      });
    }

    const statusCode = uploadRes.statusCode;
    _debugLog(`Upload response status: ${statusCode}`);

    // Handle redirects from upload server (undici doesn't follow them)
    if ([301, 302, 303, 307, 308].includes(statusCode)) {
      const location = uploadRes.headers['location'];
      try { await uploadRes.body.text(); } catch {}
      _debugLog(`Upload redirect to: ${location}`);
      if (location) {
        return this._handleUploadResult(location);
      }
    }

    const resText = await uploadRes.body.text();
    const uploadContentType = uploadRes.headers && uploadRes.headers['content-type'];
    _debugLog(`Upload response: ${summarizeResponse(resText, uploadContentType)}`);

    if (statusCode >= 400) {
      let payload;
      try { payload = JSON.parse(resText); } catch {}
      const msg = payload && payload.msg ? sanitizeRemoteText(payload.msg) : '';
      throw createTransportError(`Doodstream Upload fehlgeschlagen${msg ? `: ${msg}` : ''}`, {
        phase: 'upload-response',
        endpoint: uploadUrl,
        httpStatus: statusCode,
        contentType: uploadContentType,
        body: resText,
        retryable: statusCode === 429 || statusCode >= 500,
        transientNetwork: statusCode >= 500
      });
    }

    return this._parseUploadResponse(resText);
  }

  /**
   * Follow a redirect URL from upload server and extract filecode
   */
  async _handleUploadResult(url) {
    _debugLog(`Following upload result URL: ${safeEndpoint(url) || 'unknown endpoint'}`);
    const res = await this._fetch(url);
    const html = await res.text();
    const contentType = res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-type') : '';
    _debugLog(`Result page: ${summarizeResponse(html, contentType)}`);
    return this._parseUploadResponse(html);
  }

  /**
   * Extract hidden form fields from HTML (handles various attribute orders)
   */
  _extractHiddenFields(html) {
    const fields = {};
    // Textarea fields: <textarea name="op">upload_result</textarea>
    const ta = /<textarea[^>]*name=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/textarea>/gi;
    let m;
    while ((m = ta.exec(html)) !== null) fields[m[1]] = m[2].trim();
    // Input hidden fields
    const p1 = /<input[^>]*type=['"]hidden['"][^>]*name=['"]([^'"]+)['"][^>]*value=['"]([^'"]*)['"]/gi;
    while ((m = p1.exec(html)) !== null) { if (!fields[m[1]]) fields[m[1]] = m[2]; }
    const p2 = /<input[^>]*name=['"]([^'"]+)['"][^>]*value=['"]([^'"]*)['"]/gi;
    while ((m = p2.exec(html)) !== null) { if (!fields[m[1]]) fields[m[1]] = m[2]; }
    const p3 = /<input[^>]*value=['"]([^'"]*)['"]\s[^>]*name=['"]([^'"]+)['"]/gi;
    while ((m = p3.exec(html)) !== null) { if (!fields[m[2]]) fields[m[2]] = m[1]; }
    return fields;
  }

  /**
   * Parse filecode from upload server response (JSON or HTML)
   */
  async _parseUploadResponse(resText) {
    // 1. Try JSON
    let payload;
    try { payload = JSON.parse(resText); } catch {}

    if (payload) {
      return this._extractFromJson(payload);
    }

    // 2. Try filecode directly in HTML
    const code = this._findFilecodeInHtml(resText);
    if (code) {
      _debugLog(`Found filecode in HTML: ${code}`);
      return this._buildResult(code);
    }

    // 3. Parse HTML form (XFileSharing two-step upload)
    const hiddenFields = this._extractHiddenFields(resText);
    _debugLog(`Hidden fields: ${Object.keys(hiddenFields).join(',')}`);

    // Check if filecode is already in hidden fields
    const fnCode = hiddenFields.fn || hiddenFields.filecode || hiddenFields.file_code;
    if (fnCode && fnCode.length >= 8) {
      _debugLog(`Filecode from hidden field 'fn': length ${fnCode.length}`);
      // We still need to submit the form so doodstream registers the file
      // But the filecode is the 'fn' value
    }

    // XFileSharing standard: form with op=upload_result, fn, st
    // Always submit to doodstream.com, not to CDN
    if (hiddenFields.fn || hiddenFields.op === 'upload_result') {
      // Ensure op=upload_result is set
      if (!hiddenFields.op) hiddenFields.op = 'upload_result';

      _debugLog(`Submitting upload_result fields: ${Object.keys(hiddenFields).join(',')}`);
      const formData = new URLSearchParams(hiddenFields);
      let followText = '';
      try {
        const followRes = await this._fetch(BASE_URL + '/', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Referer': BASE_URL + '/'
          },
          body: formData.toString()
        });
        followText = await followRes.text();
      } catch {
        // The file already uploaded to the CDN; this POST only registers it on
        // doodstream's side. If it fails transiently (even after _fetch's own
        // retries) but we already hold the filecode, the upload succeeded from
        // the user's view — return it rather than discarding a done upload.
        if (fnCode && fnCode.length >= 8) {
          _debugLog(`upload_result submit failed; using existing filecode length ${fnCode.length}`);
          return this._buildResult(fnCode);
        }
        throw createTransportError('Doodstream Upload: Ergebnis konnte nicht registriert werden', {
          phase: 'upload-result-submit',
          endpoint: BASE_URL,
          retryable: true,
          transientNetwork: true
        });
      }
      _debugLog(`upload_result response: ${summarizeResponse(followText, '')}`);

      // Try to find filecode in result page
      const resultCode = this._findFilecodeInHtml(followText);
      if (resultCode) {
        return this._buildResult(resultCode);
      }

      // If we had fn from hidden fields, use that as filecode
      if (fnCode && fnCode.length >= 8) {
        return this._buildResult(fnCode);
      }

      // Try download URL pattern in result page
      const dlMatch = followText.match(/https?:\/\/[a-z0-9.]+\/d\/([a-zA-Z0-9]+)/i);
      if (dlMatch) {
        return this._buildResult(dlMatch[1]);
      }

      // No filecode anywhere. Surface WHY: XFileSharing puts the real reason
      // in the `st` field (anything other than "OK" means the backend refused
      // the file — copyright/hash match, duplicate, size, quota, …). The
      // download link being empty while the page structure is unchanged points
      // at doodstream's backend, not at a parsing bug on our side.
      const st = hiddenFields.st || '';
      const safeStatus = sanitizeRemoteText(st, 100);
      const fnInfo = fnCode ? `vorhanden(len ${fnCode.length})` : 'fehlt/leer';
      const node = safeEndpoint(this._lastUploadUrl) || 'unbekannt';
      _debugLog(`No filecode. st=${safeStatus || '?'} fn=${fnInfo} node=${node} response=${summarizeResponse(resText, 'text/html')}`);
      if (st && st !== 'OK') {
        throw createTransportError(`Doodstream lehnt Datei ab (Server-Status: ${safeStatus || 'unbekannt'})`, {
          phase: 'upload-result',
          endpoint: this._lastUploadUrl || BASE_URL,
          contentType: 'text/html',
          body: resText
        });
      }
      // Empty form (no fn, no st) is a doodstream-side processing flake — same
      // account + same file works on a later attempt. Tag it explicitly so the
      // upload-manager classifies this as a hoster-transient error and does NOT
      // blacklist the account (otherwise one of these flakes poisons the whole
      // session and later batches hit `pre-job-swap-blocked` for no fault of
      // the account). The flag is the primary signal; the message text is a
      // belt-and-suspenders regex fallback in the classifier.
      throw createTransportError(`Doodstream Upload: kein Filecode (st=${safeStatus || '?'}, fn=${fnInfo}, CDN=${node})`, {
        phase: 'upload-result',
        endpoint: this._lastUploadUrl || BASE_URL,
        contentType: 'text/html',
        body: resText,
        retryable: true,
        hosterTransient: true
      });
    }

    // 4. Fallback: follow form action as-is (for non-XFS forms)
    const formAction = resText.match(/<form[^>]*action=['"]([^'"]+)['"]/i);
    if (formAction) {
      _debugLog(`Fallback: following form action ${safeEndpoint(formAction[1]) || 'unknown endpoint'}`);
      const formData = new URLSearchParams(hiddenFields);
      const followRes = await this._fetch(formAction[1], {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': BASE_URL + '/'
        },
        body: formData.toString()
      });
      const followText = await followRes.text();
      _debugLog(`Fallback response: ${summarizeResponse(followText, '')}`);

      const fallbackCode = this._findFilecodeInHtml(followText);
      if (fallbackCode) return this._buildResult(fallbackCode);

      // Check if fn was in original hidden fields
      if (fnCode && fnCode.length >= 8) return this._buildResult(fnCode);

      throw createTransportError('Doodstream Upload: Redirect-Antwort ungültig', {
        phase: 'upload-result',
        endpoint: formAction[1],
        body: followText,
        hosterTransient: true,
        retryable: true
      });
    }

    throw createTransportError('Doodstream Upload: Keine gültige Antwort', {
      phase: 'upload-result',
      endpoint: this._lastUploadUrl || BASE_URL,
      contentType: /<\s*(?:!doctype|html|body|form|input)\b/i.test(resText) ? 'text/html' : 'text/plain',
      body: resText,
      hosterTransient: true,
      retryable: true
    });
  }

  /**
   * Search for filecode patterns in HTML
   */
  _findFilecodeInHtml(html) {
    // filecode: "xxx" or filecode = "xxx"
    const m1 = html.match(/filecode['":\s]+['"]([a-zA-Z0-9]{8,})['"]/i);
    if (m1) return m1[1];
    // file_code: "xxx"
    const m2 = html.match(/file_code['":\s]+['"]([a-zA-Z0-9]{8,})['"]/i);
    if (m2) return m2[1];
    // Download URL pattern: /d/FILECODE
    const m3 = html.match(/\/d\/([a-zA-Z0-9]{8,})/);
    if (m3) return m3[1];
    return null;
  }

  /**
   * Extract result from JSON payload
   */
  _extractFromJson(payload) {
    if (payload.status && Number(payload.status) !== 200 && payload.msg) {
      throw createTransportError(`Doodstream Upload: ${sanitizeRemoteText(payload.msg) || 'Antwort wurde abgelehnt'}`, {
        phase: 'upload-result',
        endpoint: this._lastUploadUrl || BASE_URL,
        httpStatus: Number(payload.status),
        contentType: 'application/json',
        body: JSON.stringify(payload),
        retryable: Number(payload.status) === 429 || Number(payload.status) >= 500,
        transientNetwork: Number(payload.status) >= 500
      });
    }

    let item = null;
    const result = payload.result;
    if (Array.isArray(result) && result.length > 0) {
      item = result[0];
    } else if (typeof result === 'object' && result) {
      item = result;
    }

    if (!item) {
      throw createTransportError('Doodstream Upload: Antwort enthielt kein Ergebnis', {
        phase: 'upload-result',
        endpoint: this._lastUploadUrl || BASE_URL,
        contentType: 'application/json',
        body: JSON.stringify(payload),
        hosterTransient: true,
        retryable: true
      });
    }

    const fileCode = String(item.filecode || item.file_code || '').trim();
    if (!fileCode) {
      throw createTransportError('Doodstream Upload: Antwort enthielt keinen Filecode', {
        phase: 'upload-result',
        endpoint: this._lastUploadUrl || BASE_URL,
        contentType: 'application/json',
        body: JSON.stringify(payload),
        hosterTransient: true,
        retryable: true
      });
    }
    return this._buildResult(fileCode);
  }

  _buildResult(fileCode) {
    return {
      download_url: `https://doodstream.com/d/${fileCode}`,
      embed_url: `https://doodstream.com/e/${fileCode}`,
      file_code: fileCode
    };
  }

  /**
   * Pull candidate API-key tokens out of a logged-in settings page. We do NOT
   * rely on knowing doodstream's exact (cookie-gated, unseen) settings DOM —
   * instead we gather every plausible long token from form-field values and
   * element contents, ranked so tokens near an "api" mention are tried first.
   * The caller validates each against the official API, so a wrong guess is
   * harmless (it just fails validation). Returned newest-/most-likely-first.
   */
  _extractApiKeyCandidates(html) {
    if (!html) return [];
    const cands = new Set();
    const patterns = [
      /value=["']([A-Za-z0-9]{20,})["']/gi,                                  // <input value="KEY">
      /<(?:textarea|code|span|pre|input)[^>]*>\s*([A-Za-z0-9]{20,})\s*</gi,   // <textarea>KEY</textarea>
      /\b(?:api[_-]?key|apikey)\b["':\s=>]*["']?([A-Za-z0-9]{20,})/gi         // api_key: "KEY"
    ];
    for (const re of patterns) {
      let m;
      while ((m = re.exec(html)) !== null) cands.add(m[1]);
    }
    // Rank tokens whose preceding context mentions "api" ahead of the rest.
    return [...cands]
      .map(t => {
        const idx = html.indexOf(t);
        const ctx = html.slice(Math.max(0, idx - 160), idx).toLowerCase();
        return { t, near: /api/.test(ctx) ? 0 : 1 };
      })
      .sort((a, b) => a.near - b.near)
      .map(s => s.t);
  }

  /**
   * Validate a candidate key against the official API. Only the account's real
   * key returns status 200, so this is what makes the brute-force extraction
   * safe regardless of the settings-page markup.
   */
  async _validateApiKey(key) {
    try {
      const res = await fetch(`https://doodapi.co/api/account/info?key=${encodeURIComponent(key)}`, {
        method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(15000)
      });
      const json = await res.json().catch(() => null);
      return !!(json && Number(json.status) === 200);
    } catch {
      return false;
    }
  }

  /**
   * Derive the account's doodapi API key from the logged-in web session, so a
   * login-only account can upload via the reliable JSON API (which returns the
   * filecode directly) instead of the fragile web upload form. Best-effort:
   * returns null if no valid key can be found, and the caller falls back to the
   * web-form upload. Requires login() to have run first (needs the cookies).
   */
  async deriveApiKey() {
    if (this.apiKey) return this.apiKey;
    let html = '';
    for (const page of ['/?op=my_account', '/settings', '/?op=profile']) {
      try {
        const res = await this._fetch(BASE_URL + page);
        const text = await res.text();
        if (text && /api[\s_-]?key/i.test(text)) { html = text; break; }
        if (text && !html) html = text;
      } catch { /* try next page */ }
    }
    const candidates = this._extractApiKeyCandidates(html);
    // Cap validation calls (rate limit 10/s; settings page yields few tokens).
    for (const key of candidates.slice(0, 15)) {
      if (await this._validateApiKey(key)) {
        this.apiKey = key;
        _debugLog(`api-key derive: validated key (len ${key.length})`);
        return key;
      }
    }
    _debugLog(`api-key derive: ${candidates.length} candidate(s), none validated. response=${summarizeResponse(html, 'text/html')}`);
    return null;
  }
}

module.exports = DoodstreamUploader;
module.exports.setDebugVerbose = setDebugVerbose;
