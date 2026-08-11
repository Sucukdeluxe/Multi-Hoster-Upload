(function (root) {
  'use strict';

  const pathApi = typeof require === 'function' ? require('path') : null;
  const protectedStatuses = new Set(['done', 'error', 'aborted', 'skipped']);

  function normalizeFile(file, platform) {
    const value = typeof file === 'string' ? file.trim() : '';
    if (!value) return '';
    if (platform === 'win32') {
      if (pathApi) return pathApi.win32.resolve(value);
      return value.replace(/\//g, '\\');
    }
    if (pathApi) return pathApi.resolve(value);
    return value;
  }

  function normalizeHoster(hoster) {
    return typeof hoster === 'string' ? hoster.trim().toLowerCase() : '';
  }

  function uniqueHosters(values) {
    const hosters = [];
    const seen = new Set();
    for (const value of values) {
      const hoster = normalizeHoster(value);
      if (!hoster || seen.has(hoster)) continue;
      seen.add(hoster);
      hosters.push(hoster);
    }
    return hosters;
  }

  function cloneFingerprint(fingerprint) {
    if (!fingerprint || typeof fingerprint !== 'object' || Array.isArray(fingerprint)) return null;
    return { ...fingerprint };
  }

  function relatedJobs(queueJobs, job, platform) {
    if (!Array.isArray(queueJobs) || !job) return [];
    const file = normalizeFile(job.file, platform);
    const token = typeof job.sourceCleanupToken === 'string' && job.sourceCleanupToken
      ? job.sourceCleanupToken
      : null;
    return queueJobs.filter((candidate) => {
      if (!candidate) return false;
      if (file && normalizeFile(candidate.file, platform) === file) return true;
      return token !== null && candidate.sourceCleanupToken === token;
    });
  }

  function storedRequiredHosters(jobs) {
    const values = [];
    for (const job of jobs) {
      if (Array.isArray(job.sourceCleanupRequiredHosters)) {
        values.push(...job.sourceCleanupRequiredHosters);
      }
    }
    return uniqueHosters(values);
  }

  function completedHosters(jobs, requiredHosters) {
    const values = [];
    for (const job of jobs) {
      if (Array.isArray(job.sourceCleanupCompletedHosters)) {
        values.push(...job.sourceCleanupCompletedHosters);
      }
    }
    for (const job of jobs) {
      if (job.status === 'done') values.push(job.hoster);
    }
    const completed = new Set(uniqueHosters(values));
    return requiredHosters.filter((hoster) => completed.has(hoster));
  }

  function storedToken(jobs) {
    for (const job of jobs) {
      if (typeof job.sourceCleanupToken === 'string' && job.sourceCleanupToken) {
        return job.sourceCleanupToken;
      }
    }
    return null;
  }

  function storedFingerprint(jobs) {
    for (const job of jobs) {
      const fingerprint = cloneFingerprint(job.sourceCleanupFingerprint);
      if (fingerprint) return fingerprint;
    }
    return null;
  }

  function assignMetadata(jobs, token, requiredHosters, completed, fingerprint, touchedJobs, touchedSet) {
    for (const job of jobs) {
      job.sourceCleanupToken = token;
      job.sourceCleanupRequiredHosters = [...requiredHosters];
      job.sourceCleanupCompletedHosters = [...completed];
      job.sourceCleanupFingerprint = cloneFingerprint(fingerprint);
      if (!touchedSet.has(job)) {
        touchedSet.add(job);
        touchedJobs.push(job);
      }
    }
  }

  function prepareGroups(queueJobs, jobsToStart, createToken, platform) {
    const groups = [];
    const touchedJobs = [];
    const touchedSet = new Set();
    const preparedFiles = new Set();
    if (!Array.isArray(queueJobs) || !Array.isArray(jobsToStart)) return { groups, touchedJobs };

    for (const selectedJob of jobsToStart) {
      const file = normalizeFile(selectedJob && selectedJob.file, platform);
      if (!file || preparedFiles.has(file)) continue;
      const siblings = relatedJobs(queueJobs, selectedJob, platform);
      if (siblings.length === 0) continue;
      preparedFiles.add(file);

      const token = storedToken(siblings) || (typeof createToken === 'function' ? createToken(file) : null);
      if (typeof token !== 'string' || !token) continue;
      const persistedRequired = storedRequiredHosters(siblings);
      const requiredHosters = uniqueHosters([
        ...persistedRequired,
        ...siblings.map((job) => job.hoster)
      ]);
      const completed = completedHosters(siblings, requiredHosters);
      const fingerprint = storedFingerprint(siblings);

      assignMetadata(
        siblings,
        token,
        requiredHosters,
        completed,
        fingerprint,
        touchedJobs,
        touchedSet
      );

      groups.push({
        token,
        file: selectedJob.file,
        requiredHosters: [...requiredHosters],
        completedHosters: [...completed],
        fingerprint: cloneFingerprint(fingerprint),
        jobs: siblings.map((job) => ({
          jobId: job.id,
          hoster: normalizeHoster(job.hoster),
          status: job.status
        }))
      });
    }

    return { groups, touchedJobs };
  }

  function markCompleted(queueJobs, job, platform) {
    const siblings = relatedJobs(queueJobs, job, platform);
    if (siblings.length === 0) return [];
    const requiredHosters = storedRequiredHosters(siblings);
    const completed = new Set(completedHosters(siblings, requiredHosters));
    const hoster = normalizeHoster(job.hoster);
    if (requiredHosters.includes(hoster)) completed.add(hoster);
    const orderedCompleted = requiredHosters.filter((required) => completed.has(required));
    for (const sibling of siblings) {
      sibling.sourceCleanupCompletedHosters = [...orderedCompleted];
    }
    return siblings;
  }

  function removeRequirement(queueJobs, job, platform) {
    if (!job || protectedStatuses.has(job.status)) return [];
    const siblings = relatedJobs(queueJobs, job, platform);
    const removedHoster = normalizeHoster(job.hoster);
    for (const sibling of siblings) {
      const required = Array.isArray(sibling.sourceCleanupRequiredHosters)
        ? sibling.sourceCleanupRequiredHosters
        : [];
      const completed = Array.isArray(sibling.sourceCleanupCompletedHosters)
        ? sibling.sourceCleanupCompletedHosters
        : [];
      sibling.sourceCleanupRequiredHosters = uniqueHosters(required)
        .filter((hoster) => hoster !== removedHoster);
      sibling.sourceCleanupCompletedHosters = uniqueHosters(completed)
        .filter((hoster) => hoster !== removedHoster);
    }
    return siblings;
  }

  function fingerprintFor(fingerprints, token) {
    if (fingerprints instanceof Map) return fingerprints.get(token);
    if (!fingerprints || typeof fingerprints !== 'object') return undefined;
    return Object.prototype.hasOwnProperty.call(fingerprints, token)
      ? fingerprints[token]
      : undefined;
  }

  function applyFingerprints(queueJobs, fingerprints) {
    if (!Array.isArray(queueJobs)) return [];
    const touchedJobs = [];
    for (const job of queueJobs) {
      if (!job || typeof job.sourceCleanupToken !== 'string' || !job.sourceCleanupToken) continue;
      const fingerprint = fingerprintFor(fingerprints, job.sourceCleanupToken);
      if (fingerprint === undefined) continue;
      job.sourceCleanupFingerprint = cloneFingerprint(fingerprint);
      touchedJobs.push(job);
    }
    return touchedJobs;
  }

  const api = {
    prepareGroups,
    markCompleted,
    removeRequirement,
    applyFingerprints
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else if (root) {
    root.SourceCleanupPolicy = api;
  }
})(typeof window !== 'undefined' ? window : this);
