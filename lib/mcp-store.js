const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
const { McpAccessError } = require('./mcp-access');

const RELAY_URL = 'https://downloader.24-music.de/mcp-relay';
const CAPABILITIES = ['read', 'control', 'files', 'secrets', 'updates'];

class McpStore {
  constructor({ directory, encrypt, decrypt }) {
    this.file = path.join(directory, 'mcp-access.json');
    this.disabledMarker = path.join(directory, 'mcp-disabled.marker');
    this.encrypt = encrypt;
    this.decrypt = decrypt;
    this.value = { version: 1, enabled: false, name: 'Multi-Hoster-Uploader', capabilities: ['read'], grants: [], identity: null, revocations: [] };
    this.tail = Promise.resolve();
  }
  async load() {
    const disabled = await fs.stat(this.disabledMarker).then(() => true, error => { if (error.code === 'ENOENT') return false; throw new McpAccessError('ACCESS_STORE_UNAVAILABLE'); });
    try {
      const text = await fs.readFile(this.file, 'utf8');
      if (text.length > 100000) throw new Error('size');
      const value = JSON.parse(text);
      if (value.version !== 1 || !Array.isArray(value.capabilities) || !Array.isArray(value.grants) || !Array.isArray(value.revocations)) throw new Error('format');
      if (typeof value.enabled !== 'boolean' || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 100
        || value.capabilities.some(item => !CAPABILITIES.includes(item)) || value.grants.length > 30 || value.revocations.length > 32
        || value.grants.some(grant => !grant || typeof grant.id !== 'string' || typeof grant.path !== 'string' || !path.isAbsolute(grant.path)
          || typeof grant.label !== 'string' || typeof grant.readOnly !== 'boolean'
          || (grant.allowTransfer !== undefined && typeof grant.allowTransfer !== 'boolean'))) throw new Error('format');
      const decode = identity => {
        if (!identity) return null;
        if (identity.relayUrl !== RELAY_URL || !/^[a-f0-9-]{36}$/.test(identity.installationId)) throw new Error('identity');
        if (!identity.agentToken?.startsWith('enc:v1:') || !identity.clientToken?.startsWith('enc:v1:')) throw new Error('encryption');
        const decoded = { ...identity, agentToken: this.decrypt(identity.agentToken), clientToken: this.decrypt(identity.clientToken) };
        if (![decoded.agentToken, decoded.clientToken].every(token => /^[A-Za-z0-9_-]{43}$/.test(token)) || decoded.agentToken === decoded.clientToken) throw new Error('credentials');
        return decoded;
      };
      this.value = { ...value, capabilities: value.capabilities.filter(item => CAPABILITIES.includes(item)), identity: decode(value.identity), revocations: value.revocations.map(decode) };
      if (disabled) {
        this.value.enabled = false;
        if (this.value.identity) {
          if (!this.value.revocations.some(identity => identity.installationId === this.value.identity.installationId)) this.value.revocations.push(this.value.identity);
          this.value.identity = null;
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw new McpAccessError('ACCESS_STORE_UNAVAILABLE');
    }
    return this.value;
  }
  async markDisabled() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const handle = await fs.open(this.disabledMarker, 'w', 0o600);
    try { await handle.writeFile('disabled\n'); await handle.sync(); }
    finally { await handle.close(); }
  }
  async clearDisabled() { await fs.unlink(this.disabledMarker).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  async save(next) {
    const encode = identity => identity ? { ...identity, agentToken: this.encrypt(identity.agentToken), clientToken: this.encrypt(identity.clientToken) } : null;
    const disk = { ...next, identity: encode(next.identity), revocations: next.revocations.map(encode) };
    for (const identity of [disk.identity, ...disk.revocations].filter(Boolean)) {
      if (!identity.agentToken.startsWith('enc:v1:') || !identity.clientToken.startsWith('enc:v1:')) throw new McpAccessError('ENCRYPTION_UNAVAILABLE');
    }
    const task = this.tail.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const temporary = this.file + '.' + randomUUID() + '.tmp';
      try { await fs.writeFile(temporary, JSON.stringify(disk), { mode: 0o600, flag: 'wx' }); await fs.rename(temporary, this.file); }
      finally { await fs.unlink(temporary).catch(() => {}); }
      this.value = next;
    });
    this.tail = task.catch(() => {});
    return task;
  }
  newIdentity() { return { relayUrl: RELAY_URL, installationId: randomUUID(), agentToken: randomBytes(32).toString('base64url'), clientToken: randomBytes(32).toString('base64url') }; }
  code() {
    const value = this.value;
    if (!value.enabled || !value.identity) throw new McpAccessError('NOT_ENABLED');
    const identity = value.identity;
    return 'media-mcp:v1:' + Buffer.from(JSON.stringify({ v: 1, url: `${identity.relayUrl}/mcp/${identity.installationId}`, installationId: identity.installationId, kind: 'uploader', name: value.name, token: identity.clientToken })).toString('base64url');
  }
}

module.exports = { McpStore, RELAY_URL, CAPABILITIES };
