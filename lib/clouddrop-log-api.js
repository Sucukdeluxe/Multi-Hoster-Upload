const { request } = require('undici');
const { isIP } = require('node:net');

class CloudLogError extends Error {
  constructor(code, status = 0) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

class ClouddropLogApi {
  constructor(apiKey, options = {}) {
    this.apiKey = String(apiKey || '').trim();
    this.request = options.request || request;
  }

  async call(route, { method = 'GET', body, signal, idempotencyKey } = {}) {
    const response = await this.request(`https://clouddrop.cc/api/cloud${route}`, {
      method, signal, maxRedirections: 0, headersTimeout: 20000, bodyTimeout: 20000,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'Multi-Hoster-Upload Log Sync',
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {})
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        response.body.destroy();
        throw new CloudLogError('RESPONSE_TOO_LARGE');
      }
      chunks.push(chunk);
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      const code = response.statusCode === 401 ? 'INVALID_KEY'
        : response.statusCode === 403 ? 'ACCESS_DENIED'
          : response.statusCode === 429 ? 'RATE_LIMIT' : 'REMOTE_ERROR';
      throw new CloudLogError(code, response.statusCode);
    }
    let data;
    try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new CloudLogError('INVALID_RESPONSE', response.statusCode); }
    return data;
  }

  async identify(signal) {
    if (!/^cd_[a-f0-9]{32}$/.test(this.apiKey)) throw new CloudLogError('INVALID_KEY');
    const authorization = await this.call('/upload-token', { signal });
    const token = authorization?.token;
    if (typeof token !== 'string' || token.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(token)) {
      throw new CloudLogError('INVALID_RESPONSE');
    }
    const [accountId, expires, signature, extra] = Buffer.from(token, 'base64url').toString('utf8').split(':');
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(accountId || '') || !/^\d{13}$/.test(expires || '')
      || Number(expires) <= Date.now() || !/^[a-f0-9]{64}$/.test(signature || '') || extra !== undefined) {
      throw new CloudLogError('INVALID_RESPONSE');
    }
    for (const endpoint of ['https://api.ipify.org?format=json', 'https://api64.ipify.org?format=json']) {
      try {
        const response = await this.request(endpoint, {
          signal, maxRedirections: 0, headersTimeout: 10000, bodyTimeout: 10000,
          headers: { Accept: 'application/json' }
        });
        const text = await response.body.text();
        const ip = JSON.parse(text).ip;
        if (response.statusCode === 200 && isIP(ip || '')) return { accountId, ip, folderName: ip };
      } catch {
        if (signal?.aborted) throw new CloudLogError('IP_UNAVAILABLE');
      }
    }
    throw new CloudLogError('IP_UNAVAILABLE');
  }

  async ensureFolder(name, signal) {
    const folders = await this.call('/folders?limit=5000', { signal });
    if (!Array.isArray(folders)) throw new CloudLogError('INVALID_RESPONSE');
    const existing = folders.find(folder => folder.name === name && !folder.parentId);
    if (existing) return String(existing.id);
    try {
      const created = await this.call('/folder', { method: 'POST', signal, body: { name, parentId: null } });
      if (!created.id || created.file?.parentId) throw new CloudLogError('UNRESTRICTED_KEY_REQUIRED');
      return String(created.id);
    } catch (error) {
      if (error.status !== 409) throw error;
      const refreshed = await this.call('/folders?limit=5000', { signal });
      const folder = refreshed.find(item => item.name === name && !item.parentId);
      if (!folder) throw new CloudLogError('UNRESTRICTED_KEY_REQUIRED');
      return String(folder.id);
    }
  }

  async createFile(folderId, name, id, signal) {
    const verificationRoute = `/check-duplicate?parent=${encodeURIComponent(folderId)}&filename=${encodeURIComponent(name)}`;
    let created;
    try {
      created = await this.call('/create-file', {
        method: 'POST', signal, idempotencyKey: `mhu-log:${id}`,
        body: { parentId: folderId, name }
      });
    } catch (error) {
      if (error.status !== 409) throw error;
      const existing = await this.call(verificationRoute, { signal });
      if (!existing.exists || !existing.existingId) throw error;
      created = { id: existing.existingId, filename: name };
    }
    if (!created.id || created.filename !== name) throw new CloudLogError('INVALID_RESPONSE');
    const verification = await this.call(verificationRoute, { signal });
    if (verification.exists !== true || verification.existingId !== created.id) {
      throw new CloudLogError('UNRESTRICTED_KEY_REQUIRED');
    }
    return String(created.id);
  }

  async writeFile(id, content, signal) {
    const data = await this.call(`/files/${encodeURIComponent(id)}/content`, {
      method: 'PUT', signal, body: { content }
    });
    if (data.ok !== true || data.size !== Buffer.byteLength(content)) throw new CloudLogError('INVALID_RESPONSE');
  }

  async readFile(id, signal) {
    return this.call(`/files/${encodeURIComponent(id)}/content`, { signal });
  }
}

module.exports = { ClouddropLogApi, CloudLogError };
