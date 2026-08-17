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
  text = text.replace(/(["']?(?:api[_-]?key|token|password|cookie|authorization|session)["']?\s*[:=]\s*)[^,;\s}"']+/gi, '$1[redacted]');
  if (/^(?:bearer|basic)\s+/i.test(text)) {
    text = '[redacted authorization]';
  }
  return text.slice(0, limit);
}

function normalizeFailureDetails(diagnostic) {
  if (!diagnostic || typeof diagnostic !== 'object') return null;
  const httpStatus = Number.isInteger(Number(diagnostic.http)) && Number(diagnostic.http) >= 100 && Number(diagnostic.http) <= 599
    ? Number(diagnostic.http)
    : null;
  const contentType = cleanText(diagnostic.contentType, 120);
  const responseSnippet = cleanText(diagnostic.payloadSnippet, 320);
  const details = {};
  if (httpStatus !== null) details.httpStatus = httpStatus;
  if (contentType) details.contentType = contentType;
  if (responseSnippet) details.responseSnippet = responseSnippet;
  return Object.keys(details).length > 0 ? details : null;
}

module.exports = { normalizeFailureDetails };
