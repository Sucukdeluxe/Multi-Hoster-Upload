(function (root) {
  function summarizePerHoster(history, opts) {
    const out = {};
    if (!Array.isArray(history)) return out;
    const cutoff = opts && Number.isFinite(opts.sinceMs) ? opts.sinceMs : null;
    const limitBatches = opts && Number.isFinite(opts.lastNBatches) && opts.lastNBatches > 0 ? opts.lastNBatches : null;

    const entries = [...history];
    entries.sort((a, b) => {
      const ta = a && a.timestamp ? Date.parse(a.timestamp) : 0;
      const tb = b && b.timestamp ? Date.parse(b.timestamp) : 0;
      return tb - ta;
    });
    const sliced = limitBatches ? entries.slice(0, limitBatches) : entries;

    for (const batch of sliced) {
      if (!batch || !Array.isArray(batch.files)) continue;
      if (cutoff !== null) {
        const ts = batch.timestamp ? Date.parse(batch.timestamp) : 0;
        if (!ts || ts < cutoff) continue;
      }
      for (const file of batch.files) {
        if (!file || !Array.isArray(file.results)) continue;
        for (const r of file.results) {
          if (!r || !r.hoster) continue;
          const bucket = out[r.hoster] || (out[r.hoster] = { ok: 0, fail: 0, skipped: 0, total: 0 });
          bucket.total++;
          if (r.status === 'done') bucket.ok++;
          else if (r.status === 'skipped') bucket.skipped++;
          else bucket.fail++;
        }
      }
    }
    for (const h of Object.keys(out)) {
      const b = out[h];
      const attempted = b.ok + b.fail;
      b.rate = attempted > 0 ? b.ok / attempted : null;
    }
    return out;
  }

  function mergeHosterHealthHistory(history, batch) {
    if (!Array.isArray(history)) return history;
    if (!batch?.id) return [...history, batch];
    const merged = [];
    let replaced = false;
    for (const existing of history) {
      if (existing?.id === batch.id) {
        if (!replaced) merged.push(batch);
        replaced = true;
      } else {
        merged.push(existing);
      }
    }
    if (!replaced) merged.push(batch);
    return merged;
  }

  function summarizeHosterHealth(history, options = {}) {
    const out = {};
    const hosters = options.hosters && typeof options.hosters === 'object' ? options.hosters : {};
    const accountStatuses = options.accountStatuses && typeof options.accountStatuses === 'object' ? options.accountStatuses : {};
    const failedKeys = new Set(options.sessionFailedKeys instanceof Set
      ? options.sessionFailedKeys
      : (Array.isArray(options.sessionFailedKeys) ? options.sessionFailedKeys : []));
    const nowCandidate = options.now instanceof Date
      ? options.now.getTime()
      : (Number.isFinite(options.now) ? Number(options.now) : Date.parse(options.now));
    const nowMs = Number.isFinite(nowCandidate) ? nowCandidate : Date.now();
    const recentCutoff = nowMs - 7 * 24 * 60 * 60 * 1000;

    const ensure = (name) => out[name] || (out[name] = {
      sampleSize: 0,
      successful: 0,
      failed: 0,
      skipped: 0,
      successRate: null,
      effectiveBytes: 0,
      effectiveDurationSec: 0,
      effectiveBytesPerSecond: null,
      lastSuccessAt: null,
      failuresLast7Days: 0,
      configuredAccounts: 0,
      accountProblems: 0,
      uncheckedAccounts: 0,
      checkingAccounts: 0
    });

    const hasCredentials = (account) => {
      if (!account || typeof account !== 'object' || !account.id) return false;
      if (account.authType === 'api') return Boolean(String(account.apiKey || '').trim());
      if (account.authType === 'login') return Boolean(String(account.username || '').trim() && String(account.password || '').trim());
      return Boolean(String(account.apiKey || '').trim() || (String(account.username || '').trim() && String(account.password || '').trim()));
    };

    for (const [name, accountsValue] of Object.entries(hosters)) {
      const bucket = ensure(name);
      const accounts = Array.isArray(accountsValue) ? accountsValue : [];
      bucket.configuredAccounts = accounts.length;
      for (const account of accounts) {
        if (account?.enabled === false) continue;
        const status = accountStatuses[account?.id]?.status || 'unchecked';
        const unavailable = !hasCredentials(account);
        const problem = unavailable || failedKeys.has(`${name}:${account?.id || ''}`) || ['error', 'warn', 'otp_required'].includes(status);
        if (problem) bucket.accountProblems++;
        if (!unavailable && status === 'unchecked') bucket.uncheckedAccounts++;
        if (!unavailable && status === 'checking') bucket.checkingAccounts++;
      }
    }

    const validBatches = (Array.isArray(history) ? history : [])
      .map((batch, index) => {
        const timestampMs = batch?.timestamp ? Date.parse(batch.timestamp) : NaN;
        return { batch, index, timestampMs };
      })
      .filter(({ timestampMs }) => Number.isFinite(timestampMs) && timestampMs <= nowMs);
    const batches = [...validBatches]
      .sort((a, b) => b.timestampMs - a.timestampMs || b.index - a.index)
      .slice(0, 50);

    for (const { batch, timestampMs } of batches) {
      if (!batch || !Array.isArray(batch.files)) continue;
      for (const file of batch.files) {
        if (!file || !Array.isArray(file.results)) continue;
        const fileSize = Number(file.size);
        for (const result of file.results) {
          if (!result?.hoster) continue;
          const bucket = ensure(result.hoster);
          bucket.sampleSize++;
          if (result.status === 'done') {
            bucket.successful++;
            const previous = bucket.lastSuccessAt ? Date.parse(bucket.lastSuccessAt) : -Infinity;
            if (timestampMs > previous) bucket.lastSuccessAt = new Date(timestampMs).toISOString();
            const durationSec = Number(result.durationSec);
            if (Number.isFinite(fileSize) && fileSize > 0 && Number.isFinite(durationSec) && durationSec > 0) {
              bucket.effectiveBytes += fileSize;
              bucket.effectiveDurationSec += durationSec;
            }
          } else if (result.status === 'skipped') {
            bucket.skipped++;
          } else {
            bucket.failed++;
          }
        }
      }
    }

    for (const { batch, timestampMs } of validBatches) {
      if (timestampMs < recentCutoff || !Array.isArray(batch?.files)) continue;
      for (const file of batch.files) {
        if (!Array.isArray(file?.results)) continue;
        for (const result of file.results) {
          if (!result?.hoster || result.status === 'done' || result.status === 'skipped') continue;
          ensure(result.hoster).failuresLast7Days++;
        }
      }
    }

    for (const bucket of Object.values(out)) {
      const attempted = bucket.successful + bucket.failed;
      bucket.successRate = attempted > 0 ? bucket.successful / attempted : null;
      bucket.effectiveBytesPerSecond = bucket.effectiveDurationSec > 0
        ? bucket.effectiveBytes / bucket.effectiveDurationSec
        : null;
    }
    return out;
  }

  function classifyErrorCategory(err) {
    if (!err || typeof err !== 'string') return 'unknown';
    const s = err.toLowerCase();
    if (/abgebrochen|aborted|cancel/.test(s)) return 'aborted';
    if (/not video file format|kein videoformat|invalid file|wrong format|duplicate|already exists|file too (small|big|large)|datei zu (gro|klein)/.test(s)) return 'file-rejected';
    if (/quota|storage (full|exhausted|voll)|account (full|banned|suspended)|disk (space )?full|insufficient (disk )?space|not enough (disk )?(space|storage)/.test(s)) return 'account-error';
    if (/csrf|kein upload-server|server.*?(busy|unavailable|try again)|no servers available|filecode|kein filecode|empty.*?(form|response)/.test(s)) return 'hoster-transient';
    if (/timeout|econnreset|enotfound|fetch failed|network|socket hang up|abort/.test(s)) return 'network';
    return 'unknown';
  }

  function summarizeBatchErrors(batchSummary) {
    const buckets = {
      'file-rejected': [],
      'account-error': [],
      'hoster-transient': [],
      'network': [],
      'unknown': [],
      'aborted': []
    };
    if (!batchSummary || !Array.isArray(batchSummary.files)) return buckets;
    for (const f of batchSummary.files) {
      if (!f || !Array.isArray(f.results)) continue;
      for (const r of f.results) {
        if (!r || r.status === 'done' || r.status === 'skipped') continue;
        const cat = classifyErrorCategory(r.error);
        buckets[cat].push({
          fileName: f.name || f.fileName || '',
          hoster: r.hoster || '',
          error: r.error || '',
          jobId: r.jobId || null
        });
      }
    }
    return buckets;
  }

  function mergeSkippedIntoSummary(summary, skippedJobs) {
    const source = summary && typeof summary === 'object' ? summary : {};
    const merged = {
      ...source,
      files: Array.isArray(source.files)
        ? source.files.map(file => ({ ...file, results: Array.isArray(file.results) ? [...file.results] : [] }))
        : []
    };
    const existingJobIds = new Set();
    const filesByName = new Map();
    for (const file of merged.files) {
      filesByName.set(String(file.name || file.fileName || ''), file);
      for (const result of file.results) {
        if (result?.jobId) existingJobIds.add(result.jobId);
      }
    }
    let added = 0;
    for (const skipped of Array.isArray(skippedJobs) ? skippedJobs : []) {
      if (!skipped || (skipped.jobId && existingJobIds.has(skipped.jobId))) continue;
      const fileName = String(skipped.fileName || skipped.file || '').split(/[\\/]/).pop() || '';
      let file = filesByName.get(fileName);
      if (!file) {
        file = { name: fileName, size: Number(skipped.size) || 0, results: [] };
        merged.files.push(file);
        filesByName.set(fileName, file);
      }
      file.results.push({
        jobId: skipped.jobId || null,
        hoster: skipped.hoster || '',
        status: 'skipped',
        error: skipped.reason || 'Übersprungen'
      });
      if (skipped.jobId) existingJobIds.add(skipped.jobId);
      added++;
    }
    merged.total = (Number(source.total) || 0) + added;
    merged.succeeded = Number(source.succeeded) || 0;
    merged.failed = Number(source.failed) || 0;
    merged.skipped = (Number(source.skipped) || 0) + added;
    return merged;
  }

  const RETRYABLE_CATEGORIES = new Set(['hoster-transient', 'network', 'unknown']);
  function isRetryableCategory(cat) {
    return RETRYABLE_CATEGORIES.has(cat);
  }

  const CATEGORY_LABELS = {
    'file-rejected': 'Datei abgelehnt',
    'account-error': 'Account-Problem',
    'hoster-transient': 'Hoster-Flake',
    'network': 'Netzwerk',
    'unknown': 'Unbekannt',
    'aborted': 'Abgebrochen'
  };

  function formatLinks(rows, format) {
    if (!Array.isArray(rows)) return '';
    const safe = rows.filter(r => r && r.url);
    if (safe.length === 0) return '';
    switch (format) {
      case 'plain':
        return safe.map(r => r.url).join('\n');
      case 'bbcode':
        return safe.map(r => {
          const label = r.fileName || r.hoster || r.url;
          return `[url=${r.url}]${label}[/url]`;
        }).join('\n');
      case 'markdown':
        return safe.map(r => {
          const label = r.fileName || r.hoster || r.url;
          return `- [${label}](${r.url})`;
        }).join('\n');
      case 'html':
        return safe.map(r => {
          const label = r.fileName || r.hoster || r.url;
          return `<a href="${r.url}">${label}</a>`;
        }).join('\n');
      case 'csv': {
        const head = 'fileName,hoster,url\n';
        return head + safe.map(r => {
          const esc = (v) => `"${String(v || '').replace(/"/g, '""')}"`;
          return [esc(r.fileName), esc(r.hoster), esc(r.url)].join(',');
        }).join('\n');
      }
      case 'json':
        return JSON.stringify(safe.map(r => ({ fileName: r.fileName || '', hoster: r.hoster || '', url: r.url })), null, 2);
      default:
        return safe.map(r => r.url).join('\n');
    }
  }

  const api = {
    summarizePerHoster,
    mergeHosterHealthHistory,
    summarizeHosterHealth,
    classifyErrorCategory,
    summarizeBatchErrors,
    mergeSkippedIntoSummary,
    isRetryableCategory,
    RETRYABLE_CATEGORIES,
    CATEGORY_LABELS,
    formatLinks
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else if (root) {
    root.Stats = api;
  }
})(typeof window !== 'undefined' ? window : this);
