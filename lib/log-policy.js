// Per-hoster upload-log policy. Decides whether a hoster's successful upload
// links get written to fileuploader.log. Pure + dependency-free so it's
// trivially unit-testable and shared between the runtime decision and tests.
//
// Contract: logging is ON unless the hoster's settings explicitly set
// logToFile === false. Missing settings / missing hoster / malformed input
// all default to ON, so the feature is strictly opt-out and never silently
// drops links because a config key wasn't present.

function hosterLogToFileEnabled(hosterSettings, hoster) {
  if (!hosterSettings || typeof hosterSettings !== 'object') return true;
  const hs = hosterSettings[hoster];
  if (!hs || typeof hs !== 'object') return true;
  return hs.logToFile !== false;
}

module.exports = { hosterLogToFileEnabled };
