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

function isExpectedHostUrl(value, expectedHost, allowHttp = false) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const acceptedDomains = HOSTER_RESULT_DOMAINS[expectedHost] || [expectedHost];
    return (url.protocol === 'https:' || (allowHttp && url.protocol === 'http:'))
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

function selectPublicUploadUrl(result) {
  for (const value of [result?.download_url, result?.embed_url]) {
    if (typeof value !== 'string' || value.trim() === '') continue;
    try {
      const url = new URL(value.trim());
      if (url.protocol === 'https:') return url.href;
    } catch {}
  }
  return '';
}

function assertUploadConfirmation(result, hoster) {
  const expectedHost = typeof hoster === 'string' ? hoster.trim().toLowerCase() : '';
  const fileCode = typeof result?.file_code === 'string' ? result.file_code.trim() : '';
  const urls = [result?.download_url, result?.embed_url].filter(value => (
    value !== null
    && value !== undefined
    && !(typeof value === 'string' && value.trim() === '')
  ));
  if (SUPPORTED_HOSTERS.has(expectedHost) && FILE_CODE_PATTERN.test(fileCode)) {
    if (expectedHost === 'doodstream.com' && urls.every(value => isExpectedHostUrl(value, expectedHost, true))) {
      return {
        ...result,
        file_code: fileCode,
        download_url: `https://doodstream.com/d/${fileCode}`,
        embed_url: `https://doodstream.com/e/${fileCode}`
      };
    }
    if (urls.length > 0 && urls.every(value => isExpectedHostUrl(value, expectedHost))) {
      return fileCode === result.file_code ? result : { ...result, file_code: fileCode };
    }
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

module.exports = { assertUploadConfirmation, selectPublicUploadUrl };
