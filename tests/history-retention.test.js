const test = require('node:test');
const assert = require('node:assert');
const { applyHistoryRetention, countHistoryRows } = require('../lib/config-store');

function batch(timestamp, okRows, extras = {}) {
  const results = [];
  for (let i = 0; i < okRows; i++) results.push({ status: 'success', hoster: 'voe.sx', download_url: `https://voe.sx/${i}` });
  if (extras.aborted) for (let i = 0; i < extras.aborted; i++) results.push({ status: 'aborted', hoster: 'voe.sx' });
  if (extras.error) for (let i = 0; i < extras.error; i++) results.push({ status: 'error', hoster: 'voe.sx' });
  return { timestamp, files: [{ name: 'clip.mp4', results }] };
}

const DAY = 86400000;

test('countHistoryRows counts every visible history result', () => {
  const h = [batch('2026-01-01', 3, { aborted: 2, error: 1 })];
  assert.strictEqual(countHistoryRows(h), 6);
});

test('count policy prunes histories made only from failed or aborted uploads', () => {
  const h = [
    batch('2026-01-01', 0, { error: 60 }),
    batch('2026-01-02', 0, { aborted: 60 }),
    batch('2026-01-03', 0, { error: 60 })
  ];
  const pruned = applyHistoryRetention(h, '100', Date.parse('2026-06-01'));
  assert.deepStrictEqual(pruned.map(b => b.timestamp), ['2026-01-02', '2026-01-03']);
  assert.strictEqual(countHistoryRows(pruned), 120);
});

test('retention "all" returns the array unchanged', () => {
  const h = [batch('2026-01-01', 5), batch('2026-01-02', 5)];
  assert.strictEqual(applyHistoryRetention(h, 'all', Date.parse('2026-06-01')), h);
});

test('count policy keeps newest whole batches up to the row target', () => {
  const h = [batch('2026-01-01', 400), batch('2026-01-02', 400), batch('2026-01-03', 400)];
  const pruned = applyHistoryRetention(h, '1000', Date.parse('2026-06-01'));
  assert.strictEqual(pruned.length, 3);
  assert.strictEqual(countHistoryRows(pruned), 1200);
});

test('count policy drops older batches once target reached (newest first)', () => {
  const h = [batch('2026-01-01', 600), batch('2026-01-02', 600), batch('2026-01-03', 600)];
  const pruned = applyHistoryRetention(h, '1000', Date.parse('2026-06-01'));
  assert.strictEqual(pruned.length, 2);
  assert.deepStrictEqual(pruned.map(b => b.timestamp), ['2026-01-02', '2026-01-03']);
});

test('count policy always keeps the newest batch even if it alone exceeds N', () => {
  const h = [batch('2026-01-01', 50), batch('2026-01-02', 5000)];
  const pruned = applyHistoryRetention(h, '100', Date.parse('2026-06-01'));
  assert.strictEqual(pruned.length, 1);
  assert.strictEqual(pruned[0].timestamp, '2026-01-02');
});

test('time policy drops batches older than the cutoff', () => {
  const now = Date.parse('2026-06-15T00:00:00Z');
  const h = [
    batch(new Date(now - 10 * DAY).toISOString(), 5),
    batch(new Date(now - 3 * DAY).toISOString(), 5),
    batch(new Date(now - 1 * DAY).toISOString(), 5)
  ];
  const pruned = applyHistoryRetention(h, '7d', now);
  assert.strictEqual(pruned.length, 2);
});

test('time policy keeps batches with missing or invalid timestamp', () => {
  const now = Date.parse('2026-06-15T00:00:00Z');
  const h = [
    batch(undefined, 5),
    batch('not-a-date', 5),
    batch(new Date(now - 99 * DAY).toISOString(), 5),
    batch(new Date(now - 1 * DAY).toISOString(), 5)
  ];
  const pruned = applyHistoryRetention(h, '30d', now);
  assert.strictEqual(pruned.length, 3);
  assert.ok(pruned.includes(h[0]));
  assert.ok(pruned.includes(h[1]));
  assert.ok(!pruned.includes(h[2]));
});

test('count policy shrinks a realistic 41-batch / >1000-row history', () => {
  const h = [];
  for (let i = 0; i < 41; i++) h.push(batch(`2026-04-${String((i % 28) + 1).padStart(2, '0')}`, 1300));
  assert.strictEqual(countHistoryRows(h), 41 * 1300);
  const pruned = applyHistoryRetention(h, '1000', Date.parse('2026-06-01'));
  assert.strictEqual(pruned.length, 1);
  assert.strictEqual(countHistoryRows(pruned), 1300);
});

test('empty history is returned as-is for any policy', () => {
  assert.deepStrictEqual(applyHistoryRetention([], '7d', Date.now()), []);
  assert.deepStrictEqual(applyHistoryRetention([], '100', Date.now()), []);
});
