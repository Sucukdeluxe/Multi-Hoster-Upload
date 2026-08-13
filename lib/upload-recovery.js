(function exposeUploadRecovery(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.UploadRecovery = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  const terminalStatuses = new Set(['done', 'error', 'skipped', 'aborted']);

  function buildTerminalJobSnapshots(summary) {
    const snapshots = new Map();
    for (const file of Array.isArray(summary?.files) ? summary.files : []) {
      for (const result of Array.isArray(file?.results) ? file.results : []) {
        const jobId = typeof result?.jobId === 'string' ? result.jobId : '';
        const status = typeof result?.status === 'string' ? result.status : '';
        if (!jobId || !terminalStatuses.has(status)) continue;
        const uploadResult = result.download_url || result.embed_url || result.file_code
          ? {
              download_url: result.download_url || null,
              embed_url: result.embed_url || null,
              file_code: result.file_code || null
            }
          : null;
        snapshots.set(jobId, {
          jobId,
          status,
          error: result.error || null,
          failureDetails: result.failureDetails || null,
          result: uploadResult
        });
      }
    }
    return Array.from(snapshots.values());
  }

  function getRecoveryOutcome(job, recovery) {
    const status = typeof job?.status === 'string' ? job.status : 'preview';
    const jobId = typeof job?.id === 'string' ? job.id : '';
    const terminal = Array.isArray(recovery?.terminalJobs)
      ? recovery.terminalJobs.find(entry => entry?.jobId === jobId && terminalStatuses.has(entry.status))
      : null;
    if (terminal) {
      return {
        status: terminal.status,
        error: terminal.error || null,
        failureDetails: terminal.failureDetails || null,
        result: terminal.result || null,
        interrupted: false
      };
    }
    const interruptedIds = new Set(Array.isArray(recovery?.jobIds) ? recovery.jobIds.filter(Boolean) : []);
    return { status, interrupted: interruptedIds.has(jobId) && !terminalStatuses.has(status) };
  }

  return { buildTerminalJobSnapshots, getRecoveryOutcome };
});
