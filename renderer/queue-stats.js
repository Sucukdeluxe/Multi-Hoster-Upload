(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.QueueStats = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  function calculateQueueStats(jobs) {
    const items = Array.isArray(jobs) ? jobs : [];
    let remaining = 0;
    let inProgress = 0;
    let done = 0;
    let errors = 0;
    let skipped = 0;
    let aborted = 0;
    let bytesRemaining = 0;
    let totalSize = 0;
    let remainingSize = 0;
    let inProgressBytes = 0;

    for (const job of items) {
      const status = job?.status;
      const totalBytes = Number(job?.bytesTotal) || 0;
      const uploadedBytes = Number(job?.bytesUploaded) || 0;
      const pendingBytes = Math.max(0, totalBytes - uploadedBytes);
      totalSize += totalBytes;

      if (status === 'uploading' || status === 'getting-server' || status === 'retrying') {
        inProgress++;
        remaining++;
        inProgressBytes += uploadedBytes;
        bytesRemaining += pendingBytes;
        remainingSize += pendingBytes;
      } else if (status === 'preview' || status === 'queued') {
        remaining++;
        bytesRemaining += pendingBytes;
        remainingSize += pendingBytes;
      } else if (status === 'done') {
        done++;
      } else if (status === 'error') {
        errors++;
      } else if (status === 'skipped') {
        skipped++;
      } else if (status === 'aborted') {
        aborted++;
      }
    }

    return { total: items.length, remaining, inProgress, done, errors, skipped, aborted, bytesRemaining, totalSize, remainingSize, inProgressBytes };
  }

  return { calculateQueueStats };
});
