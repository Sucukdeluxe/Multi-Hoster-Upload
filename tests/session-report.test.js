const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSessionReport, buildSessionReportCsv } = require('../lib/session-report');

test('erstellt einen Hosterbericht mit Erfolgsquote, Dauer, Bytes und Fehlern', () => {
  const report = buildSessionReport({
    id: 'batch-1',
    timestamp: '2026-08-12T12:00:00.000Z',
    files: [{
      name: 'video.mp4',
      size: 1024,
      results: [
        { hoster: 'byse.sx', status: 'done', durationSec: 4, attempt: 1 },
        { hoster: 'doodstream.com', status: 'error', durationSec: 3, attempt: 2, error: 'HTTP 503' }
      ]
    }]
  });

  assert.equal(report.totals.total, 2);
  assert.equal(report.totals.succeeded, 1);
  assert.equal(report.hosters['byse.sx'].bytes, 1024);
  assert.equal(report.hosters['doodstream.com'].attempts, 2);
  assert.deepEqual(report.hosters['doodstream.com'].errors, { 'HTTP 503': 1 });
  assert.match(buildSessionReportCsv(report), /doodstream\.com/);
});

test('entschärft Formeln und Geheimnisse im CSV-Bericht', () => {
  const report = buildSessionReport({ files: [{ size: 1, results: [{ hoster: 'byse.sx', status: 'error', error: '=CMD() token=secret' }] }] });

  assert.match(buildSessionReportCsv(report), /1× =CMD\(\) token=\[redacted\]/);
});
