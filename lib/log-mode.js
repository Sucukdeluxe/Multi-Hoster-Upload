// Log-file mode resolution for fileuploader.log:
//   - "single"  → one file:   fileuploader.log
//   - "daily"   → per-day:    fileuploader-YYYY-MM-DD.log
//   - "session" → per-launch: DD-MM-YYYY-mdu-session-HH-MM-NNNNNN.log
//
// Pure functions only — no fs, no Date.now() at call time — so they unit-test
// cleanly and the main.js call sites pass in `new Date()` + the session stamp.
//
// MIGRATION TRAP this lib protects against: the legacy boolean was named
// `sessionLog` but actually toggled *daily* mode. A naive rename would silently
// flip every per-day user onto per-session. normalizeLogMode below maps the
// legacy `sessionLog: true` to "daily", NOT "session". Read logMode everywhere
// downstream; do not derive from sessionLog at call sites.
//
// Loaded both as CommonJS (main.js, tests) and as a browser global
// (renderer/app.js via index.html script tag) so a single implementation backs
// runtime and tests — same pattern as queue-prune.js / queue-dedup.js.

(function (root) {
  'use strict';

  const VALID_MODES = new Set(['single', 'daily', 'session']);

  function normalizeLogMode(globalSettings) {
    const gs = globalSettings && typeof globalSettings === 'object' ? globalSettings : {};
    if (typeof gs.logMode === 'string' && VALID_MODES.has(gs.logMode)) {
      return gs.logMode;
    }
    // Legacy boolean migration: sessionLog *named* like "session" but actually
    // implemented "daily" — preserve daily users on the migration path.
    if (gs.sessionLog === true) return 'daily';
    return 'single';
  }

  function _two(n) { return String(n).padStart(2, '0'); }

  function formatDateStamp(date) {
    return `${date.getFullYear()}-${_two(date.getMonth() + 1)}-${_two(date.getDate())}`;
  }

  function formatSessionStamp(date, rand) {
    const d = `${_two(date.getDate())}-${_two(date.getMonth() + 1)}-${date.getFullYear()}`;
    const t = `${_two(date.getHours())}-${_two(date.getMinutes())}`;
    const r = (rand !== undefined && rand !== null && String(rand).trim()) ? `-${String(rand).trim()}` : '';
    return `${d}-mdu-session-${t}${r}`;
  }

  /**
   * Compute the log filename for the given mode + clock.
   * @param {Object} args
   * @param {string} args.baseName    e.g. "fileuploader"
   * @param {string} args.ext         e.g. ".log"
   * @param {string} args.mode        "single" | "daily" | "session"
   * @param {Date}   args.date        current timestamp
   * @param {string} [args.sessionId] required when mode === "session"
   * @returns {string} the bare filename (no directory)
   */
  function resolveLogFileName(args) {
    const a = args || {};
    const base = String(a.baseName || 'fileuploader');
    const ext = String(a.ext || '.log');
    const mode = VALID_MODES.has(a.mode) ? a.mode : 'single';
    if (mode === 'single') return `${base}${ext}`;
    if (mode === 'daily') {
      const date = a.date instanceof Date ? a.date : new Date();
      return `${base}-${formatDateStamp(date)}${ext}`;
    }
    // session — the stamp is the full app-defined stem (DD-MM-YYYY-mdu-session-HH-MM),
    // independent of baseName.
    const sid = a.sessionId && String(a.sessionId).trim();
    if (sid) return `${sid}${ext}`;
    // Defensive: if a session-id wasn't passed, fall back to single rather
    // than emit a malformed name. main.js always supplies one.
    return `${base}${ext}`;
  }

  /**
   * Reverse of resolveLogFileName: given a full filename like
   * "fileuploader-2026-06-03.log" or
   * "fileuploader-session-2026-06-03_18-16-20-8132.log", strip the mode-stamp
   * so the bare base ("fileuploader.log") remains. Used when persisting an
   * auto-resolved fallback path back into config — otherwise the saved path
   * would keep growing a new stamp on every reload.
   */
  function stripModeStampFromFileName(fileName) {
    if (!fileName || typeof fileName !== 'string') return fileName;
    const newSessionRe = /^\d{2}-\d{2}-\d{4}-mdu-session-\d{2}-\d{2}(?:-\d+)?(\.[^.]+)?$/;
    const mNew = fileName.match(newSessionRe);
    if (mNew) return `fileuploader${mNew[1] || ''}`;
    // Order matters: session first (longer, more specific) before daily.
    // Both regexes are anchored to $ with no nested/ambiguous quantifiers, so
    // matching is linear — the eslint security warning is precautionary.
    const sessionRe = /-session-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(?:-\d+)?(\.[^.]+)?$/;
    const dailyRe = /-\d{4}-\d{2}-\d{2}(\.[^.]+)?$/;
    let out = fileName.replace(sessionRe, (m, ext) => ext || '');
    out = out.replace(dailyRe, (m, ext) => ext || '');
    return out;
  }

  function isManagedUploadLogFileName(fileName, args) {
    const value = String(fileName || '');
    const options = args && typeof args === 'object' ? args : {};
    const baseName = String(options.baseName || 'fileuploader');
    const ext = String(options.ext || '.log');
    const normalizedValue = value.toLowerCase();
    const normalizedBaseName = baseName.toLowerCase();
    const normalizedExt = ext.toLowerCase();
    if (!normalizedExt || !normalizedValue.endsWith(normalizedExt)) return false;
    if (stripModeStampFromFileName(normalizedValue) === `${normalizedBaseName}${normalizedExt}`) return true;
    const stem = normalizedValue.slice(0, -normalizedExt.length);
    return /^\d{2}-\d{2}-\d{4}-mdu-session-\d{2}-\d{2}(?:-\d+)?$/.test(stem);
  }

  const api = { normalizeLogMode, resolveLogFileName, formatDateStamp, formatSessionStamp, stripModeStampFromFileName, isManagedUploadLogFileName, VALID_MODES };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else if (root) {
    root.LogMode = api;
  }
})(typeof window !== 'undefined' ? window : this);
