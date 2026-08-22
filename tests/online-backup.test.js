const http = require('node:http');
const { once } = require('node:events');
const { afterEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');

const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

function settings() {
  return {
    hosters: {
      'doodstream.com': [{ id: 'account-1', authType: 'api', apiKey: 'secret-api-key', enabled: true }]
    },
    hosterSettings: {
      'doodstream.com': { retries: 3, parallelCount: 5 }
    },
    globalSettings: {
      alwaysOnTop: true,
      webhookUrl: 'https://example.invalid/private-webhook'
    },
    history: []
  };
}

describe('online backup key', () => {
  it('creates a unique 75-character MHU key and restores every snapshot independently', () => {
    const { createOnlineBackup, restoreOnlineBackup } = require('../lib/online-backup');
    const first = createOnlineBackup(settings(), '2.0.3', '2026-08-09T00:00:00.000Z');
    const secondSettings = settings();
    secondSettings.globalSettings.alwaysOnTop = false;
    const second = createOnlineBackup(secondSettings, '2.0.3', '2026-08-09T00:01:00.000Z');

    assert.match(first.key, /^MHU2-[A-Za-z0-9_-]{70}$/);
    assert.equal(first.key.length, 75);
    assert.notEqual(second.key, first.key);
    assert.deepEqual(restoreOnlineBackup(first.key, first.record.blob).settings, settings());
    assert.equal(restoreOnlineBackup(second.key, second.record.blob).settings.globalSettings.alwaysOnTop, false);
  });

  it('never places credentials or the decryption secret in the server record', () => {
    const { createOnlineBackup, parseOnlineBackupKey } = require('../lib/online-backup');
    const created = createOnlineBackup(settings(), '2.0.3');
    const serialized = JSON.stringify(created.record);
    const parsed = parseOnlineBackupKey(created.key);

    assert.equal(serialized.includes('secret-api-key'), false);
    assert.equal(serialized.includes('private-webhook'), false);
    assert.equal(serialized.includes(parsed.masterKey.toString('base64url')), false);
    assert.deepEqual(Object.keys(created.record).sort(), ['blob', 'deleteVerifier', 'id']);
  });

  it('rejects corrupted keys, ciphertext and oversized settings', () => {
    const { createOnlineBackup, parseOnlineBackupKey, restoreOnlineBackup } = require('../lib/online-backup');
    const created = createOnlineBackup(settings(), '2.0.3');
    const keyTail = created.key.endsWith('A') ? 'B' : 'A';
    const blobTail = created.record.blob.endsWith('A') ? 'B' : 'A';

    assert.throws(() => parseOnlineBackupKey(`${created.key.slice(0, -1)}${keyTail}`), /Schlüssel/i);
    assert.throws(() => restoreOnlineBackup(created.key, `${created.record.blob.slice(0, -1)}${blobTail}`), /entschlüsselt|beschädigt/i);
    assert.throws(() => createOnlineBackup({ huge: 'x'.repeat(600_000) }, '2.0.3'), /zu groß/i);
  });
});

describe('online backup transport', () => {
  it('uses only POST bodies and never sends the master key or record id in URLs', async () => {
    const {
      createOnlineBackup,
      deleteOnlineBackup,
      downloadOnlineBackup,
      parseOnlineBackupKey,
      uploadOnlineBackup
    } = require('../lib/online-backup');
    let stored = null;
    let deleteRequest = null;
    const requestedUrls = [];
    const server = http.createServer(async (request, response) => {
      requestedUrls.push(String(request.url || ''));
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      if (request.method === 'POST' && request.url === '/v1/backups') {
        stored = body;
        response.writeHead(201, { 'content-type': 'application/json' });
        response.end('{"created":true}');
        return;
      }
      if (request.method === 'POST' && request.url === '/v1/backups/restore' && stored) {
        assert.equal(body.id, stored.id);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ blob: stored.blob }));
        return;
      }
      if (request.method === 'POST' && request.url === '/v1/backups/delete' && stored) {
        deleteRequest = body;
        response.writeHead(204);
        response.end();
        return;
      }
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{"error":"not_found"}');
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const created = createOnlineBackup(settings(), '2.0.3');

    await uploadOnlineBackup(created.record, baseUrl);
    const restored = await downloadOnlineBackup(created.key, baseUrl);
    assert.deepEqual(await deleteOnlineBackup(created.key, baseUrl), { deleted: true, notFound: false });

    assert.deepEqual(restored.settings, settings());
    assert.equal(JSON.stringify(stored).includes(parseOnlineBackupKey(created.key).masterKey.toString('base64url')), false);
    assert.match(deleteRequest.deleteSecret, /^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(requestedUrls, ['/v1/backups', '/v1/backups/restore', '/v1/backups/delete']);
    assert.equal(requestedUrls.join(' ').includes(stored.id), false);
  });

  it('returns an idempotent outcome when the backup is already missing', async () => {
    const { createOnlineBackup, deleteOnlineBackup } = require('../lib/online-backup');
    const server = http.createServer((_request, response) => {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{"error":"not_found"}');
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const missingBaseUrl = `http://127.0.0.1:${server.address().port}`;
    const { key } = createOnlineBackup(settings(), '2.0.3');

    assert.deepEqual(await deleteOnlineBackup(key, missingBaseUrl), { deleted: false, notFound: true });
  });

  it('uses the generic deletion error without reflecting the server response body', async () => {
    const { createOnlineBackup, deleteOnlineBackup } = require('../lib/online-backup');
    const server = http.createServer((_request, response) => {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end('{"leaked":"server-secret-value"}');
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const { key } = createOnlineBackup(settings(), '2.0.3');

    await assert.rejects(
      deleteOnlineBackup(key, baseUrl),
      (error) => error.message === 'Online-Sicherung konnte nicht gelöscht werden'
        && !error.message.includes('server-secret-value')
    );
  });

  it('does not reflect server response bodies into client errors', async () => {
    const { createOnlineBackup, uploadOnlineBackup } = require('../lib/online-backup');
    const server = http.createServer((_request, response) => {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end('{"leaked":"server-secret-value"}');
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const created = createOnlineBackup(settings(), '2.0.3');

    await assert.rejects(
      uploadOnlineBackup(created.record, `http://127.0.0.1:${server.address().port}`),
      (error) => !String(error.message).includes('server-secret-value')
    );
  });

  it('keeps the timeout active until the response body is fully read', async () => {
    const { createOnlineBackup, downloadOnlineBackup } = require('../lib/online-backup');
    const created = createOnlineBackup(settings(), '2.0.3');
    const fetchImpl = async (_url, options) => ({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: {
        getReader: () => ({
          read: () => new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          }),
          cancel: async () => {}
        })
      }
    });

    const outcome = await Promise.race([
      assert.rejects(
        downloadOnlineBackup(created.key, 'http://127.0.0.1:8788', { fetchImpl, timeoutMs: 20 }),
        /antwortet nicht/i
      ).then(() => 'timed-out'),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 120))
    ]);

    assert.equal(outcome, 'timed-out');
  });
});
