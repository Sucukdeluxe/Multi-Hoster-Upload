// Pure unit tests for the validate-credentials shape contract — does NOT spin
// up Electron or the real per-hoster checkers. Those need network. We verify
// the SHAPE the ephemeral hosterConfig is built into (which the per-hoster
// checkers consume) plus the snapshot-key/invalidation invariants that the
// renderer relies on to enforce "validated creds only".
//
// The three assertions the advisor called out as the regression guard for the
// user's "mehrfach angelegt" complaint:
//   (a) failed validation persists nothing to config.hosters
//   (b) a second "Anlegen" click with the guard set persists exactly one entry
//   (c) OTP-required path persists nothing
// are exercised at the state-machine level by simulating the renderer's logic
// (re-implemented here as pure functions for testability — the real ones live
// in renderer/app.js which can't run under node:test).

const { test } = require('node:test');
const assert = require('node:assert');

// ---- Re-implementations of the renderer's pure helpers ----
// These mirror the production code exactly so the tests serve as both a guard
// and executable spec for what saveAccount() must do.

function credsSnapshotKey(authType, creds) {
  if (authType === 'login') return `login:${creds.username || ''}:${creds.password || ''}`;
  return `api:${creds.apiKey || ''}`;
}

function buildEphemeralHosterConfig(payload) {
  return {
    username: payload.username || '',
    password: payload.password || '',
    apiKey: payload.apiKey || '',
    enabled: true
  };
}

// State-machine simulator that mirrors saveAccount() WITHOUT DOM/IPC.
function makeStateMachine({ validateImpl, persistImpl }) {
  let busy = false;
  let validated = null; // { hosterName, authType, snapshot, status }
  const log = []; // log of every persist call, for assertions

  async function click(ctx, creds, otp = '') {
    if (busy) { log.push({ type: 'click-ignored-busy' }); return; }
    const snapshot = credsSnapshotKey(ctx.authType, creds);

    // STEP 2: commit if validated matches.
    if (validated &&
        validated.hosterName === ctx.hosterName &&
        validated.authType === ctx.authType &&
        validated.snapshot === snapshot) {
      busy = true;
      try {
        await persistImpl(ctx, creds);
        log.push({ type: 'persisted', accountId: ctx.accountId || `${ctx.hosterName}-NEW` });
      } finally { busy = false; }
      return;
    }

    // STEP 1: ephemeral validate.
    busy = true;
    let row;
    try {
      row = await validateImpl({ hoster: ctx.hosterName, authType: ctx.authType, ...creds, otp });
    } finally { busy = false; }
    if (row && (row.status === 'ok' || row.status === 'warn')) {
      validated = { hosterName: ctx.hosterName, authType: ctx.authType, snapshot, status: row.status };
      log.push({ type: 'validated', status: row.status });
      return;
    }
    if (row && row.status === 'otp_required') {
      log.push({ type: 'otp-required' });
      return;
    }
    log.push({ type: 'validation-failed', message: row && row.message });
  }

  function editField() { validated = null; log.push({ type: 'invalidated-by-edit' }); }
  return { click, editField, log: () => log.slice(), getValidated: () => validated };
}

// ---- Tests ----

test('regression (a): failed validation persists NOTHING to config.hosters', async () => {
  const persistCalls = [];
  const sm = makeStateMachine({
    validateImpl: async () => ({ status: 'error', message: 'Falsches Passwort' }),
    persistImpl: async (ctx, creds) => persistCalls.push({ ctx, creds })
  });
  await sm.click({ hosterName: 'doodstream.com', authType: 'login', isEdit: false }, { username: 'u', password: 'wrong' });
  assert.equal(persistCalls.length, 0, 'no persist should happen on failed validation');
  assert.equal(sm.getValidated(), null);
  assert.deepEqual(sm.log().map(e => e.type), ['validation-failed']);
});

test('regression (b): second click with guard set persists exactly ONE entry — no duplication', async () => {
  const persistCalls = [];
  let validateCount = 0;
  const sm = makeStateMachine({
    validateImpl: async () => { validateCount++; return { status: 'ok' }; },
    persistImpl: async (ctx, creds) => persistCalls.push({ ctx, creds })
  });
  const ctx = { hosterName: 'doodstream.com', authType: 'login', isEdit: false };
  const creds = { username: 'u', password: 'p' };
  // Click 1 = validate → green.
  await sm.click(ctx, creds);
  // Click 2 = commit (same creds, validated snapshot matches).
  await sm.click(ctx, creds);
  // Click 3 = guard prevents a second commit because after persistImpl the
  // state-machine in real code closes the modal. In this simulator the
  // validated snapshot is still set — but a real double-click WHILE persistImpl
  // is in flight would be caught by busy. Simulate that:
  const sm2 = makeStateMachine({
    validateImpl: async () => ({ status: 'ok' }),
    persistImpl: () => new Promise(r => setTimeout(() => { persistCalls.push('slow'); r(); }, 30))
  });
  await sm2.click(ctx, creds); // validate
  const p1 = sm2.click(ctx, creds); // start commit
  const p2 = sm2.click(ctx, creds); // racing click — must be ignored
  await Promise.all([p1, p2]);

  assert.equal(persistCalls.length, 2, 'one persist from the deliberate two-step flow + one from sm2; racing click ignored');
  assert.equal(validateCount, 1, 'second click reused the validated snapshot — no re-validate');
  // The racing click MUST have been ignored by the busy guard.
  assert.ok(sm2.log().some(e => e.type === 'click-ignored-busy'), 'busy guard fired on racing click');
});

