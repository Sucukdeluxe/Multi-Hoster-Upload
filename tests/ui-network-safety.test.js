const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const RemoteServer = require('../lib/remote-server');

let networkSafety = {};
try {
  networkSafety = require('./support/ui-network-safety');
} catch {}

test('Electron UI test listeners bind only to loopback', async () => {
  assert.equal(typeof networkSafety.listenOnLoopback, 'function');

  const server = net.createServer();
  try {
    await networkSafety.listenOnLoopback(server);
    const address = server.address();
    assert.equal(address.address, '127.0.0.1');
    assert.ok(address.port > 0);
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
});

test('Electron UI remote server guard keeps the real server on loopback', async () => {
  assert.equal(typeof networkSafety.installLoopbackRemoteServerGuard, 'function');

  const observedAddresses = [];
  const restore = networkSafety.installLoopbackRemoteServerGuard(RemoteServer, address => observedAddresses.push(address));
  const server = new RemoteServer();

  try {
    await server.start({
      port: 0,
      token: 'ui-network-safety-token',
      allowInput: true,
      onSignalingToCapture: () => {},
      onCreateCaptureWindow: () => {},
      onDestroyCaptureWindow: () => {}
    });
    assert.equal(server._wss.address().address, '127.0.0.1');
    assert.deepEqual(observedAddresses, ['127.0.0.1']);
  } finally {
    server.stop();
    restore();
  }
});
