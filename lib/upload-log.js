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

  const api = { formatUploadLogLine, parseUploadLogLine };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else if (root) root.UploadLog = api;
})(typeof window !== 'undefined' ? window : this);