test('regression (c): OTP-required persists NOTHING — and a follow-up click with OTP re-validates ephemerally', async () => {
  const persistCalls = [];
  let calls = 0;
  const sm = makeStateMachine({
    validateImpl: async (payload) => {
      calls++;
      if (!payload.otp) return { status: 'otp_required', message: 'OTP sent' };
      if (payload.otp === '123456') return { status: 'ok' };
      return { status: 'error', message: 'Bad OTP' };
    },
    persistImpl: async (ctx, creds) => persistCalls.push({ ctx, creds })
  });
  const ctx = { hosterName: 'doodstream.com', authType: 'login', isEdit: false };
  const creds = { username: 'u', password: 'p' };
  await sm.click(ctx, creds, '');         // first click → otp_required
  await sm.click(ctx, creds, '123456');   // retry with otp → ok
  await sm.click(ctx, creds);             // final click → commit
  assert.equal(persistCalls.length, 1, 'exactly one persist after OTP confirmed');
  assert.equal(calls, 2, 'validate ran twice (initial + OTP) before commit');
  assert.deepEqual(
    sm.log().map(e => e.type),
    ['otp-required', 'validated', 'persisted']
  );
});

test('field edit after green check invalidates the snapshot — next click is a re-Prüfen, not a commit', async () => {
  const persistCalls = [];
  let validateCount = 0;
  const sm = makeStateMachine({
    validateImpl: async () => { validateCount++; return { status: 'ok' }; },
    persistImpl: async (ctx, creds) => persistCalls.push({ ctx, creds })
  });
  const ctx = { hosterName: 'doodstream.com', authType: 'login', isEdit: false };
  await sm.click(ctx, { username: 'u', password: 'p' });   // validate → green
  sm.editField();                                           // user edits cred field → snapshot dropped
  await sm.click(ctx, { username: 'u', password: 'newpw' }); // creds differ → re-validate
  await sm.click(ctx, { username: 'u', password: 'newpw' }); // now commit the NEW creds
  assert.equal(persistCalls.length, 1, 'one persist of the new (re-validated) creds');
  assert.equal(persistCalls[0].creds.password, 'newpw', 'persisted creds match the re-validated set');
  assert.equal(validateCount, 2, 'second validate was forced by the edit-induced invalidation');
});

test('snapshot key is identical for same creds and DIFFERENT for any cred change (excluding label)', () => {
  // Label changes must NOT invalidate validation — label is metadata, not a credential.
  assert.equal(credsSnapshotKey('login', { username: 'u', password: 'p' }),
               credsSnapshotKey('login', { username: 'u', password: 'p', label: 'XYZ' }));
  assert.notEqual(credsSnapshotKey('login', { username: 'u', password: 'p' }),
                  credsSnapshotKey('login', { username: 'u', password: 'P' })); // password char-case
  assert.notEqual(credsSnapshotKey('login', { username: 'u', password: 'p' }),
                  credsSnapshotKey('login', { username: 'U', password: 'p' })); // username diff
  assert.equal(credsSnapshotKey('api', { apiKey: 'KEY' }),
               credsSnapshotKey('api', { apiKey: 'KEY', label: 'mein key' }));
  assert.notEqual(credsSnapshotKey('api', { apiKey: 'KEY' }),
                  credsSnapshotKey('api', { apiKey: 'KEY2' }));
});

test('ephemeral hosterConfig shape matches what per-hoster checkers expect', () => {
  // The per-hoster checkers in main.js read .username/.password/.apiKey directly.
  // This guards the validate-credentials IPC contract from drifting.
  const cfg = buildEphemeralHosterConfig({ hoster: 'doodstream.com', username: 'u', password: 'p' });
  assert.equal(cfg.username, 'u');
  assert.equal(cfg.password, 'p');
  assert.equal(cfg.apiKey, '');
  assert.equal(cfg.enabled, true);
  const cfg2 = buildEphemeralHosterConfig({ hoster: 'byse.sx', apiKey: 'K' });
  assert.equal(cfg2.apiKey, 'K');
  assert.equal(cfg2.username, '');
});
