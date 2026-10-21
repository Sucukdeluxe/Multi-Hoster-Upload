const fs = require('node:fs/promises');
const path = require('node:path');
const { fetch } = require('undici');
const { McpStore, CAPABILITIES } = require('./mcp-store');
const { RelayAgent } = require('./mcp-relay');
const { createMcpProtocol } = require('./mcp-protocol');
const { createMcpToolAdapter } = require('./mcp-tools');
const { createMcpSanitizer, createMcpConfirmation } = require('./mcp-security');
const { McpAccessError, validateInput } = require('./mcp-access');
const { randomUUID } = require('node:crypto');

class McpService {
  constructor(options) {
    this.options = options;
    this.store = new McpStore(options);
    this.request = options.request || fetch;
    this.active = false;
    this.connection = 'disabled';
    this.agent = null;
    this.lastContact = null;
    this.activeRequests = 0;
    this.tail = Promise.resolve();
    this.ready = false;
    this.retryTimer = null;
    this.protocol = null;
    this.generation = 0;
  }
  capabilities() {
    if (!this.active) return [];
    return this.store.value.capabilities.includes('full_access') ? [...CAPABILITIES] : this.store.value.capabilities;
  }
  state() {
    const { name, capabilities, grants, enabled, identity, revocations } = this.store.value;
    return { name, capabilities, grants, enabled: this.active && enabled, connection: this.connection, installationId: identity?.installationId || null,
      lastContact: this.lastContact, activeRequests: this.activeRequests, pendingRevocations: revocations.length, available: this.ready };
  }
  publish() { this.options.onStatus?.(this.state()); }
  async start() {
    try {
      await this.store.load();
      this.ready = true;
      await this.retryRevocations();
      if (this.store.value.enabled && this.store.value.identity) this.connect();
      this.retryTimer = setInterval(() => { void this.serialize(() => this.retryRevocations()).catch(() => {}); }, 30000);
      this.retryTimer.unref?.();
    } catch { this.connection = 'storage-error'; }
    this.publish();
  }
  serialize(action) { const task = this.tail.then(action); this.tail = task.catch(() => {}); return task; }
  connect() {
    const identity = this.store.value.identity;
    const sanitize = createMcpSanitizer(this.options.loadConfig);
    const confirmation = createMcpConfirmation({ dialog: this.options.dialog, getWindow: this.options.getWindow, getName: () => this.store.value.name, sanitize });
    const adapter = createMcpToolAdapter({ handlers: this.options.handlers, getCapabilities: () => this.capabilities(), sanitize,
      authorizeConfirmation: confirmation, requiresConfirmation: this.options.requiresConfirmation,
      audit: event => this.options.audit?.({ ...event, installationId: identity.installationId }) });
    this.protocol = createMcpProtocol({ adapter, version: this.options.version, getCapabilities: () => this.capabilities() });
    this.active = true;
    this.connection = 'connecting';
    const protocol = this.protocol;
    this.agent = new RelayAgent({ credentials: identity, request: this.request,
      endpoint: { handle: (command, signal) => protocol.handle(command.message, { principalId: command.principal.id, sessionId: command.sessionId, requestId: command.requestId, deadline: command.deadline, signal }),
        closeSession: id => protocol.closeSession(`${identity.installationId}:client`, id) },
      status: (state, count) => { if (!this.active) return; this.connection = state; this.activeRequests = count; if (state === 'online') this.lastContact = new Date().toISOString(); this.publish(); }
    });
    this.agent.start();
    this.publish();
  }
  async disconnect() {
    this.active = false;
    this.protocol?.reset();
    this.connection = 'disabled';
    const agent = this.agent; this.agent = null;
    this.publish();
    await Promise.all([agent?.stop(), this.options.handlers?.dispose?.()]);
  }
  async retryRevocations() {
    const pending = this.store.value.revocations;
    if (!pending.length) return;
    const retained = [];
    for (const identity of pending) {
      try {
        const response = await this.request(`${identity.relayUrl}/v1/agent/${identity.installationId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${identity.agentToken}` }, redirect: 'error', signal: AbortSignal.timeout(5000) });
        await response.body?.cancel();
        if (!response.ok && ![401, 404].includes(response.status)) retained.push(identity);
      } catch { retained.push(identity); }
    }
    if (retained.length !== pending.length) await this.store.save({ ...this.store.value, revocations: retained });
  }
  configure(args) {
    validateInput(args, { type: 'object', additionalProperties: false, required: ['enabled', 'name', 'capabilities'], properties: {
      enabled: { type: 'boolean' }, name: { type: 'string', minLength: 1, maxLength: 100 }, capabilities: { type: 'array', maxItems: CAPABILITIES.length, items: { type: 'string', enum: CAPABILITIES } }
    } });
    if (!args.name.trim()) throw new McpAccessError('INVALID_ARGUMENTS');
    this.active = false;
    this.agent?.abort.abort();
    const generation = ++this.generation;
    const disabled = this.store.markDisabled().then(() => null, error => error);
    return this.serialize(async () => {
      const markerError = await disabled;
      if (markerError) throw markerError;
      if (generation !== this.generation) return this.state();
      if (!this.ready) throw new McpAccessError('ACCESS_STORE_UNAVAILABLE');
      await this.disconnect();
      let current = this.store.value;
      const capabilities = [...new Set(args.capabilities)];
      if (!args.enabled) {
        if (current.identity && current.revocations.length >= 32) throw new McpAccessError('REVOCATIONS_PENDING');
        await this.store.save({ ...current, enabled: false, identity: null, revocations: [...current.revocations, ...current.identity ? [current.identity] : []], name: args.name.trim(), capabilities });
        await this.retryRevocations(); this.publish(); return this.state();
      }
      if (!capabilities.length) throw new McpAccessError('CAPABILITY_REQUIRED');
      if (current.revocations.length >= 32) throw new McpAccessError('REVOCATIONS_PENDING');
      const identity = current.identity || this.store.newIdentity();
      await this.store.save({ ...current, identity, enabled: false, name: args.name.trim(), capabilities });
      if (!current.identity) {
        try {
          const response = await this.request(`${identity.relayUrl}/v1/installations`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ installationId: identity.installationId, kind: 'uploader', name: args.name.trim(), agentToken: identity.agentToken, clientToken: identity.clientToken }), redirect: 'error', signal: AbortSignal.timeout(15000) });
          await response.body?.cancel();
          if (response.status !== 201) throw new Error('enrollment');
        } catch {
          await this.store.save({ ...this.store.value, identity: null, revocations: [...this.store.value.revocations, identity] });
          this.connection = 'enrollment-error'; this.publish(); throw new McpAccessError('ENROLLMENT_FAILED');
        }
      }
      await this.store.save({ ...this.store.value, enabled: true });
      if (generation !== this.generation) return this.state();
      await this.store.clearDisabled();
      this.connect(); return this.state();
    });
  }
  async rotate() {
    const current = this.store.value;
    const args = { enabled: true, name: current.name, capabilities: current.capabilities };
    await this.configure({ ...args, enabled: false });
    return this.configure(args);
  }
  addGrant(directory) {
    return this.serialize(async () => {
      if (!this.ready || this.store.value.grants.length >= 30) throw new McpAccessError('GRANT_LIMIT');
      const resolved = await fs.realpath(directory);
      const stat = await fs.stat(resolved);
      if (!stat.isDirectory() || path.parse(resolved).root === resolved) throw new McpAccessError('PATH_NOT_GRANTED');
      if (!this.store.value.grants.some(grant => grant.path === resolved)) await this.store.save({ ...this.store.value, grants: [...this.store.value.grants, { id: randomUUID(), label: path.basename(resolved), path: resolved, readOnly: true, allowTransfer: false }] });
      this.publish(); return this.state();
    });
  }
  grantDirectory(directory, { readOnly = true, allowTransfer = false } = {}) {
    return this.serialize(async () => {
      if (!this.ready) throw new McpAccessError('ACCESS_STORE_UNAVAILABLE');
      if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new McpAccessError('PATH_NOT_GRANTED');
      const resolved = await fs.realpath(directory).catch(() => { throw new McpAccessError('PATH_NOT_GRANTED'); });
      const stat = await fs.stat(resolved);
      if (!stat.isDirectory() || path.parse(resolved).root === resolved) throw new McpAccessError('PATH_NOT_GRANTED');
      const existing = this.store.value.grants.find(grant => grant.path === resolved);
      if (existing && ((existing.readOnly === false && readOnly) || (existing.allowTransfer === true && !allowTransfer))) throw new McpAccessError('GRANT_NARROWING_LOCAL_ONLY');
      if (!existing && this.store.value.grants.length >= 30) throw new McpAccessError('GRANT_LIMIT');
      const grant = existing ? { ...existing, readOnly, allowTransfer } : { id: randomUUID(), label: path.basename(resolved), path: resolved, readOnly, allowTransfer };
      await this.store.save({ ...this.store.value, grants: existing ? this.store.value.grants.map(item => item.id === existing.id ? grant : item) : [...this.store.value.grants, grant] });
      this.publish();
      return { id: grant.id, label: grant.label, readOnly: grant.readOnly, allowTransfer: grant.allowTransfer };
    });
  }
  updateGrant(id, remove, readOnly = true, allowTransfer) {
    const generation = this.generation;
    return this.serialize(async () => {
      const wasActive = this.active;
      await this.disconnect();
      await this.store.markDisabled();
      const grants = this.store.value.grants.flatMap(grant => grant.id !== id ? [grant] : remove ? [] : [{ ...grant, readOnly, ...(allowTransfer === undefined ? {} : { allowTransfer }) }]);
      await this.store.save({ ...this.store.value, grants });
      if (wasActive && generation === this.generation) { await this.store.clearDisabled(); this.connect(); }
      this.publish(); return this.state();
    });
  }
  async stop() { clearInterval(this.retryTimer); await this.disconnect(); }
}

module.exports = { McpService };
