const LOOPBACK_HOST = '127.0.0.1';

function listenOnLoopback(server, port = 0) {
  return new Promise((resolve, reject) => {
    const handleError = error => reject(error);
    server.once('error', handleError);
    server.listen(port, LOOPBACK_HOST, () => {
      server.off('error', handleError);
      resolve(server.address());
    });
  });
}

function installLoopbackRemoteServerGuard(RemoteServer, onListening = () => {}) {
  const originalStart = RemoteServer.prototype.start;
  const guardedStart = async function (options) {
    const result = await originalStart.call(this, { ...options, host: LOOPBACK_HOST });
    const address = this._wss && this._wss.address();
    onListening(address && typeof address === 'object' ? address.address : '');
    return result;
  };
  RemoteServer.prototype.start = guardedStart;
  return () => {
    if (RemoteServer.prototype.start === guardedStart) RemoteServer.prototype.start = originalStart;
  };
}

module.exports = { listenOnLoopback, installLoopbackRemoteServerGuard };
