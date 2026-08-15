(function initFilenameFilter(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FilenameFilter = api;
})(typeof window !== 'undefined' ? window : globalThis, function createFilenameFilter() {
  function normalizeFilenameFilter(value) {
    const source = value && typeof value === 'object' ? value : {};
    const conditions = Array.isArray(source.conditions)
      ? source.conditions.flatMap(condition => {
          if (!condition || typeof condition !== 'object') return [];
          const text = String(condition.value ?? '').trim();
          if (!text) return [];
          return [{
            operator: condition.operator === 'notContains' ? 'notContains' : 'contains',
            value: text
          }];
        })
      : [];
    return {
      enabled: source.enabled === true,
      action: source.action === 'exclude' ? 'exclude' : 'include',
      matchMode: source.matchMode === 'any' ? 'any' : 'all',
      conditions
    };
  }

  function getFilename(entry) {
    if (entry && typeof entry === 'object' && entry.name) return String(entry.name);
    const source = entry && typeof entry === 'object' ? entry.path : entry;
    return String(source ?? '').split(/[\\/]/).pop() || '';
  }

  function evaluateFilenameFilter(filename, value) {
    const filter = normalizeFilenameFilter(value);
    const active = filter.enabled && filter.conditions.length > 0;
    if (!active) return { accepted: true, matched: false, active, filter };
    const normalizedName = String(filename ?? '').toLowerCase();
    const results = filter.conditions.map(condition => {
      const contains = normalizedName.includes(condition.value.toLowerCase());
      return condition.operator === 'notContains' ? !contains : contains;
    });
    const matched = filter.matchMode === 'any' ? results.some(Boolean) : results.every(Boolean);
    const accepted = filter.action === 'exclude' ? !matched : matched;
    return { accepted, matched, active, filter };
  }

  function applyFilenameFilter(entries, value) {
    const filter = normalizeFilenameFilter(value);
    const accepted = [];
    const excluded = [];
    for (const entry of Array.isArray(entries) ? entries : []) {
      const evaluation = evaluateFilenameFilter(getFilename(entry), filter);
      if (evaluation.accepted) accepted.push(entry);
      else excluded.push(entry);
    }
    return {
      total: accepted.length + excluded.length,
      accepted,
      excluded,
      active: filter.enabled && filter.conditions.length > 0,
      filter
    };
  }

  return {
    normalizeFilenameFilter,
    evaluateFilenameFilter,
    applyFilenameFilter
  };
});
