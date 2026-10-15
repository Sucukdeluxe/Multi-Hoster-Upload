const { fetch } = require('undici');

async function readBoundedJson(response, maximum = 2 * 1024 * 1024) {
  let length = 0;
  const chunks = [];
  try {
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > maximum) throw new Error('RELAY_RESPONSE_TOO_LARGE');
      chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { await response.body?.cancel().catch(() => {}); throw new Error('INVALID_RELAY_RESPONSE'); }
}

class RelayAgent {
  constructor({ credentials, endpoint, status, request = fetch }) {
    this.credentials = credentials;
    this.endpoint = endpoint;
    this.status = status;
    this.request = request;
    this.abort = new AbortController();
    this.active = new Map();
    this.seen = new Set();
    this.task = null;
  }
  start() { if (!this.task) this.task = this.loop(); }
  async stop() { this.abort.abort(); for (const entry of this.active.values()) entry.abort.abort(); await this.task; }
  async wait(ms) {
    if (this.abort.signal.aborted) return;
    await new Promise(resolve => {
      const done = () => { clearTimeout(timer); this.abort.signal.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, ms);
      this.abort.signal.addEventListener('abort', done, { once: true });
    });
  }
  async loop() {
    let failures = 0;
    while (!this.abort.signal.aborted) {
      try {
        const response = await this.request(`${this.credentials.relayUrl}/v1/agent/${this.credentials.installationId}/poll`, {
          headers: { Authorization: `Bearer ${this.credentials.agentToken}` }, redirect: 'error', signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(30000)])
        });
        if ([401, 403].includes(response.status)) { await response.body?.cancel(); this.status('blocked', this.active.size); return; }
        if (!response.ok) { await response.body?.cancel(); throw new Error('RELAY_POLL_FAILED'); }
        const payload = await readBoundedJson(response);
        if (!Array.isArray(payload.commands) || payload.commands.length > 32 || !Array.isArray(payload.cancellations) || payload.cancellations.length > 1024 || !Array.isArray(payload.closedSessions) || payload.closedSessions.length > 1024) throw new Error('INVALID_RELAY_RESPONSE');
        failures = 0;
        this.status('online', this.active.size);
        for (const id of payload.cancellations) this.active.get(id)?.abort.abort();
        for (const id of payload.closedSessions) {
          for (const entry of this.active.values()) if (entry.sessionId === id) entry.abort.abort();
          this.endpoint.closeSession(id);
        }
        for (const command of payload.commands) this.dispatch(command);
      } catch {
        if (this.abort.signal.aborted) break;
        this.status('offline', this.active.size);
        await this.wait(Math.min(15000, 500 * 2 ** Math.min(failures++, 5)));
      }
    }
  }
  dispatch(command) {
    const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
    if (this.abort.signal.aborted || !command || !validId(command.requestId) || !validId(command.sessionId)
      || !command.message || command.message.jsonrpc !== '2.0' || command.principal?.installationId !== this.credentials.installationId
      || command.principal.id !== `${this.credentials.installationId}:client` || command.principal.role !== 'client'
      || !Number.isFinite(command.deadline) || command.deadline <= Date.now() || command.deadline > Date.now() + 121000
      || Buffer.byteLength(JSON.stringify(command.message)) > 1024 * 1024
      || this.active.size >= 32 || this.seen.has(command.requestId)) return;
    this.seen.add(command.requestId);
    if (this.seen.size > 4096) this.seen.delete(this.seen.values().next().value);
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, this.abort.signal, AbortSignal.timeout(Math.min(120000, command.deadline - Date.now()))]);
    this.active.set(command.requestId, { abort, sessionId: command.sessionId });
    this.status('online', this.active.size);
    void (async () => {
      let response = null;
      try { response = await this.endpoint.handle(command, signal); }
      catch { if (Object.hasOwn(command.message, 'id')) response = { jsonrpc: '2.0', id: command.message.id, error: { code: -32000, message: 'MCP request failed or was cancelled' } }; }
      try {
        if (this.abort.signal.aborted) return;
        const result = await this.request(`${this.credentials.relayUrl}/v1/agent/${this.credentials.installationId}/results`, {
          method: 'POST', headers: { Authorization: `Bearer ${this.credentials.agentToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId: command.requestId, response }), redirect: 'error', signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(15000)])
        });
        await result.body?.cancel();
      } catch { }
      finally { this.active.delete(command.requestId); this.status(this.abort.signal.aborted ? 'offline' : 'online', this.active.size); }
    })();
  }
}

module.exports = { RelayAgent, readBoundedJson };
