// Startup queue auto-dedup logic. Extracted from renderer/app.js
// _autoDeduplicateFromLog so the decision can be unit-tested without a DOM or
// the renderer's module-level state.
//
// Loaded both as a CommonJS module (Node tests) and as a browser global
// (renderer/app.js via index.html script tag) so a single implementation backs
// runtime and tests — no drift.
//
// Behaviour: on launch the restored queue is compared against the lifetime
// upload log. Two rules drop a job:
//   1) a 'done' job whose fileName|hoster appears in the log (declutter of
//      already-finished work), and
//   2) ANY job (incl. preview) whose newest matching log entry is timestamped
//      at/after the snapshot's savedAt — it provably completed AFTER the queue
//      was last persisted, so a restored 'preview' row for it is a stale ghost.
//
// Rule 2 only fires when a savedAt is passed AND the log carries timestamps;
// without them this falls back to rule 1 alone. That fallback is the invariant
// the canary tests pin: a pending job matching an OLDER log line (ts < savedAt,
// or no ts at all) is KEPT — it's an intentional re-upload of a file uploaded
// before, not a ghost. The old code filtered on log-presence alone, regardless
// of status, so the ENTIRE restored queue vanished on the next restart/update
// whenever the files had been uploaded previously. Manual log import
// (importUploadLog) stays separate and explicit for bulk dedup.

(function (root) {
  'use strict';

  function _key(fileName, hoster) {
    return `${String(fileName).toLowerCase()}|${String(hoster).toLowerCase()}`;
  }

  /**
   * Partition restored queue jobs into kept vs removed, given lifetime log
   * entries. Removes only 'done' jobs whose fileName|hoster is in the log.
   * @param {Array<{status:string,fileName:string,hoster:string}>} jobs
   * @param {Array<{fileName:string,hoster:string}>} logEntries
   * @returns {{ kept: Array, removed: Array }}
   */
  function partitionRestoredJobsByLog(jobs, logEntries, savedAt) {
    const kept = [];
    const removed = [];
    if (!Array.isArray(jobs) || jobs.length === 0) return { kept, removed };

    const logKeys = new Set();
    const logMaxTs = new Map();
    for (const e of (Array.isArray(logEntries) ? logEntries : [])) {
      if (e && e.fileName && e.hoster) {
        const k = _key(e.fileName, e.hoster);
        logKeys.add(k);
        if (typeof e.ts === 'number' && isFinite(e.ts)) {
          const prev = logMaxTs.get(k);
          if (prev === undefined || e.ts > prev) logMaxTs.set(k, e.ts);
        }
      }
    }

    const savedAtFloor = (typeof savedAt === 'number' && isFinite(savedAt))
      ? Math.floor(savedAt / 1000) * 1000
      : null;

    const filesPerKey = new Map();
    for (const job of jobs) {
      if (job && job.fileName && job.hoster) {
        const jk = _key(job.fileName, job.hoster);
        let set = filesPerKey.get(jk);
        if (!set) { set = new Set(); filesPerKey.set(jk, set); }
        set.add(job.file || '');
      }
    }

    for (const job of jobs) {
      const hasIds = job && job.fileName && job.hoster;
      const k = hasIds ? _key(job.fileName, job.hoster) : null;
      const doneInLog = job && job.status === 'done' && hasIds && logKeys.has(k);
      const keyUnambiguous = k !== null && filesPerKey.get(k).size <= 1;
      const uploadedAfterSnapshot = savedAtFloor !== null && k !== null && keyUnambiguous
        && logMaxTs.has(k) && logMaxTs.get(k) >= savedAtFloor;
      if (doneInLog || uploadedAfterSnapshot) {
        removed.push(job);
      } else {
        kept.push(job);
      }
    }
    return { kept, removed };
  }

  function completedSelectionKeys(selectedFiles, hosters, logEntries, savedAt) {
    const out = [];
    if (!Array.isArray(selectedFiles) || !Array.isArray(hosters)) return out;
    if (!(typeof savedAt === 'number' && isFinite(savedAt))) return out;
    const synthetic = [];
    for (const f of selectedFiles) {
      if (!f || !f.path) continue;
      const name = f.name || String(f.path).split(/[\\/]/).pop();
      for (const h of hosters) {
        if (h) synthetic.push({ fileName: name, hoster: h, file: f.path, status: 'preview' });
      }
    }
    if (synthetic.length === 0) return out;
    const { removed } = partitionRestoredJobsByLog(synthetic, logEntries, savedAt);
    for (const job of removed) out.push(`${job.file}|${job.hoster}`);
    return out;
  }

  const api = { partitionRestoredJobsByLog, completedSelectionKeys };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else if (root) {
    root.QueueDedup = api;
  }
})(typeof window !== 'undefined' ? window : this);
