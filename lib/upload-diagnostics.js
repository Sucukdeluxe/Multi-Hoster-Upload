function cleanText(value, limit = 320) {
  let text = String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  text = text.replace(/https?:\/\/[^\s"'<>]+/gi, (raw) => {
    try {
      const url = new URL(raw);
      return `${url.host}${url.pathname}`;
    } catch {
      return '[URL]';
    }
  });
  text = text.replace(/\b(authorization|proxy-authorization|cookie|set-cookie)\s*[:=]\s*[^,]+/gi, '$1=[redacted]');
  text = text.replace(/(["']?(?:api[_-]?key|token|password|cookie|authorization|session)["']?\s*[:=]\s*)[^,;\s}"']+/gi, '$1[redacted]');
  if (/^(?:bearer|basic)\s+/i.test(text)) {
    text = '[redacted authorization]';
  }
  text = text.replace(/\b[A-Za-z0-9_-]{20,}\b/g, '[redacted]');
  return text.slice(0, limit);
}

function normalizeEndpointHost(value) {
  const host = String(value || '').trim().toLowerCase();
  if (!host || host.length > 253 || !/^[a-z0-9.-]+$/.test(host)) return '';
  if (host.startsWith('.') || host.endsWith('.') || host.includes('..')) return '';
  return host;
}

function normalizePhase(value) {
  const phase = String(value || '').trim();
  if (/^[a-z0-9._:-]{1,80}$/i.test(phase)) return phase;
  return cleanText(phase, 80);
}

function normalizeFailureDetails(diagnostic) {
  if (!diagnostic || typeof diagnostic !== 'object') return null;
  const httpStatus = Number.isInteger(Number(diagnostic.http)) && Number(diagnostic.http) >= 100 && Number(diagnostic.http) <= 599
    ? Number(diagnostic.http)
    : null;
  const contentType = cleanText(diagnostic.contentType, 120);
  const responseSnippet = cleanText(diagnostic.payloadSnippet, 320);
  const phase = normalizePhase(diagnostic.phase);
  const endpointHost = normalizeEndpointHost(diagnostic.safeEndpointHost);
  const responseKind = ['empty', 'json', 'html', 'text'].includes(diagnostic.responseKind)
    ? diagnostic.responseKind
    : '';
  const details = {};
  if (phase) details.phase = phase;
  if (httpStatus !== null) details.httpStatus = httpStatus;
  if (contentType) details.contentType = contentType;
  if (endpointHost) details.endpointHost = endpointHost;
  if (responseKind) details.responseKind = responseKind;
  if (typeof diagnostic.retryable === 'boolean') details.retryable = diagnostic.retryable;
  if (responseSnippet) details.responseSnippet = responseSnippet;
  return Object.keys(details).length > 0 ? details : null;
}

module.exports = { normalizeFailureDetails };
