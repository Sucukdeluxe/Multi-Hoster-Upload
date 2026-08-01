const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const WebSocket = require('ws');
const RemoteServer = require('../lib/remote-server');

const TOKEN = 'a'.repeat(64);

function firstLanIpv4() {
  for (const entry of Object.values(os.networkInterfaces())) {
    for (const net of (entry || [])) {
      if (net && net.family === 'IPv4' && !net.internal && net.address) return net.address;
    }
  }
  return null;
}

function startAgent(onDiagnosticRequest, extra) {
  const srv = new RemoteServer();
  return srv.start({ port: 0, host: '127.0.0.1', token: TOKEN, diagnosticMode: true, onDiagnosticRequest, ...(extra || {}) })
    .then(() => srv);
}

function connect(port) {
  return new WebSocket(`ws://127.0.0.1:${port}`);
}

function once(ws, type) {
  return new Promise((resolve, reject) => {
    ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.type === type) resolve(m); });
    ws.on('close', (code) => reject(new Error('closed ' + code)));
    ws.on('error', reject);
  });
}

test('diagnostic client: auth -> diag-request -> reqId-correlated diag-response', async () => {
  const agent = await startAgent((msg, _client, reply) => {
    assert.equal(msg.op, 'server_health');
    reply({ ok: true, data: { hello: 'world', echo: msg.args } });
  });
  const port = agent.getPort();
  const ws = connect(port);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'auth', token: TOKEN, role: 'diagnostic' }));
  const ok = await once(ws, 'auth-ok');
  assert.ok(ok.clientId);
  ws.send(JSON.stringify({ type: 'diag-request', reqId: 'r1', op: 'server_health', args: { errorLimit: 3 } }));
  const resp = await once(ws, 'diag-response');
  assert.equal(resp.reqId, 'r1');
  assert.equal(resp.ok, true);
  assert.equal(resp.data.hello, 'world');
  assert.equal(resp.data.echo.errorLimit, 3);
  assert.equal(agent.getLastAccess() !== null, true, 'access timestamp recorded');
  ws.close(); agent.stop();
});

test('a diagnostic client NEVER triggers the screen-capture window', async () => {
  let captureCreated = false;
  const agent = await startAgent(() => {}, { onCreateCaptureWindow: () => { captureCreated = true; } });
  const ws = connect(agent.getPort());
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'auth', token: TOKEN, role: 'diagnostic' }));
  await once(ws, 'auth-ok');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(captureCreated, false, 'diagnosticMode must not spawn the capture window');
  ws.close(); agent.stop();
});

test('allowlist gate (wiring): a non-loopback peer is closed 4005 when not allowlisted (fail-closed)', () => {
  const srv = new RemoteServer();
  const closeCodeFor = (remoteAddress, allowlist) => {
    srv._config = { allowlist, token: TOKEN, diagnosticMode: true };
    let closed = null;
    srv._handleConnection({ close: (c) => { closed = c; }, on: () => {} }, { socket: { remoteAddress } });
    return closed;
  };
  assert.equal(closeCodeFor('100.64.0.9', []), 4005, 'empty allowlist => non-loopback rejected (fail-closed)');
  assert.equal(closeCodeFor('203.0.113.5', ['100.64.0.0/10']), 4005, 'peer outside the allowlist CIDR rejected');
});

test('a loopback diagnostic client connects even with a non-matching allowlist (loopback is always allowed)', async () => {
  const agent = await startAgent(() => {}, { allowlist: ['100.64.0.0/10'] });
  const ws = connect(agent.getPort());
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'auth', token: TOKEN, role: 'diagnostic' }));
  const ok = await once(ws, 'auth-ok');
  assert.ok(ok.clientId);
  ws.close(); agent.stop();
});

test('network bind (0.0.0.0): an allowlisted non-loopback peer connects over a real socket (the Tailscale path)', async (t) => {
  const lan = firstLanIpv4();
  if (!lan) { t.skip('no non-internal IPv4 interface available'); return; }
  const agent = await startAgent(() => {}, { host: '0.0.0.0', allowlist: [lan] });
  const port = agent.getPort();
  const ws = new WebSocket(`ws://${lan}:${port}`);
  try {
    await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
    ws.send(JSON.stringify({ type: 'auth', token: TOKEN, role: 'diagnostic' }));
    const ok = await once(ws, 'auth-ok');
    assert.ok(ok.clientId, 'allowlisted LAN peer authed over the 0.0.0.0 bind');
  } finally {
    ws.close(); agent.stop();
  }
});

test('wrong token is rejected and the ip is locked out after 5 attempts', async () => {
  const agent = await startAgent(() => {});
  const port = agent.getPort();
  for (let i = 0; i < 5; i++) {
    const ws = connect(port);
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'auth', token: 'wrong', role: 'diagnostic' }));
    await new Promise((r) => ws.on('close', r));
  }
  const ws = connect(port);
  const closeCode = await new Promise((resolve) => ws.on('close', (c) => resolve(c)));
  assert.equal(closeCode, 4003, 'locked out after 5 failed attempts');
  agent.stop();
});
