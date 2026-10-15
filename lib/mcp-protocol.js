const { McpAccessError } = require('./mcp-access');

function createMcpProtocol({ adapter, version, getCapabilities }) {
  const sessions = new Map();
  const error = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  const response = (id, result) => ({ jsonrpc: '2.0', id, result });
  async function handle(message, context) {
    for (const [key, seen] of sessions) if (Date.now() - seen > 30 * 60 * 1000) sessions.delete(key);
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string' || Array.isArray(message)
      || (message.id !== undefined && typeof message.id !== 'string' && !(typeof message.id === 'number' && Number.isFinite(message.id)))) return error(null, -32600, 'Invalid request');
    if (!context || typeof context.sessionId !== 'string' || typeof context.principalId !== 'string') return error(message.id, -32600, 'Invalid session');
    const sessionKey = context.principalId + ':' + context.sessionId;
    if (message.method === 'initialize') {
      if (message.id === undefined || !message.params || typeof message.params.protocolVersion !== 'string') return error(message.id, -32602, 'Invalid initialization');
      if (sessions.size >= 16 && !sessions.has(sessionKey)) return error(message.id, -32000, 'Session limit');
      sessions.set(sessionKey, Date.now());
      const requested = message.params?.protocolVersion;
      const protocolVersion = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'].includes(requested) ? requested : '2025-11-25';
      return response(message.id, { protocolVersion, capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'multi-hoster-uploader', version }, instructions: 'Tools operate on one running uploader installation. Destructive actions require a local confirmation. Secrets are masked unless explicitly revealed through the separately enabled secret tool.' });
    }
    if (!sessions.has(sessionKey)) return error(message.id, -32000, 'Session not initialized');
    sessions.set(sessionKey, Date.now());
    if (message.method.startsWith('notifications/')) return null;
    if (message.id === undefined) return error(null, -32600, 'Request id required');
    if (message.method === 'ping') return response(message.id, {});
    if (message.method === 'tools/list') return response(message.id, { tools: adapter.list().filter(tool => tool.requiredScopes.every(scope => getCapabilities().includes(scope))).map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations })) });
    if (message.method === 'resources/list') return response(message.id, { resources: getCapabilities().includes('read') ? [{ uri: 'mhu://installation/state', name: 'Uploader state', mimeType: 'application/json' }] : [] });
    if (message.method === 'resources/read' && message.params?.uri === 'mhu://installation/state') {
      try {
        const value = await adapter.call('mhu_app_state', {}, { ...context, scopes: getCapabilities() });
        return response(message.id, { contents: [{ uri: 'mhu://installation/state', mimeType: 'application/json', text: JSON.stringify(value) }] });
      } catch { return error(message.id, -32000, 'Resource unavailable'); }
    }
    if (message.method === 'prompts/list') return response(message.id, { prompts: [] });
    if (message.method === 'prompts/get') return error(message.id, -32602, 'Unknown prompt');
    if (message.method !== 'tools/call') return error(message.id, -32601, 'Method not found');
    try {
      const result = await adapter.call(message.params?.name, message.params?.arguments ?? {}, { ...context, scopes: getCapabilities() });
      return response(message.id, { content: [{ type: 'text', text: JSON.stringify(result ?? null) }], isError: false });
    } catch (failure) {
      const code = failure instanceof McpAccessError ? failure.code : 'ACTION_FAILED';
      return response(message.id, { content: [{ type: 'text', text: code }], isError: true });
    }
  }
  return { handle, closeSession: (principalId, sessionId) => sessions.delete(principalId + ':' + sessionId), reset: () => sessions.clear() };
}

module.exports = { createMcpProtocol };
