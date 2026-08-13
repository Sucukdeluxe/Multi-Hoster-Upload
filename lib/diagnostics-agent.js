const { valueScrub } = require('./support-bundle');

function createAgent(collectors) {
  const OPS = {
    get_system_info: (a) => collectors.getSystemInfo(a),
    server_health: (a) => collectors.serverHealth(a),
    get_config_redacted: (a) => collectors.getConfigRedacted(a),
    list_logs: () => collectors.listLogs(),
    read_log: (a) => collectors.readLog(a),
    tail_log: (a) => collectors.readLog(a),
    get_app_events: (a) => collectors.getAppEvents(a),
    list_errors: (a) => collectors.listErrors(a),
    get_queue_state: (a) => collectors.getQueueState(a),
    get_history: (a) => collectors.getHistory(a),
    get_rotation_state: () => collectors.getRotationState(),
    get_health: () => collectors.getHealth()
  };

  function redactResponse(value) {
    try {
      const redacted = typeof collectors.redactResponse === 'function'
        ? collectors.redactResponse(value)
        : valueScrub(value, []);
      const response = valueScrub(redacted, []);
      if (!response || typeof response !== 'object' || Array.isArray(response)) throw new Error('invalid redaction result');
      return response;
    } catch {
      return { ok: false, error: 'diagnostic response could not be safely returned' };
    }
  }

  function handle(op, args) {
    const fn = (typeof op === 'string' && Object.prototype.hasOwnProperty.call(OPS, op)) ? OPS[op] : null;
    if (typeof fn !== 'function') return redactResponse({ ok: false, error: `unknown or non-readonly op: ${op}` });
    try {
      const data = fn(args || {});
      if (data && data.ok === false) return redactResponse(data);
      return redactResponse({ ok: true, data });
    } catch (e) {
      return redactResponse({ ok: false, error: String((e && e.message) || e) });
    }
  }

  return { handle, ops: Object.keys(OPS) };
}

module.exports = { createAgent };
