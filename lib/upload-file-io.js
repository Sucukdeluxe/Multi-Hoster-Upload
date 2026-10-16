const fs = require('node:fs');
const { runtimePerformance } = require('./performance-monitor');

const statUploadFile = file => runtimePerformance.measure('file.stat', () => fs.promises.stat(file));

async function* readUploadFile(file, signal) {
  signal?.throwIfAborted();
  const stream = fs.createReadStream(file, { highWaterMark: 1024 * 1024, ...(signal ? { signal } : {}) });
  const iterator = stream[Symbol.asyncIterator]();
  try {
    for (;;) {
      const result = await runtimePerformance.measure('file.read', () => iterator.next());
      if (result.done) break;
      signal?.throwIfAborted();
      yield result.value;
    }
  } finally {
    stream.destroy();
    await iterator.return?.();
  }
}

module.exports = { statUploadFile, readUploadFile };
