// Time-windowed memoization. Reuses a previously-computed value if the
// signature + input identity match AND the cached entry is younger than
// `refreshMs`. Used by the renderer's dynamic-key sort throttle (every
// progress tick re-sorts a 5000-row queue → reuse for 200 ms, the user
// can't perceive sub-200 ms reorder lag).
//
// Loaded both as a CommonJS module (Node tests) and as a browser global
// (renderer/app.js via index.html script tag) — same single implementation
// across runtime and tests.

(function (root) {
  'use strict';

  /**
   * Build a throttled cache. The clock is injected so tests don't have to
   * sleep — pass `() => fakeClock.value` from tests.
   *
   * @param {number} refreshMs cache TTL in milliseconds
   * @param {() => number} [now] clock source, defaults to Date.now
   */
  function makeThrottledCache(refreshMs, now) {
    if (!Number.isFinite(refreshMs) || refreshMs < 0) {
      throw new TypeError('refreshMs must be a non-negative finite number');
    }
    const clock = typeof now === 'function' ? now : () => Date.now();
    let entry = null;
    return {
      get(sig, input) {
        if (!entry) return undefined;
        if (entry.sig !== sig) return undefined;
        if (entry.input !== input) return undefined;
        if (clock() - entry.ts >= refreshMs) return undefined;
        return entry.value;
      },
      set(sig, input, value) {
        entry = { sig, input, value, ts: clock() };
        return value;
      },
      clear() { entry = null; },
      // Introspection (mainly for tests/debug). Returns null when empty.
      peek() {
        if (!entry) return null;
        return { sig: entry.sig, ts: entry.ts, age: clock() - entry.ts };
      }
    };
  }

  const api = { makeThrottledCache };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else if (root) root.ThrottledCache = api;
})(typeof window !== 'undefined' ? window : this);
