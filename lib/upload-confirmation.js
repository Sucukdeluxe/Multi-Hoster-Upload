const SUPPORTED_HOSTERS = new Set([
  'doodstream.com',
  'voe.sx',
  'vidmoly.me',
  'byse.sx',
  'clouddrop.cc'
]);

const FILE_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;
const HOSTER_RESULT_DOMAINS = {
  'doodstream.com': ['doodstream.com', 'dood.to', 'dood.la', 'dood.so', 'dsvplay.com']
};

function isExpectedHostUrl(value, expectedHost) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const acceptedDomains = HOSTER_RESULT_DOMAINS[expectedHost] || [expectedHost];
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && acceptedDomains.some(domain => hostname === domain || hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

function getUrlHost(value) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return 'invalid';
  }
}

function normalizeDoodstreamUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return value;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (hostname !== 'doodstream.com' && HOSTER_RESULT_DOMAINS['doodstream.com'].includes(hostname)) {
      url.hostname = 'doodstream.com';
      return url.toString();
    }
  } catch {}
  return value;
}

function normalizeConfirmedResult(result, hoster) {
  if (hoster !== 'doodstream.com') return result;
  const downloadUrl = normalizeDoodstreamUrl(result.download_url);
  const embedUrl = normalizeDoodstreamUrl(result.embed_url);
  if (downloadUrl === result.download_url && embedUrl === result.embed_url) return result;
  return { ...result, download_url: downloadUrl, embed_url: embedUrl };
}

function assertUploadConfirmation(result, hoster) {
  const expectedHost = typeof hoster === 'string' ? hoster.trim().toLowerCase() : '';
  const fileCode = typeof result?.file_code === 'string' ? result.file_code.trim() : '';
  const urls = [result?.download_url, result?.embed_url].filter(value => (
    value !== null
    && value !== undefined
    && !(typeof value === 'string' && value.trim() === '')
  ));
  if (SUPPORTED_HOSTERS.has(expectedHost)
    && FILE_CODE_PATTERN.test(fileCode)
    && urls.every(value => isExpectedHostUrl(value, expectedHost))) {
    return normalizeConfirmedResult(result, expectedHost);
  }
  const error = new Error(`Upload zu ${hoster || 'unbekanntem Hoster'} wurde nicht bestätigt`);
  error.diagnostic = {
    payloadSnippet: JSON.stringify({
      fileCodeLength: fileCode.length,
      urlHosts: urls.map(getUrlHost)
    })
  };
  throw error;
}

module.exports = { assertUploadConfirmation };
