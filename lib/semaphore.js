/**
 * FIFO Semaphore for per-hoster concurrency control.
 * acquire(signal?) blocks until a slot is available or the signal aborts.
 * release() frees a slot.
 */
class Semaphore {
  constructor(limit) {
    this.limit = Math.max(1, limit || 1);
    this.active = 0;
    this.queue = []; // { resolve, reject, signal?, onAbort? }
  }

  acquire(signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) {
        reject(new Error('Aborted'));
        return;
      }

      if (this.active < this.limit) {
        this.active++;
        resolve();
        return;
      }

      const entry = { resolve, reject };

      if (signal) {
        entry.signal = signal;
        entry.onAbort = () => {
          const idx = this.queue.indexOf(entry);
          if (idx !== -1) this.queue.splice(idx, 1);
          reject(new Error('Aborted'));
        };
        signal.addEventListener('abort', entry.onAbort, { once: true });
      }

      this.queue.push(entry);
    });
  }

  _cleanupEntry(entry) {
    if (entry.signal && entry.onAbort) {
      entry.signal.removeEventListener('abort', entry.onAbort);
    }
  }

  release() {
    if (this.queue.length > 0) {
      const entry = this.queue.shift();
      this._cleanupEntry(entry);
      entry.resolve();
    } else {
      this.active = Math.max(0, this.active - 1);
    }
  }

  updateLimit(newLimit) {
    this.limit = Math.max(1, newLimit || 1);
    while (this.active < this.limit && this.queue.length > 0) {
      this.active++;
      const entry = this.queue.shift();
      this._cleanupEntry(entry);
      entry.resolve();
    }
  }

  get pending() {
    return this.queue.length;
  }
}

module.exports = Semaphore;
