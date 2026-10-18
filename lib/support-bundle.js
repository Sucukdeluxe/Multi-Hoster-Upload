const fs = require('fs');

const CRED_KEYS = new Set(['password', 'apiKey', 'token', 'cookie', 'sessionId', 'webhookUrl', 'diagToken']);
const REDACTED = '<redacted>';

function sanitizeConfig(config) {
  if (!config || typeof config !== 'object') return config;
  const clone = JSON.parse(JSON.stringify(config));
  (function walk(o) {
    if (!o) return;
    if (Array.isArray(o)) { for (const e of o) walk(e); return; }
    if (typeof o !== 'object') return;
    for (const k of Object.keys(o)) {
      if (CRED_KEYS.has(k) && typeof o[k] === 'string' && o[k]) o[k] = REDACTED;
      else walk(o[k]);
    }
  })(clone);
  return clone;
}

function collectSecretValues(config) {
  const out = new Set();
  (function walk(o) {
    if (!o) return;
    if (Array.isArray(o)) { for (const e of o) walk(e); return; }
    if (typeof o !== 'object') return;
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (CRED_KEYS.has(k) && typeof v === 'string' && v.length >= 6) out.add(v);
      else walk(v);
    }
  })(config);
  return Array.from(out);
}

function redactLogText(text, secrets) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  if (Array.isArray(secrets)) {
    for (const s of secrets) {
      if (typeof s === 'string' && s.length >= 6) out = out.split(s).join(REDACTED);
    }
  }
  out = out
    .replace(/("(?:file|fileName|stagedFile|sourceFile|targetFile|path|[A-Za-z0-9_]*Path)"\s*:\s*")[^"]*(")/gi, '$1<redacted-path>$2')
    .replace(/\b[A-Za-z]:(?:\\+|\/+)[^\r\n"'<>|]*?(?=\s+(?:trigger|error|outcome|hoster|attempt|status|code)=|\r?\n|$|["'])/gi, '<redacted-path>')
    .replace(/\\{2,}[A-Za-z0-9._$-]+\\+[^\r\n"'<>|]*?(?=\s+(?:trigger|error|outcome|hoster|attempt|status|code)=|\r?\n|$|["'])/g, '<redacted-path>')
    .replace(/https?:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+/gi, 'https://discord.com/api/webhooks/' + REDACTED)
    .replace(/(\/\/[^\s/:@]+:)[^\s/@]+(@)/g, '$1' + REDACTED + '$2')
    .replace(/(authorization:\s*(?:bearer|basic)\s+)\S+/gi, '$1' + REDACTED)
    .replace(/\bbearer\s+[A-Za-z0-9._\-/+]{16,}/gi, 'bearer ' + REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/g, REDACTED)
    .replace(/([?&](?:api_?key|key|token|access_token|password|pass)=)[^\s&"'`]+/gi, '$1' + REDACTED)
    .replace(/("?\b(?:api[_-]?key|apikey|password|passwd|secret|(?:access|refresh|auth|session)[_-]?token|token|sessionid|session)"?\s*[:=]\s*"?)[A-Za-z0-9._\-/+]{8,}/gi, '$1' + REDACTED)
    .replace(/(\bset-cookie:|\bcookie:)\s*\S[^\n]*/gi, '$1 ' + REDACTED)
    .replace(/(\bsess(?:_?id)?\b["'=:\s]+)[A-Za-z0-9._\-]{8,}/gi, '$1' + REDACTED);
  return out;
}

function valueScrub(value, secrets) {
  if (value === null || value === undefined) return value;
  const json = JSON.stringify(value);
  let scrubbed = json;
  if (Array.isArray(secrets)) {
    for (const s of secrets) {
      if (typeof s === 'string' && s.length >= 6) scrubbed = scrubbed.split(s).join(REDACTED);
    }
  }
  return JSON.parse(scrubbed);
}

async function collectFileSnapshot(filePath, label, maxBytes, options) {
  const includePath = !options || options.includePath !== false;
  const signal = options?.signal;
  if (!filePath) return { text: `=== ${label} ===\n<no path configured>\n\n`, sizeBytes: null };
  let stat;
  let file;
  try {
    signal?.throwIfAborted();
    try {
      file = await fs.promises.open(filePath, 'r');
      stat = await file.stat();
    } catch (err) {
      signal?.throwIfAborted();
      const context = includePath ? ` (${filePath})` : '';
      const message = err?.code === 'ENOENT' ? '<file does not exist yet>' : `<stat error: ${err.message}>`;
      return { text: `=== ${label}${context} ===\n${message}\n\n`, sizeBytes: null };
    }
    const cap = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.max(1, Math.floor(maxBytes)) : 5 * 1024 * 1024;
    let content;
    try {
      signal?.throwIfAborted();
      if (!stat.isFile()) throw new Error('Not a regular file');
      const size = Math.min(stat.size, cap);
      const start = Math.max(0, stat.size - size);
      const buffer = Buffer.alloc(size);
      let offset = 0;
      while (offset < size) {
        signal?.throwIfAborted();
        const { bytesRead } = await file.read(buffer, offset, Math.min(size - offset, 256 * 1024), start + offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      signal?.throwIfAborted();
      content = (start > 0 ? `<truncated: skipped first ${start} bytes; showing last ${size} bytes of ${stat.size}>\n` : '') + buffer.subarray(0, offset).toString('utf-8');
    } catch (err) {
      signal?.throwIfAborted();
      content = `<read error: ${err.message}>`;
    }
    const metadata = includePath ? `${filePath}, size=${stat.size} bytes` : `size=${stat.size} bytes`;
    return { text: `=== ${label} (${metadata}) ===\n${content}\n\n`, sizeBytes: stat.size };
  } finally {
    await file?.close().catch(() => {});
  }
}

async function collectFile(filePath, label, maxBytes, options) {
  return (await collectFileSnapshot(filePath, label, maxBytes, options)).text;
}

async function buildSupportBundleText({ header, sanitizedConfig, files, secrets }) {
  const parts = [];
  parts.push('=== Multi-Hoster-Upload Support Bundle ===\n');
  if (header && typeof header === 'object') {
    for (const [k, v] of Object.entries(header)) parts.push(`${k}: ${v}\n`);
  }
  parts.push('\n');
  parts.push('=== Config (sanitized — password/apiKey/token/cookie/sessionId redacted) ===\n');
  parts.push(redactLogText(JSON.stringify(sanitizedConfig, null, 2), secrets));
  parts.push('\n\n');
  for (const f of (files || [])) {
    parts.push(redactLogText(await collectFile(f.path, f.label || f.path, f.maxBytes, { includePath: false }), secrets));
  }
  return parts.join('');
}

module.exports = { sanitizeConfig, collectSecretValues, redactLogText, valueScrub, collectFile, collectFileSnapshot, buildSupportBundleText, CRED_KEYS, REDACTED };
