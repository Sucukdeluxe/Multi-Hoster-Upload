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
      if (CRED_KEYS.has(k) && typeof v === 'string' && v.length > 0) out.add(v);
      else walk(v);
    }
  })(config);
  return Array.from(out);
}

function redactConfiguredSecrets(text, secrets) {
  if (!Array.isArray(secrets)) return text;
  const values = Array.from(new Set(secrets
    .filter(value => typeof value === 'string' && value.length > 0)
    .flatMap(value => {
      const variants = [value];
      for (let index = 0; index < 3; index++) {
        const escaped = JSON.stringify(variants[variants.length - 1]).slice(1, -1);
        if (escaped === variants[variants.length - 1]) break;
        variants.push(escaped);
      }
      return variants;
    })))
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const value of values) {
    let offset = 0;
    while (offset < out.length) {
      const index = out.indexOf(value, offset);
      if (index < 0) break;
      const before = index > 0 ? out[index - 1] : '';
      const after = index + value.length < out.length ? out[index + value.length] : '';
      const continuation = character => /[A-Za-z0-9_.]/.test(character);
      if (!continuation(before) && !continuation(after)) {
        out = `${out.slice(0, index)}${REDACTED}${out.slice(index + value.length)}`;
        offset = index + REDACTED.length;
      } else {
        offset = index + value.length;
      }
    }
  }
  return out;
}

function redactHtmlCredentialFields(text) {
  let out = '';
  let offset = 0;
  const lower = text.toLowerCase();
  while (offset < text.length) {
    const start = lower.indexOf('<input', offset);
    if (start < 0) {
      out += text.slice(offset);
      break;
    }
    out += text.slice(offset, start);
    let quote = '';
    let end = start + 6;
    for (; end < text.length; end++) {
      const character = text[end];
      if (quote) {
        if (character === quote) quote = '';
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === '>') {
        end++;
        break;
      }
    }
    const input = text.slice(start, end);
    const sensitive = /\btype\s*=\s*["']?password\b/i.test(input)
      || /\b(?:name|id)\s*=\s*["']?(?:password|passwd|api[_-]?(?:key|token)|token|secret|authorization|cookie|session(?:[_-]?id)?)\b/i.test(input);
    out += sensitive
      ? input
        .replace(/(\bvalue\s*=\s*)(["'])([\s\S]*?)\2/gi, `$1$2${REDACTED}$2`)
        .replace(/(\bvalue\s*=\s*)(?!["'])([^\s>]+)/gi, `$1${REDACTED}`)
      : input;
    offset = end;
  }
  return out;
}

function redactAbsolutePaths(text) {
  const isDriveStart = (value, index) => /[A-Za-z]/.test(value[index] || '')
    && !/[A-Za-z0-9]/.test(value[index - 1] || '')
    && value[index + 1] === ':'
    && /[\\/]/.test(value[index + 2] || '');
  const isBackslashUncStart = (value, index) => {
    if (value[index] !== '\\' || value[index + 1] !== '\\' || value[index - 1] === '\\') return false;
    let cursor = index + 2;
    while (value[cursor] === '\\') cursor++;
    if (value[cursor] === '?') return true;
    const separator = value.indexOf('\\', cursor);
    return separator > cursor;
  };
  const isSlashUncStart = (value, index) => value[index] === '/'
    && value[index + 1] === '/'
    && !/[:/]/.test(value[index - 1] || '')
    && !/[\/]/.test(value[index + 2] || '')
    && value.indexOf('/', index + 2) > index + 2;
  let out = '';
  let index = 0;
  while (index < text.length) {
    if (!isDriveStart(text, index) && !isBackslashUncStart(text, index) && !isSlashUncStart(text, index)) {
      out += text[index];
      index++;
      continue;
    }
    let end = index;
    while (end < text.length && !/[\r\n"'<>|]/.test(text[end])) end++;
    const candidate = text.slice(index, end).replace(/\s+(?:trigger|error|outcome|hoster|attempt|status|code)=.*$/i, '');
    out += '<redacted-path>';
    index += candidate.length;
  }
  return out;
}

function redactLogText(text, secrets) {
  if (typeof text !== 'string' || !text) return text;
  let out = redactConfiguredSecrets(text, secrets);
  out = redactHtmlCredentialFields(out)
    .replace(/("(?:file|fileName|stagedFile|sourceFile|targetFile|path|[A-Za-z0-9_]*Path)"\s*:\s*")[^"]*(")/gi, '$1<redacted-path>$2');
  out = redactAbsolutePaths(out)
    .replace(/https?:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+/gi, 'https://discord.com/api/webhooks/' + REDACTED)
    .replace(/(\/\/[^\s/:@]+:)[^\s/@]+(@)/g, '$1' + REDACTED + '$2')
    .replace(/(\b(?:proxy-)?authorization\s*:\s*)[^\r\n]*/gi, '$1' + REDACTED)
    .replace(/(\b(?:set-cookie|cookie)\s*:\s*)[^\r\n]*/gi, '$1' + REDACTED)
    .replace(/(\b(?:bearer|basic)\s+)[A-Za-z0-9._~+\-/=]+/gi, '$1' + REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/g, REDACTED)
    .replace(/([?&](?:api[_-]?key|key|token|access[_-]?token|refresh[_-]?token|auth|authorization|password|pass|cookie|session(?:[_-]?id)?)=)[^\s&#"'`]+/gi, '$1' + REDACTED)
    .replace(/("?\b(?:api[_-]?key|apikey|password|passwd|secret|authorization|cookie|(?:access|refresh|auth|session)[_-]?token|token|session[_-]?id|sessionid|session|sess[_-]?id|sessid|sess)"?\s*[:=]\s*)(["'])(.*?)\2/gi, `$1$2${REDACTED}$2`)
    .replace(/("?\b(?:api[_-]?key|apikey|password|passwd|secret|authorization|cookie|(?:access|refresh|auth|session)[_-]?token|token|session[_-]?id|sessionid|session|sess[_-]?id|sessid|sess)"?\s*[:=]\s*)(?!["'])([^\s,;}\]\r\n]+)/gi, '$1' + REDACTED);
  return out;
}

function valueScrub(value, secrets) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactLogText(value, secrets);
  if (Array.isArray(value)) return value.map(entry => valueScrub(entry, secrets));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value)) out[redactLogText(key, secrets)] = valueScrub(entry, secrets);
    return out;
  }
  return value;
}

function collectFile(filePath, label, maxBytes, options) {
  const includePath = !options || options.includePath !== false;
  if (!filePath) return `=== ${label} ===\n<no path configured>\n\n`;
  let stat;
  try { stat = fs.statSync(filePath); }
  catch (err) {
    const context = includePath ? ` (${filePath})` : '';
    if (err && err.code === 'ENOENT') return `=== ${label}${context} ===\n<file does not exist yet>\n\n`;
    return `=== ${label}${context} ===\n<stat error: ${err.message}>\n\n`;
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
  const metadata = includePath ? `${filePath}, size=${stat.size} bytes` : `size=${stat.size} bytes`;
  return `=== ${label} (${metadata}) ===\n${content}\n\n`;
}

function buildSupportBundleText({ header, sanitizedConfig, files, secrets }) {
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
    parts.push(collectFile(f.path, f.label || 'log', f.maxBytes, { includePath: false }));
  }
  return redactLogText(parts.join(''), secrets);
}

module.exports = { sanitizeConfig, collectSecretValues, redactLogText, valueScrub, collectFile, buildSupportBundleText, CRED_KEYS, REDACTED };
