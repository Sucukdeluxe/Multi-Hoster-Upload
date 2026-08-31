const { createHash } = require('node:crypto');

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

function createDoodstreamOtpCoordinator(options = {}) {
  if (typeof options.createUploader !== 'function') throw new TypeError('createUploader is required');
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const challengeTtlMs = Number.isFinite(Number(options.challengeTtlMs)) ? Math.max(1000, Number(options.challengeTtlMs)) : 10 * 60 * 1000;
  const resendCooldownMs = Number.isFinite(Number(options.resendCooldownMs)) ? Math.max(1000, Number(options.resendCooldownMs)) : 60 * 1000;
  const maxEntries = Number.isFinite(Number(options.maxEntries)) ? Math.max(1, Math.floor(Number(options.maxEntries))) : 1000;
  const states = new Map();

  function credentialKey(username, password) {
    return createHash('sha256')
      .update(String(username || ''))
      .update('\0')
      .update(String(password || ''))
      .digest('hex');
  }

  function storeState(key, state) {
    states.delete(key);
    states.set(key, state);
    while (states.size > maxEntries) states.delete(states.keys().next().value);
  }

  function activeState(key) {
    const state = states.get(key);
    if (!state || state.inFlight) return state || null;
    if (state.expiresAt > now()) return state;
    states.delete(key);
    return null;
  }

  async function check(input = {}) {
    const username = String(input.username || '');
    const password = String(input.password || '');
    const otp = String(input.otp || '').trim();
    const key = credentialKey(username, password);
    const existing = activeState(key);
    if (existing?.inFlight) return existing.inFlight;
    if (otp && !existing?.pending) {
      return {
        status: 'otp_required',
        message: 'OTP-Anfrage ist abgelaufen. Bitte einen neuen Code anfordern.'
      };
    }
    if (!otp && existing?.pending && input.requestNewChallenge !== true) return existing.result;
    if (!otp && existing?.pending && now() - existing.requestedAt < resendCooldownMs) return existing.result;

    const uploader = otp ? existing.uploader : options.createUploader();
    const requestedAt = otp ? existing.requestedAt : now();
    const operationId = Symbol('doodstream-otp-check');
    const operation = (async () => {
      try {
        await uploader.login(username, password, otp || undefined);
        if (states.get(key)?.operationId === operationId) states.delete(key);
        return { status: 'ok', message: 'Login ok, Upload-Seite bereit' };
      } catch (error) {
        if (error?.otpRequired === true) {
          const result = { status: 'otp_required', message: error.message || 'OTP erforderlich' };
          if (states.get(key)?.operationId === operationId) {
            storeState(key, {
              operationId,
              uploader,
              pending: true,
              requestedAt: otp ? existing.requestedAt : requestedAt,
              expiresAt: now() + challengeTtlMs,
              result,
              inFlight: null
            });
          }
          return result;
        }
        if (otp && existing?.pending) {
          const result = {
            status: 'otp_required',
            message: error?.message || 'OTP konnte nicht bestätigt werden'
          };
          if (states.get(key)?.operationId === operationId) {
            storeState(key, {
              ...existing,
              operationId,
              uploader,
              result,
              inFlight: null
            });
          }
          return result;
        }
        if (states.get(key)?.operationId === operationId) states.delete(key);
        throw error;
      }
    })();
    storeState(key, {
      operationId,
      uploader,
      pending: existing?.pending === true,
      requestedAt,
      expiresAt: existing?.expiresAt || (requestedAt + challengeTtlMs),
      result: existing?.result || null,
      inFlight: operation
    });
    return operation;
  }

  return { check };
}

module.exports = { createDoodstreamOtpCoordinator, selectUploadAuth };
