const { classifyErrorCategory } = require('./stats');
const { redactLogText } = require('./support-bundle');

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function integer(value) {
  return Math.max(0, Math.trunc(number(value)));
}

function iso(value, fallback) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function text(value, secrets, limit = 500) {
  const source = value instanceof Error ? value.message : String(value ?? '');
  return String(redactLogText(source, secrets) || '').slice(0, limit);
}

function redactPosixPaths(value) {
  let output = '';
  let index = 0;
  while (index < value.length) {
    const previous = value[index - 1] || '';
    if (value[index] !== '/' || (index > 0 && !/[\s=:([{]/.test(previous))) {
      output += value[index++];
      continue;
    }
    let end = index + 1;
    while (end < value.length && !/[\s"'<>|]/.test(value[end])) end++;
    const candidate = value.slice(index, end);
    if (candidate.slice(1).includes('/')) {
      output += '<redacted-path>';
      index = end;
      continue;
    }
    output += value[index++];
  }
  return output;
}

function errorText(value, secrets) {
  return redactPosixPaths(text(value, secrets)
    .replace(/https?:\/\/[^\s"'<>]+/gi, '<redacted-url>'))
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, '<redacted>');
}

function fileName(value, secrets) {
  const name = String(value ?? '').split(/[\\/]/).pop() || '';
  return text(name, secrets, 260);
}

function createJobTotals() {
  return { total: 0, succeeded: 0, failed: 0, skipped: 0, aborted: 0 };
}

function createHostTotals() {
  return { ...createJobTotals(), successfulBytes: 0 };
}

function addStatus(target, status) {
  target.total++;
  if (status === 'done') target.succeeded++;
  else if (status === 'skipped') target.skipped++;
  else if (status === 'aborted') target.aborted++;
  else target.failed++;
}

function buildCleanupTotals(outcomes) {
  const totals = { requested: 0, deleted: 0, blocked: 0, failed: 0 };
  for (const value of Array.isArray(outcomes) ? outcomes : []) {
    const outcome = String(value || 'failed');
    if (outcome === 'setting-disabled') continue;
    totals.requested++;
    if (outcome === 'deleted') totals.deleted++;
    else if (outcome === 'blocked' || outcome === 'source-changed' || outcome === 'source-missing' || outcome === 'unsafe-source-type') totals.blocked++;
    else totals.failed++;
  }
  return totals;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function buildBatchCompletionReport(input = {}) {
  const summary = input.summary && typeof input.summary === 'object' ? input.summary : {};
  const secrets = Array.isArray(input.secrets) ? input.secrets : [];
  const completedAt = iso(input.completedAt, new Date().toISOString());
  const startedAt = iso(input.startedAt ?? summary.timestamp, completedAt);
  const durationSec = Math.max(0, (new Date(completedAt).getTime() - new Date(startedAt).getTime()) / 1000);
  const files = { total: 0, fullySucceeded: 0, partiallySucceeded: 0, failed: 0 };
  const jobs = createJobTotals();
  const hostMap = new Map();
  const errors = [];
  let successfulBytes = 0;

  for (const file of Array.isArray(summary.files) ? summary.files : []) {
    const results = Array.isArray(file?.results) ? file.results : [];
    if (results.length === 0) continue;
    files.total++;
    const size = number(file?.size);
    const successful = results.filter(result => result?.status === 'done').length;
    if (successful === results.length) files.fullySucceeded++;
    else if (successful > 0) files.partiallySucceeded++;
    else files.failed++;
    const safeFileName = fileName(file?.name ?? file?.fileName, secrets);

    for (const result of results) {
      const status = String(result?.status || 'error');
      const hoster = text(result?.hoster || 'unknown', secrets, 120) || 'unknown';
      if (!hostMap.has(hoster)) hostMap.set(hoster, createHostTotals());
      const host = hostMap.get(hoster);
      addStatus(jobs, status);
      addStatus(host, status);
      if (status === 'done') {
        successfulBytes += size;
        host.successfulBytes += size;
      }
      if (status === 'error' || result?.remoteCommitUncertain === true) {
        const message = errorText(result?.error || 'Unknown error', secrets);
        errors.push({
          jobId: text(result?.jobId, secrets, 160),
          fileName: safeFileName,
          hoster,
          status,
          category: classifyErrorCategory(message),
          attempt: integer(result?.attempt),
          maxAttempts: integer(result?.maxAttempts),
          remoteCommitUncertain: result?.remoteCommitUncertain === true,
          message
        });
      }
    }
  }

  const hosters = Object.fromEntries([...hostMap.entries()].sort(([left], [right]) => left.localeCompare(right)));
  const batchId = text(summary.id, secrets, 160);
  const report = {
    reportId: text(input.reportId || `report-${batchId || completedAt}`, secrets, 200),
    batchId,
    startedAt,
    completedAt,
    generatedAt: completedAt,
    durationSec,
    files,
    jobs,
    cleanup: buildCleanupTotals(input.cleanupOutcomes),
    transfer: {
      successfulBytes,
      averageBytesPerSecond: durationSec > 0 ? successfulBytes / durationSec : 0
    },
    hosters,
    errors
  };
  return deepFreeze(report);
}

function csvCell(value) {
  let output = value === null || value === undefined ? '' : String(value);
  if (/^[\u0000-\u0020]*[=+\-@]/.test(output)) output = `'${output}`;
  return /[",\r\n]/.test(output) ? `"${output.replace(/"/g, '""')}"` : output;
}

function buildBatchErrorCsv(report) {
  const rows = [['Job ID', 'File name', 'Host', 'Status', 'Category', 'Attempt', 'Max attempts', 'Remote commit uncertain', 'Message']];
  for (const error of Array.isArray(report?.errors) ? report.errors : []) {
    rows.push([
      error.jobId,
      error.fileName,
      error.hoster,
      error.status,
      error.category,
      integer(error.attempt),
      integer(error.maxAttempts),
      error.remoteCommitUncertain === true ? 'true' : 'false',
      error.message
    ]);
  }
  return `${rows.map(row => row.map(csvCell).join(',')).join('\n')}\n`;
}

module.exports = { buildBatchCompletionReport, buildBatchErrorCsv };
