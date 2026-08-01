const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const support = require('../lib/support-bundle');
const stats = require('../lib/stats');
const { createCollectors } = require('../lib/diagnostics-collectors');
const { createAgent } = require('../lib/diagnostics-agent');

const fixtureSecrets = {
  diagnosticToken: ['fixture', 'diagnostic', 'token', '123456'].join('-'),
  bearerToken: ['fixture', 'bearer', 'token', '123456'].join('-'),
  doodstreamKey: ['fixture', 'doodstream', 'key', '99999'].join('-'),
  password: ['fixture', 'password', 'not', 'real'].join('-'),
  apiKey: ['fixture', 'api', 'key', '1234567'].join('-'),
  webhookToken: ['fixture', 'webhook', 'token', '123456'].join('-')
};

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mhu-diag-'));
  const paths = {
    fileuploader: path.join(dir, 'fileuploader.log'),
    debug: path.join(dir, 'debug.log'),
    accountRotation: path.join(dir, 'account-rotation.log'),
    doodstreamDebug: path.join(dir, 'doodstream-debug.log'),
    crashLog: path.join(dir, 'crash.log'),
    logDir: dir
  };
  fs.writeFileSync(paths.debug, `boot ok\nuploading file with token ${fixtureSecrets.diagnosticToken} inline\nAuthorization: Bearer ${fixtureSecrets.bearerToken}\n`);
  fs.writeFileSync(paths.doodstreamDebug, `api_key=${fixtureSecrets.doodstreamKey} sess=abc\n`);
  fs.writeFileSync(paths.crashLog, 'CRASH at 12:00\n');
  const config = {
    hosters: { 'voe.sx': [{ id: 'a1', username: 'u', password: fixtureSecrets.password }], 'byse.sx': [{ id: 'b1', apiKey: fixtureSecrets.apiKey }] },
    hosterSettings: {},
    globalSettings: {
      webhookUrl: `https://discord.com/api/webhooks/12345/${fixtureSecrets.webhookToken}`,
      diagnostics: { enabled: true, port: 9110, token: fixtureSecrets.diagnosticToken, bindAddress: '127.0.0.1' },
      pendingQueue: { savedAt: 1, selectedUploadHosters: ['voe.sx'], selectedFiles: [{ path: 'C:/a.mkv' }], queueJobs: [{ file: 'C:/a.mkv', fileName: 'a.mkv', hoster: 'voe.sx', status: 'error', error: 'timeout' }] }
    },
    history: [{ timestamp: new Date(2026, 0, 1).toISOString(), files: [{ name: 'x.mkv', results: [{ hoster: 'voe.sx', status: 'error', error: 'Not video file format' }, { hoster: 'byse.sx', status: 'done', url: 'https://byse.sx/x' }] }] }],
    rotationCursors: { 'voe.sx': 1 }
  };
  const collectors = createCollectors({
    loadConfig: () => JSON.parse(JSON.stringify(config)),
    getAllLogPaths: () => paths,
    support, stats,
    appInfo: () => ({ name: 'mhu', version: '9.9.9' }),
    systemInfo: () => ({ platform: 'win32', hostname: 'srv' }),
    agentInfo: () => ({ version: '9.9.9', port: 9110, clientCount: 0, lastAccess: null })
  });
  return { dir, paths, config, collectors };
}

test('getConfigRedacted strips password/apiKey/token/webhookUrl and value-scrubs the token mid-string', () => {
  const { collectors } = makeFixture();
  const out = collectors.getConfigRedacted({ section: 'all' });
  const json = JSON.stringify(out);
  assert.ok(!json.includes(fixtureSecrets.password), 'password must be redacted');
  assert.ok(!json.includes(fixtureSecrets.apiKey), 'apiKey must be redacted');
  assert.ok(!json.includes(fixtureSecrets.diagnosticToken), 'diag token must be redacted');
  assert.ok(!json.includes(fixtureSecrets.webhookToken), 'webhook secret must be redacted');
});

test('getHistory reads loadHistory (migrated mode: loadConfig().history is empty)', () => {
  const c = createCollectors({
    loadConfig: () => ({ hosters: {}, globalSettings: {}, history: [] }),
    loadHistory: () => [
      { timestamp: '2026-01-01T00:00:00.000Z', files: [{ name: 'a.mkv', results: [{ hoster: 'voe.sx', status: 'done', url: 'https://voe.sx/a' }] }] },
      { timestamp: '2026-01-02T00:00:00.000Z', files: [{ name: 'b.mkv', results: [{ hoster: 'byse.sx', status: 'done', url: 'https://byse.sx/b' }] }] }
    ],
    getAllLogPaths: () => ({ logDir: os.tmpdir() }),
    support, stats,
    appInfo: () => ({}), systemInfo: () => ({}), agentInfo: () => ({})
  });
  const out = c.getHistory({ limit: 10 });
  assert.equal(out.totalBatches, 2, 'must report real history from loadHistory, not the empty load().history');
  assert.equal(out.returned, 2);
});

