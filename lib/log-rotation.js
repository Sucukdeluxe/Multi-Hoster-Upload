// Generic numbered-backup log rotation. Used by the upload log + can be
// reused by other long-lived log files (debug log, account-rotation log).
//
// Behaviour:
// - File missing → no-op, returns false.
// - File ≤ maxBytes → no-op, returns false.
// - File > maxBytes → drop oldest .N backup, shift .K → .K+1, rename live
//   file to .1, return true. Caller (or the next append) creates a fresh
//   primary on demand.
//
// Errors are reported via `log` (e.g. debugLog) but never thrown — rotation
// is best-effort; the caller's append happens anyway.

const fs = require('fs');
const path = require('path');

function maybeRotateLogFile(filePath, maxBytes, maxBackups = 3, log = () => {}) {
  if (!filePath || !Number.isFinite(maxBytes) || maxBytes <= 0) return false;
  let size = 0;
  try {
    const st = fs.statSync(filePath);
    size = st.size;
  } catch (err) {
    // ENOENT is normal — nothing to rotate yet.
    if (err && err.code !== 'ENOENT') {
      log(`logRotation: stat ${filePath} failed: ${err.message}`);
    }
    return false;
  }
  if (size <= maxBytes) return false;

  const ext = path.extname(filePath);
  const base = filePath.slice(0, filePath.length - ext.length);

  // Drop the oldest backup if it exists, then shift each numbered backup up
  // one slot. Errors are ignored: missing intermediate backups are normal,
  // failed renames just mean we'll rotate again next time.
  try { fs.unlinkSync(`${base}.${maxBackups}${ext}`); } catch {}
  for (let i = maxBackups - 1; i >= 1; i--) {
    try { fs.renameSync(`${base}.${i}${ext}`, `${base}.${i + 1}${ext}`); } catch {}
  }
  try {
    fs.renameSync(filePath, `${base}.1${ext}`);
    log(`logRotation: rotated ${filePath} (${(size / 1024 / 1024).toFixed(1)} MB) → ${base}.1${ext}`);
    return true;
  } catch (err) {
    log(`logRotation: rename ${filePath} → ${base}.1${ext} failed: ${err.message}`);
    return false;
  }
}

module.exports = { maybeRotateLogFile };
