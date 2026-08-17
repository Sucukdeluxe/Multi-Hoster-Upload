const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const { evaluateClientAllowed } = require('./ip-allowlist');

function timingSafeEqualStr(a, b) {
  const x = Buffer.from(String(a === null || a === undefined ? '' : a));
  const y = Buffer.from(String(b === null || b === undefined ? '' : b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

class RemoteServer {
  constructor() {
    this._wss = null;
    this._clients = new Map(); // ws -> { id, role, authenticated }
    this._config = null;
    this._failedAttempts = new Map(); // ip -> { count, blockedUntil }
    this._lastAccess = null;
  }

  start(opts) {
    return new Promise((resolve, reject) => {
      this._config = opts;

      const wssOpts = { port: opts.port, maxPayload: 256 * 1024 };
      if (opts.host) wssOpts.host = opts.host;
      this._wss = new WebSocketServer(wssOpts, () => {
        resolve();
      });

      this._wss.on('error', (err) => {
        reject(err);
      });

      this._wss.on('connection', (ws, req) => {
        this._handleConnection(ws, req);
      });
    });
  }

  stop() {
    if (this._wss) {
      for (const [ws] of this._clients) {
        ws.close(1000, 'Server shutting down');
      }
      this._clients.clear();
      this._wss.close();
      this._wss = null;
    }
  }

  getClientCount() {
    let count = 0;
    for (const [, client] of this._clients) {
      if (client.authenticated) count++;
    }
    return count;
  }

  getPort() {
    if (this._wss && this._wss.address()) {
      return this._wss.address().port;
    }
    return null;
  }

  _handleConnection(ws, req) {
    const ip = req.socket.remoteAddress || 'unknown';

    if (this._isBlocked(ip)) {
      ws.close(4003, 'Too many failed attempts');
      return;
    }

    if (Array.isArray(this._config.allowlist) && !evaluateClientAllowed(ip, this._config.allowlist)) {
      ws.close(4005, 'Client IP not allowed');
      return;
    }

    const clientId = crypto.randomUUID();
    this._clients.set(ws, { id: clientId, role: null, authenticated: false });

    let authReceived = false;
    const authTimeout = setTimeout(() => {
      if (!authReceived) {
        ws.close(4001, 'Auth timeout');
        this._clients.delete(ws);
      }
    }, 5000);

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      const client = this._clients.get(ws);
      if (!client) return;

      if (!client.authenticated) {
        authReceived = true;
        clearTimeout(authTimeout);

        if (msg.type === 'auth' && timingSafeEqualStr(msg.token, this._config.token)) {
          client.authenticated = true;
          client.role = this._config.diagnosticMode ? 'diagnostic' : (msg.role || 'viewer');
          this._lastAccess = Date.now();
          ws.send(JSON.stringify({ type: 'auth-ok', clientId }));

          if (!this._config.diagnosticMode && this.getClientCount() === 1) {
            this._config.onCreateCaptureWindow();
          }
        } else {
          this._recordFailedAttempt(ip);
          ws.close(4002, 'Invalid token');
          this._clients.delete(ws);
        }
        return;
      }

      if (this._config.diagnosticMode) {
        if (msg.type === 'diag-request' && typeof this._config.onDiagnosticRequest === 'function') {
          this._lastAccess = Date.now();
          this._config.onDiagnosticRequest(msg, client, (payload) => {
            this.sendToClient(client.id, { type: 'diag-response', reqId: msg.reqId, ...payload });
          });
        }
        return;
      }

      if (msg.type === 'offer' || msg.type === 'ice-candidate') {
        msg.clientId = client.id;
        msg.role = client.role;
        this._config.onSignalingToCapture(msg);
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimeout);
      const client = this._clients.get(ws);
      const wasAuthenticated = client && client.authenticated;
      this._clients.delete(ws);

      if (wasAuthenticated && !this._config.diagnosticMode) {
        this._config.onSignalingToCapture({
          type: 'client-disconnected',
          clientId: client.id
        });

        if (this.getClientCount() === 0) {
          this._config.onDestroyCaptureWindow();
        }
      }
    });

    ws.on('error', () => {
      clearTimeout(authTimeout);
      const client = this._clients.get(ws);
      const wasAuthenticated = client && client.authenticated;
      this._clients.delete(ws);

      if (wasAuthenticated && !this._config.diagnosticMode) {
        this._config.onSignalingToCapture({
          type: 'client-disconnected',
          clientId: client.id
        });
        if (this.getClientCount() === 0) {
          this._config.onDestroyCaptureWindow();
        }
      }
    });
  }

  getLastAccess() {
    return this._lastAccess;
  }

  sendToClient(clientId, data) {
    for (const [ws, client] of this._clients) {
      if (client.id === clientId && client.authenticated) {
        if (ws.readyState === 1) {
          try { ws.send(JSON.stringify(data)); } catch {}
        }
        break;
      }
    }
  }

  broadcast(data) {
    const msg = JSON.stringify(data);
    for (const [ws, client] of this._clients) {
      if (client.authenticated && ws.readyState === 1) {
        ws.send(msg);
      }
    }
  }

  _isBlocked(ip) {
    const entry = this._failedAttempts.get(ip);
    if (!entry) return false;
    if (entry.blockedUntil && Date.now() < entry.blockedUntil) return true;
    if (entry.blockedUntil && Date.now() >= entry.blockedUntil) {
      this._failedAttempts.delete(ip);
      return false;
    }
    return false;
  }

  _recordFailedAttempt(ip) {
    const entry = this._failedAttempts.get(ip) || { count: 0, blockedUntil: null };
    entry.count++;
    if (entry.count >= 5) {
      entry.blockedUntil = Date.now() + 60000;
    }
    this._failedAttempts.set(ip, entry);
  }
}

module.exports = RemoteServer;
