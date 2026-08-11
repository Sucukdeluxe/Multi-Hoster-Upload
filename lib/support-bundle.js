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

function collectFile(filePath, label, maxBytes) {
  if (!filePath) return `=== ${label} ===\n<no path configured>\n\n`;
  let stat;
  try { stat = fs.statSync(filePath); }
  catch (err) {
    if (err && err.code === 'ENOENT') return `=== ${label} (${filePath}) ===\n<file does not exist yet>\n\n`;
    return `=== ${label} (${filePath}) ===\n<stat error: ${err.message}>\n\n`;
  }
  const cap = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : 5 * 1024 * 1024;
  let content;
  try {
    if (stat.size > cap) {
      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(cap);
      fs.readSync(fd, buf, 0, cap, stat.size - cap);
      fs.closeSync(fd);
      const skipped = stat.size - cap;
      content = `<truncated: skipped first ${skipped} bytes; showing last ${cap} bytes of ${stat.size}>\n` + buf.toString('utf-8');
    } else {
      content = fs.readFileSync(filePath, 'utf-8');
    }
  } catch (err) {
    content = `<read error: ${err.message}>`;
  }
  return `=== ${label} (${filePath}, size=${stat.size} bytes) ===\n${content}\n\n`;
}

function buildSupportBundleText({ header, sanitizedConfig, files }) {
  const parts = [];
  parts.push('=== Multi-Hoster-Upload Support Bundle ===\n');
  if (header && typeof header === 'object') {
    for (const [k, v] of Object.entries(header)) parts.push(`${k}: ${v}\n`);
  }
  parts.push('\n');
  parts.push('=== Config (sanitized — password/apiKey/token/cookie/sessionId redacted) ===\n');
  parts.push(JSON.stringify(sanitizedConfig, null, 2));
  parts.push('\n\n');
  for (const f of (files || [])) {
    parts.push(collectFile(f.path, f.label || f.path, f.maxBytes));
  }
  return parts.join('');
}

module.exports = { sanitizeConfig, collectSecretValues, redactLogText, valueScrub, collectFile, buildSupportBundleText, CRED_KEYS, REDACTED };
