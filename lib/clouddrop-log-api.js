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
    const user = await this.call('/me', { signal });
    if (typeof user.id !== 'string' || !user.id) throw new CloudLogError('INVALID_RESPONSE');
    const response = await this.request('https://api64.ipify.org?format=json', {
      signal, maxRedirections: 0, headersTimeout: 15000, bodyTimeout: 15000,
      headers: { Accept: 'application/json' }
    });
    const text = await response.body.text();
    let ip;
    try { ip = JSON.parse(text).ip; } catch {}
    if (response.statusCode !== 200 || !isIP(ip || '')) throw new CloudLogError('IP_UNAVAILABLE');
    return { accountId: user.id, ip, folderName: ip.replaceAll(':', '_') };
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
    let created;
    try {
      created = await this.call('/create-file', {
        method: 'POST', signal, idempotencyKey: `mhu-log:${id}`,
        body: { parentId: folderId, name }
      });
    } catch (error) {
      if (error.status !== 409) throw error;
      const existing = await this.call(`/files?parent=${encodeURIComponent(folderId)}&limit=2500&sync=${encodeURIComponent(id)}`, { signal });
      const file = existing.files?.find(item => item.filename === name && item.parentId === folderId && !item.isFolder);
      if (!file) throw error;
      created = { id: file.id, filename: file.filename };
    }
    if (!created.id || created.filename !== name) throw new CloudLogError('INVALID_RESPONSE');
    const listing = await this.call(`/files?parent=${encodeURIComponent(folderId)}&limit=2500&sync=${encodeURIComponent(id)}`, { signal });
    if (!Array.isArray(listing.files) || !listing.files.some(file => file.id === created.id && file.parentId === folderId)) {
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
