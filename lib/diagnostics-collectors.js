const fs = require('fs');
const path = require('path');
const { getRotatedLogPath } = require('./log-rotation');

const READABLE_LOGS = {
  debug: 'debug',
  fileuploader: 'fileuploader',
  uploadAudit: 'uploadAudit',
  accountRotation: 'accountRotation',
  crash: 'crashLog'
};

const QUEUE_STATUSES = ['preview', 'queued', 'getting-server', 'uploading', 'retrying', 'done', 'error', 'aborted', 'skipped'];

function createCollectors(deps) {
  const { loadConfig, loadHistory, getAllLogPaths, support, stats, appInfo, systemInfo, agentInfo } = deps;

  function _secrets() {
    try { return support.collectSecretValues(loadConfig()); } catch { return []; }
  }

  function _deepRedact(value, secrets) {
    return support.valueScrub(value, secrets || _secrets());
  }

  function redactResponse(value) {
    return _deepRedact(value);
  }

  function _resolveLogPath(name, backup) {
    const key = READABLE_LOGS[name];
    if (!key) return null;
    const paths = getAllLogPaths();
    let p = paths[key];
    if (!p) return null;
    if (backup === 1 || backup === 2) p = getRotatedLogPath(p, backup);
    return p;
  }

  function getSystemInfo() {
    return { app: appInfo(), system: systemInfo(), agent: agentInfo() };
  }

  function getConfigRedacted(args) {
    const section = (args && args.section) || 'all';
    const cfg = loadConfig();
    const secrets = support.collectSecretValues(cfg);
    const sanitized = support.sanitizeConfig(cfg);
    let pick;
    let note;
    if (section === 'all') {
      pick = { ...sanitized };
      delete pick.history;
      note = 'history omitted from config — use get_history';
    } else {
      pick = sanitized[section] !== undefined ? sanitized[section] : null;
    }
    return { section, note, config: _deepRedact(pick, secrets) };
  }

  function listLogs() {
    const paths = getAllLogPaths();
    const dir = paths.logDir;
    const files = [];
    const readableNames = new Set();
    for (const [name, key] of Object.entries(READABLE_LOGS)) {
      const base = paths[key];
      if (!base) continue;
      const variants = [];
      for (const backup of [0, 1, 2]) {
        const fp = backup === 0 ? base : getRotatedLogPath(base, backup);
        readableNames.add(path.basename(fp));
        try {
          const st = fs.statSync(fp);
          variants.push({ id: backup === 0 ? name : `${name}:${backup}`, backup, fileName: path.basename(fp), sizeBytes: st.size, mtime: st.mtime.toISOString() });
        } catch {}
      }
      files.push({ id: name, name, fileName: path.basename(base), readable: true, present: variants.length > 0, variants });
    }
    let siblings = [];
    try {
      siblings = fs.readdirSync(dir)
        .filter(f => /\.log(\.\d+)?$/i.test(f))
        .filter(f => !readableNames.has(f));
      siblings = siblings.map(f => {
        let size = 0, mtime = null;
        try { const st = fs.statSync(path.join(dir, f)); size = st.size; mtime = st.mtime.toISOString(); } catch {}
        return { name: f, readable: false, sizeBytes: size, mtime };
      });
    } catch {}
    return { files, otherLogs: siblings };
  }

  function readLog(args) {
    const a = args || {};
    const name = a.name;
    const p = _resolveLogPath(name, a.backup);
    if (!p) return { ok: false, error: 'unknown or non-readable log identifier' };
    const tailKb = Math.min(Math.max(Number(a.tailKb) || 256, 1), 1024);
    const raw = support.collectFile(p, name, tailKb * 1024, { includePath: false });
    let content = support.redactLogText(raw, _secrets());
    let matchedLines;
    if (a.grep && typeof a.grep === 'string' && a.grep.length <= 200) {
      const terms = a.grep.split('|').map(s => s.trim().toLowerCase()).filter(Boolean);
      if (terms.length) {
        const lines = content.split('\n').filter(l => {
          const low = l.toLowerCase();
          return terms.some(t => low.includes(t));
        });
        matchedLines = lines.length;
        content = lines.join('\n');
      }
    }
    let sizeBytes = null;
    try { sizeBytes = fs.statSync(p).size; } catch {}
    return { id: name, name, fileName: path.basename(p), sizeBytes, returnedBytes: Buffer.byteLength(content), tailKb, matchedLines, content };
  }

  function getAppEvents(args) {
    const limit = Math.min(Math.max(Number(args && args.limit) || 50, 1), 500);
    const out = [];
    const secrets = _secrets();
    for (const name of ['crash', 'debug']) {
      const p = _resolveLogPath(name);
      if (!p) continue;
      const raw = support.redactLogText(support.collectFile(p, name, 256 * 1024), secrets);
      const lines = raw.split('\n').filter(l => l.trim() && !l.startsWith('==='));
      for (const line of lines.slice(-limit)) out.push({ source: name, text: line });
    }
    return { events: out.slice(-limit), truncated: out.length > limit };
  }

  function _historyErrors(history, opts) {
    const o = opts || {};
    const sinceMs = Number.isFinite(o.sinceMs) ? o.sinceMs : null;
    const secrets = _secrets();
    const errors = [];
    const byCategory = {};
    for (const batch of (Array.isArray(history) ? history : [])) {
      if (!batch || !Array.isArray(batch.files)) continue;
      const ts = batch.timestamp ? Date.parse(batch.timestamp) : null;
      if (sinceMs !== null && ts !== null && ts < sinceMs) continue;
      for (const file of batch.files) {
        if (!file || !Array.isArray(file.results)) continue;
        for (const r of file.results) {
          if (!r || r.status === 'done') continue;
          const category = stats.classifyErrorCategory(r.error);
          if (o.category && o.category !== category) continue;
          if (o.hoster && o.hoster !== r.hoster) continue;
          byCategory[category] = (byCategory[category] || 0) + 1;
          errors.push({
            ts: batch.timestamp || null,
            fileName: file.name || file.fileName || '',
            hoster: r.hoster || '',
            accountId: r.accountId || undefined,
            category,
            error: support.redactLogText(String(r.error || ''), secrets)
          });
        }
      }
    }
    return { errors, byCategory };
  }

  function listErrors(args) {
    const a = args || {};
    const cfg = loadConfig();
    const { errors, byCategory } = _historyErrors(cfg.history, a);
    const limit = Math.min(Math.max(Number(a.limit) || 100, 1), 1000);
    const window = Number.isFinite(a.sinceMs) ? `since ${new Date(a.sinceMs).toISOString()}` : 'all history';
    return { window, total: errors.length, byCategory, errors: errors.slice(-limit) };
  }

  function getQueueState(args) {
    const a = args || {};
    const cfg = loadConfig();
    const pending = cfg.globalSettings && cfg.globalSettings.pendingQueue;
    if (!pending || typeof pending !== 'object') {
      return { source: 'empty', stale: false, counts: {}, selectedHosters: [] };
    }
    const counts = {};
    for (const s of QUEUE_STATUSES) counts[s] = 0;
    const jobs = Array.isArray(pending.queueJobs) ? pending.queueJobs : [];
    for (const j of jobs) { if (counts[j.status] !== undefined) counts[j.status]++; }
    const result = {
      source: 'persisted',
      stale: true,
      savedAt: pending.savedAt || null,
      selectedHosters: Array.isArray(pending.selectedUploadHosters) ? pending.selectedUploadHosters : [],
      fileCount: Array.isArray(pending.selectedFiles) ? pending.selectedFiles.length : 0,
      counts
    };
    if (a.includeJobs !== false) {
      const maxJobs = Math.min(Math.max(Number(a.maxJobs) || 200, 1), 2000);
      result.jobs = _deepRedact(jobs.slice(0, maxJobs).map(j => ({
        file: j.file, fileName: j.fileName, hoster: j.hoster, status: j.status, error: j.error || null
      })));
      result.jobsTruncated = jobs.length > maxJobs;
    }
    return result;
  }

  function getHistory(args) {
    const a = args || {};
    const history = typeof loadHistory === 'function'
      ? (loadHistory() || [])
      : (Array.isArray(loadConfig().history) ? loadConfig().history : []);
    const limit = Math.min(Math.max(Number(a.limit) || 20, 1), 200);
    const perHoster = stats.summarizePerHoster(history);
    const recent = [...history].slice(-limit).reverse();
    const secrets = _secrets();
    const batches = recent.map(b => {
      const out = { timestamp: b.timestamp || null, fileCount: Array.isArray(b.files) ? b.files.length : 0 };
      if (a.includeFiles) {
        out.files = (b.files || []).map(f => ({
          name: f.name || f.fileName || '',
          results: (f.results || []).map(r => {
            const rr = { hoster: r.hoster, status: r.status };
            if (r.error) rr.error = support.redactLogText(String(r.error), secrets);
            if (a.includeUrls && r.url) rr.url = r.url;
            return rr;
          })
        }));
      }
      return out;
    });
    return { totalBatches: history.length, returned: batches.length, perHoster, batches };
  }

  function getRotationState() {
    const cfg = loadConfig();
    return { rotationCursors: _deepRedact(cfg.rotationCursors || {}) };
  }

  function getHealth() {
    const cfg = loadConfig();
    const hosters = cfg.hosters && typeof cfg.hosters === 'object' ? Object.keys(cfg.hosters).filter(h => Array.isArray(cfg.hosters[h]) && cfg.hosters[h].length > 0) : [];
    return {
      reachabilityKnown: false,
      hint: 'Live hoster probing (run_health_check) is disabled in this build. Configured hosters with at least one account are listed.',
      configuredHosters: hosters
    };
  }

  function serverHealth(args) {
    const a = args || {};
    const errorLimit = Math.min(Math.max(Number(a.errorLimit) || 20, 1), 200);
    const errArgs = Number.isFinite(a.errorSinceMs) ? { sinceMs: a.errorSinceMs, limit: errorLimit } : { limit: errorLimit };
    const errors = listErrors(errArgs);
    const queue = getQueueState({ includeJobs: false });
    const history = getHistory({ limit: 5 });
    const warnings = [];
    if (queue.source === 'persisted' && queue.stale) warnings.push('queue state is from the persisted snapshot (may lag live state; UploadManager not introspected in this build).');
    if (errors.total > 0) warnings.push(`${errors.total} non-success result(s) in the error window.`);
    return {
      server: getSystemInfo(),
      queue,
      recentBatches: history.batches,
      perHoster: history.perHoster,
      errors,
      hosters: getHealth(),
      logs: listLogs(),
      warnings
    };
  }

  return {
    getSystemInfo, getConfigRedacted, listLogs, readLog, getAppEvents,
    listErrors, getQueueState, getHistory, getRotationState, getHealth, serverHealth,
    redactResponse, READABLE_LOGS
  };
}

module.exports = { createCollectors, READABLE_LOGS };
