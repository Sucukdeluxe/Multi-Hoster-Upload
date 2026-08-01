(function (root) {
  'use strict';

  function makeThrottleTimer(opts) {
    const o = opts || {};
    const now = typeof o.now === 'function' ? o.now : (() => Date.now());
    const schedule = typeof o.schedule === 'function'
      ? o.schedule
      : ((cb, ms) => setTimeout(cb, ms));
    const clear = typeof o.clear === 'function' ? o.clear : ((h) => clearTimeout(h));

    let handle = null;
    let burstStart = null;
    let pendingFn = null;

    function fire() {
      handle = null;
      burstStart = null;
      const fn = pendingFn;
      pendingFn = null;
      if (typeof fn === 'function') fn();
    }

    function request(fn, delay, maxWait) {
      if (typeof fn === 'function') pendingFn = fn;
      const t = now();
      if (burstStart === null) burstStart = t;
      let wait = typeof delay === 'number' && delay >= 0 ? delay : 0;
      if (typeof maxWait === 'number' && maxWait >= 0) {
        const remaining = maxWait - (t - burstStart);
        wait = Math.min(wait, remaining < 0 ? 0 : remaining);
      }
      if (handle !== null) clear(handle);
      handle = schedule(fire, wait);
    }

    function flushSync() {
      if (handle !== null) { clear(handle); handle = null; }
      burstStart = null;
      const fn = pendingFn;
      pendingFn = null;
      if (typeof fn === 'function') fn();
    }

    function cancel() {
      if (handle !== null) { clear(handle); handle = null; }
      burstStart = null;
      pendingFn = null;
    }

    function isPending() { return handle !== null; }

    return { request, flushSync, cancel, isPending };
  }

  const api = { makeThrottleTimer };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else if (root) root.ThrottleTimer = api;
})(typeof window !== 'undefined' ? window : this);
