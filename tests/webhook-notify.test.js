const test = require('node:test');
const assert = require('node:assert');
const { isDiscordWebhook, formatDurationShort, summarizePerHosterFromBatch, buildWebhookRequest, resolveDiscordMention, isAllAborted, clampDiscordContent, DISCORD_CONTENT_LIMIT } = require('../lib/webhook-notify');

const SAMPLE_SUMMARY = {
  total: 10,
  succeeded: 8,
  failed: 2,
  files: [
    { name: 'a.mkv', results: [
      { hoster: 'voe.sx', status: 'done' },
      { hoster: 'byse.sx', status: 'error', error: 'x' }
    ] },
    { name: 'b.mkv', results: [
      { hoster: 'voe.sx', status: 'done' },
      { hoster: 'byse.sx', status: 'done' }
    ] }
  ]
};

test('isDiscordWebhook recognizes discord URLs incl. ptb/canary/discordapp', () => {
  assert.ok(isDiscordWebhook('https://discord.com/api/webhooks/123/abc'));
  assert.ok(isDiscordWebhook('https://discordapp.com/api/webhooks/123/abc'));
  assert.ok(isDiscordWebhook('https://ptb.discord.com/api/webhooks/123/abc'));
  assert.ok(isDiscordWebhook('https://canary.discord.com/api/webhooks/123/abc'));
  assert.strictEqual(isDiscordWebhook('https://example.com/hook'), false);
  assert.strictEqual(isDiscordWebhook(''), false);
  assert.strictEqual(isDiscordWebhook(null), false);
});

test('isDiscordWebhook REJECTS incomplete discord URLs (no id/token)', () => {
  assert.strictEqual(isDiscordWebhook('https://discord.com/api/webhooks/'), false);
  assert.strictEqual(isDiscordWebhook('https://discord.com/api/webhooks'), false);
  assert.strictEqual(isDiscordWebhook('https://discord.com/api/webhooks/123'), false);
  assert.strictEqual(isDiscordWebhook('https://discord.com/api/webhooks/123/'), false);
  assert.ok(isDiscordWebhook('https://discord.com/api/webhooks/123456789/aBc-_token123'));
});

test('clampDiscordContent caps to the Discord limit with ellipsis', () => {
  const short = 'hello';
  assert.strictEqual(clampDiscordContent(short), short);
  const long = 'x'.repeat(5000);
  const clamped = clampDiscordContent(long);
  assert.ok(clamped.length <= DISCORD_CONTENT_LIMIT);
  assert.ok(clamped.endsWith('…'));
});

test('buildWebhookRequest: many hosters does not exceed Discord limit', () => {
  const files = [{ name: 'a.mkv', results: [] }];
  for (let i = 0; i < 60; i++) files[0].results.push({ hoster: `hoster-with-a-really-long-name-${i}.example.com`, status: 'done' });
  const req = buildWebhookRequest('https://discord.com/api/webhooks/1/x', { total: 60, succeeded: 60, failed: 0, files }, { durationSec: 60 });
  const body = JSON.parse(req.body);
  assert.ok(body.content.length <= DISCORD_CONTENT_LIMIT, `content ${body.content.length} must be <= ${DISCORD_CONTENT_LIMIT}`);
  assert.match(body.content, /\+\d+/);
});

test('buildWebhookRequest: aborted meta changes the headline', () => {
  const req = buildWebhookRequest('https://discord.com/api/webhooks/1/x', { total: 5, succeeded: 0, failed: 5, files: [] }, { aborted: true, language: 'de' });
  const body = JSON.parse(req.body);
  assert.match(body.content, /Batch abgebrochen/);
});

test('isAllAborted: true only when every result is aborted', () => {
  assert.strictEqual(isAllAborted({ files: [{ results: [{ status: 'aborted' }, { status: 'aborted' }] }] }), true);
  assert.strictEqual(isAllAborted({ files: [{ results: [{ status: 'aborted' }, { status: 'done' }] }] }), false);
  assert.strictEqual(isAllAborted({ files: [{ results: [{ status: 'error' }] }] }), false);
  assert.strictEqual(isAllAborted({ files: [] }), false);
  assert.strictEqual(isAllAborted(null), false);
});

test('formatDurationShort formats h/m/s tiers', () => {
  assert.strictEqual(formatDurationShort(45), '45s');
  assert.strictEqual(formatDurationShort(125), '2m 5s');
  assert.strictEqual(formatDurationShort(3 * 3600 + 12 * 60), '3h 12m');
  assert.strictEqual(formatDurationShort(-5), '0s');
  assert.strictEqual(formatDurationShort(undefined), '0s');
});

test('summarizePerHosterFromBatch counts ok/fail per hoster', () => {
  const s = summarizePerHosterFromBatch(SAMPLE_SUMMARY);
  assert.deepStrictEqual(s['voe.sx'], { ok: 2, fail: 0 });
  assert.deepStrictEqual(s['byse.sx'], { ok: 1, fail: 1 });
});

