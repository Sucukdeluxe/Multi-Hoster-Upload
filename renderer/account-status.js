(function (scope) {
  const STATUS_PRESENTATIONS = {
    ok: { statusClass: 'ok', label: 'Bereit', requiresOtp: false },
    warn: { statusClass: 'warn', label: 'Warnung', requiresOtp: false },
    checking: { statusClass: 'checking', label: 'Prüfe...', requiresOtp: false },
    error: { statusClass: 'error', label: 'Fehler', requiresOtp: false },
    otp_required: { statusClass: 'warn', label: 'OTP erforderlich', requiresOtp: true },
    unchecked: { statusClass: 'unchecked', label: 'Nicht geprüft', requiresOtp: false },
    disabled: { statusClass: 'disabled', label: 'Deaktiviert', requiresOtp: false }
  };

  function getAccountStatusPresentation(status) {
    const presentation = STATUS_PRESENTATIONS[status] || STATUS_PRESENTATIONS.unchecked;
    return { ...presentation };
  }

  function getAccountGroupStatus(summary) {
    const total = Math.max(0, Number(summary && summary.total) || 0);
    const disabled = Math.min(total, Math.max(0, Number(summary && summary.disabled) || 0));
    const active = total - disabled;
    const errors = Math.max(0, Number(summary && summary.error) || 0);
    const ok = Math.max(0, Number(summary && summary.ok) || 0);
    const warning = Math.max(0, Number(summary && summary.warn) || 0);
    const checking = Math.max(0, Number(summary && summary.checking) || 0);
    const unchecked = Math.max(0, Number(summary && summary.unchecked) || 0);
    if (active === 0) return 'unchecked';
    if (errors >= active) return 'error';
    if (errors > 0 || warning > 0 || checking > 0 || unchecked > 0) return 'warn';
    if (ok >= active) return 'ok';
    return 'warn';
  }

  const accountStatus = { getAccountGroupStatus, getAccountStatusPresentation };
  if (typeof module !== 'undefined' && module.exports) module.exports = accountStatus;
  if (scope) scope.AccountStatus = accountStatus;
})(typeof window !== 'undefined' ? window : globalThis);
