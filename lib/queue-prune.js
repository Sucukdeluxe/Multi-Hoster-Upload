// Queue auto-prune logic. Extracted from renderer/app.js handleBatchDone so
// the algorithm can be unit-tested without needing a DOM or the renderer's
// module-level state (queueJobs, _jobIndexById).
//
// Loaded both as a CommonJS module (Node tests) and as a browser global
// (renderer/app.js via index.html script tag) so the same single
// implementation backs both runtime and tests — no drift between them.
//
// Behaviour: when the number of terminal-status jobs (done / skipped /
// error / aborted) in the queue exceeds `limit`, drop the oldest terminal
// jobs (insertion order) until we're back at the limit. Non-terminal jobs
// (queued / preview / uploading / retrying / getting-server) are always
// kept — those are work the user can still act on. Without this cap a
// long session accumulates thousands of done rows and every render becomes
// O(N) on a perpetually-growing N.

(function (root) {
  'use strict';

  const TERMINAL_STATUSES = new Set(['done', 'skipped', 'error', 'aborted']);

  /**
   * Compute which jobs to keep vs drop, given a queue and a terminal-jobs cap.
   * @param {Array<{id: string, status: string}>} jobs the current queue
   * @param {number} limit max terminal jobs to keep
   * @returns {null | { kept: Array, dropped: Array }} null when nothing changed
   */
  function pruneOldestTerminalJobs(jobs, limit) {
    if (!Array.isArray(jobs) || jobs.length === 0) return null;
    if (!Number.isFinite(limit) || limit < 0) return null;

    // Walk once, record indices of terminal jobs in insertion order.
    const terminalIdxs = [];
    for (let i = 0; i < jobs.length; i++) {
      const j = jobs[i];
      if (j && TERMINAL_STATUSES.has(j.status)) terminalIdxs.push(i);
    }
    if (terminalIdxs.length <= limit) return null;

    const dropCount = terminalIdxs.length - limit;
    const dropSet = new Set(terminalIdxs.slice(0, dropCount));

    const kept = [];
    const dropped = [];
    for (let i = 0; i < jobs.length; i++) {
      if (dropSet.has(i)) dropped.push(jobs[i]);
      else kept.push(jobs[i]);
    }
    return { kept, dropped };
  }

  const api = { pruneOldestTerminalJobs, TERMINAL_STATUSES };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else if (root) {
    root.QueuePrune = api;
  }
})(typeof window !== 'undefined' ? window : this);
