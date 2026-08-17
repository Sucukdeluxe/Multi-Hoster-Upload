const { test } = require('node:test');
const assert = require('node:assert');
const { createAgent } = require('../lib/diagnostics-agent');

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

test('agent surfaces a collector ok:false verbatim and never throws', () => {
  const agent = createAgent({ readLog: () => ({ ok: false, error: 'unknown or non-readable log: x' }), getSystemInfo: () => { throw new Error('boom'); } });
  assert.equal(agent.handle('read_log', { name: 'x' }).ok, false);
  const thrown = agent.handle('get_system_info', {});
  assert.equal(thrown.ok, false);
  assert.match(thrown.error, /boom/);
});
