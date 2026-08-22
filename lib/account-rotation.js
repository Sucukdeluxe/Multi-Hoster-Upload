function enabledAccountsFor(hosters, hoster, hasCreds) {
  const list = hosters && hosters[hoster];
  if (!Array.isArray(list)) return [];
  return list.filter(a => a && a.enabled !== false && hasCreds(hoster, a));
}

function createAccountPicker({ hosters, hosterSettings, hasCreds, indices }) {
  const rotIdx = Object.assign(Object.create(null), indices || {});
  let dirty = false;
  function pick(hoster) {
    const enabled = enabledAccountsFor(hosters, hoster, hasCreds);
    if (enabled.length === 0) return null;
    const hs = (hosterSettings && hosterSettings[hoster]) || {};
    if (hs.rotateAccounts === true && enabled.length > 1) {
      const cursor = Number.isFinite(rotIdx[hoster]) ? rotIdx[hoster] : 0;
      rotIdx[hoster] = cursor + 1;
      dirty = true;
      return enabled[cursor % enabled.length];
    }
    return enabled[0];
  }
  pick.indices = () => ({ ...rotIdx });
  pick.dirty = () => dirty;
  return pick;
}

function classifyAccountFailure(error) {
  if (!error || error.transientNetwork === true || error.hosterTransient === true || error.fileRejected === true) return 'none';
  if (error.otpRequired === true) return 'manual';
  const message = String(error.message || error);
  const manualPatterns = [
    /otp|two[- ]?factor|verification code/i,
    /Falscher (User|Username|Passwort)/i,
    /Incorrect (Login|Password)/i,
    /invalid (credentials|api[- ]?key|token)/i,
    /unauthori[sz]ed|not authorized|\b401\b/i,
    /(account|user) (banned|suspended|disabled|gesperrt)/i,
    /API[- ]?Key (fehlt|prüfen)|missing API[- ]?key/i,
    /Login fehlgeschlagen/i
  ];
  if (manualPatterns.some(pattern => pattern.test(message))) return 'manual';
  const cooldownPatterns = [
    /\b429\b|rate[- ]?limit|too many requests/i,
    /quota|not enough (disk )?(space|storage)|insufficient (disk )?space/i,
    /disk (space )?full|storage (exhausted|full|voll|limit)|account (full|voll)/i,
    /session (expired|abgelaufen)|CSRF[- ]?Token nicht gefunden|not logged in/i,
    /Keine Session erhalten|Session konnte nicht verifiziert werden/i,
    /sess_id nicht gefunden|session id not found/i
  ];
  if (error.accountError === true || cooldownPatterns.some(pattern => pattern.test(message))) return 'cooldown';
  return 'none';
}

function createAccountCooldownController(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const setTimer = typeof options.setTimer === 'function' ? options.setTimer : setTimeout;
  const clearTimer = typeof options.clearTimer === 'function' ? options.clearTimer : clearTimeout;
  const onClearAccount = typeof options.onClearAccount === 'function' ? options.onClearAccount : () => {};
  const onChange = typeof options.onChange === 'function' ? options.onChange : () => {};
  const active = new Map();
  const failures = new Map();
  const cooldowns = [15, 30, 60, 120];
  let timer = null;

  function keyOf(hoster, accountId) {
    return `${hoster}:${accountId}`;
  }

  function records() {
    return [...active.values()]
      .sort((left, right) => left.key.localeCompare(right.key))
      .map(record => ({ ...record }));
  }

  function publish(cause) {
    onChange(records(), cause);
  }

  function schedule() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    const deadlines = [...active.values()]
      .filter(record => record.mode === 'cooldown' && Number.isFinite(record.pausedUntil))
      .map(record => record.pausedUntil);
    if (deadlines.length === 0) return;
    const delay = Math.max(0, Math.min(...deadlines) - now());
    timer = setTimer(() => {
      timer = null;
      releaseExpired();
    }, delay);
  }

  function markFailure({ hoster, accountId, mode }) {
    if (!hoster || !accountId || mode === 'none') return null;
    const key = keyOf(hoster, accountId);
    const current = active.get(key);
    if (current?.mode === 'manual' && mode !== 'manual') return { ...current };
    if (current?.mode === mode && (mode === 'manual' || current.pausedUntil > now())) return { ...current };
    const count = (failures.get(key) || 0) + 1;
    failures.set(key, count);
    const minutes = cooldowns[Math.min(count - 1, cooldowns.length - 1)];
    const record = {
      key,
      hoster,
      accountId,
      mode: mode === 'manual' ? 'manual' : 'cooldown',
      failures: count,
      pausedUntil: mode === 'manual' ? null : now() + minutes * 60_000
    };
    active.set(key, record);
    publish('failed');
    schedule();
    return { ...record };
  }

  function releaseExpired() {
    const currentTime = now();
    const released = [];
    for (const [key, record] of active) {
      if (record.mode !== 'cooldown' || record.pausedUntil > currentTime) continue;
      active.delete(key);
      released.push(key);
      onClearAccount(record.hoster, record.accountId);
    }
    if (released.length > 0) publish('expired');
    schedule();
    return released;
  }

  function reset(hoster, accountId, cause = 'reset') {
    const key = keyOf(hoster, accountId);
    const removed = active.delete(key);
    const resetFailures = failures.delete(key);
    if (removed || resetFailures) onClearAccount(hoster, accountId);
    if (removed) publish(cause);
    schedule();
    return removed || resetFailures;
  }

  function markSuccess(hoster, accountId) {
    return reset(hoster, accountId, 'success');
  }

  function clear() {
    const current = records();
    active.clear();
    failures.clear();
    for (const record of current) onClearAccount(record.hoster, record.accountId);
    if (current.length > 0) publish('clear');
    schedule();
    return current.length;
  }

  function dispose() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  return Object.freeze({
    activeKeys: () => [...active.keys()].sort(),
    clear,
    dispose,
    list: records,
    markFailure,
    markSuccess,
    releaseExpired,
    reset
  });
}

module.exports = {
  classifyAccountFailure,
  createAccountCooldownController,
  createAccountPicker,
  enabledAccountsFor
};
