const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyHistoryStatus, historyDetail } = require('../renderer/history-status');

test('history status keeps skipped separate from successful and failed uploads', () => {
  assert.equal(classifyHistoryStatus('done'), 'success');
  assert.equal(classifyHistoryStatus('error'), 'error');
  assert.equal(classifyHistoryStatus('aborted'), 'error');
  assert.equal(classifyHistoryStatus('skipped'), 'skipped');
  assert.equal(classifyHistoryStatus('unexpected'), 'error');
});

test('history detail shows a skipped reason instead of a fake link', () => {
  assert.equal(historyDetail({ status: 'skipped', error: 'Datei zu groß', download_url: 'https://example.invalid/wrong' }), 'Datei zu groß');
  assert.equal(historyDetail({ status: 'done', download_url: 'https://example.invalid/ok' }), 'https://example.invalid/ok');
});
