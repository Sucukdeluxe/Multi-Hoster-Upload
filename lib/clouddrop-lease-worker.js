const { parentPort } = require('node:worker_threads');
const { performance } = require('node:perf_hooks');
const { encryptChunk } = require('./clouddrop-lease-crypto');

function transferable(buffer) {
  if (buffer.byteOffset === 0 && buffer.buffer.byteLength === buffer.length) return buffer.buffer;
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length);
}

parentPort.on('message', (job) => {
  const started = performance.now();
  try {
    const { cipher, macs } = encryptChunk({
      aesKey: Buffer.from(job.aesKey),
      nonce: Buffer.from(job.nonce),
      offset: job.offset,
      data: Buffer.from(job.data, 0, job.length),
      segments: job.segments,
    });
    const cipherBuffer = transferable(cipher);
    const macBuffer = transferable(macs);
    parentPort.postMessage({ id: job.id, cipher: cipherBuffer, macs: macBuffer, plain: job.data, ms: performance.now() - started },
      [cipherBuffer, macBuffer, job.data]);
  } catch (error) {
    parentPort.postMessage({ id: job.id, error: error && error.message ? error.message : String(error), plain: job.data }, [job.data]);
  }
});
