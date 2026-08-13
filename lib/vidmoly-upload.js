const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { request } = require('undici');
const { createTransportError, sanitizeRemoteText } = require('./hoster-transport-error');
const { normalizeRecoveryTitle } = require('./hosters');

const BASE_URL = 'https://vidmoly.me';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const UPLOAD_TIMEOUT = 1800000; // 30 min
const RESULT_POLL_ATTEMPTS = 10;
const RESULT_POLL_DELAY_MS = 2000;

/**
 * XFileSharing-based upload for Vidmoly (login + form upload)
 */
class VidmolyUploader {
  constructor(recoveryClaim = null) {
    this.cookies = new Map();
    this.recoveryClaim = recoveryClaim;
  }

  _cookieHeader() {
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  _parseCookiesFromHeaders(headers) {
    // Handle both undici response headers and fetch Headers
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

  /**
   * Simple GET/POST using built-in fetch (handles redirects)
   */
  async _fetch(url, opts = {}, _redirectCount = 0) {
    const MAX_REDIRECTS = 10;
    const headers = {
      'User-Agent': USER_AGENT,
      ...(opts.headers || {})
    };
    if (this.cookies.size > 0) {
      headers['Cookie'] = this._cookieHeader();
    }

    const res = await fetch(url, {
      ...opts,
      headers,
      redirect: 'manual' // handle manually to capture cookies from redirect responses
    });

    this._parseCookiesFromHeaders(res.headers);

    // Follow redirects manually (to capture cookies at each hop)
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      // Drain body to prevent connection leak
      try { await res.text(); } catch {}
      if (_redirectCount >= MAX_REDIRECTS) {
        throw new Error('Zu viele Redirects');
      }
      const location = res.headers.get('location');
      if (location) {
        const nextUrl = new URL(location, url).href;
        return this._fetch(nextUrl, { ...opts, method: 'GET', body: undefined }, _redirectCount + 1);
      }
    }

    return res;
  }

  /**
   * Login to Vidmoly via the new JSON API (replaces the old XFS form POST
   * at `/` with `op=login`, which the SPA redesign deprecated). The response
   * sets a `vidmoly_session` HttpOnly cookie that the upload API checks.
   */
  async login(username, password) {
    // Warm up — get baseline cookies (cf_clearance etc.)
    try {
      const initRes = await this._fetch(BASE_URL);
      await initRes.text();
    } catch {}

    const res = await this._fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      body: JSON.stringify({ login: username, password }),
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Origin': BASE_URL,
        'Referer': `${BASE_URL}/login`
      }
    });

    const body = await res.text();
    if (res.status === 401 || res.status === 403 || /incorrect|invalid|wrong/i.test(body)) {
      throw new Error('Vidmoly Login fehlgeschlagen: Falscher Username oder Passwort');
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Vidmoly Login fehlgeschlagen: HTTP ${res.status}`);
    }
    if (!this.cookies.has('vidmoly_session')) {
      throw new Error('Vidmoly Login fehlgeschlagen: Keine Session erhalten (vidmoly_session fehlt)');
    }

    // Probe the upload API so downstream getUploadParams() has a warm path.
    const probe = await this._fetch(`${BASE_URL}/api/upload/config`);
    const probeBody = await probe.text();
    let probeJson = null;
    try { probeJson = JSON.parse(probeBody); } catch {}
    if (!probeJson || !probeJson.sess_id || !probeJson.upload_url) {
      throw new Error('Vidmoly Login fehlgeschlagen: Session konnte nicht verifiziert werden (API-Probe)');
    }
  }

  /**
   * Fetch the upload session config from Vidmoly's new SPA API.
   * Replaces the old HTML-form scrape at /?op=upload which the redesign
   * removed. Returns an XFS-style session token + a transit-server URL.
   */
  async getUploadParams() {
    const endpoint = `${BASE_URL}/api/upload/config`;
    let res;
    try {
      res = await this._fetch(endpoint);
    } catch {
      throw createTransportError('Vidmoly: Upload-Konfiguration konnte nicht geladen werden', {
        phase: 'upload-config',
        endpoint,
        retryable: true,
        transientNetwork: true
      });
    }
    const body = await res.text();
    const contentType = res.headers && typeof res.headers.get === 'function'
      ? res.headers.get('content-type')
      : null;
    if (res.status < 200 || res.status >= 300) {
      throw createTransportError('Vidmoly: Upload-Konfiguration konnte nicht geladen werden', {
        phase: 'upload-config',
        endpoint,
        httpStatus: res.status,
        contentType,
        body,
        retryable: res.status === 429 || res.status >= 500,
        transientNetwork: res.status >= 500
      });
    }
    let payload = null;
    try { payload = JSON.parse(body); } catch {
      throw createTransportError('Vidmoly: Upload-Konfiguration war kein JSON', {
        phase: 'upload-config',
        endpoint,
        httpStatus: res.status,
        contentType,
        body
      });
    }
    if (!payload || !payload.sess_id || !payload.upload_url) {
      throw createTransportError('Vidmoly: Upload-Konfiguration war unvollständig', {
        phase: 'upload-config',
        endpoint,
        httpStatus: res.status,
        contentType,
        body
      });
    }
    return {
      uploadUrl: payload.upload_url,
      // Fields verified from a real browser POST capture.
      // to_json=1 forces a JSON response instead of an HTML redirect page.
      params: { sess_id: payload.sess_id, to_json: '1', fld_id: '0' },
      fileFieldName: 'file'
    };
  }

  /**
   * Upload a file to Vidmoly (uses undici.request for streaming progress)
   */
  async upload(filePath, onProgress, signal, throttle) {
    const fileName = path.basename(filePath);
    const fileSize = fs.statSync(filePath).size;
    let baselineCodes = null;
    let baselineError = null;
    try {
      baselineCodes = await this._captureVmFileCodes();
    } catch (err) {
      if (signal && signal.aborted) throw err;
      baselineError = err;
    }

    const { uploadUrl, params, fileFieldName } = await this.getUploadParams();

    const boundary = '----FormBoundary' + crypto.randomBytes(16).toString('hex');

    // XFS form fields
    const formFields = {};
    for (const [k, v] of Object.entries(params)) {
      if (!/^file(?:_\d+)?$/i.test(k)) { // eslint-disable-line security/detect-unsafe-regex -- safe: no backtracking
        formFields[k] = v;
      }
    }

    // Build multipart
    let preamble = '';
    for (const [key, value] of Object.entries(formFields)) {
      preamble += `--${boundary}\r\n`;
      preamble += `Content-Disposition: form-data; name="${key}"\r\n\r\n`;
      preamble += `${value}\r\n`;
    }
    preamble += `--${boundary}\r\n`;
    const safeFileName = fileName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    preamble += `Content-Disposition: form-data; name="${fileFieldName || 'file'}"; filename="${safeFileName}"\r\n`;
    preamble += `Content-Type: application/octet-stream\r\n\r\n`;

    const epilogue = `\r\n--${boundary}--\r\n`;

    const preambleBuf = Buffer.from(preamble, 'utf-8');
    const epilogueBuf = Buffer.from(epilogue, 'utf-8');
    const totalSize = preambleBuf.length + fileSize + epilogueBuf.length;

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

    // Transit server lives on a different domain (*.vmwesa.online) and runs
    // the nginx-upload-progress module. It requires an X-Progress-ID query
    // parameter on the POST URL — without it the upload hangs at the final
    // byte because the module can't finalize the session. Browsers append it
    // automatically before submitting the form.
    const progressId = Date.now().toString() + Math.floor(Math.random() * 1e6).toString().padStart(6, '0');
    const targetUrl = uploadUrl + (uploadUrl.includes('?') ? '&' : '?') + 'X-Progress-ID=' + progressId;

    // Browsers don't send vidmoly.me cookies across origins, so we don't either.
    let uploadResponse;
    try {
      uploadResponse = await request(targetUrl, {
        method: 'POST',
        body: generate(),
        signal,
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': '*/*',
          'Origin': BASE_URL,
          'Referer': `${BASE_URL}/`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': String(totalSize)
        },
        headersTimeout: UPLOAD_TIMEOUT,
        bodyTimeout: UPLOAD_TIMEOUT
      });
    } catch (err) {
      const error = signal && signal.aborted ? err : createTransportError('Vidmoly Upload konnte nicht übertragen werden', {
        phase: 'upload-request',
        endpoint: targetUrl,
        retryable: true,
        transientNetwork: true
      });
      throw this._markRemoteCommitUncertain(error);
    }

    const { body, statusCode, headers } = uploadResponse;

    this._parseCookiesFromHeaders(headers || {});

    // Check if upload response is a redirect (XFS often redirects to result page)
    let resultHtml;
    if ([301, 302, 303].includes(statusCode)) {
      const location = headers && headers.location;
      // Always drain the original body to prevent connection leak
      try { await body.text(); } catch {}
      if (location) {
        try {
          const resultRes = await this._fetch(new URL(location, uploadUrl).href);
          resultHtml = await resultRes.text();
        } catch (err) {
          throw this._markRemoteCommitUncertain(err);
        }
      } else {
        resultHtml = '';
      }
    } else {
      try {
        resultHtml = await body.text();
      } catch (err) {
        throw this._markRemoteCommitUncertain(err);
      }
    }

    if (statusCode >= 400) {
      const error = createTransportError('Vidmoly Upload fehlgeschlagen', {
        phase: 'upload-response',
        endpoint: targetUrl,
        httpStatus: statusCode,
        contentType: headers && headers['content-type'],
        body: resultHtml,
        retryable: statusCode === 429 || statusCode >= 500,
        transientNetwork: statusCode >= 500
      });
      throw statusCode >= 500 ? this._markRemoteCommitUncertain(error) : error;
    }

    // Try JSON first. The current transit server returns
    // { status: "OK", file_code: "...", msg: "Upload Completed" }.
    // Legacy XFS shapes (json.files / json.result) are kept as fallback.
    try {
      const json = JSON.parse(resultHtml);
      if (json.status && /ok/i.test(json.status) && json.file_code) {
        return this._buildUrlsFromCode(json.file_code);
      }
      if (json.file_code || json.filecode) {
        return this._buildUrlsFromCode(json.file_code || json.filecode);
      }
      if (json.files && json.files.length > 0) {
        const f = json.files[0];
        return this._buildUrlsFromCode(f.filecode || f.file_code);
      }
      if (json.result) {
        const r = Array.isArray(json.result) ? json.result[0] : json.result;
        const code = r.filecode || r.file_code;
        const urls = this._buildUrlsFromCode(code);
        if (urls) return urls;
      }
      if (json.status && !/ok/i.test(json.status) && json.msg) {
        throw createTransportError(`Vidmoly Upload abgelehnt: ${sanitizeRemoteText(json.msg)}`, {
          phase: 'upload-result',
          endpoint: targetUrl,
          httpStatus: statusCode,
          contentType: 'application/json',
          body: resultHtml
        });
      }
    } catch (err) {
      if (err && err.diagnostic) throw err;
    }

    try {
      return this._parseUploadResult(resultHtml);
    } catch (primaryErr) {
      if (primaryErr && primaryErr.remoteIdentityClaimed === true) throw primaryErr;
      if (baselineCodes) {
        try {
          const fallback = await this._resolveUploadedFileFromVmApi(fileName, baselineCodes, signal);
          if (fallback) return fallback;
        } catch (err) {
          throw this._markRemoteCommitUncertain(err);
        }
      }
      if (baselineError) {
        baselineError.hosterTransient = true;
        throw this._markRemoteCommitUncertain(baselineError);
      }
      throw this._markRemoteCommitUncertain(primaryErr);
    }
  }

  _normalizeTitle(value) {
    return normalizeRecoveryTitle(value);
  }

  _markRemoteCommitUncertain(error) {
    if (this.recoveryClaim && typeof this.recoveryClaim.markUncertain === 'function') {
      return this.recoveryClaim.markUncertain(error);
    }
    const uncertainError = error && typeof error === 'object'
      ? error
      : new Error('Vidmoly Upload-Ergebnis ist unsicher');
    uncertainError.remoteCommitUncertain = true;
    uncertainError.hosterTransient = true;
    return uncertainError;
  }

  _buildUrlsFromCode(fileCode, phase = 'upload-result') {
    const code = String(fileCode || '').trim();
    if (!code) return null;
    if (this.recoveryClaim
        && typeof this.recoveryClaim.reserve === 'function'
        && !this.recoveryClaim.reserve(code)) {
      const error = createTransportError('Vidmoly Upload-Ergebnis ist bereits einem anderen Upload zugeordnet', {
        phase,
        endpoint: BASE_URL,
        retryable: true,
        hosterTransient: true
      });
      error.remoteIdentityClaimed = true;
      throw this._markRemoteCommitUncertain(error);
    }

    return {
      download_url: `${BASE_URL}/w/${code}`,
      embed_url: `${BASE_URL}/embed-${code}.html`,
      file_code: code
    };
  }

  async _captureVmFileCodes() {
    const files = await this._fetchVmList('recovery-baseline');
    return new Set(
      files
        .map((f) => String(f.file_code || '').trim())
        .filter(Boolean)
    );
  }

  async _fetchVmList(phase = 'recovery-poll') {
    const params = new URLSearchParams({
      op: 'vm',
      api: 'list',
      page: '1',
      per: '100',
      sort: 'date',
      order: 'desc',
      fld_id: '0'
    });

    const endpoint = `${BASE_URL}/?${params.toString()}`;
    let res;
    try {
      res = await this._fetch(endpoint);
    } catch {
      throw createTransportError('Vidmoly: Dateiliste konnte nicht geladen werden', {
        phase,
        endpoint,
        retryable: true,
        transientNetwork: true
      });
    }
    const body = await res.text();
    const contentType = res.headers && typeof res.headers.get === 'function'
      ? res.headers.get('content-type')
      : null;

    if (res.status < 200 || res.status >= 300) {
      throw createTransportError('Vidmoly: Dateiliste konnte nicht geladen werden', {
        phase,
        endpoint,
        httpStatus: res.status,
        contentType,
        body,
        retryable: res.status === 429 || res.status >= 500,
        transientNetwork: res.status >= 500
      });
    }

    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      throw createTransportError('Vidmoly: Dateiliste war kein JSON', {
        phase,
        endpoint,
        httpStatus: res.status,
        contentType,
        body
      });
    }

    if (!payload || !Array.isArray(payload.files)) return [];
    return payload.files;
  }

  async _resolveUploadedFileFromVmApi(fileName, baselineCodes, signal) {
    if (!(baselineCodes instanceof Set)) return null;
    const expectedTitle = this._normalizeTitle(path.parse(fileName).name);
    let lastPollError = null;
    let successfulPoll = false;

    for (let attempt = 0; attempt < RESULT_POLL_ATTEMPTS; attempt++) {
      if (signal && signal.aborted) {
        const err = new Error('Aborted');
        err.name = 'AbortError';
        throw err;
      }

      let files = [];
      try {
        files = await this._fetchVmList('recovery-poll');
        successfulPoll = true;
      } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        lastPollError = err;
      }

      const withCode = files.filter((f) => f && typeof f.file_code === 'string' && f.file_code.trim());
      const newFiles = withCode.filter((f) => !baselineCodes.has(f.file_code.trim()));
      const matches = newFiles
        .filter((file) => {
          const title = this._normalizeTitle(file.full_title || file.title_txt || '');
          return expectedTitle && title === expectedTitle;
        })
        .filter((file) => !this.recoveryClaim
          || typeof this.recoveryClaim.has !== 'function'
          || !this.recoveryClaim.has(file.file_code.trim()));

      if (matches.length > 1) return null;
      if (matches.length === 1) {
        return this._buildUrlsFromCode(matches[0].file_code, 'recovery-poll');
      }

      if (attempt < RESULT_POLL_ATTEMPTS - 1) {
        await this._sleep(RESULT_POLL_DELAY_MS, signal);
      }
    }

    if (!successfulPoll && lastPollError) throw lastPollError;
    return null;
  }

  _sleep(ms, signal) {
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

  _parseUploadResult(html) {
    let download_url = null;
    let embed_url = null;
    let file_code = null;

    const fnMatch = html.match(/<(?:input|textarea)[^>]*name=["']fn["'][^>]*(?:value=["']([^"']+)["'])?[^>]*>([^<]*)/i); // eslint-disable-line security/detect-unsafe-regex -- parses trusted hoster HTML only
    if (fnMatch) {
      const codeFromFn = (fnMatch[1] || fnMatch[2] || '').trim();
      if (/^[a-z0-9]{8,16}$/i.test(codeFromFn)) {
        file_code = codeFromFn;
      }
    }

    if (!file_code) {
      const fnAltMatch = html.match(/(?:^|[?&])fn=([a-z0-9]{8,16})(?:&|$)/i);
      if (fnAltMatch) file_code = fnAltMatch[1];
    }

    // Vidmoly URL patterns - includes /w/ path format
    const linkPatterns = [
      /https?:\/\/vidmoly\.[a-z]+\/w\/[a-z0-9]{12}/gi,
      /https?:\/\/vidmoly\.[a-z]+\/embed-[a-z0-9]{12}[^\s"']*/gi,
      /https?:\/\/vidmoly\.[a-z]+\/[a-z0-9]{12}\.html/gi,
      /https?:\/\/vidmoly\.[a-z]+\/[a-z0-9]{12}/gi
    ];

    for (const pattern of linkPatterns) {
      const matches = html.match(pattern);
      if (matches) {
        for (const url of matches) {
          if (url.includes('/embed-') || url.includes('/embed/')) {
            if (!embed_url) embed_url = url;
          } else {
            if (!download_url) download_url = url;
          }
        }
      }
    }

    // Extract file code from URLs
    const codeMatch = (download_url || embed_url || '').match(/\/(?:w\/)?([a-z0-9]{12})/i)
      || (download_url || embed_url || '').match(/embed-([a-z0-9]{12})/i);
    if (codeMatch) {
      file_code = codeMatch[1];
    }

    // Try input/textarea fields
    if (!download_url) {
      const inputMatch = html.match(/<(?:input|textarea)[^>]*value=["'](https?:\/\/vidmoly[^"']+)["']/i);
      if (inputMatch) {
        download_url = inputMatch[1];
        const code = download_url.match(/\/(?:w\/)?([a-z0-9]{12})/i);
        if (code) file_code = code[1];
      }
    }

    // Try to find file code in any filecode reference
    if (!file_code) {
      const codeInPage = html.match(/filecode['":\s]+['"]?([a-z0-9]{12})['"]?/i)
        || html.match(/file_code['":\s]+['"]?([a-z0-9]{12})['"]?/i);
      if (codeInPage) file_code = codeInPage[1];
    }

    if (file_code) {
      const urls = this._buildUrlsFromCode(file_code);
      if (!download_url) download_url = urls.download_url;
      if (!embed_url) embed_url = urls.embed_url;
    }

    if (!download_url && !file_code) {
      const errMatch = html.match(/class=["']err["'][^>]*>([^<]+)/i);
      const errMsg = errMatch ? errMatch[1].trim() : 'Kein Download-Link gefunden';
      throw createTransportError(`Vidmoly Upload-Ergebnis: ${sanitizeRemoteText(errMsg)}`, {
        phase: 'upload-result',
        endpoint: BASE_URL,
        contentType: 'text/html',
        body: html,
        hosterTransient: true,
        retryable: true
      });
    }

    return { download_url, embed_url, file_code };
  }
}

module.exports = VidmolyUploader;
