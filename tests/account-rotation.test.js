const test = require('node:test');
const assert = require('node:assert');
const {
  classifyAccountFailure,
  createAccountCooldownController,
  createAccountPicker,
  enabledAccountsFor
} = require('../lib/account-rotation');

const hasCreds = (hoster, a) => !!(a && a.creds !== false);
function acc(id, opts = {}) { return { id, enabled: opts.enabled, creds: opts.creds }; }
function picks(pick, hoster, n) { return Array.from({ length: n }, () => { const a = pick(hoster); return a ? a.id : null; }); }

test('rotate OFF: always the first enabled account (primary, unchanged behavior)', () => {
  const hosters = { 'byse.sx': [acc('a1'), acc('a2'), acc('a3')] };
  const pick = createAccountPicker({ hosters, hosterSettings: {}, hasCreds });
  assert.deepStrictEqual(picks(pick, 'byse.sx', 4), ['a1', 'a1', 'a1', 'a1']);
});

test('rotate ON, 3 accounts: round-robin per call and wraps around', () => {
  const hosters = { 'byse.sx': [acc('a1'), acc('a2'), acc('a3')] };
  const pick = createAccountPicker({ hosters, hosterSettings: { 'byse.sx': { rotateAccounts: true } }, hasCreds });
  assert.deepStrictEqual(picks(pick, 'byse.sx', 7), ['a1', 'a2', 'a3', 'a1', 'a2', 'a3', 'a1']);
});

test('rotate ON, single enabled account: no-op (length must be > 1 to rotate)', () => {
  const hosters = { 'byse.sx': [acc('a1')] };
  const pick = createAccountPicker({ hosters, hosterSettings: { 'byse.sx': { rotateAccounts: true } }, hasCreds });
  assert.deepStrictEqual(picks(pick, 'byse.sx', 3), ['a1', 'a1', 'a1']);
});

test('rotate ON skips a disabled account, keeps the rest in order', () => {
  const hosters = { 'byse.sx': [acc('a1'), acc('a2', { enabled: false }), acc('a3')] };
  const pick = createAccountPicker({ hosters, hosterSettings: { 'byse.sx': { rotateAccounts: true } }, hasCreds });
  assert.deepStrictEqual(picks(pick, 'byse.sx', 4), ['a1', 'a3', 'a1', 'a3']);
});

test('rotate ON skips an account without credentials', () => {
  const hosters = { 'byse.sx': [acc('a1'), acc('a2', { creds: false }), acc('a3')] };
  const pick = createAccountPicker({ hosters, hosterSettings: { 'byse.sx': { rotateAccounts: true } }, hasCreds });
  assert.deepStrictEqual(picks(pick, 'byse.sx', 4), ['a1', 'a3', 'a1', 'a3']);
});

test('no usable account → null (disabled hoster or missing hoster)', () => {
  const hosters = { 'byse.sx': [acc('a1', { enabled: false })] };
  const pick = createAccountPicker({ hosters, hosterSettings: { 'byse.sx': { rotateAccounts: true } }, hasCreds });
  assert.strictEqual(pick('byse.sx'), null);
  assert.strictEqual(pick('voe.sx'), null);
});

test('rotation index is independent per hoster (interleaved calls)', () => {
  const hosters = { 'byse.sx': [acc('b1'), acc('b2')], 'voe.sx': [acc('v1'), acc('v2')] };
  const settings = { 'byse.sx': { rotateAccounts: true }, 'voe.sx': { rotateAccounts: true } };
  const pick = createAccountPicker({ hosters, hosterSettings: settings, hasCreds });
  assert.strictEqual(pick('byse.sx').id, 'b1');
  assert.strictEqual(pick('voe.sx').id, 'v1');
  assert.strictEqual(pick('byse.sx').id, 'b2');
  assert.strictEqual(pick('voe.sx').id, 'v2');
  assert.strictEqual(pick('byse.sx').id, 'b1');
});

test('rotate ON for byse only: voe still uses its primary', () => {
  const hosters = { 'byse.sx': [acc('b1'), acc('b2')], 'voe.sx': [acc('v1'), acc('v2')] };
  const pick = createAccountPicker({ hosters, hosterSettings: { 'byse.sx': { rotateAccounts: true } }, hasCreds });
  assert.deepStrictEqual(picks(pick, 'voe.sx', 2), ['v1', 'v1']);
  assert.deepStrictEqual(picks(pick, 'byse.sx', 2), ['b1', 'b2']);
});

test('user scenario: 100 files across 2 active accounts → even 50/50 alternating split', () => {
  const hosters = { 'byse.sx': [acc('a1'), acc('a2')] };
  const pick = createAccountPicker({ hosters, hosterSettings: { 'byse.sx': { rotateAccounts: true } }, hasCreds });
  const ids = picks(pick, 'byse.sx', 100);
  assert.strictEqual(ids.filter(x => x === 'a1').length, 50);
  assert.strictEqual(ids.filter(x => x === 'a2').length, 50);
  assert.deepStrictEqual(ids.slice(0, 5), ['a1', 'a2', 'a1', 'a2', 'a1']);
});

