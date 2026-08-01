// Microtask-coalesced set. Adds are O(1); the apply callback runs once per
// scheduler tick with every id collected since the last flush.
//
// Used by the renderer to merge a burst of done-jobs (e.g. 500 jobs all
// finishing within milliseconds) into a single queueJobs.filter() pass —
// without this each event was its own O(N) sweep, so 500 finishes were
// O(N²) and visibly froze the UI on completion.
//
// Loaded both as a CommonJS module (Node tests) and as a browser global
// (renderer/app.js via index.html script tag).

(function (root) {
  'use strict';

  /**
   * Build a coalesced set.
   * @param {{ apply: (Set) => void, scheduler?: (cb: () => void) => void }} opts
   *   apply: called once per scheduler tick with the accumulated ids.
   *   scheduler: defaults to queueMicrotask. Tests can pass a synchronous
   *   stand-in to avoid async waits.
   */
  function makeCoalescedSet(opts) {
    if (!opts || typeof opts.apply !== 'function') {
      throw new TypeError('makeCoalescedSet: { apply: fn } required');
    }
    const apply = opts.apply;
    const scheduler = typeof opts.scheduler === 'function'
      ? opts.scheduler
      : (typeof queueMicrotask === 'function' ? queueMicrotask : (cb) => Promise.resolve().then(cb));
    let pending = new Set();
    let scheduled = false;

    function flush() {
      scheduled = false;
      if (pending.size === 0) return;
      const drop = pending;
      pending = new Set();
      try { apply(drop); } catch (e) {
        // Don't let a failing apply lock out the next batch — surface it
        // but keep the coalescer usable.
        if (typeof console !== 'undefined' && console.error) console.error(e);
      }
    }

    return {
      add(id) {
        pending.add(id);
        if (!scheduled) {
          scheduled = true;
          scheduler(flush);
        }
      },
      /**
       * Synchronously consume any pending ids. Used by beforeunload paths
       * where we can't wait for the next microtask before persisting.
       */
      drainSync() {
        if (pending.size === 0) return;
        const drop = pending;
        pending = new Set();
        scheduled = false;
        apply(drop);
      },
      /** Introspection for tests + diagnostics. */
      pendingSize() { return pending.size; },
      isScheduled() { return scheduled; }
    };
  }

  const api = { makeCoalescedSet };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else if (root) root.CoalescedSet = api;
})(typeof window !== 'undefined' ? window : this);
