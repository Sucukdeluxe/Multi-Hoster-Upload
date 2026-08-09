const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  getAccountGroupStatus,
  getAccountStatusPresentation
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
