(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HistoryStatus = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function classifyHistoryStatus(status) {
    if (status === 'done') return 'success';
    if (status === 'skipped') return 'skipped';
    return 'error';
  }

  function historyDetail(result) {
    const category = classifyHistoryStatus(result?.status);
    if (category === 'success') return String(result?.download_url || result?.embed_url || '');
    if (result?.error || result?.message) return String(result.error || result.message);
    if (result?.status === 'aborted') return 'Abgebrochen';
    if (category === 'skipped') return 'Übersprungen';
    return 'Fehlgeschlagen';
  }

  return { classifyHistoryStatus, historyDetail };
});
