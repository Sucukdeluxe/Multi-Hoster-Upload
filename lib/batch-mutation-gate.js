function createBatchMutationGate() {
  let activeLeaseCount = 0;
  let sealed = false;
  let activeAtSeal = false;
  let drainPromise = null;
  let resolveDrain = null;

  function acquire() {
    if (sealed) return null;

    activeLeaseCount += 1;
    let open = true;

    return Object.freeze({
      finish() {
        if (!open) return false;

        open = false;
        activeLeaseCount -= 1;

        if (sealed && activeLeaseCount === 0 && resolveDrain) {
          const resolve = resolveDrain;
          resolveDrain = null;
          resolve(activeAtSeal);
        }

        return true;
      },
      isOpen() {
        return open;
      }
    });
  }

  function sealAndDrain() {
    if (drainPromise) return drainPromise;

    sealed = true;
    activeAtSeal = activeLeaseCount > 0;

    if (!activeAtSeal) {
      drainPromise = Promise.resolve(false);
      return drainPromise;
    }

    drainPromise = new Promise((resolve) => {
      resolveDrain = resolve;
    });
    return drainPromise;
  }

  return Object.freeze({ acquire, sealAndDrain });
}

module.exports = { createBatchMutationGate };
