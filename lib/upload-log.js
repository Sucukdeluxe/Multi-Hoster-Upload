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
    let fileNameIndex = -1;
    for (let i = parts.length - 1; i >= 4; i--) {
      if (parts[i].trim() !== '') { fileName = parts[i]; fileNameIndex = i; break; }
    }
    if (!hoster || !fileName) return null;
    const confirmed = parts.slice(2, fileNameIndex).some(value => value.trim() !== '');
    const tsStr = (parts[0] || '').trim();
    const tsParsed = tsStr ? Date.parse(tsStr.replace(' ', 'T')) : NaN;
    const ts = isNaN(tsParsed) ? undefined : tsParsed;
    return { hoster, fileName, ts, confirmed };
  }

  async function* iterateBoundedUploadLogLines(chunks, maxLineLength) {
    let buffer = '';
    for await (const chunk of chunks) {
      buffer += String(chunk);
      for (;;) {
        const separator = buffer.indexOf('\n');
        if (separator < 0) break;
        const line = buffer.slice(0, separator).replace(/\r$/, '');
        if (line.length > maxLineLength) throw new Error('Upload-Log-Zeile ist zu lang');
        yield line;
        buffer = buffer.slice(separator + 1);
      }
      if (buffer.length > maxLineLength) throw new Error('Upload-Log-Zeile ist zu lang');
    }
    if (buffer) yield buffer.replace(/\r$/, '');
  }

  async function* iterateBoundedUploadLogChunks(chunks, maxBytes, onBytes) {
    const BufferImpl = typeof require === 'function' ? require('node:buffer').Buffer : null;
    let total = 0;
    for await (const chunk of chunks) {
      const bytes = BufferImpl ? BufferImpl.byteLength(String(chunk), 'utf8') : String(chunk).length;
      total += bytes;
      if (total > maxBytes) throw new Error('Upload-Log überschreitet das Leselimit');
      if (typeof onBytes === 'function') onBytes(bytes);
      yield chunk;
    }
  }

  async function* iterateUploadLogEntries(filePath, options = {}) {
    const fsImpl = options.fs || (typeof require === 'function' ? require('node:fs') : null);
    if (!options.lines && !fsImpl?.createReadStream) throw new Error('Upload-Log-Stream ist nicht verfügbar');
    const yieldEvery = Number.isFinite(Number(options.yieldEvery)) ? Math.max(1, Math.floor(Number(options.yieldEvery))) : 1000;
    const maxLineLength = Number.isFinite(Number(options.maxLineLength)) ? Math.max(1, Math.floor(Number(options.maxLineLength))) : 65536;
    const maxBytes = Number.isFinite(Number(options.maxBytes)) ? Math.max(1, Math.floor(Number(options.maxBytes))) : 256 * 1024 * 1024;
    const yieldFn = typeof options.yieldFn === 'function' ? options.yieldFn : (() => new Promise(resolve => setImmediate(resolve)));
    const input = options.lines ? null : fsImpl.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 32768 });
    const lines = options.lines || iterateBoundedUploadLogLines(iterateBoundedUploadLogChunks(input, maxBytes, options.onBytes), maxLineLength);
    let count = 0;
    try {
      for await (const line of lines) {
        if (String(line).length > maxLineLength) throw new Error('Upload-Log-Zeile ist zu lang');
        const parsed = parseUploadLogLine(line);
        if (parsed) yield parsed;
        count++;
        if (count % yieldEvery === 0) await yieldFn();
      }
    } finally {
      if (input && !input.destroyed && typeof input.destroy === 'function') input.destroy();
    }
  }

  async function readUploadLogEntries(filePath, options = {}) {
    const entries = [];
    for await (const entry of iterateUploadLogEntries(filePath, options)) entries.push(entry);
    return entries;
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

  const api = { formatUploadLogLine, parseUploadLogLine, iterateUploadLogEntries, readUploadLogEntries, summarizeBatchPlan, formatUploadPlanLogLine };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else if (root) root.UploadLog = api;
})(typeof window !== 'undefined' ? window : this);
