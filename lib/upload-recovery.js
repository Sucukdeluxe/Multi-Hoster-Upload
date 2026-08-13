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

  function buildFailedUploadSummary(tasks, message, now = Date.now()) {
    const files = new Map();
    for (const [index, task] of (Array.isArray(tasks) ? tasks : []).entries()) {
      if (!task || typeof task !== 'object') continue;
      const filePath = typeof task.file === 'string' ? task.file : '';
      const fileName = filePath.split(/[\\/]/).pop() || `upload-${index + 1}`;
      const key = filePath || `${fileName}\0${index}`;
      if (!files.has(key)) files.set(key, { name: fileName, size: 0, results: [] });
      files.get(key).results.push({
        jobId: typeof task.jobId === 'string' ? task.jobId : '',
        hoster: typeof task.hoster === 'string' ? task.hoster : '',
        status: 'error',
        error: message,
        failureDetails: null,
        download_url: null,
        embed_url: null,
        file_code: null
      });
    }
    const grouped = Array.from(files.values());
    const failed = grouped.reduce((count, file) => count + file.results.length, 0);
    return {
      id: `start-error-${now}`,
      timestamp: new Date(now).toISOString(),
      total: failed,
      succeeded: 0,
      failed,
      skipped: 0,
      files: grouped,
      error: message
    };
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

  return { buildFailedUploadSummary, buildTerminalJobSnapshots, getRecoveryOutcome };
});
