// Decides which credential an upload task should use for a given hoster.
// Extracted from main.js buildTaskFromAccount so the routing can be unit-tested
// without Electron.
//
// DOODSTREAM SPECIAL CASE: prefer the official doodapi.co API key whenever the
// account has one. The web-login path (username/password) drives doodstream's
// browser upload flow, which hands the filecode back inside an XFileSharing
// HTML form. On long/large uploads that form comes back empty (no fn) because a
// per-page-load sess_id token ages out over the multi-minute upload and/or the
// server-side file-registration callback times out — the upload then "succeeds"
// (bytes sent, HTTP 200) but yields no link. The JSON API returns the filecode
// directly in result[0].filecode and authenticates with a persistent api_key,
// so it has no empty-form failure mode for result retrieval. The API path was
// doodstream's ORIGINAL upload path (present since the initial commit); web
// login was added later only as an alternative for keyless accounts — so
// preferring the key here restores the intended primary path, it doesn't fight
// a deliberate choice. Keyless accounts keep using web login unchanged.
function selectUploadAuth(hoster, account) {
  if (!account || typeof account !== 'object') return {};

  if (hoster === 'doodstream.com' && account.apiKey) {
    return { apiKey: account.apiKey };
  }
  if (account.authType === 'api' && account.apiKey) {
    return { apiKey: account.apiKey };
  }
  if (account.username && account.password) {
    return { username: account.username, password: account.password };
  }
  if (account.apiKey) {
    return { apiKey: account.apiKey };
  }
  return {};
}

module.exports = { selectUploadAuth };
