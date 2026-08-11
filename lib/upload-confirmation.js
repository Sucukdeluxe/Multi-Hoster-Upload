const SUPPORTED_HOSTERS = new Set([
  'doodstream.com',
  'voe.sx',
  'vidmoly.me',
  'byse.sx',
  'clouddrop.cc'
]);

const FILE_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;

function isExpectedHostUrl(value, expectedHost) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && (hostname === expectedHost || hostname.endsWith(`.${expectedHost}`));
  } catch {
    return false;
  }
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
    return result;
  }
  throw new Error(`Upload zu ${hoster || 'unbekanntem Hoster'} wurde nicht bestätigt`);
}

module.exports = { assertUploadConfirmation };
