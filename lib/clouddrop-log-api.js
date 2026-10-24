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
      if (size > 10 * 1024 * 1024) {
        response.body.destroy();
        throw new CloudLogError('RESPONSE_TOO_LARGE');
      }
      chunks.push(chunk);
    }
    let data;
    try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch {
      if (response.statusCode >= 200 && response.statusCode < 300) {
        throw new CloudLogError('INVALID_RESPONSE', response.statusCode);
      }
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      const code = response.statusCode === 401 ? 'INVALID_KEY'
        : response.statusCode === 403 ? 'ACCESS_DENIED'
          : response.statusCode === 429 ? 'RATE_LIMIT'
            : response.statusCode === 428 ? 'REVISION_REQUIRED'
              : response.statusCode === 423 ? 'REMOTE_FILE_LOCKED'
                : response.statusCode === 409 && data?.code === 'CONTENT_CHANGED' ? 'REMOTE_CONTENT_CHANGED'
                  : 'REMOTE_ERROR';
      throw new CloudLogError(code, response.statusCode);
    }
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
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await this.readFile(id, signal);
      if (current?.writable === false) throw new CloudLogError('ACCESS_DENIED');
      if (typeof current?.content !== 'string' || !/^[a-f0-9]{64}$/.test(current.revision || '')) {
        throw new CloudLogError('INVALID_RESPONSE');
      }
      if (!content.startsWith(current.content)) throw new CloudLogError('REMOTE_CONTENT_CHANGED');
      try {
        const data = await this.call(`/files/${encodeURIComponent(id)}/content`, {
          method: 'PUT', signal, body: { content, revision: current.revision }
        });
        if (data?.ok !== true || data.size !== Buffer.byteLength(content)) throw new CloudLogError('INVALID_RESPONSE');
        return;
      } catch (error) {
        if (error.code !== 'REMOTE_CONTENT_CHANGED' || attempt === 2) throw error;
      }
    }
  }

  async readFile(id, signal) {
    return this.call(`/files/${encodeURIComponent(id)}/content`, { signal });
  }
}

module.exports = { ClouddropLogApi, CloudLogError };
