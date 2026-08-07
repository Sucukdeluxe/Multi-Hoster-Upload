const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createAccountSubmitter,
  getAccountSubmitLabel,
  submitValidatedAccount
} = require('../renderer/account-submit');

test('account submit labels stay exact for add, edit, and OTP retries', () => {
  assert.equal(getAccountSubmitLabel({ isEdit: false, hasOtp: false }), 'Prüfen und anlegen');
  assert.equal(getAccountSubmitLabel({ isEdit: true, hasOtp: false }), 'Prüfen und speichern');
  assert.equal(getAccountSubmitLabel({ isEdit: false, hasOtp: true }), 'Prüfen und anlegen');
  assert.equal(getAccountSubmitLabel({ isEdit: true, hasOtp: true }), 'Prüfen und speichern');
});

test('close and reopen cannot start a second save while the first save is pending', async () => {
  const submitter = createAccountSubmitter();
  let current = true;
  let commits = 0;
  let applies = 0;
  let saveStarted;
  let finishSave;
  const started = new Promise(resolve => { saveStarted = resolve; });
  const saving = new Promise(resolve => { finishSave = resolve; });
  const first = submitter.submit({
    validate: async () => ({ status: 'ok' }),
    commit: async () => {
      commits++;
      saveStarted();
      await saving;
      return { accountId: 'first' };
    },
    afterCommit: async () => {
      applies++;
    },
    isCurrent: () => current
  });

  await started;
  current = false;
  const second = submitter.submit({
    validate: async () => ({ status: 'ok' }),
    commit: async () => {
      commits++;
    },
    isCurrent: () => true
  });

  assert.equal(second, null);
  assert.equal(submitter.isBusy(), true);
  finishSave();
  const result = await first;

  assert.equal(result.status, 'stale');
  assert.equal(result.committed, true);
  assert.equal(commits, 1);
  assert.equal(applies, 1);
  assert.equal(submitter.isBusy(), false);
});

test('post-save apply failure remains committed and cannot invite a duplicate retry', async () => {
  const expected = new Error('render failed');
  let saves = 0;
  let applies = 0;
  const result = await submitValidatedAccount({
    validate: async () => ({ status: 'ok' }),
    commit: async () => {
      saves++;
      return { accountId: 'saved-account' };
    },
    afterCommit: async () => {
      applies++;
      throw expected;
    },
    isCurrent: () => true
  });

  assert.equal(result.status, 'committed');
  assert.equal(result.value.accountId, 'saved-account');
  assert.equal(result.postCommitError, expected);
  assert.equal(saves, 1);
  assert.equal(applies, 1);
});

test('ok validates and commits exactly once in one submission', async () => {
  let validations = 0;
  let commits = 0;
  const result = await submitValidatedAccount({
    validate: async () => {
      validations++;
      return { status: 'ok', message: 'Login erfolgreich' };
    },
    commit: async () => {
      commits++;
    },
    isCurrent: () => true
  });

  assert.equal(result.status, 'committed');
  assert.equal(validations, 1);
  assert.equal(commits, 1);
});

test('warn validates and commits exactly once in one submission', async () => {
  let commits = 0;
  const validation = { status: 'warn', message: 'Login mit Warnung' };
  const result = await submitValidatedAccount({
    validate: async () => validation,
    commit: async (received) => {
      commits++;
      assert.equal(received, validation);
    },
    isCurrent: () => true
  });

  assert.equal(result.status, 'committed');
  assert.equal(result.validation, validation);
  assert.equal(commits, 1);
});

for (const status of ['error', 'skipped']) {
  test(`${status} rejects without committing`, async () => {
    let commits = 0;
    const validation = { status, message: `${status} result` };
    const result = await submitValidatedAccount({
      validate: async () => validation,
      commit: async () => {
        commits++;
      },
      isCurrent: () => true
    });

    assert.equal(result.status, 'rejected');
    assert.equal(result.validation, validation);
    assert.equal(commits, 0);
  });
}

test('validate throw returns error without committing', async () => {
  const expected = new Error('validation failed');
  let commits = 0;
  const result = await submitValidatedAccount({
    validate: async () => {
      throw expected;
    },
    commit: async () => {
      commits++;
    },
    isCurrent: () => true
  });

  assert.equal(result.status, 'error');
  assert.equal(result.error, expected);
  assert.equal(commits, 0);
});

test('otp_required returns challenge without committing', async () => {
  let commits = 0;
  const validation = { status: 'otp_required', message: 'OTP gesendet' };
  const result = await submitValidatedAccount({
    validate: async () => validation,
    commit: async () => {
      commits++;
    },
    isCurrent: () => true
  });

  assert.equal(result.status, 'otp_required');
  assert.equal(result.validation, validation);
  assert.equal(commits, 0);
});

test('stale submission is rejected immediately before commit', async () => {
  let current = true;
  let commits = 0;
  const validation = { status: 'ok' };
  const result = await submitValidatedAccount({
    validate: async () => {
      current = false;
      return validation;
    },
    commit: async () => {
      commits++;
    },
    isCurrent: () => current
  });

  assert.equal(result.status, 'stale');
  assert.equal(result.validation, validation);
  assert.equal(commits, 0);
});

test('save failure returns error after one commit attempt', async () => {
  const expected = new Error('save failed');
  let commits = 0;
  const result = await submitValidatedAccount({
    validate: async () => ({ status: 'ok' }),
    commit: async () => {
      commits++;
      throw expected;
    },
    isCurrent: () => true
  });

  assert.equal(result.status, 'error');
  assert.equal(result.error, expected);
  assert.equal(commits, 1);
});