test('enabledAccountsFor filters disabled + no-creds and preserves order', () => {
  const hosters = { 'byse.sx': [acc('a1'), acc('a2', { enabled: false }), acc('a3', { creds: false }), acc('a4')] };
  assert.deepStrictEqual(enabledAccountsFor(hosters, 'byse.sx', hasCreds).map(a => a.id), ['a1', 'a4']);
  assert.deepStrictEqual(enabledAccountsFor(hosters, 'missing', hasCreds), []);
});

test('seeded index resumes mid-cycle (restart / persisted cursor)', () => {
  const hosters = { 'byse.sx': [acc('a1'), acc('a2'), acc('a3')] };
  const pick = createAccountPicker({ hosters, hosterSettings: { 'byse.sx': { rotateAccounts: true } }, hasCreds, indices: { 'byse.sx': 1 } });
  assert.deepStrictEqual(picks(pick, 'byse.sx', 4), ['a2', 'a3', 'a1', 'a2']);
});

test('drip-feed: fresh picker per call seeded from prior indices keeps rotating (no per-batch reset)', () => {
  const hosters = { 'byse.sx': [acc('a1'), acc('a2'), acc('a3')] };
  const settings = { 'byse.sx': { rotateAccounts: true } };
  let cursors = {};
  const landed = [];
  for (let i = 0; i < 6; i++) {
    const pick = createAccountPicker({ hosters, hosterSettings: settings, hasCreds, indices: cursors });
    landed.push(pick('byse.sx').id);
    cursors = pick.indices();
  }
  assert.deepStrictEqual(landed, ['a1', 'a2', 'a3', 'a1', 'a2', 'a3']);
});

test('dirty() is true only after an actual rotation advance', () => {
  const hosters = { 'byse.sx': [acc('a1'), acc('a2')], 'voe.sx': [acc('v1'), acc('v2')] };
  const offPick = createAccountPicker({ hosters, hosterSettings: {}, hasCreds });
  offPick('byse.sx'); offPick('voe.sx');
  assert.strictEqual(offPick.dirty(), false);

  const singlePick = createAccountPicker({ hosters: { 'byse.sx': [acc('a1')] }, hosterSettings: { 'byse.sx': { rotateAccounts: true } }, hasCreds });
  singlePick('byse.sx');
  assert.strictEqual(singlePick.dirty(), false);

  const onPick = createAccountPicker({ hosters, hosterSettings: { 'byse.sx': { rotateAccounts: true } }, hasCreds });
  onPick('voe.sx');
  assert.strictEqual(onPick.dirty(), false);
  onPick('byse.sx');
  assert.strictEqual(onPick.dirty(), true);
});

test('indices() carries forward unrotated seeded hosters alongside advanced ones', () => {
  const hosters = { 'byse.sx': [acc('a1'), acc('a2')], 'voe.sx': [acc('v1'), acc('v2')] };
  const pick = createAccountPicker({ hosters, hosterSettings: { 'byse.sx': { rotateAccounts: true } }, hasCreds, indices: { 'voe.sx': 5 } });
  pick('byse.sx');
  assert.deepStrictEqual(pick.indices(), { 'voe.sx': 5, 'byse.sx': 1 });
});

test('persisted cursor wraps correctly after the enabled-account count shrinks', () => {
  const hosters = { 'byse.sx': [acc('a1'), acc('a2')] };
  const pick = createAccountPicker({ hosters, hosterSettings: { 'byse.sx': { rotateAccounts: true } }, hasCreds, indices: { 'byse.sx': 7 } });
  assert.deepStrictEqual(picks(pick, 'byse.sx', 3), ['a2', 'a1', 'a2']);
});

test('temporary account failures escalate through 15, 30, 60, and 120 minute cooldowns', () => {
  let now = 1_000_000;
  const scheduled = [];
  const controller = createAccountCooldownController({
    now: () => now,
    setTimer: (callback, delay) => { scheduled.push({ callback, delay }); return scheduled.length; },
    clearTimer: () => {}
  });

  const expectedMinutes = [15, 30, 60, 120, 120];
  for (let index = 0; index < expectedMinutes.length; index++) {
    const record = controller.markFailure({ hoster: 'byse.sx', accountId: 'acc-1', mode: 'cooldown' });
    assert.equal(record.failures, index + 1);
    assert.equal(record.pausedUntil, now + expectedMinutes[index] * 60_000);
    assert.equal(scheduled.at(-1).delay, expectedMinutes[index] * 60_000);
    now = record.pausedUntil;
    assert.deepEqual(controller.releaseExpired(), [`byse.sx:acc-1`]);
  }
});

test('parallel duplicate failures count as one strike until the active cooldown expires', () => {
  let now = 50_000;
  const controller = createAccountCooldownController({
    now: () => now,
    setTimer: () => 1,
    clearTimer: () => {}
  });
  const first = controller.markFailure({ hoster: 'byse.sx', accountId: 'acc-1', mode: 'cooldown' });
  const duplicate = controller.markFailure({ hoster: 'byse.sx', accountId: 'acc-1', mode: 'cooldown' });
  now = first.pausedUntil;
  controller.releaseExpired();
  const next = controller.markFailure({ hoster: 'byse.sx', accountId: 'acc-1', mode: 'cooldown' });

  assert.equal(duplicate.failures, 1);
  assert.equal(duplicate.pausedUntil, first.pausedUntil);
  assert.equal(next.failures, 2);
  assert.equal(next.pausedUntil, now + 30 * 60_000);
});

