(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AutoResume = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  function getAutoResumeJobs(jobs, jobIds) {
    const allowedJobIds = Array.isArray(jobIds) ? new Set(jobIds) : null;
    return Array.isArray(jobs)
      ? jobs.filter(job => job && (job.status === 'queued' || job.status === 'preview') && job.file && job.hoster && (!allowedJobIds || allowedJobIds.has(job.id)))
      : [];
  }

  function createAutoResumeController(options = {}) {
    const delaySeconds = Math.max(1, Number(options.delaySeconds) || 8);
    const setIntervalFn = options.setIntervalFn || setInterval;
    const clearIntervalFn = options.clearIntervalFn || clearInterval;
    const onTick = options.onTick || (() => {});
    const onStart = options.onStart || (() => {});
    const onCancel = options.onCancel || (() => {});
    let timer = null;
    let pending = false;

    function stopTimer() {
      if (timer === null) return;
      clearIntervalFn(timer);
      timer = null;
    }

    function schedule(jobIds) {
      if (pending || !Array.isArray(jobIds)) return false;
      const plannedJobIds = [...new Set(jobIds.filter(jobId => typeof jobId === 'string' && jobId))];
      if (!plannedJobIds.length) return false;
      pending = true;
      let remaining = delaySeconds;
      onTick(remaining, plannedJobIds.length);
      timer = setIntervalFn(() => {
        if (!pending) return;
        remaining--;
        if (remaining > 0) {
          onTick(remaining, plannedJobIds.length);
          return;
        }
        pending = false;
        stopTimer();
        onStart(plannedJobIds);
      }, 1000);
      return true;
    }

    function cancel() {
      if (!pending) return false;
      pending = false;
      stopTimer();
      onCancel();
      return true;
    }

    return {
      schedule,
      cancel,
      get pending() { return pending; }
    };
  }

  return { getAutoResumeJobs, createAutoResumeController };
});
