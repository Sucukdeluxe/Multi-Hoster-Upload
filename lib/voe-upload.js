const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { request } = require('undici');

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
    const res = await this._fetch(`${BASE_URL}/engine/delivery-node`, {
      headers: {
        'X-CSRF-TOKEN': csrfToken,
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json'
      }
    });
    const body = await res.text();
    let data;
    try { data = JSON.parse(body); } catch {
      throw new Error(`VOE: Upload-Server Antwort war kein JSON: ${body.slice(0, 200)}`);
    }

    if (!data || !data.success || !data.server) {
      throw new Error('VOE: Kein Upload-Server erhalten von delivery-node');
    }

    return { uploadServer: data.server, sessionId: data.session_id || '' };
  }

  /**
   * List current files via VOE API (for result polling fallback)
   */
  async _fetchFileList() {
    try {
      const res = await this._fetch(`${BASE_URL}/api2/my-files?sort=date&order=dsc&page=1&per_page=50`);
      const body = await res.text();
      const data = JSON.parse(body);
      if (data && Array.isArray(data.data)) return data.data;
      if (data && Array.isArray(data.files)) return data.files;
      return [];
    } catch {
      return [];
    }
  }

  async _captureFileCodes() {
    try {
      const files = await this._fetchFileList();
      return new Set(files.map(f => String(f.file_code || f.slug || '').trim()).filter(Boolean));
    } catch {
      return new Set();
    }
  }

  /**
   * Upload a file to VOE.sx via login session
   * Flow: GET delivery-node → POST file to CDN server
   */
  async upload(filePath, onProgress, signal, throttle) {
    const fileName = path.basename(filePath);
    const fileSize = fs.statSync(filePath).size;
    const baselineCodes = await this._captureFileCodes();

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
    const { body, headers } = await request(uploadServer, {
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

    this._parseCookiesFromHeaders(headers || {});

    const rawBody = await body.text();

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
        throw new Error(`VOE Upload-Fehler: ${json.error || json.message}`);
      }
    } catch (parseErr) {
      if (parseErr.message.startsWith('VOE Upload-Fehler')) throw parseErr;
      // Not JSON - might be a redirect or HTML response
    }

    // Fallback: poll the file list to find the newly uploaded file
    const result = await this._resolveUploadedFile(fileName, baselineCodes, signal);
    if (result) return result;

    throw new Error('VOE Upload: Kein file_code in der Antwort gefunden');
  }

  async _resolveUploadedFile(fileName, baselineCodes, signal) {
    const expectedTitle = this._normalizeTitle(path.parse(fileName).name);

    for (let attempt = 0; attempt < RESULT_POLL_ATTEMPTS; attempt++) {
      if (signal && signal.aborted) {
        const err = new Error('Aborted');
        err.name = 'AbortError';
        throw err;
      }

      let files = [];
      try {
        files = await this._fetchFileList();
      } catch { files = []; }

      const withCode = files.filter(f => f && (f.file_code || f.slug));
      const newFiles = withCode.filter(f => !baselineCodes.has(String(f.file_code || f.slug || '').trim()));

      if (newFiles.length > 0) {
        // Try to match by title
        let best = null;
        let bestScore = -1;

        for (const file of newFiles) {
          const score = this._scoreCandidate(file, expectedTitle);
          if (score > bestScore) {
            bestScore = score;
            best = file;
          }
        }

        if (best && (bestScore > 0 || newFiles.length === 1)) {
          const code = best.file_code || best.slug;
          return this._buildUrls(code);
        }
      }

      if (attempt < RESULT_POLL_ATTEMPTS - 1) {
        await this._sleep(RESULT_POLL_DELAY_MS, signal);
      }
    }

    return null;
  }

  _normalizeTitle(value) {
    return String(value || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '');
  }

  _scoreCandidate(file, expectedTitle) {
    if (!file || !(file.file_code || file.slug)) return -1;
    if (!expectedTitle) return 0;

    const title = this._normalizeTitle(file.title || file.name || '');
    if (!title) return -1;
    if (title === expectedTitle) return 120;
    if (title.startsWith(expectedTitle) || expectedTitle.startsWith(title)) return 90;
    if (title.includes(expectedTitle) || expectedTitle.includes(title)) return 70;
    return 0;
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
