/**
 * Shared upload rate limiter. Every consumed byte reserves send time at the
 * configured rate, so concurrent uploads together never exceed it. Only a
 * short burst (burstMs) may be sent ahead after idle time.
 * maxBytesPerSec = 0 means unlimited (passthrough).
 */
class Throttle {
  constructor(maxBytesPerSec, options = {}) {
    this.maxBps = maxBytesPerSec || 0;
    this.burstMs = Math.max(0, Number(options.burstMs ?? 200));
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.nextFreeAt = this.now();
  }

  async consume(bytes, signal) {
    if (this.maxBps <= 0 || !(bytes > 0)) return;
    if (signal && signal.aborted) return;
    const now = this.now();
    const start = Math.max(this.nextFreeAt, now - this.burstMs);
    this.nextFreeAt = start + (bytes * 1000) / this.maxBps;
    const wait = start - now;
    if (wait <= 0) return;
    await new Promise((resolve) => {
      const timer = setTimeout(done, wait);
      function done() {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', done);
        resolve();
      }
      if (signal) signal.addEventListener('abort', done, { once: true });
    });
  }

  updateRate(maxBytesPerSec) {
    const next = maxBytesPerSec || 0;
    if (next === this.maxBps) return;
    this.maxBps = next;
    this.nextFreeAt = Math.min(this.nextFreeAt, this.now() + this.burstMs);
  }
}

module.exports = Throttle;
