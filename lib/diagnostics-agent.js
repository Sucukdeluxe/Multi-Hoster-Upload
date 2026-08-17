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

  function handle(op, args) {
    const fn = (typeof op === 'string' && Object.prototype.hasOwnProperty.call(OPS, op)) ? OPS[op] : null;
    if (typeof fn !== 'function') return { ok: false, error: `unknown or non-readonly op: ${op}` };
    try {
      const data = fn(args || {});
      if (data && data.ok === false) return data;
      return { ok: true, data };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  return { handle, ops: Object.keys(OPS) };
}

module.exports = { createAgent };
