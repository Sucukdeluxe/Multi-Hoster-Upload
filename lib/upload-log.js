(function (root) {
  'use strict';

  function _pad(n) { return String(n).padStart(2, '0'); }

  function formatUploadLogLine(date, hoster, link, fileName) {
    const d = date instanceof Date ? date : new Date();
    const dateStr = `${d.getFullYear()}-${_pad(d.getMonth() + 1)}-${_pad(d.getDate())} ` +
      `${_pad(d.getHours())}:${_pad(d.getMinutes())}:${_pad(d.getSeconds())}`;
    return `${dateStr}|${hoster}|${link}||${fileName}|\n`;
  }

  function parseUploadLogLine(line) {
    if (typeof line !== 'string') return null;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return null;
    const parts = trimmed.split('|');
    if (parts.length < 5) return null;
    const hoster = (parts[1] || '').trim();
    let fileName = '';
    for (let i = parts.length - 1; i >= 4; i--) {
      if (parts[i].trim() !== '') { fileName = parts[i]; break; }
    }
    if (!hoster || !fileName) return null;
    const tsStr = (parts[0] || '').trim();
    const tsParsed = tsStr ? Date.parse(tsStr.replace(' ', 'T')) : NaN;
    const ts = isNaN(tsParsed) ? undefined : tsParsed;
    return { hoster, fileName, ts };
  }

  function summarizeBatchPlan(payload) {
    const source = payload && typeof payload === 'object' ? payload : {};
    const jobs = Array.isArray(source.jobs) ? source.jobs : [];
    if (jobs.length > 0) {
      const files = new Set();
      const destinations = new Set();
      let plannedUploadCount = 0;
      for (const job of jobs) {
        if (!job || typeof job !== 'object') continue;
        const file = typeof job.file === 'string' ? job.file.trim() : '';
        const hoster = typeof job.hoster === 'string' ? job.hoster.trim() : '';
        if (!file || !hoster) continue;
        files.add(file);
        destinations.add(hoster);
        plannedUploadCount++;
      }
      return {
        fileCount: files.size,
        destinationCount: destinations.size,
        plannedUploadCount
      };
    }

    const files = new Set((Array.isArray(source.files) ? source.files : []).filter(value => typeof value === 'string' && value.trim()));
    const destinations = new Set((Array.isArray(source.hosters) ? source.hosters : []).filter(value => typeof value === 'string' && value.trim()));
    return {
      fileCount: files.size,
      destinationCount: destinations.size,
      plannedUploadCount: files.size * destinations.size
    };
  }

  function formatUploadPlanLogLine(date, plan, mode) {
    const inputDate = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
    const source = plan && typeof plan === 'object' ? plan : {};
    const count = value => Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : 0;
    return `# UPLOAD-PLAN ${JSON.stringify({
      timestamp: inputDate.toISOString(),
      mode: mode === 'add' ? 'add' : 'start',
      fileCount: count(source.fileCount),
      destinationCount: count(source.destinationCount),
      plannedUploadCount: count(source.plannedUploadCount)
    })}\r\n`;
  }

  const api = { formatUploadLogLine, parseUploadLogLine, summarizeBatchPlan, formatUploadPlanLogLine };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else if (root) root.UploadLog = api;
})(typeof window !== 'undefined' ? window : this);
