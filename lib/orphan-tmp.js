(function (root) {
  'use strict';

  function selectOrphanTmps(fileNames, opts) {
    const o = opts || {};
    const baseName = String(o.baseName || '');
    const currentPid = o.currentPid;
    const isAlive = typeof o.isAlive === 'function' ? o.isAlive : () => false;
    const out = [];
    if (!baseName || !Array.isArray(fileNames)) return out;
    const prefix = baseName + '.';
    const suffix = '.tmp';
    for (const file of fileNames) {
      if (typeof file !== 'string') continue;
      if (!file.startsWith(prefix) || !file.endsWith(suffix)) continue;
      const mid = file.slice(prefix.length, file.length - suffix.length);
      if (!/^\d+$/.test(mid)) continue;
      const pid = Number(mid);
      if (pid === currentPid) continue;
      if (isAlive(pid)) continue;
      out.push(file);
    }
    return out;
  }

  const api = { selectOrphanTmps };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else if (root) root.OrphanTmp = api;
})(typeof window !== 'undefined' ? window : this);
