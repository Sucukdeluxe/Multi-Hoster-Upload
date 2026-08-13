const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createAgent } = require('../lib/diagnostics-agent');
const { valueScrub } = require('../lib/support-bundle');

function stubCollectors() {
  const calls = [];
  const mk = (name) => (a) => { calls.push([name, a]); return { name, a }; };
  return {
    calls,
    getSystemInfo: mk('getSystemInfo'),
    serverHealth: mk('serverHealth'),
    getConfigRedacted: mk('getConfigRedacted'),
    listLogs: mk('listLogs'),
    readLog: mk('readLog'),
    getAppEvents: mk('getAppEvents'),
    listErrors: mk('listErrors'),
    getQueueState: mk('getQueueState'),
    getHistory: mk('getHistory'),
    getRotationState: mk('getRotationState'),
    getHealth: mk('getHealth')
  };
}

test('agent rejects unknown ops and any write/exec-shaped op', () => {
  const agent = createAgent(stubCollectors());
  for (const bad of ['delete_log', 'write_config', 'run_health_check', 'exec', 'eval', '__proto__', 'set_setting', 'restart']) {
    const r = agent.handle(bad, {});
    assert.equal(r.ok, false, `${bad} must be rejected`);
    assert.match(r.error, /unknown or non-readonly/);
  }
  const pathShaped = agent.handle('C:\\Users\\PrivateProfile\\operation', {});
  assert.ok(!pathShaped.error.includes('PrivateProfile'));
  assert.match(pathShaped.error, /<redacted-path>/);
});

test('agent rejects inherited Object.prototype members (no whitelist bypass via the prototype chain)', () => {
  const agent = createAgent(stubCollectors());
  for (const proto of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'toLocaleString']) {
    const r = agent.handle(proto, {});
    assert.equal(r.ok, false, `${proto} (inherited) must NOT be treated as an op`);
  }
  for (const bad of [null, undefined, 42, {}, ['read_log']]) {
    assert.equal(agent.handle(bad, {}).ok, false, `non-string op ${JSON.stringify(bad)} must be rejected`);
  }
});

test('agent maps each whitelisted op to its collector and is read-only only', () => {
  const stub = stubCollectors();
  const agent = createAgent(stub);
  assert.equal(agent.handle('server_health', { errorLimit: 5 }).ok, true);
  assert.equal(agent.handle('read_log', { name: 'debug' }).ok, true);
  assert.equal(agent.handle('tail_log', { name: 'debug' }).ok, true, 'tail_log aliases read_log');
  assert.equal(agent.handle('get_config_redacted', {}).ok, true);
  const ops = new Set(agent.ops);
  assert.ok(!ops.has('run_health_check'), 'no live probe op in this build');
  for (const op of agent.ops) assert.ok(!/write|delete|set_|exec|restart|cancel|retry/.test(op), `${op} must be read-only`);
});

test('agent redacts collector failures and thrown errors at the response boundary', () => {
  const drivePath = 'C:\\Users\\PrivateProfile\\secret.log';
  const uncPath = '\\\\?\\UNC\\private-server\\secret-share\\secret.log';
  const agent = createAgent({
    readLog: () => ({ ok: false, error: `cannot read ${drivePath}` }),
    getSystemInfo: () => { throw new Error(`boom at ${uncPath}`); }
  });
  assert.equal(agent.handle('read_log', { name: 'x' }).ok, false);
  assert.ok(!JSON.stringify(agent.handle('read_log', { name: 'x' })).includes('PrivateProfile'));
  const thrown = agent.handle('get_system_info', {});
  assert.equal(thrown.ok, false);
  assert.match(thrown.error, /boom/);
  assert.ok(!thrown.error.includes('private-server'));
  assert.match(thrown.error, /<redacted-path>/);
});

test('agent redacts every successful response with configured secrets at the boundary', () => {
  const secret = 'configured-secret-123';
  const slashUnc = '//private-server/secret-share/secret.log';
  const collectors = stubCollectors();
  collectors.getSystemInfo = () => ({ nested: { message: `token ${secret}`, path: slashUnc } });
  collectors.redactResponse = value => valueScrub(value, [secret]);
  const result = createAgent(collectors).handle('get_system_info', {});
  const json = JSON.stringify(result);
  assert.equal(result.ok, true);
  assert.ok(!json.includes(secret));
  assert.ok(!json.includes('private-server'));
  assert.match(json, /<redacted>/);
  assert.match(json, /<redacted-path>/);
});

test('agent fails closed when response redaction fails', () => {
  const agent = createAgent({
    getSystemInfo: () => ({ token: 'must-not-leak' }),
    redactResponse: () => { throw new Error('redactor unavailable'); }
  });
  const result = agent.handle('get_system_info', {});
  assert.deepEqual(result, { ok: false, error: 'diagnostic response could not be safely returned' });
  assert.ok(!JSON.stringify(result).includes('must-not-leak'));
});

test('main process keeps diagnostics local and fails closed at its final reply boundary', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(source, /function _diagBindHost\(\)\s*{\s*return '127\.0\.0\.1'/);
  assert.match(source, /function _diagPublicHost\(\)\s*{\s*return '127\.0\.0\.1'/);
  assert.match(source, /function _diagAllowlist\(\)\s*{\s*return \[\]/);
  assert.match(source, /bindMode: 'local'/);
  assert.match(source, /catch\s*{\s*result = { ok: false, error: 'diagnostic response could not be safely returned' }/);
});
