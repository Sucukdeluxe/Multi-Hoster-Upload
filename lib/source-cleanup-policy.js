(function (root) {
  'use strict';

  const pathApi = typeof require === 'function' ? require('path') : null;
  const metadataVersion = 2;

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

  function confirmedHosters(jobs, requiredHosters) {
    const values = [];
    for (const job of jobs) {
      if (job.sourceCleanupMetadataVersion === metadataVersion && Array.isArray(job.sourceCleanupConfirmedHosters)) {
        values.push(...job.sourceCleanupConfirmedHosters);
      }
    }
    const confirmed = new Set(uniqueHosters(values));
    return requiredHosters.filter((hoster) => confirmed.has(hoster));
  }

  function provisionalHosters(jobs, requiredHosters) {
    const values = [];
    for (const job of jobs) {
      if (job.sourceCleanupMetadataVersion === metadataVersion && Array.isArray(job.sourceCleanupProvisionalHosters)) {
        values.push(...job.sourceCleanupProvisionalHosters);
      }
    }
    const provisional = new Set(uniqueHosters(values));
    return requiredHosters.filter((hoster) => provisional.has(hoster));
  }

  function startedHosters(jobs, requiredHosters) {
    const values = [];
    let legacyMetadata = false;
    for (const job of jobs) {
      if (job.sourceCleanupMetadataVersion !== metadataVersion) continue;
      if (!Array.isArray(job.sourceCleanupStartedHosters)) legacyMetadata = true;
      else values.push(...job.sourceCleanupStartedHosters);
    }
    if (legacyMetadata) return [...requiredHosters];
    const started = new Set(uniqueHosters(values));
    return requiredHosters.filter((hoster) => started.has(hoster));
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

  function assignMetadata(jobs, token, requiredHosters, confirmed, provisional, started, fingerprint, touchedJobs, touchedSet) {
    for (const job of jobs) {
      job.sourceCleanupMetadataVersion = metadataVersion;
      job.sourceCleanupToken = token;
      job.sourceCleanupRequiredHosters = [...requiredHosters];
      job.sourceCleanupConfirmedHosters = [...confirmed];
      job.sourceCleanupProvisionalHosters = [...provisional];
      job.sourceCleanupStartedHosters = [...started];
      job.sourceCleanupFingerprint = cloneFingerprint(fingerprint);
      delete job.sourceCleanupCompletedHosters;
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
    const revokedHosters = [];
    const revokedSet = new Set();
    if (!Array.isArray(queueJobs) || !Array.isArray(jobsToStart)) return { groups, touchedJobs, revokedHosters };
    const currentRoundJobs = new Set(jobsToStart);

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
      const currentStartedHosters = new Set(uniqueHosters(
        siblings.filter((job) => currentRoundJobs.has(job)).map((job) => job.hoster)
      ));
      const started = uniqueHosters([...startedHosters(siblings, requiredHosters), ...currentStartedHosters]);
      const storedConfirmed = confirmedHosters(siblings, requiredHosters);
      const confirmed = storedConfirmed.filter((hoster) => !currentStartedHosters.has(hoster));
      const provisional = provisionalHosters(siblings, requiredHosters)
        .filter((hoster) => !currentStartedHosters.has(hoster));
      for (const hoster of storedConfirmed) {
        if (!currentStartedHosters.has(hoster) || revokedSet.has(hoster)) continue;
        revokedSet.add(hoster);
        revokedHosters.push(hoster);
      }
      const fingerprint = storedFingerprint(siblings);

      assignMetadata(
        siblings,
        token,
        requiredHosters,
        confirmed,
        provisional,
        started,
        fingerprint,
        touchedJobs,
        touchedSet
      );

      groups.push({
        token,
        file: selectedJob.file,
        requiredHosters: [...requiredHosters],
        confirmedHosters: [...confirmed],
        fingerprint: cloneFingerprint(fingerprint),
        jobs: siblings.map((job) => ({
          jobId: job.id,
          hoster: normalizeHoster(job.hoster),
          status: job.status,
          currentRound: currentRoundJobs.has(job)
        }))
      });
    }

    return { groups, touchedJobs, revokedHosters };
  }

  function markCompleted(queueJobs, job, platform) {
    const siblings = relatedJobs(queueJobs, job, platform);
    if (siblings.length === 0) return [];
    const requiredHosters = storedRequiredHosters(siblings);
    const provisional = new Set(provisionalHosters(siblings, requiredHosters));
    const hoster = normalizeHoster(job.hoster);
    if (requiredHosters.includes(hoster)) provisional.add(hoster);
    const orderedConfirmed = confirmedHosters(siblings, requiredHosters);
    const orderedProvisional = requiredHosters.filter((required) => provisional.has(required));
    for (const sibling of siblings) {
      sibling.sourceCleanupMetadataVersion = metadataVersion;
      sibling.sourceCleanupConfirmedHosters = [...orderedConfirmed];
      sibling.sourceCleanupProvisionalHosters = [...orderedProvisional];
      delete sibling.sourceCleanupCompletedHosters;
    }
    return siblings;
  }

  async function persistRoundCompletions(queueJobs, options = {}) {
    if (!Array.isArray(queueJobs) || typeof options.persist !== 'function') return false;
    const historyPersisted = options.historyPersisted === true;
    const groupsByToken = new Map();
    for (const job of queueJobs) {
      if (!job || typeof job.sourceCleanupToken !== 'string' || !job.sourceCleanupToken) continue;
      if (!groupsByToken.has(job.sourceCleanupToken)) groupsByToken.set(job.sourceCleanupToken, []);
      groupsByToken.get(job.sourceCleanupToken).push(job);
    }
    const snapshots = [];
    for (const jobs of groupsByToken.values()) {
      const requiredHosters = storedRequiredHosters(jobs);
      const confirmed = confirmedHosters(jobs, requiredHosters);
      const provisional = provisionalHosters(jobs, requiredHosters);
      const promoted = historyPersisted
        ? uniqueHosters([...confirmed, ...provisional])
        : confirmed;
      const orderedPromoted = requiredHosters.filter((hoster) => promoted.includes(hoster));
      for (const job of jobs) {
        snapshots.push({
          job,
          confirmedHosters: job.sourceCleanupMetadataVersion === metadataVersion
            ? uniqueHosters(job.sourceCleanupConfirmedHosters)
            : []
        });
        job.sourceCleanupMetadataVersion = metadataVersion;
        job.sourceCleanupConfirmedHosters = [...orderedPromoted];
        job.sourceCleanupProvisionalHosters = [];
        delete job.sourceCleanupCompletedHosters;
      }
    }
    let persisted = false;
    try {
      persisted = (await options.persist()) === true;
    } catch {}
    if (!persisted) {
      for (const snapshot of snapshots) {
        snapshot.job.sourceCleanupMetadataVersion = metadataVersion;
        snapshot.job.sourceCleanupConfirmedHosters = [...snapshot.confirmedHosters];
        snapshot.job.sourceCleanupProvisionalHosters = [];
        delete snapshot.job.sourceCleanupCompletedHosters;
      }
    }
    return persisted;
  }

  function removeRequirement(queueJobs, job, platform) {
    if (!job || job.status !== 'preview' || job.interrupted) return [];
    const siblings = relatedJobs(queueJobs, job, platform);
    const removedHoster = normalizeHoster(job.hoster);
    if (startedHosters(siblings, storedRequiredHosters(siblings)).includes(removedHoster)) return [];
    for (const sibling of siblings) {
      const required = Array.isArray(sibling.sourceCleanupRequiredHosters)
        ? sibling.sourceCleanupRequiredHosters
        : [];
      const confirmed = sibling.sourceCleanupMetadataVersion === metadataVersion && Array.isArray(sibling.sourceCleanupConfirmedHosters)
        ? sibling.sourceCleanupConfirmedHosters
        : [];
      const provisional = sibling.sourceCleanupMetadataVersion === metadataVersion && Array.isArray(sibling.sourceCleanupProvisionalHosters)
        ? sibling.sourceCleanupProvisionalHosters
        : [];
      sibling.sourceCleanupMetadataVersion = metadataVersion;
      sibling.sourceCleanupRequiredHosters = uniqueHosters(required)
        .filter((hoster) => hoster !== removedHoster);
      sibling.sourceCleanupConfirmedHosters = uniqueHosters(confirmed)
        .filter((hoster) => hoster !== removedHoster);
      sibling.sourceCleanupProvisionalHosters = uniqueHosters(provisional)
        .filter((hoster) => hoster !== removedHoster);
      delete sibling.sourceCleanupCompletedHosters;
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
    persistRoundCompletions,
    removeRequirement,
    applyFingerprints
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else if (root) {
    root.SourceCleanupPolicy = api;
  }
})(typeof window !== 'undefined' ? window : this);