test('summarizePerHosterFromBatch handles malformed input', () => {
  assert.deepStrictEqual(summarizePerHosterFromBatch(null), {});
  assert.deepStrictEqual(summarizePerHosterFromBatch({}), {});
  assert.deepStrictEqual(summarizePerHosterFromBatch({ files: [{ results: null }] }), {});
});

test('buildWebhookRequest produces Discord content body for discord URLs', () => {
  const req = buildWebhookRequest('https://discord.com/api/webhooks/1/x', SAMPLE_SUMMARY, { durationSec: 3700, appVersion: '3.3.59', machineName: 'srv-1' });
  assert.strictEqual(req.method, 'POST');
  assert.strictEqual(req.headers['Content-Type'], 'application/json');
  const body = JSON.parse(req.body);
  assert.ok(typeof body.content === 'string');
  assert.match(body.content, /Batch completed/);
  assert.match(body.content, /srv-1/);
  assert.match(body.content, /8 succeeded/);
  assert.match(body.content, /2 failed/);
  assert.match(body.content, /1h 1m/);
  assert.match(body.content, /voe\.sx: 2\/2/);
});

test('buildWebhookRequest localizes Discord content from the selected language', () => {
  const req = buildWebhookRequest('https://discord.com/api/webhooks/1/x', SAMPLE_SUMMARY, { language: 'de' });
  const body = JSON.parse(req.body);
  assert.match(body.content, /Batch fertig/);
  assert.match(body.content, /2 Fehler/);
  assert.match(body.content, /10 gesamt/);
});

test('buildWebhookRequest produces raw JSON payload for generic URLs', () => {
  const req = buildWebhookRequest('https://example.com/hook', SAMPLE_SUMMARY, { durationSec: 60, appVersion: '3.3.59', timestamp: '2026-06-09T00:00:00Z' });
  const body = JSON.parse(req.body);
  assert.strictEqual(body.event, 'batch-done');
  assert.strictEqual(body.total, 10);
  assert.strictEqual(body.succeeded, 8);
  assert.strictEqual(body.failed, 2);
  assert.strictEqual(body.durationSec, 60);
  assert.strictEqual(body.version, '3.3.59');
  assert.deepStrictEqual(body.perHoster['byse.sx'], { ok: 1, fail: 1 });
});

test('resolveDiscordMention: @here / @everyone use parse=everyone', () => {
  assert.deepStrictEqual(resolveDiscordMention('@here'), { token: '@here', allowed: { parse: ['everyone'] } });
  assert.deepStrictEqual(resolveDiscordMention('everyone'), { token: '@everyone', allowed: { parse: ['everyone'] } });
});

test('resolveDiscordMention: bare numeric id → user mention', () => {
  assert.deepStrictEqual(resolveDiscordMention('123456789012345'), { token: '<@123456789012345>', allowed: { users: ['123456789012345'] } });
  assert.deepStrictEqual(resolveDiscordMention('<@!123456789012345>'), { token: '<@123456789012345>', allowed: { users: ['123456789012345'] } });
});

test('resolveDiscordMention: role:id and <@&id> → role mention', () => {
  assert.deepStrictEqual(resolveDiscordMention('role:99887766'), { token: '<@&99887766>', allowed: { roles: ['99887766'] } });
  assert.deepStrictEqual(resolveDiscordMention('<@&99887766>'), { token: '<@&99887766>', allowed: { roles: ['99887766'] } });
});

test('resolveDiscordMention: empty / junk → null', () => {
  assert.strictEqual(resolveDiscordMention(''), null);
  assert.strictEqual(resolveDiscordMention('   '), null);
  assert.strictEqual(resolveDiscordMention('not-an-id'), null);
});

test('buildWebhookRequest: discord with mention prepends token + sets allowed_mentions', () => {
  const req = buildWebhookRequest('https://discord.com/api/webhooks/1/x', SAMPLE_SUMMARY, { durationSec: 60, mention: '123456789012345' });
  const body = JSON.parse(req.body);
  assert.ok(body.content.startsWith('<@123456789012345> '));
  assert.deepStrictEqual(body.allowed_mentions, { users: ['123456789012345'] });
});

test('buildWebhookRequest: discord without mention blocks all pings (allowed_mentions parse empty)', () => {
  const req = buildWebhookRequest('https://discord.com/api/webhooks/1/x', SAMPLE_SUMMARY, { durationSec: 60 });
  const body = JSON.parse(req.body);
  assert.deepStrictEqual(body.allowed_mentions, { parse: [] });
});

test('buildWebhookRequest tolerates empty summary', () => {
  const req = buildWebhookRequest('https://example.com/hook', null, {});
  const body = JSON.parse(req.body);
  assert.strictEqual(body.total, 0);
  assert.strictEqual(body.succeeded, 0);
});
