const test = require('node:test');
const assert = require('node:assert/strict');

test('builds immutable file, job, transfer, cleanup, host and error totals', () => {
  const { buildBatchCompletionReport } = require('../lib/batch-completion-report');
  const report = buildBatchCompletionReport({
    reportId: 'report-1',
    startedAt: '2026-08-16T10:00:00.000Z',
    completedAt: '2026-08-16T10:00:10.000Z',
    cleanupOutcomes: ['deleted', 'blocked', 'source-changed', 'source-missing', 'unsafe-source-type', 'failed', 'setting-disabled'],
    summary: {
      id: 'batch-1',
      files: [
        {
          name: 'complete.mkv',
          size: 100,
          results: [
            { jobId: 'done-a', hoster: 'doodstream.com', status: 'done', attempt: 1, maxAttempts: 3 },
            { jobId: 'done-b', hoster: 'voe.sx', status: 'done', attempt: 1, maxAttempts: 2 }
          ]
        },
        {
          name: 'partial.mkv',
          size: 200,
          results: [
            { jobId: 'done-c', hoster: 'doodstream.com', status: 'done', attempt: 2, maxAttempts: 3 },
            { jobId: 'error-a', hoster: 'voe.sx', status: 'error', error: 'network timeout', attempt: 2, maxAttempts: 2 }
          ]
        },
        {
          name: 'failed.mkv',
          size: 300,
          results: [
            { jobId: 'skip-a', hoster: 'doodstream.com', status: 'skipped', error: 'No account', attempt: 0, maxAttempts: 0 },
            { jobId: 'abort-a', hoster: 'voe.sx', status: 'aborted', error: 'Aborted', attempt: 0, maxAttempts: 2 },
            { jobId: 'error-b', hoster: 'byse.sx', status: 'error', error: 'account full', attempt: 1, maxAttempts: 1, remoteCommitUncertain: true }
          ]
        }
      ]
    }
  });

  assert.deepEqual(report.files, { total: 3, fullySucceeded: 1, partiallySucceeded: 1, failed: 1 });
  assert.deepEqual(report.jobs, { total: 7, succeeded: 3, failed: 2, skipped: 1, aborted: 1 });
  assert.deepEqual(report.cleanup, { requested: 6, deleted: 1, blocked: 4, failed: 1 });
  assert.deepEqual(report.transfer, { successfulBytes: 400, averageBytesPerSecond: 40 });
  assert.deepEqual(report.hosters['doodstream.com'], { total: 3, succeeded: 2, failed: 0, skipped: 1, aborted: 0, successfulBytes: 300 });
  assert.equal(report.errors.length, 2);
  assert.deepEqual(report.errors.map(error => error.category), ['network', 'account-error']);
  assert.equal(report.errors[1].remoteCommitUncertain, true);
  assert.equal(report.batchId, 'batch-1');
  assert.equal(report.durationSec, 10);
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.errors), true);
  assert.equal(Object.isFrozen(report.errors[0]), true);
});

test('counts duplicate basenames as separate summary files without exposing local paths', () => {
  const { buildBatchCompletionReport } = require('../lib/batch-completion-report');
  const report = buildBatchCompletionReport({
    summary: {
      files: [
        { name: 'C:\\private\\one\\same.mkv', size: 10, results: [{ jobId: 'one', hoster: 'voe.sx', status: 'done' }] },
        { name: '/private/two/same.mkv', size: 10, results: [{ jobId: 'two', hoster: 'voe.sx', status: 'error', error: 'failed at C:\\private\\two\\same.mkv' }] }
      ]
    }
  });

  assert.equal(report.files.total, 2);
  assert.equal(report.files.fullySucceeded, 1);
  assert.equal(report.files.failed, 1);
  assert.equal(report.errors[0].fileName, 'same.mkv');
  assert.doesNotMatch(JSON.stringify(report), /private[\\/](?:one|two)/i);
});

test('redacts configured secrets, opaque tokens, URLs and local paths from errors', () => {
  const { buildBatchCompletionReport } = require('../lib/batch-completion-report');
  const secret = 'private-api-value';
  const opaqueToken = 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4';
  const report = buildBatchCompletionReport({
    secrets: [secret],
    summary: {
      files: [{
        name: 'secret.mkv',
        size: 1,
        results: [{
          jobId: 'error-secret',
          hoster: 'doodstream.com',
          status: 'error',
          error: `token=${secret} path=D:\\private\\secret.mkv /home/private/customer/file.mkv https://private.example.test/upload/${opaqueToken}`
        }]
      }]
    }
  });
  const serialized = JSON.stringify(report);

  assert.doesNotMatch(serialized, new RegExp(secret));
  assert.doesNotMatch(serialized, /D:\\\\private/);
  assert.doesNotMatch(serialized, /\/home\/private/);
  assert.doesNotMatch(serialized, /private\.example\.test/);
  assert.doesNotMatch(serialized, new RegExp(opaqueToken));
  assert.match(report.errors[0].message, /<redacted>/);
  assert.match(report.errors[0].message, /<redacted-path>/);
});

test('builds a formula-safe English error CSV and handles zero duration', () => {
  const { buildBatchCompletionReport, buildBatchErrorCsv } = require('../lib/batch-completion-report');
  const report = buildBatchCompletionReport({
    startedAt: '2026-08-16T10:00:00.000Z',
    completedAt: '2026-08-16T10:00:00.000Z',
    summary: {
      files: [{
        name: '=danger.csv',
        size: 8,
        results: [{ jobId: '+job', hoster: '@host', status: 'error', error: '-CMD()', attempt: 1, maxAttempts: 1 }]
      }]
    }
  });
  const csv = buildBatchErrorCsv(report);

  assert.equal(report.transfer.averageBytesPerSecond, 0);
  assert.match(csv, /^Job ID,File name,Host,Status,Category,Attempt,Max attempts,Remote commit uncertain,Message\n/);
  assert.match(csv, /'\+job/);
  assert.match(csv, /'=danger\.csv/);
  assert.match(csv, /'@host/);
  assert.match(csv, /'-CMD\(\)/);
  const prefixed = buildBatchErrorCsv({ errors: [{ message: '\t=HYPERLINK("https://example.test")' }] });
  assert.match(prefixed, /'\t=HYPERLINK/);
  assert.equal(csv.endsWith('\n'), true);
});