test('getHistory falls back to loadConfig().history when loadHistory is absent (legacy mode)', () => {
  const c = createCollectors({
    loadConfig: () => ({ hosters: {}, globalSettings: {}, history: [{ timestamp: '2026-01-01T00:00:00.000Z', files: [] }] }),
    getAllLogPaths: () => ({ logDir: os.tmpdir() }),
    support, stats,
    appInfo: () => ({}), systemInfo: () => ({}), agentInfo: () => ({})
  });
  assert.equal(c.getHistory({ limit: 10 }).totalBatches, 1, 'legacy path reads load().history when loadHistory not injected');
});

test('readLog redacts a planted token and a Bearer line; doodstream is NOT readable; unknown name rejected', () => {
  const { collectors } = makeFixture();
  const dbg = collectors.readLog({ name: 'debug', tailKb: 64 });
  assert.ok(!dbg.content.includes(fixtureSecrets.diagnosticToken), 'value-scrub removes the live diag token from logs');
  assert.ok(!dbg.content.includes(fixtureSecrets.bearerToken), 'pattern-scrub removes Authorization Bearer');
  assert.equal(collectors.readLog({ name: 'doodstreamDebug' }).ok, false, 'doodstream-debug.log is not in the readable allowlist');
  assert.equal(collectors.readLog({ name: '../../etc/passwd' }).ok, false, 'arbitrary names are rejected (no path traversal)');
  assert.equal(collectors.readLog({ name: 'crash' }).name, 'crash');
});

test('readLog grep is case-insensitive substring with | alternation, and is ReDoS-safe', () => {
  const { paths } = makeFixture();
  const fs2 = require('fs');
  fs2.writeFileSync(paths.debug, ['ERROR upload failed', 'info all good', 'WARN timeout hit', 'a'.repeat(120) + '! catastrophic bait'].join('\n'));
  const { collectors } = (() => {
    const support2 = require('../lib/support-bundle');
    const stats2 = require('../lib/stats');
    const c = require('../lib/diagnostics-collectors').createCollectors({
      loadConfig: () => ({ hosters: {}, globalSettings: {}, history: [] }),
      getAllLogPaths: () => paths, support: support2, stats: stats2,
      appInfo: () => ({}), systemInfo: () => ({}), agentInfo: () => ({})
    });
    return { collectors: c };
  })();
  const alt = collectors.readLog({ name: 'debug', grep: 'error|timeout' });
  assert.equal(alt.matchedLines, 2, 'matches the ERROR and timeout lines case-insensitively');
  assert.ok(alt.content.includes('ERROR upload failed') && alt.content.includes('WARN timeout hit'));
  assert.ok(!alt.content.includes('info all good'), 'non-matching line excluded');
  const t0 = Date.now();
  const redos = collectors.readLog({ name: 'debug', grep: '(a+)+$' });
  assert.ok(Date.now() - t0 < 1000, 'catastrophic-looking grep must return promptly (literal substring, no backtracking)');
  assert.equal(redos.matchedLines, 0, '"(a+)+$" is treated as a literal substring, matching nothing here');
});

test('getQueueState flags stale=true for the persisted snapshot and counts by status', () => {
  const { collectors } = makeFixture();
  const q = collectors.getQueueState({});
  assert.equal(q.source, 'persisted');
  assert.equal(q.stale, true);
  assert.equal(q.counts.error, 1);
});

test('getQueueState (includeJobs default) pattern-scrubs an opaque token in a job error that is NOT a config secret', () => {
  const opaqueToken = ['fixture', 'opaque', 'token', '9988'].join('_');
  const config = {
    hosters: {}, hosterSettings: {},
    globalSettings: { pendingQueue: { savedAt: 1, selectedUploadHosters: [], selectedFiles: [], queueJobs: [
      { file: 'C:/b.mkv', fileName: 'b.mkv', hoster: 'streamtape', status: 'error', error: `upload rejected: token=${opaqueToken}` }
    ] } },
    history: [], rotationCursors: {}
  };
  const collectors = createCollectors({
    loadConfig: () => JSON.parse(JSON.stringify(config)),
    getAllLogPaths: () => ({ logDir: os.tmpdir() }),
    support, stats,
    appInfo: () => ({}), systemInfo: () => ({}), agentInfo: () => ({})
  });
  const q = collectors.getQueueState({});
  const json = JSON.stringify(q);
  assert.ok(!json.includes(opaqueToken), 'opaque token in a job error must be pattern-scrubbed even on the default includeJobs path');
});

test('listErrors classifies via stats.classifyErrorCategory and redacts error text', () => {
  const { collectors } = makeFixture();
  const e = collectors.listErrors({});
  assert.equal(e.total, 1, 'only the non-done result is an error');
  assert.equal(e.byCategory['file-rejected'], 1, '"Not video file format" -> file-rejected');
});

test('serverHealth assembles the one-shot hub without leaking secrets', () => {
  const { collectors } = makeFixture();
  const h = collectors.serverHealth({});
  const json = JSON.stringify(h);
  assert.ok(h.server && h.queue && h.errors && h.logs, 'hub has all sections');
  assert.ok(!json.includes(fixtureSecrets.password) && !json.includes(fixtureSecrets.diagnosticToken) && !json.includes(fixtureSecrets.webhookToken), 'no secret leaks in server_health');
});