test('a successful upload resets cooldown escalation to the first level', () => {
  let now = 5_000;
  const controller = createAccountCooldownController({
    now: () => now,
    setTimer: () => 1,
    clearTimer: () => {}
  });
  const first = controller.markFailure({ hoster: 'voe.sx', accountId: 'acc-1', mode: 'cooldown' });
  now = first.pausedUntil;
  controller.releaseExpired();
  controller.markFailure({ hoster: 'voe.sx', accountId: 'acc-1', mode: 'cooldown' });

  assert.equal(controller.markSuccess('voe.sx', 'acc-1'), true);
  const afterSuccess = controller.markFailure({ hoster: 'voe.sx', accountId: 'acc-1', mode: 'cooldown' });
  assert.equal(afterSuccess.failures, 1);
  assert.equal(afterSuccess.pausedUntil, now + 15 * 60_000);
});

test('manual account pauses never expire and can be reset explicitly', () => {
  let now = 10_000;
  const controller = createAccountCooldownController({
    now: () => now,
    setTimer: () => { throw new Error('manual pauses must not schedule timers'); },
    clearTimer: () => {}
  });
  const record = controller.markFailure({ hoster: 'doodstream.com', accountId: 'acc-1', mode: 'manual' });
  now += 24 * 60 * 60_000;

  assert.equal(record.pausedUntil, null);
  assert.deepEqual(controller.releaseExpired(), []);
  assert.deepEqual(controller.activeKeys(), ['doodstream.com:acc-1']);
  assert.equal(controller.reset('doodstream.com', 'acc-1'), true);
  assert.deepEqual(controller.activeKeys(), []);
});

test('automatic expiry clears the runtime account and publishes the remaining state', () => {
  let now = 2_000;
  let scheduled;
  const cleared = [];
  const published = [];
  const controller = createAccountCooldownController({
    now: () => now,
    setTimer: (callback, delay) => { scheduled = { callback, delay }; return 1; },
    clearTimer: () => {},
    onClearAccount: (hoster, accountId) => cleared.push(`${hoster}:${accountId}`),
    onChange: (records, cause) => published.push({ records, cause })
  });
  const record = controller.markFailure({ hoster: 'byse.sx', accountId: 'acc-1', mode: 'cooldown' });
  now = record.pausedUntil;
  scheduled.callback();

  assert.deepEqual(cleared, ['byse.sx:acc-1']);
  assert.deepEqual(published.at(-1), { records: [], cause: 'expired' });
  assert.deepEqual(controller.activeKeys(), []);
});

test('account failure classification keeps credential and OTP errors manual', () => {
  const otp = new Error('Doodstream Login: OTP required');
  otp.otpRequired = true;
  assert.equal(classifyAccountFailure(otp), 'manual');
  assert.equal(classifyAccountFailure(new Error('VOE Login fehlgeschlagen: Falscher Username oder Passwort')), 'manual');
  assert.equal(classifyAccountFailure(new Error('HTTP 401 Unauthorized')), 'manual');
  assert.equal(classifyAccountFailure(new Error('Account banned')), 'manual');
});

test('account failure classification cools down quota and rate-limit errors without pausing transient failures', () => {
  const quota = new Error('not enough disk space on your account');
  quota.accountError = true;
  assert.equal(classifyAccountFailure(quota), 'cooldown');
  assert.equal(classifyAccountFailure(new Error('Maximum storage space of the account used up.')), 'cooldown');
  assert.equal(classifyAccountFailure(new Error('HTTP 429 Too Many Requests')), 'cooldown');
  const transient = new Error('HTTP 503 Service Unavailable');
  transient.transientNetwork = true;
  assert.equal(classifyAccountFailure(transient), 'none');
});

test('account failure classification does not punish unknown, confirmation, or bare WAF errors', () => {
  assert.equal(classifyAccountFailure(new Error('Upload wurde nicht bestätigt')), 'none');
  assert.equal(classifyAccountFailure(new Error('Unbekannter Parserfehler')), 'none');
  const waf = new Error('HTTP 403');
  waf.status = 403;
  assert.equal(classifyAccountFailure(waf), 'none');
});

test('account failure classification cools down stale sessions and explicit account errors', () => {
  assert.equal(classifyAccountFailure(new Error('CSRF-Token nicht gefunden')), 'cooldown');
  assert.equal(classifyAccountFailure(new Error('Session expired')), 'cooldown');
  const accountError = new Error('Provider account unavailable');
  accountError.accountError = true;
  assert.equal(classifyAccountFailure(accountError), 'cooldown');
  assert.equal(classifyAccountFailure(new Error('Doodstream: sess_id nicht gefunden nach Login')), 'cooldown');
});
