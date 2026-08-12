function normalNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

const { normalizeFailureDetails } = require('./upload-diagnostics');

function safeError(value) {
  const text = normalizeFailureDetails({ payloadSnippet: value })?.responseSnippet || '';
  return text || 'Unbekannter Fehler';
}

function createHosterSummary() {
  return { total: 0, succeeded: 0, failed: 0, skipped: 0, aborted: 0, bytes: 0, durationSec: 0, attempts: 0, errors: {} };
}

function buildSessionReport(summary) {
  const hosters = {};
  const totals = createHosterSummary();
  for (const file of Array.isArray(summary && summary.files) ? summary.files : []) {
    const size = normalNumber(file && file.size);
    for (const result of Array.isArray(file && file.results) ? file.results : []) {
      const hoster = String(result && result.hoster || 'Unbekannt');
      const bucket = hosters[hoster] || (hosters[hoster] = createHosterSummary());
      const status = String(result && result.status || 'error');
      for (const target of [bucket, totals]) {
        target.total++;
        target.bytes += size;
        target.durationSec += normalNumber(result && result.durationSec);
        target.attempts += normalNumber(result && result.attempt);
        if (status === 'done') target.succeeded++;
        else if (status === 'skipped') target.skipped++;
        else if (status === 'aborted') target.aborted++;
        else target.failed++;
        if (status !== 'done' && result && result.error) {
          const error = safeError(result.error);
          target.errors[error] = (target.errors[error] || 0) + 1;
        }
      }
    }
  }
  for (const target of [totals, ...Object.values(hosters)]) {
    target.successRate = target.total ? target.succeeded / target.total : 0;
  }
  return {
    generatedAt: new Date().toISOString(),
    batchId: summary && summary.id ? String(summary.id) : '',
    batchTimestamp: summary && summary.timestamp ? String(summary.timestamp) : '',
    totals,
    hosters
  };
}

function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function buildSessionReportCsv(report) {
  const header = ['Hoster', 'Gesamt', 'Erfolgreich', 'Fehler', 'Übersprungen', 'Abgebrochen', 'Erfolgsrate', 'Bytes', 'Dauer Sekunden', 'Versuche', 'Fehlerdetails'];
  const lines = [header.join(',')];
  for (const [hoster, row] of Object.entries(report && report.hosters || {})) {
    lines.push([
      hoster, row.total, row.succeeded, row.failed, row.skipped, row.aborted,
      `${Math.round((row.successRate || 0) * 100)}%`, row.bytes, row.durationSec, row.attempts,
      Object.entries(row.errors || {}).map(([error, count]) => `${count}× ${error}`).join(' | ')
    ].map(csvCell).join(','));
  }
  return `${lines.join('\n')}\n`;
}

module.exports = { buildSessionReport, buildSessionReportCsv };
