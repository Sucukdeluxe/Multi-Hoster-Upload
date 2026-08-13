const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

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
});
