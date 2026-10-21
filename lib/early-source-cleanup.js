function createEarlySourceCleanup(options) {
  if (!options || !options.cleanup || typeof options.prepare !== 'function') {
    throw new TypeError('createEarlySourceCleanup requires cleanup and prepare');
  }
  const cleanup = options.cleanup;
  const prepare = options.prepare;
  const delayMs = Number.isFinite(options.delayMs) ? Math.max(0, options.delayMs) : 3000;
  const schedule = typeof options.schedule === 'function' ? options.schedule : (callback, ms) => setTimeout(callback, ms);
  const cancel = typeof options.cancel === 'function' ? options.cancel : (timer) => clearTimeout(timer);
  const onError = typeof options.onError === 'function' ? options.onError : () => {};
  const pending = new Set();
  let timer = null;
  let running = null;
  let closed = false;

  function arm() {
    if (closed || timer || running || pending.size === 0) return;
    timer = schedule(() => {
      timer = null;
      running = run().finally(() => {
        running = null;
        arm();
      });
    }, delayMs);
  }

  async function run() {
    const tokens = [...pending];
    pending.clear();
    if (closed || tokens.length === 0) return;
    let evidence = null;
    try {
      evidence = await prepare(tokens);
    } catch (error) {
      onError(error);
      return;
    }
    if (closed || !evidence || evidence.queuePersisted !== true) return;
    try {
      await cleanup.finalizeReady(tokens, evidence);
    } catch (error) {
      onError(error);
    }
  }

  function request(token) {
    if (closed || typeof token !== 'string' || token.length === 0) return;
    pending.add(token);
    arm();
  }

  async function close() {
    closed = true;
    if (timer) cancel(timer);
    timer = null;
    pending.clear();
    if (running) await running;
  }

  return Object.freeze({ request, close });
}

module.exports = { createEarlySourceCleanup };
