/**
 * Token-bucket speed limiter for bandwidth throttling.
 * maxBytesPerSec = 0 means unlimited (passthrough).
 */
class Throttle {
  constructor(maxBytesPerSec) {
    this.maxBps = maxBytesPerSec || 0;
    this.tokens = this.maxBps;
    this.lastRefill = Date.now();
  }

  async consume(bytes, signal) {
    if (this.maxBps <= 0) return; // unlimited

    while (bytes > 0) {
      if (signal && signal.aborted) return;
      this._refill();
      const available = Math.min(bytes, Math.floor(this.tokens));
      if (available > 0) {
        this.tokens -= available;
        bytes -= available;
      }
      if (bytes > 0) {
        if (signal && signal.aborted) return;
        // Wait 50ms for tokens to refill
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }

  _refill() {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.maxBps, this.tokens + elapsed * this.maxBps);
    this.lastRefill = now;
  }

  updateRate(maxBytesPerSec) {
    this.maxBps = maxBytesPerSec || 0;
  }
}

module.exports = Throttle;
