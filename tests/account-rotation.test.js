const test = require('node:test');
const assert = require('node:assert');
const { createAccountPicker, enabledAccountsFor } = require('../lib/account-rotation');

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
