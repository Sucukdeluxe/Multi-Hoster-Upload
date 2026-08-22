const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  getAccountGroupStatus,
  getAccountPausePresentation,
  getAccountStatusPresentation,
  formatAccountPauseRemaining,
  subscribeAccountPauseSnapshots
} = require('../renderer/account-status');

test('mixed account results use warning group status', () => {
  assert.equal(getAccountGroupStatus({ total: 3, disabled: 0, ok: 2, error: 1, checking: 0, unchecked: 0 }), 'warn');
});

test('group is red only when every active account has an error', () => {
  assert.equal(getAccountGroupStatus({ total: 3, disabled: 0, ok: 0, error: 3, checking: 0, unchecked: 0 }), 'error');
});

test('group is green when every active account is ready', () => {
  assert.equal(getAccountGroupStatus({ total: 3, disabled: 0, ok: 3, error: 0, checking: 0, unchecked: 0 }), 'ok');
});

test('warning-only accounts keep the group orange', () => {
  assert.equal(getAccountGroupStatus({ total: 2, disabled: 0, ok: 0, warn: 2, error: 0, checking: 0, unchecked: 0 }), 'warn');
});

test('OTP-required account exposes warning presentation', () => {
  assert.deepEqual(getAccountStatusPresentation('otp_required'), {
    statusClass: 'warn',
    label: 'OTP erforderlich',
    requiresOtp: true
  });
});

test('timed account pause presentation exposes a stable countdown', () => {
  assert.deepEqual(getAccountPausePresentation({ mode: 'cooldown', pausedUntil: 905_000 }, 5_000), {
    mode: 'cooldown',
    remainingSeconds: 900,
    expired: false
  });
});

test('manual account pause presentation requires action and timed pauses expire at zero', () => {
  assert.deepEqual(getAccountPausePresentation({ mode: 'manual', pausedUntil: null }, 5_000), {
    mode: 'manual',
    remainingSeconds: null,
    expired: false
  });
  assert.deepEqual(getAccountPausePresentation({ mode: 'cooldown', pausedUntil: 5_000 }, 5_000), {
    mode: 'cooldown',
    remainingSeconds: 0,
    expired: true
  });
});

test('account pause countdown uses fixed two-digit seconds and supports two-hour cooldowns', () => {
  assert.equal(formatAccountPauseRemaining(900), '15:00');
  assert.equal(formatAccountPauseRemaining(3599), '59:59');
  assert.equal(formatAccountPauseRemaining(7200), '120:00');
});

test('account pause subscription is installed before the initial snapshot is requested', async () => {
  const order = [];
  let push;
  let resolveInitial;
  const initial = new Promise(resolve => { resolveInitial = resolve; });
  const applied = [];
  const api = {
    onSessionFailedAccountsChanged: callback => { order.push('subscribe'); push = callback; },
    getSessionFailedAccountStates: () => { order.push('load'); return initial; }
  };
  const pending = subscribeAccountPauseSnapshots(api, snapshot => applied.push(snapshot));
  push({ revision: 2, accounts: [{ accountId: 'live' }] });
  resolveInitial({ revision: 1, accounts: [] });
  await pending;

  assert.deepEqual(order, ['subscribe', 'load']);
  assert.deepEqual(applied, [
    { revision: 2, accounts: [{ accountId: 'live' }] },
    { revision: 1, accounts: [] }
  ]);
});
