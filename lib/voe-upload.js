const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { request } = require('undici');
const { createTransportError, sanitizeRemoteText } = require('./hoster-transport-error');

const BASE_URL = 'https://voe.sx';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const UPLOAD_TIMEOUT = 1800000; // 30 min
const RESULT_POLL_ATTEMPTS = 10;
const RESULT_POLL_DELAY_MS = 2000;

/**
 * Login-based upload for VOE.sx (Laravel / FilePond)
 * Fallback when API-based upload fails or is unavailable.
 */
class VoeUploader {
  constructor() {
    this.cookies = new Map();
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

  /**
   * GET/POST with cookie management and manual redirect following
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
      redirect: 'manual'
    });

    this._parseCookiesFromHeaders(res.headers);

    if ([301, 302, 303, 307, 308].includes(res.status)) {
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
   * Extract CSRF token from page HTML
   */
  _extractCsrfToken(html) {
    // Laravel meta tag
    const metaMatch = html.match(/<meta\s+name=["']csrf-token["']\s+content=["']([^"']+)["']/i);
    if (metaMatch) return metaMatch[1];

    // Hidden input field
    const inputMatch = html.match(/<input[^>]*name=["']_token["'][^>]*value=["']([^"']+)["']/i)
      || html.match(/<input[^>]*value=["']([^"']+)["'][^>]*name=["']_token["']/i);
    if (inputMatch) return inputMatch[1];

    return null;
  }

  /**
   * Login to VOE.sx
   */
  async login(email, password) {
    // GET login page for cookies + CSRF token
    const loginPageRes = await this._fetch(`${BASE_URL}/login`);
    const loginHtml = await loginPageRes.text();

    const csrfToken = this._extractCsrfToken(loginHtml);
    if (!csrfToken) {
      throw new Error('VOE Login: CSRF-Token nicht gefunden');
    }

    // POST login
    const loginData = new URLSearchParams({
      _token: csrfToken,
      email: email,
      password: password
    });

    const res = await this._fetch(`${BASE_URL}/login`, {
      method: 'POST',
      body: loginData.toString(),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': `${BASE_URL}/login`
      }
    });

    const body = await res.text();

    // Check for login errors
    if (body.includes('credentials do not match') || body.includes('Incorrect') || body.includes('invalid')) {
      throw new Error('VOE Login fehlgeschlagen: Falscher Username oder Passwort');
    }

    // Verify we have a session
    const hasSession = this.cookies.has('voe_session') ||
      this.cookies.has('laravel_session') ||
      this.cookies.size > 2;

    if (!hasSession) {
      throw new Error('VOE Login fehlgeschlagen: Keine Session erhalten');
    }
  }

  /**
   * Get the upload page and extract CSRF token
   */
  async _getUploadParams() {
    const res = await this._fetch(`${BASE_URL}/file-upload`);
    const html = await res.text();

    const csrfToken = this._extractCsrfToken(html);
    if (!csrfToken) {
      throw new Error('VOE Upload: CSRF-Token nicht gefunden. Bist du eingeloggt?');
    }

    return { csrfToken };
  }

  /**
   * Get upload server URL from /engine/delivery-node
   * Returns { server: "https://cdn-xxx.edgeon-bandwidth.com/node/u/01", session_id: "..." }
   */
  async _getDeliveryNode(csrfToken) {
    const endpoint = `${BASE_URL}/engine/delivery-node`;
    let res;
    try {
      res = await this._fetch(endpoint, {
        headers: {
          'X-CSRF-TOKEN': csrfToken,
          'X-Requested-With': 'XMLHttpRequest',
          'Accept': 'application/json'
        }
      });
    } catch {
      throw createTransportError('VOE: Upload-Server konnte nicht geladen werden', {
        phase: 'upload-server',
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
      throw createTransportError('VOE: Upload-Server konnte nicht geladen werden', {
        phase: 'upload-server',
        endpoint,
        httpStatus: res.status,
        contentType,
        body,
        retryable: res.status === 429 || res.status >= 500,
        transientNetwork: res.status >= 500
      });
    }
    let data;
    try { data = JSON.parse(body); } catch {
      throw createTransportError('VOE: Upload-Server Antwort war kein JSON', {
        phase: 'upload-server',
        endpoint,
        httpStatus: res.status,
        contentType,
        body
      });
    }

    if (!data || !data.success || !data.server) {
      throw createTransportError('VOE: Kein Upload-Server erhalten von delivery-node', {
        phase: 'upload-server',
        endpoint,
        httpStatus: res.status,
        contentType,
        body
      });
    }

    return { uploadServer: data.server, sessionId: data.session_id || '' };
  }

  /**
   * List current files via VOE API (for result polling fallback)
   */
  async _fetchFileList(phase = 'recovery-poll') {
    const endpoint = `${BASE_URL}/api2/my-files?sort=date&order=dsc&page=1&per_page=50`;
    let res;
    try {
      res = await this._fetch(endpoint);
    } catch {
      throw createTransportError('VOE: Dateiliste konnte nicht geladen werden', {
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
      throw createTransportError('VOE: Dateiliste konnte nicht geladen werden', {
        phase,
        endpoint,
        httpStatus: res.status,
        contentType,
        body,
        retryable: res.status === 429 || res.status >= 500,
        transientNetwork: res.status >= 500
      });
    }
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      throw createTransportError('VOE: Dateiliste war kein JSON', {
        phase,
        endpoint,
        httpStatus: res.status,
        contentType,
        body
      });
    }
    if (data && Array.isArray(data.data)) return data.data;
    if (data && Array.isArray(data.files)) return data.files;
    return [];
  }

  async _captureFileCodes() {
    const files = await this._fetchFileList('recovery-baseline');
    return new Set(files.map(f => String(f.file_code || f.slug || '').trim()).filter(Boolean));
  }

  /**
   * Upload a file to VOE.sx via login session
   * Flow: GET delivery-node → POST file to CDN server
   */
  async upload(filePath, onProgress, signal, throttle) {
    const fileName = path.basename(filePath);
    const fileSize = fs.statSync(filePath).size;
    let baselineCodes = null;
    let baselineError = null;
    try {
      baselineCodes = await this._captureFileCodes();
    } catch (err) {
      if (signal && signal.aborted) throw err;
      baselineError = err;
    }

    // Step 1: Get CSRF token from upload page
    const { csrfToken } = await this._getUploadParams();

    // Step 2: Get CDN upload server from delivery-node
    const { uploadServer, sessionId } = await this._getDeliveryNode(csrfToken);

    const boundary = '----FormBoundary' + crypto.randomBytes(16).toString('hex');

    // Build multipart body
    let preamble = '';
    // Include session_id if provided
    if (sessionId) {
      preamble += `--${boundary}\r\n`;
      preamble += `Content-Disposition: form-data; name="session_id"\r\n\r\n`;
      preamble += `${sessionId}\r\n`;
    }
    preamble += `--${boundary}\r\n`;
    const safeFileName = fileName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    preamble += `Content-Disposition: form-data; name="file"; filename="${safeFileName}"\r\n`;
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

    // Step 3: POST file to CDN upload server
    let uploadResponse;
    try {
      uploadResponse = await request(uploadServer, {
        method: 'POST',
        body: generate(),
        signal,
        headers: {
          'User-Agent': USER_AGENT,
          'Cookie': this._cookieHeader(),
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': String(totalSize),
          'X-CSRF-TOKEN': csrfToken,
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': `${BASE_URL}/file-upload`,
          'Origin': BASE_URL
        },
        headersTimeout: UPLOAD_TIMEOUT,
        bodyTimeout: UPLOAD_TIMEOUT
      });
    } catch (err) {
      if (signal && signal.aborted) throw err;
      throw createTransportError('VOE Upload konnte nicht übertragen werden', {
        phase: 'upload-request',
        endpoint: uploadServer,
        retryable: true,
        transientNetwork: true
      });
    }

    const { body, headers, statusCode } = uploadResponse;

    this._parseCookiesFromHeaders(headers || {});

    const rawBody = await body.text();
    if (statusCode < 200 || statusCode >= 300) {
      throw createTransportError('VOE Upload fehlgeschlagen', {
        phase: 'upload-response',
        endpoint: uploadServer,
        httpStatus: statusCode,
        contentType: headers && headers['content-type'],
        body: rawBody,
        retryable: statusCode === 429 || statusCode >= 500,
        transientNetwork: statusCode >= 500
      });
    }

    // Try JSON response
    try {
      const json = JSON.parse(rawBody);

      // Direct file_code in response
      const fileCode = json.file_code || json.filecode || json.slug ||
        (json.file && (json.file.file_code || json.file.slug)) ||
        (json.data && (json.data.file_code || json.data.slug));

      if (fileCode) {
        return this._buildUrls(fileCode);
      }

      // Check for error
      if (json.error || json.message) {
        throw createTransportError(`VOE Upload-Fehler: ${sanitizeRemoteText(json.error || json.message)}`, {
          phase: 'upload-result',
          endpoint: uploadServer,
          contentType: 'application/json',
          body: rawBody
        });
      }
    } catch (parseErr) {
      if (parseErr && parseErr.diagnostic) throw parseErr;
      // Not JSON - might be a redirect or HTML response
    }

    // Fallback: poll the file list to find the newly uploaded file
    if (baselineCodes) {
      const result = await this._resolveUploadedFile(fileName, baselineCodes, signal);
      if (result) return result;
    }

    if (baselineError) {
      baselineError.hosterTransient = true;
      throw baselineError;
    }

    throw createTransportError('VOE Upload: Kein file_code in der Antwort gefunden', {
      phase: 'upload-result',
      endpoint: uploadServer,
      contentType: headers && headers['content-type'],
      body: rawBody,
      hosterTransient: true,
      retryable: true
    });
  }

  async _resolveUploadedFile(fileName, baselineCodes, signal) {
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
        files = await this._fetchFileList('recovery-poll');
        successfulPoll = true;
      } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        lastPollError = err;
      }

      const withCode = files.filter(f => f && (f.file_code || f.slug));
      const newFiles = withCode.filter(f => !baselineCodes.has(String(f.file_code || f.slug || '').trim()));
      const matches = newFiles.filter(file => {
        const title = this._normalizeTitle(file.title || file.name || '');
        return expectedTitle && title === expectedTitle;
      });

      if (matches.length > 1) return null;
      if (matches.length === 1) {
        const code = matches[0].file_code || matches[0].slug;
        return this._buildUrls(code);
      }

      if (attempt < RESULT_POLL_ATTEMPTS - 1) {
        await this._sleep(RESULT_POLL_DELAY_MS, signal);
      }
    }

    if (!successfulPoll && lastPollError) throw lastPollError;
    return null;
  }

  _normalizeTitle(value) {
    return String(value || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/[^a-z0-9]+/g, '');
  }

  _buildUrls(fileCode) {
    const code = String(fileCode || '').trim();
    if (!code) return null;
    return {
      download_url: `${BASE_URL}/${code}`,
      embed_url: `${BASE_URL}/e/${code}`,
      file_code: code
    };
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
}

module.exports = VoeUploader;
