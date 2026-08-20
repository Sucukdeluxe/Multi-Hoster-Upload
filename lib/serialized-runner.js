(function (root) {
  'use strict';

  function createSerializedRunner(task) {
    if (typeof task !== 'function') throw new TypeError('task must be a function');
    let pending = Promise.resolve();
    return {
      run(...args) {
        const result = pending.catch(() => {}).then(() => task(...args));
        pending = result;
        return result;
      },
      flush() {
        return pending;
      }
    };
  }

  function createReadySerializedRunner(task) {
    let ready = false;
    let releaseReady;
    const readyPromise = new Promise((resolve) => { releaseReady = resolve; });
    const runner = createSerializedRunner(async (...args) => {
      await readyPromise;
      return task(...args);
    });
    return {
      run: (...args) => runner.run(...args),
      flush: () => runner.flush(),
      ready() {
        if (ready) return false;
        ready = true;
        releaseReady();
        return true;
      },
      get isReady() { return ready; }
    };
  }

  const api = { createSerializedRunner, createReadySerializedRunner };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else if (root) root.SerializedRunner = api;
})(typeof window !== 'undefined' ? window : this);
