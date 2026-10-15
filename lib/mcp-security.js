const { McpAccessError } = require('./mcp-access');

function createMcpSanitizer(loadConfig) {
  return value => {
    const config = loadConfig();
    if (!config || typeof config !== 'object') throw new McpAccessError('REDACTION_UNAVAILABLE');
    const secrets = new Set();
    const sensitive = /password|passwd|api.?key|token|cookie|sess(?:ion)?(?:id|_id)?|secret|authorization|credential|connectionCode|webhookUrl|^key$/i;
    const gather = node => {
      if (!node || typeof node !== 'object') return;
      for (const [key, item] of Object.entries(node)) {
        if (sensitive.test(key) && typeof item === 'string' && item) secrets.add(item);
        else if (item && typeof item === 'object') gather(item);
      }
    };
    gather(config);
    const values = [...secrets].sort((a, b) => b.length - a.length);
    const visit = (node, depth = 0) => {
      if (depth > 16) throw new McpAccessError('RESULT_TOO_LARGE');
      if (typeof node === 'string') {
        let result = node.replace(/(?:Bearer\s+\S+|media-mcp:v1:[A-Za-z0-9_-]+|MHU[12]-[A-Za-z0-9_-]+)/gi, '\0')
          .replace(/((?:password|passwd|api[_-]?key|access[_-]?token|secret|sess_id)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1\0');
        for (const secret of values) result = result.split(secret).join('\0');
        return result.replaceAll('\0', '[REDACTED]');
      }
      if (Array.isArray(node)) return node.map(item => visit(item, depth + 1));
      if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([key, item]) => [key, sensitive.test(key) ? '[REDACTED]' : visit(item, depth + 1)]));
      return node;
    };
    return visit(value);
  };
}

function createMcpConfirmation({ dialog, getWindow, getName, sanitize, now = Date.now, ttl = 60000 }) {
  return async ({ tool, args, context }) => {
    if (context.signal?.aborted) return false;
    const until = Math.min(context.deadline, now() + ttl);
    if (until <= now()) return false;
    const abort = new AbortController();
    const cancel = () => abort.abort();
    context.signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, until - now());
    try {
      const details = JSON.stringify(sanitize(args), null, 2).slice(0, 3000);
      const options = {
        type: 'warning', title: 'MCP – Lokale Freigabe / Local approval',
        message: `${getName()}\n${tool}`,
        detail: `Diese konkrete Fernaktion ausführen? / Run this exact remote action?\n${details}\n\nDie Freigabe läuft nach spätestens 60 Sekunden ab. / Approval expires within 60 seconds.`,
        buttons: ['Abbrechen / Cancel', 'Einmal erlauben / Allow once'], defaultId: 0, cancelId: 0, noLink: true, signal: abort.signal
      };
      const window = getWindow();
      const result = window && !window.isDestroyed() ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
      return result.response === 1 && !abort.signal.aborted && now() < until;
    } catch { return false; }
    finally { clearTimeout(timer); context.signal?.removeEventListener('abort', cancel); }
  };
}

module.exports = { createMcpSanitizer, createMcpConfirmation };
