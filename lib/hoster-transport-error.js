function normalizeContentType(value) {
  const contentType = String(value || '').trim().slice(0, 120);
  const parts = contentType.split(';').map(part => part.trim());
  if (parts.length < 1 || parts.length > 2) return null;
  const slashIndex = parts[0].indexOf('/');
  if (slashIndex <= 0 || slashIndex === parts[0].length - 1) return null;
  const tokenCharacters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.+-_';
  const validToken = token => Array.from(token).every(char => tokenCharacters.includes(char));
  if (!validToken(parts[0].slice(0, slashIndex)) || !validToken(parts[0].slice(slashIndex + 1))) return null;
  if (parts.length === 2) {
    const charsetPrefix = 'charset=';
    if (!parts[1].toLowerCase().startsWith(charsetPrefix)) return null;
    const charset = parts[1].slice(charsetPrefix.length);
    if (!charset || !validToken(charset)) return null;
  }
  return contentType;
}

function safeEndpoint(value) {
  try {
    const url = new URL(String(value || ''));
    return `${url.hostname.toLowerCase()}${url.pathname}`;
  } catch {
    return null;
  }
}

function safeEndpointHost(value) {
  try {
    return new URL(String(value || '')).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function responseKind(body, contentType) {
  const text = String(body || '').trim();
  if (!text) return 'empty';
  const type = String(contentType || '').toLowerCase();
  if (type.includes('json') || /^[\[{]/.test(text)) return 'json';
  if (type.includes('html') || /<\s*(?:!doctype|html|body|form|input)\b/i.test(text)) return 'html';
  return 'text';
}

function summarizeResponse(body, contentType) {
  const text = String(body || '');
  const kind = responseKind(text, contentType);
  return `${kind} response (${Buffer.byteLength(text, 'utf8')} bytes)`;
}

function sanitizeRemoteText(value, limit = 180) {
  let text = String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  text = text.replace(/https?:\/\/[^\s"'<>]+/gi, (raw) => safeEndpoint(raw) || '[URL]');
  text = text.replace(/\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*[:=]\s*[^,]+/gi, '[redacted]');
  text = text.replace(/((?:api[_-]?key|token|password|secret|session|sess[_-]?id|csrf)["']?\s*[:=]\s*["']?)[^\s,;"'<>]+/gi, '$1[redacted]');
  text = text.replace(/(<(?:input|textarea)[^>]*(?:name|id)=["'][^"']*(?:key|token|password|secret|session|sess|csrf)[^"']*["'][^>]*(?:value=["']))[^"']*(["'])/gi, '$1[redacted]$2');
  text = text.replace(/\b[A-Za-z0-9_-]{20,}\b/g, '[redacted]');
  return text.slice(0, limit);
}

function createTransportError(message, options = {}) {
  const httpStatus = Number(options.httpStatus);
  const hasHttpStatus = Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599;
  const contentType = normalizeContentType(options.contentType);
  const endpointHost = safeEndpointHost(options.endpoint);
  const kind = responseKind(options.body, contentType);
  const suffix = hasHttpStatus ? ` (HTTP ${httpStatus})` : '';
  const error = new Error(`${sanitizeRemoteText(message, 220)}${suffix}`);
  error.diagnostic = {
    phase: String(options.phase || 'transport').slice(0, 80),
    http: hasHttpStatus ? httpStatus : null,
    contentType,
    safeEndpointHost: endpointHost,
    responseKind: kind,
    retryable: options.retryable === true,
    payloadSnippet: summarizeResponse(options.body, contentType)
  };
  if (options.transientNetwork === true) error.transientNetwork = true;
  if (options.hosterTransient === true) error.hosterTransient = true;
  if (options.accountError === true) error.accountError = true;
  if (options.fileRejected === true) error.fileRejected = true;
  if (options.remoteCommitUncertain === true) error.remoteCommitUncertain = true;
  return error;
}

module.exports = {
  createTransportError,
  safeEndpoint,
  sanitizeRemoteText,
  summarizeResponse
};
