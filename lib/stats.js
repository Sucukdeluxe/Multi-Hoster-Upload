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
          const bucket = out[r.hoster] || (out[r.hoster] = { ok: 0, fail: 0, total: 0 });
          bucket.total++;
          if (r.status === 'done') bucket.ok++;
          else bucket.fail++;
        }
      }
    }
    for (const h of Object.keys(out)) {
      const b = out[h];
      b.rate = b.total > 0 ? b.ok / b.total : null;
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
        if (!r || r.status === 'done') continue;
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
    classifyErrorCategory,
    summarizeBatchErrors,
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
