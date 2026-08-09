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

  const api = { createSerializedRunner };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else if (root) root.SerializedRunner = api;
})(typeof window !== 'undefined' ? window : this);
