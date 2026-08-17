(function initImportPreflight(root, factory) {
  const api = typeof module === 'object' && module.exports
    ? factory(require('path'))
    : factory({
        normalize: value => String(value).replace(/[\\/]+/g, '/'),
        basename: value => String(value).split(/[\\/]/).pop() || ''
      });
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ImportPreflight = api;
})(typeof window !== 'undefined' ? window : globalThis, function createImportPreflight(path) {
  function normalizePathValue(value) {
    let text = String(value ?? '').trim();
    if (!text) return '';
    const uncNamespace = text.match(/^[\\/]{2}\?[\\/]UNC[\\/]/i);
    if (uncNamespace) text = `\\\\${text.slice(uncNamespace[0].length)}`;
    else {
      const driveNamespace = text.match(/^[\\/]{2}\?[\\/](?=[A-Za-z]:[\\/])/);
      if (driveNamespace) text = text.slice(driveNamespace[0].length);
    }
    return path.normalize(text);
  }

  function normalizeEntry(value) {
    const source = value && typeof value === 'object' ? value : {};
    const filePath = normalizePathValue(typeof value === 'string' ? value : source.path);
    const sourceName = typeof value === 'string' ? '' : String(source.name ?? '').trim();
    return {
      path: filePath,
      name: sourceName || path.basename(filePath),
      size: Number.isFinite(Number(source.size)) ? Number(source.size) : null
    };
  }

  function createPathKey(value, caseInsensitive) {
    const normalized = normalizePathValue(value);
    return caseInsensitive ? normalized.toLocaleLowerCase('en-US') : normalized;
  }

  async function mapWithConcurrency(items, concurrency, operation) {
    const results = new Array(items.length);
    let cursor = 0;
    async function worker() {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await operation(items[index], index);
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
    return results;
  }

  function unavailableReason(result) {
    if (!result || result.exists === false) return 'missing';
    if (result.readable === false) return 'unreadable';
    const size = Number(result.size);
    if (!Number.isFinite(size) || size <= 0) return 'empty';
    return '';
  }

  async function inspectReadableImportPath(filePath, openPath) {
    let fileHandle = null;
    try {
      fileHandle = await openPath(filePath, 'r');
      const fileStat = await fileHandle.stat();
      if (!fileStat.isFile()) return { exists: true, readable: false, size: fileStat.size };
      return { exists: true, readable: true, size: fileStat.size };
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return { exists: false };
      return { exists: true, readable: false };
    } finally {
      if (fileHandle) {
        try {
          await fileHandle.close();
        } catch {}
      }
    }
  }

  async function inspectImportEntries(entries, options = {}) {
    const input = Array.isArray(entries) ? entries : [];
    const caseInsensitive = options.caseInsensitive ?? (typeof process === 'object' ? process.platform === 'win32' : true);
    const existing = new Set((Array.isArray(options.existingPaths) ? options.existingPaths : [])
      .map(value => createPathKey(value && typeof value === 'object' ? value.path : value, caseInsensitive))
      .filter(Boolean));
    const duplicates = [];
    const unavailable = [];
    const unique = [];

    for (const value of input) {
      const entry = normalizeEntry(value);
      if (!entry.path) {
        unavailable.push({ ...entry, reason: 'missing' });
        continue;
      }
      const key = createPathKey(entry.path, caseInsensitive);
      if (existing.has(key)) {
        duplicates.push(entry);
        continue;
      }
      existing.add(key);
      unique.push(entry);
    }

    const concurrency = Math.max(1, Math.min(32, Math.trunc(Number(options.concurrency)) || 8));
    const inspectPath = typeof options.inspectPath === 'function'
      ? options.inspectPath
      : async (_entryPath, entry) => ({ exists: true, readable: true, size: entry.size });
    const inspected = await mapWithConcurrency(unique, concurrency, async entry => {
      try {
        const result = await inspectPath(entry.path, entry);
        const reason = unavailableReason(result);
        if (reason) return { entry: { ...entry, size: Number(result?.size) || 0 }, reason };
        return { entry: { ...entry, size: Number(result.size) }, reason: '' };
      } catch (error) {
        return { entry, reason: error && error.code === 'ENOENT' ? 'missing' : 'unreadable' };
      }
    });
    const accepted = [];
    for (const result of inspected) {
      if (result.reason) unavailable.push({ ...result.entry, reason: result.reason });
      else accepted.push(result.entry);
    }

    return {
      candidateCount: input.length,
      duplicateCount: duplicates.length,
      unavailableCount: unavailable.length,
      acceptedCount: accepted.length,
      accepted,
      duplicates,
      unavailable
    };
  }

  function normalizeSelectedHosters(values) {
    return Array.from(new Set((Array.isArray(values) ? values : [])
      .map(value => String(value ?? '').trim())
      .filter(Boolean)));
  }

  function isImportPairEligible(file, hoster, hosterSettings = {}) {
    const maxSizeMb = Number(hosterSettings?.[hoster]?.maxSizeMb);
    return !(maxSizeMb > 0 && Number(file?.size) > maxSizeMb * 1024 * 1024);
  }

  function getEligibleImportHosters(file, selectedHosters, hosterSettings = {}) {
    return normalizeSelectedHosters(selectedHosters)
      .filter(hoster => isImportPairEligible(file, hoster, hosterSettings));
  }

  function summarizeImportPlan(input = {}) {
    const inspection = input.inspection && typeof input.inspection === 'object' ? input.inspection : {};
    const accepted = Array.isArray(inspection.accepted) ? inspection.accepted : [];
    const selectedHosters = normalizeSelectedHosters(input.selectedHosters);
    const settings = input.hosterSettings && typeof input.hosterSettings === 'object' ? input.hosterSettings : {};
    let jobCount = 0;
    for (const file of accepted) jobCount += getEligibleImportHosters(file, selectedHosters, settings).length;
    return {
      candidateCount: Number(inspection.candidateCount) || 0,
      duplicateCount: Number(inspection.duplicateCount) || 0,
      unavailableCount: Number(inspection.unavailableCount) || 0,
      acceptedCount: accepted.length,
      targetCount: selectedHosters.length,
      jobCount,
      sizeLimitedJobCount: accepted.length * selectedHosters.length - jobCount
    };
  }

  return {
    getEligibleImportHosters,
    inspectImportEntries,
    inspectReadableImportPath,
    isImportPairEligible,
    summarizeImportPlan
  };
});
