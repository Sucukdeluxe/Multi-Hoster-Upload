const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const support = require('../lib/support-bundle');
const stats = require('../lib/stats');
const { createCollectors } = require('../lib/diagnostics-collectors');

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mhu-diag-'));
  const fixtureAlpha = ['SECRET', 'TOKEN', '123456'].join('');
  const fixtureBeta = ['abcdef', '123456'].join('');
  const fixtureGamma = ['LIVE', 'KEY', '99999'].join('');
  const fixtureDelta = ['HUNTER', '2', 'SECRET'].join('');
  const fixtureEpsilon = ['BYSE', 'KEY', '1234567'].join('');
  const fixtureZeta = ['WBHOOK', 'SECRET', 'TOKEN'].join('');
  const paths = {
    fileuploader: path.join(dir, 'fileuploader.log'),
    uploadAudit: path.join(dir, 'upload-audit.log'),
    debug: path.join(dir, 'debug.log'),
    accountRotation: path.join(dir, 'account-rotation.log'),
    doodstreamDebug: path.join(dir, 'doodstream-debug.log'),
    crashLog: path.join(dir, 'crash.log'),
    logDir: dir
  };
  fs.writeFileSync(paths.debug, `boot ok\nsource ${path.join(dir, 'private-source.mkv')}\nuploading file with token ${fixtureAlpha} inline\nAuthorization: Bearer ${fixtureBeta}\n`);
  fs.writeFileSync(paths.uploadAudit, `# SOURCE-CLEANUP {"token":"${fixtureAlpha}"}\n`);
  fs.writeFileSync(paths.doodstreamDebug, `api_key=${fixtureGamma} sess=abc\n`);
  fs.writeFileSync(paths.crashLog, 'CRASH at 12:00\n');
  const config = {
    hosters: { 'voe.sx': [{ id: 'a1', username: 'u', password: fixtureDelta }], 'byse.sx': [{ id: 'b1', apiKey: fixtureEpsilon }] },
    hosterSettings: {},
    globalSettings: {
      webhookUrl: ['https://discord.com/api/webhooks/', '12345', fixtureZeta].join('/'),
      diagnostics: { enabled: true, port: 9110, token: fixtureAlpha, bindAddress: '127.0.0.1' },
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
  return { dir, paths, config, collectors, fixtureAlpha, fixtureDelta, fixtureEpsilon, fixtureZeta };
}

test('getConfigRedacted strips password/apiKey/token/webhookUrl and value-scrubs the token mid-string', () => {
  const { collectors, fixtureAlpha, fixtureDelta, fixtureEpsilon, fixtureZeta } = makeFixture();
  const out = collectors.getConfigRedacted({ section: 'all' });
  const json = JSON.stringify(out);
  assert.ok(!json.includes(fixtureDelta), 'password must be redacted');
  assert.ok(!json.includes(fixtureEpsilon), 'apiKey must be redacted');
  assert.ok(!json.includes(fixtureAlpha), 'diag token must be redacted');
  assert.ok(!json.includes(fixtureZeta), 'webhook secret must be redacted');
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
  const { collectors, dir, paths } = makeFixture();
  const dbg = collectors.readLog({ name: 'debug', tailKb: 64 });
  const audit = collectors.readLog({ name: 'uploadAudit', tailKb: 64 });
  assert.ok(!dbg.content.includes('SECRETTOKEN123456'), 'value-scrub removes the live diag token from logs');
  assert.ok(!/Bearer abcdef123456/.test(dbg.content), 'pattern-scrub removes Authorization Bearer');
  assert.equal(audit.name, 'uploadAudit');
  assert.ok(!audit.content.includes('SECRETTOKEN123456'), 'source cleanup audit is readable only through the redacted diagnostics path');
  assert.equal(collectors.readLog({ name: 'doodstreamDebug' }).ok, false, 'doodstream-debug.log is not in the readable allowlist');
  assert.equal(collectors.readLog({ name: '../../etc/passwd' }).ok, false, 'arbitrary names are rejected (no path traversal)');
  assert.ok(!JSON.stringify(dbg).includes(dir), 'read log content and metadata must not expose its absolute directory');
  const rejectedAbsolutePath = collectors.readLog({ name: paths.debug });
  assert.ok(!rejectedAbsolutePath.error.includes(paths.debug), 'rejected log identifiers must not be echoed as absolute paths');
  assert.ok(!rejectedAbsolutePath.error.includes(path.basename(paths.debug)), 'rejected log identifiers must not echo path components');
  assert.equal(collectors.readLog({ name: 'crash' }).name, 'crash');
});

test('rotated audit backups are listed and readable with the rotation naming convention', () => {
  const { collectors, paths, fixtureAlpha } = makeFixture();
  const backupPath = path.join(path.dirname(paths.uploadAudit), 'upload-audit.1.log');
  fs.writeFileSync(backupPath, `# SOURCE-CLEANUP {"token":"${fixtureAlpha}"}\n`);
  const logList = collectors.listLogs();
  const listed = logList.files.find(file => file.name === 'uploadAudit');
  assert.equal(logList.dir, undefined);
  assert.equal(listed.id, 'uploadAudit');
  assert.equal(listed.fileName, 'upload-audit.log');
  assert.equal(listed.path, undefined);
  assert.ok(listed.variants.some(variant => variant.backup === 1));
  assert.ok(listed.variants.every(variant => variant.fileName && !Object.hasOwn(variant, 'path')));
  assert.ok(!collectors.listLogs().otherLogs.some(file => file.name === 'upload-audit.1.log'));
  const backup = collectors.readLog({ name: 'uploadAudit', backup: 1, tailKb: 64 });
  assert.equal(backup.id, 'uploadAudit');
  assert.equal(backup.name, 'uploadAudit');
  assert.equal(backup.fileName, 'upload-audit.1.log');
  assert.equal(backup.path, undefined);
  assert.ok(!JSON.stringify({ logList, backup }).includes(path.dirname(paths.uploadAudit)));
  assert.ok(!backup.content.includes(fixtureAlpha));
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
  const config = {
    hosters: {}, hosterSettings: {},
    globalSettings: { pendingQueue: { savedAt: 1, selectedUploadHosters: [], selectedFiles: [], queueJobs: [
      { file: 'C:/b.mkv', fileName: 'b.mkv', hoster: 'streamtape', status: 'error', error: 'upload rejected: token=OPAQUE_NONconfig_TOKEN_9988' }
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
  assert.ok(!json.includes('OPAQUE_NONconfig_TOKEN_9988'), 'opaque token in a job error must be pattern-scrubbed even on the default includeJobs path');
});

test('listErrors classifies via stats.classifyErrorCategory and redacts error text', () => {
  const { collectors } = makeFixture();
  const e = collectors.listErrors({});
  assert.equal(e.total, 1, 'only the non-done result is an error');
  assert.equal(e.byCategory['file-rejected'], 1, '"Not video file format" -> file-rejected');
});

test('serverHealth assembles the one-shot hub without leaking secrets', () => {
  const { collectors, dir, paths } = makeFixture();
  const h = collectors.serverHealth({});
  const json = JSON.stringify(h);
  assert.ok(h.server && h.queue && h.errors && h.logs, 'hub has all sections');
  assert.ok(!json.includes('HUNTER2SECRET') && !json.includes('SECRETTOKEN123456') && !json.includes('WBHOOKSECRETTOKEN'), 'no secret leaks in server_health');
  assert.ok(!json.includes(dir) && !json.includes(paths.debug), 'server_health must not expose absolute log paths');
});

test('redactResponse scrubs configured secrets and absolute paths from arbitrary nested output', () => {
  const { collectors, fixtureAlpha } = makeFixture();
  const value = {
    error: `token ${fixtureAlpha} at C:\\Users\\PrivateProfile\\secret.log`,
    nested: [{ source: '\\\\?\\UNC\\private-server\\secret-share\\secret.log' }]
  };
  const out = collectors.redactResponse(value);
  const json = JSON.stringify(out);
  assert.ok(!json.includes(fixtureAlpha));
  assert.ok(!json.includes('PrivateProfile'));
  assert.ok(!json.includes('private-server'));
  assert.match(json, /<redacted>/);
  assert.match(json, /<redacted-path>/);
});
