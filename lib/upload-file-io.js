const fs = require('node:fs');
const { runtimePerformance } = require('./performance-monitor');
const Semaphore = require('./semaphore');

const statUploadFile = file => runtimePerformance.measure('file.stat', () => fs.promises.stat(file));

function createUploadFileReader({ limit = 4, open = file => fs.promises.open(file, 'r') } = {}) {
  const slots = new Semaphore(limit);
  const admitted = async (signal, action) => {
    await runtimePerformance.measure('file.read.wait', () => slots.acquire(signal));
    try {
      signal?.throwIfAborted();
      return await action();
    } finally {
      slots.release();
    }
  };
  return {
    snapshot: () => ({ limit: slots.limit, active: slots.active, waiting: slots.pending }),
    updateLimit(value) {
      if (!Number.isInteger(value) || value < 1 || value > 32) throw new Error('Ungültiges Lese-Limit.');
      slots.updateLimit(value);
      return this.snapshot();
    },
    async *read(file, signal) {
      signal?.throwIfAborted();
      const handle = await admitted(signal, () => open(file));
      try {
        for (;;) {
          const buffer = Buffer.allocUnsafe(1024 * 1024);
          const result = await admitted(signal, () => runtimePerformance.measure('file.read', () => handle.read(buffer, 0, buffer.length, null)));
          signal?.throwIfAborted();
          if (!result.bytesRead) break;
          yield buffer.subarray(0, result.bytesRead);
        }
      } finally {
        await handle.close();
      }
    }
  };
}

const uploadFileReader = createUploadFileReader();
const readUploadFile = (file, signal) => uploadFileReader.read(file, signal);
const getUploadReadSnapshot = () => uploadFileReader.snapshot();
const setUploadReadLimit = value => uploadFileReader.updateLimit(value);

module.exports = { statUploadFile, readUploadFile, getUploadReadSnapshot, setUploadReadLimit, createUploadFileReader };
