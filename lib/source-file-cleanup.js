const RETRY_DELAYS = [100, 250, 500, 1000, 2000];
const TERMINAL_STATUSES = new Set(['done', 'error', 'aborted', 'skipped', 'failed', 'missing-account']);
const crypto = require('node:crypto');

function createSourceFileCleanup(options) {
  if (!options || !options.fs || !options.path) {
    throw new TypeError('createSourceFileCleanup requires fs and path');
  }

  const fs = options.fs;
  const path = options.path;
  const platform = options.platform || process.platform;
  const isEnabled = typeof options.isEnabled === 'function' ? options.isEnabled : () => false;
  const audit = typeof options.audit === 'function' ? options.audit : () => {};
  const journal = options.journal || null;
  const wait = typeof options.wait === 'function'
    ? options.wait
    : (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const groups = new Map();
  const leases = new Map();

  function canonicalize(file) {
    const resolved = path.resolve(file);
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
  }

  function cloneFingerprint(fingerprint) {
    if (!fingerprint) return null;
    return {
      type: 'file',
      size: fingerprint.size,
      mtimeMs: fingerprint.mtimeMs,
      birthtimeMs: fingerprint.birthtimeMs,
      dev: fingerprint.dev,
      ino: fingerprint.ino
    };
  }

  function isFingerprint(fingerprint) {
    return Boolean(
      fingerprint &&
      fingerprint.type === 'file' &&
      Number.isFinite(fingerprint.size) &&
      Number.isFinite(fingerprint.mtimeMs) &&
      Number.isFinite(fingerprint.birthtimeMs) &&
      Number.isFinite(fingerprint.dev) &&
      Number.isFinite(fingerprint.ino)
    );
  }

  function fingerprintFromStat(stat) {
    if (!stat.isFile()) return null;
    return {
      type: 'file',
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      birthtimeMs: stat.birthtimeMs,
      dev: stat.dev,
      ino: stat.ino
    };
  }

  function fingerprintsMatch(left, right) {
    return Boolean(
      left &&
      right &&
      left.type === right.type &&
      left.size === right.size &&
      left.mtimeMs === right.mtimeMs &&
      left.birthtimeMs === right.birthtimeMs &&
      left.dev === right.dev &&
      left.ino === right.ino
    );
  }

  function uniqueStrings(values) {
    return [...new Set((Array.isArray(values) ? values : []).filter((value) => typeof value === 'string' && value.length > 0))];
  }

  function normalizeStatus(status) {
    return TERMINAL_STATUSES.has(status) ? status : 'pending';
  }

  function createManifest(input, canonicalFile) {
    const requiredHosters = uniqueStrings(input.requiredHosters);
    const completedHosters = new Set(uniqueStrings(input.completedHosters));
    const jobs = new Map();

    for (const job of Array.isArray(input.jobs) ? input.jobs : []) {
      if (!job || typeof job.jobId !== 'string' || typeof job.hoster !== 'string') continue;
      const status = completedHosters.has(job.hoster) ? 'done' : normalizeStatus(job.status);
      jobs.set(job.jobId, Object.freeze({
        jobId: job.jobId,
        hoster: job.hoster,
        status
      }));
    }

    for (const hoster of completedHosters) {
      if (requiredHosters.includes(hoster)) continue;
      completedHosters.delete(hoster);
    }

    return {
      token: input.token || input.sourceCleanupToken,
      file: path.resolve(input.file),
      canonicalFile,
      requiredHosters: Object.freeze(requiredHosters),
      completedHosters,
      jobs,
      suppliedFingerprint: isFingerprint(input.fingerprint) ? cloneFingerprint(input.fingerprint) : null,
      fingerprint: null,
      registrationOutcome: null,
      registrationError: null,
      audited: false,
      finalizationPromise: null
    };
  }

  async function inspectRegistration(manifest) {
    try {
      const stat = await fs.promises.lstat(manifest.file);
      const currentFingerprint = fingerprintFromStat(stat);
      if (!currentFingerprint) {
        manifest.registrationOutcome = 'unsafe-source-type';
        return;
      }
      if (manifest.suppliedFingerprint && !fingerprintsMatch(manifest.suppliedFingerprint, currentFingerprint)) {
        manifest.fingerprint = manifest.suppliedFingerprint;
        manifest.registrationOutcome = 'source-changed';
        return;
      }
      manifest.fingerprint = manifest.suppliedFingerprint || currentFingerprint;
    } catch (error) {
      manifest.registrationOutcome = error && error.code === 'ENOENT' ? 'source-missing' : 'failed';
      manifest.registrationError = error;
    }
  }

  async function registerGroups(inputGroups) {
    const fingerprints = {};
    for (const input of Array.isArray(inputGroups) ? inputGroups : []) {
      const token = input && (input.token || input.sourceCleanupToken);
      if (typeof token !== 'string' || token.length === 0 || typeof input.file !== 'string' || input.file.length === 0) {
        throw new TypeError('source cleanup groups require token and file');
      }
      const existing = groups.get(token);
      if (existing) {
        if (existing.finalizationPromise) throw new Error('source cleanup group is already finalizing');
        if (canonicalize(input.file) !== existing.canonicalFile) throw new Error('source cleanup token changed file');
        existing.requiredHosters = Object.freeze(uniqueStrings([
          ...existing.requiredHosters,
          ...input.requiredHosters
        ]));
        for (const hoster of uniqueStrings(input.completedHosters)) {
          if (existing.requiredHosters.includes(hoster)) existing.completedHosters.add(hoster);
        }
        for (const job of Array.isArray(input.jobs) ? input.jobs : []) {
          if (!job || typeof job.jobId !== 'string' || typeof job.hoster !== 'string') continue;
          const previous = existing.jobs.get(job.jobId);
          const status = existing.completedHosters.has(job.hoster)
            ? 'done'
            : normalizeStatus(previous ? previous.status : job.status);
          existing.jobs.set(job.jobId, Object.freeze({ jobId: job.jobId, hoster: job.hoster, status }));
        }
        fingerprints[token] = cloneFingerprint(existing.fingerprint);
        continue;
      }

      const canonicalFile = canonicalize(input.file);
      const manifest = createManifest(input, canonicalFile);
      const leaseToken = leases.get(canonicalFile);
      if (leaseToken && leaseToken !== token) {
        manifest.registrationOutcome = 'blocked';
        manifest.registrationError = new Error('active-source-lease');
        const leaseOwner = groups.get(leaseToken);
        if (leaseOwner) {
          leaseOwner.registrationOutcome = 'blocked';
          leaseOwner.registrationError = new Error('active-source-lease');
        }
      } else {
        leases.set(canonicalFile, token);
        await inspectRegistration(manifest);
      }
      groups.set(token, manifest);
      fingerprints[token] = cloneFingerprint(manifest.fingerprint);
    }
    return fingerprints;
  }

  function settle(event) {
    if (!event || !TERMINAL_STATUSES.has(event.status)) return false;
    const token = event.token || event.sourceCleanupToken;
    const manifest = groups.get(token);
    if (!manifest || manifest.finalizationPromise) return false;
    const job = manifest.jobs.get(event.jobId);
    if (!job || job.hoster !== event.hoster) return false;
    if (typeof event.file === 'string' && canonicalize(event.file) !== manifest.canonicalFile) return false;
    manifest.jobs.set(event.jobId, Object.freeze({ ...job, status: event.status }));
    if (event.status === 'done') manifest.completedHosters.add(event.hoster);
    return true;
  }

  function markSkipped(jobId) {
    let changed = false;
    for (const manifest of groups.values()) {
      if (manifest.finalizationPromise) continue;
      const job = manifest.jobs.get(jobId);
      if (!job) continue;
      manifest.jobs.set(jobId, Object.freeze({ ...job, status: 'skipped' }));
      changed = true;
    }
    return changed;
  }

  function blockingStatuses(manifest) {
    const blocking = [];
    for (const hoster of manifest.requiredHosters) {
      if (manifest.completedHosters.has(hoster)) continue;
      const statuses = [...manifest.jobs.values()]
        .filter((job) => job.hoster === hoster)
        .map((job) => job.status);
      if (statuses.includes('done')) continue;
      const status = statuses.find((value) => value !== 'pending') || 'pending';
      blocking.push({ hoster, status });
    }
    return blocking;
  }

  async function emitAudit(manifest, outcome, details = {}) {
    if (manifest.audited) return;
    manifest.audited = true;
    await writeAudit(manifest, outcome, details);
  }

  async function writeAudit(manifest, outcome, details = {}) {
    const event = {
      timestamp: new Date().toISOString(),
      outcome,
      file: manifest.file,
      hosters: [...manifest.requiredHosters],
      ...details
    };
    if (event.error instanceof Error) event.error = event.error.message;
    try {
      return (await audit(event)) !== false;
    } catch {
      return false;
    }
  }

  async function currentSourceOutcome(manifest) {
    try {
      const stat = await fs.promises.lstat(manifest.file);
      const currentFingerprint = fingerprintFromStat(stat);
      if (!currentFingerprint) return { outcome: 'unsafe-source-type', trigger: 'unsafe-source-type' };
      if (!fingerprintsMatch(manifest.fingerprint, currentFingerprint)) {
        return { outcome: 'source-changed', trigger: 'source-fingerprint-mismatch' };
      }
      return null;
    } catch (error) {
      if (error && error.code === 'ENOENT') return { outcome: 'source-missing', trigger: 'source-missing' };
      return { outcome: 'failed', trigger: 'source-stat-failed', error };
    }
  }

  async function unlinkWithRetries(file) {
    let attempts = 0;
    while (true) {
      attempts += 1;
      try {
        await fs.promises.unlink(file);
        return { attempts };
      } catch (error) {
        const retryable = platform === 'win32' && error && (error.code === 'EBUSY' || error.code === 'EPERM');
        if (!retryable || attempts > RETRY_DELAYS.length) throw Object.assign(error, { cleanupAttempts: attempts });
        await wait(RETRY_DELAYS[attempts - 1]);
      }
    }
  }

  async function restoreStagedFile(manifest, stagedFile) {
    try {
      await fs.promises.rename(stagedFile, manifest.file);
      return null;
    } catch (error) {
      return error;
    }
  }

  async function clearJournal(manifest) {
    if (!journal || typeof journal.clear !== 'function') return;
    try { await journal.clear(manifest.token); } catch {}
  }

  async function stageSource(manifest) {
    const stagedFile = path.join(
      path.dirname(manifest.file),
      `.${path.basename(manifest.file)}.mhu-delete-${crypto.randomUUID()}`
    );
    if (!journal || typeof journal.plan !== 'function') {
      return { outcome: 'blocked', trigger: 'delete-journal-unavailable' };
    }
    try {
      await journal.plan({ token: manifest.token, file: manifest.file, stagedFile });
    } catch (error) {
      return { outcome: 'blocked', trigger: 'delete-journal-write-failed', error };
    }
    try {
      await fs.promises.rename(manifest.file, stagedFile);
    } catch (error) {
      await clearJournal(manifest);
      return {
        outcome: error && error.code === 'ENOENT' ? 'source-missing' : 'failed',
        trigger: error && error.code === 'ENOENT' ? 'source-missing' : 'source-stage-failed',
        error
      };
    }
    try {
      const stat = await fs.promises.lstat(stagedFile);
      const fingerprint = fingerprintFromStat(stat);
      if (fingerprintsMatch(manifest.fingerprint, fingerprint)) return { stagedFile };
      const restoreError = await restoreStagedFile(manifest, stagedFile);
      if (!restoreError) await clearJournal(manifest);
      return {
        outcome: 'source-changed',
        trigger: 'source-fingerprint-mismatch-after-stage',
        error: restoreError,
        stagedFile: restoreError ? stagedFile : undefined
      };
    } catch (error) {
      const restoreError = await restoreStagedFile(manifest, stagedFile);
      if (!restoreError) await clearJournal(manifest);
      return {
        outcome: 'failed',
        trigger: 'staged-source-stat-failed',
        error,
        restoreError,
        stagedFile: restoreError ? stagedFile : undefined
      };
    }
  }

  async function finalize(manifest, barriers) {
    try {
      let enabled;
      try {
        enabled = Boolean(await isEnabled());
      } catch (error) {
        await emitAudit(manifest, 'failed', { trigger: 'setting-check-failed', error });
        return 'failed';
      }
      if (!enabled) {
        await emitAudit(manifest, 'setting-disabled', { trigger: 'setting-disabled' });
        return 'setting-disabled';
      }
      if (!barriers.historyPersisted || !barriers.queuePersisted) {
        await emitAudit(manifest, 'blocked', {
          trigger: 'persistence-barrier-incomplete',
          historyPersisted: Boolean(barriers.historyPersisted),
          queuePersisted: Boolean(barriers.queuePersisted)
        });
        return 'blocked';
      }
      if (manifest.registrationOutcome) {
        await emitAudit(manifest, manifest.registrationOutcome, {
          trigger: manifest.registrationOutcome === 'blocked' ? 'active-source-lease' : manifest.registrationOutcome,
          error: manifest.registrationError
        });
        return manifest.registrationOutcome;
      }
      const blocking = blockingStatuses(manifest);
      if (blocking.length > 0) {
        await emitAudit(manifest, 'blocked', {
          trigger: 'required-hoster-not-done',
          blockingStatuses: blocking
        });
        return 'blocked';
      }
      const sourceOutcome = await currentSourceOutcome(manifest);
      if (sourceOutcome) {
        await emitAudit(manifest, sourceOutcome.outcome, sourceOutcome);
        return sourceOutcome.outcome;
      }
      const auditPersisted = await writeAudit(manifest, 'delete-approved', {
        trigger: 'all-selected-hosters-succeeded'
      });
      if (!auditPersisted) {
        await emitAudit(manifest, 'blocked', { trigger: 'audit-write-failed' });
        return 'blocked';
      }
      const staged = await stageSource(manifest);
      if (!staged.stagedFile || staged.outcome) {
        await emitAudit(manifest, staged.outcome || 'failed', staged);
        return staged.outcome || 'failed';
      }
      const commitPersisted = await writeAudit(manifest, 'source-staged', {
        trigger: 'verified-source-staged'
      });
      if (!commitPersisted) {
        const restoreError = await restoreStagedFile(manifest, staged.stagedFile);
        if (!restoreError) await clearJournal(manifest);
        await emitAudit(manifest, 'blocked', {
          trigger: 'audit-commit-write-failed',
          restoreError,
          stagedFile: restoreError ? staged.stagedFile : undefined
        });
        return 'blocked';
      }
      try {
        const result = await unlinkWithRetries(staged.stagedFile);
        await clearJournal(manifest);
        await emitAudit(manifest, 'deleted', {
          trigger: 'all-selected-hosters-succeeded',
          attempts: result.attempts
        });
        return 'deleted';
      } catch (error) {
        const restoreError = await restoreStagedFile(manifest, staged.stagedFile);
        if (!restoreError) await clearJournal(manifest);
        await emitAudit(manifest, 'failed', {
          trigger: 'unlink-failed',
          attempts: error.cleanupAttempts || 1,
          error,
          restoreError,
          stagedFile: restoreError ? staged.stagedFile : undefined
        });
        return 'failed';
      }
    } catch (error) {
      await emitAudit(manifest, 'failed', { trigger: 'cleanup-failed', error });
      return 'failed';
    } finally {
      if (leases.get(manifest.canonicalFile) === manifest.token) leases.delete(manifest.canonicalFile);
    }
  }

  async function finishBatch(barriers = {}) {
    const pending = [];
    for (const manifest of groups.values()) {
      if (!manifest.finalizationPromise) {
        manifest.finalizationPromise = finalize(manifest, {
          historyPersisted: barriers.historyPersisted === true,
          queuePersisted: barriers.queuePersisted === true
        });
      }
      pending.push(manifest.finalizationPromise);
    }
    return Promise.all(pending);
  }

  return Object.freeze({ registerGroups, settle, markSkipped, finishBatch });
}

module.exports = { createSourceFileCleanup };
