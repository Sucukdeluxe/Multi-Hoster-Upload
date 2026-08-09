const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { after, before, describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  createOnlineBackup,
  deleteOnlineBackup,
  downloadOnlineBackup,
  uploadOnlineBackup
} = require('../lib/online-backup');

let rootDir;
let server;
let baseUrl;

before(async () => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mhu-backup-contract-'));
  const moduleUrl = pathToFileURL(path.join(__dirname, '..', 'services', 'backup-api', 'src', 'server.mjs')).href;
  const { createBackupServer } = await import(moduleUrl);
  server = createBackupServer({ rootDir });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (rootDir) fs.rmSync(rootDir, { recursive: true, force: true });
});

describe('online backup client and service contract', () => {
  it('keeps older keys valid and stores ciphertext only', async () => {
    const firstSettings = {
      hosters: { 'byse.sx': [{ id: 'first', apiKey: 'first-secret' }] },
      hosterSettings: { 'byse.sx': { retries: 3 } },
      globalSettings: { alwaysOnTop: false },
      history: []
    };
    const secondSettings = {
      hosters: { 'byse.sx': [{ id: 'second', apiKey: 'second-secret' }] },
      hosterSettings: { 'byse.sx': { retries: 7 } },
      globalSettings: { alwaysOnTop: true },
      history: []
    };
    const first = createOnlineBackup(firstSettings, '2.0.3');
    const second = createOnlineBackup(secondSettings, '2.0.3');

    await uploadOnlineBackup(first.record, baseUrl);
    await uploadOnlineBackup(second.record, baseUrl);

    assert.deepEqual((await downloadOnlineBackup(first.key, baseUrl)).settings, firstSettings);
    assert.deepEqual((await downloadOnlineBackup(second.key, baseUrl)).settings, secondSettings);
    const stored = fs.readdirSync(rootDir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => fs.readFileSync(path.join(rootDir, name), 'utf8'))
      .join('\n');
    assert.equal(stored.includes('first-secret'), false);
    assert.equal(stored.includes('second-secret'), false);
    assert.equal(stored.includes(first.key), false);
    assert.equal(stored.includes(second.key), false);

    await deleteOnlineBackup(first.key, baseUrl);
    await assert.rejects(downloadOnlineBackup(first.key, baseUrl), /nicht gefunden/i);
    assert.deepEqual((await downloadOnlineBackup(second.key, baseUrl)).settings, secondSettings);
    await deleteOnlineBackup(second.key, baseUrl);
  });
});
