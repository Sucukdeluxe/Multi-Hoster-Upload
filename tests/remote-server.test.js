const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Test the module can be required and has the expected API
describe('RemoteServer', () => {
  it('should export a class with start/stop methods', () => {
    const RemoteServer = require('../lib/remote-server');
    assert.strictEqual(typeof RemoteServer, 'function');
    assert.strictEqual(typeof RemoteServer.prototype.start, 'function');
    assert.strictEqual(typeof RemoteServer.prototype.stop, 'function');
    assert.strictEqual(typeof RemoteServer.prototype.getClientCount, 'function');
  });

  it('should start and stop without errors', async () => {
    const RemoteServer = require('../lib/remote-server');
    const server = new RemoteServer();

    // Mock mainWindow
    const mockMainWindow = {
      isDestroyed: () => false,
      getTitle: () => 'Test Window',
      getContentBounds: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
      webContents: {
        sendInputEvent: () => {}
      }
    };

    await server.start({
      port: 0, // random available port
      host: '127.0.0.1',
      token: 'test-token-123',
      allowInput: true,
      mainWindow: mockMainWindow,
      onSignalingToCapture: () => {},
      onCreateCaptureWindow: () => {},
      onDestroyCaptureWindow: () => {}
    });

    assert.strictEqual(server.getClientCount(), 0);
    server.stop();
  });

  it('binds to loopback when no host is supplied', async () => {
    const RemoteServer = require('../lib/remote-server');
    const server = new RemoteServer();
    try {
      await server.start({
        port: 0,
        token: 'test-token-123',
        onSignalingToCapture: () => {},
        onCreateCaptureWindow: () => {},
        onDestroyCaptureWindow: () => {}
      });
      assert.strictEqual(server._wss.address().address, '127.0.0.1');
    } finally {
      server.stop();
    }
  });

  it('keeps the application remote-control listener on loopback', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const start = source.indexOf('async function startRemoteServer()');
    const end = source.indexOf("ipcMain.on('remote:signaling-from-capture'", start);
    assert.notStrictEqual(start, -1);
    assert.notStrictEqual(end, -1);
    assert.match(source.slice(start, end), /host:\s*'127\.0\.0\.1'/);
  });
});
