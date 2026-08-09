import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection } from 'node:net'
import test from 'node:test'
import lockfile from 'proper-lockfile'
import { createBackupServer } from '../src/server.mjs'

const allowedOrigin = 'https://uploader.24-music.de'

function fixture() {
  const deleteSecret = randomBytes(32).toString('base64url')
  return {
    deleteSecret,
    payload: {
      id: randomBytes(16).toString('base64url'),
      blob: randomBytes(96).toString('base64url'),
      deleteVerifier: createHash('sha256').update(Buffer.from(deleteSecret, 'base64url')).digest('base64url')
    }
  }
}

async function startApi(options = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), 'mhu-backup-api-'))
  const server = createBackupServer({
    rootDir,
    allowedOrigins: [allowedOrigin],
    rateLimit: { max: 100, windowMs: 60_000 },
    ...options
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    rootDir,
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    async close() {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      await rm(rootDir, { recursive: true, force: true })
    }
  }
}

function request(api, path, options = {}) {
  return fetch(`${api.baseUrl}${path}`, options)
}

test('health reports readiness without storage details and sends security headers', async (t) => {
  const api = await startApi()
  t.after(() => api.close())

  const response = await request(api, '/health')

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { status: 'ok' })
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(response.headers.get('content-security-policy'), "default-src 'none'")
})

test('creates immutable ciphertext records and restores them after a restart', async (t) => {
  const api = await startApi()
  const backup = fixture()
  t.after(async () => {
    if (api.server.listening) await new Promise((resolve) => api.server.close(resolve))
    await rm(api.rootDir, { recursive: true, force: true })
  })

  const created = await request(api, '/v1/backups', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(backup.payload)
  })
  assert.equal(created.status, 201)
  await new Promise((resolve) => api.server.close(resolve))

  api.server = createBackupServer({ rootDir: api.rootDir, allowedOrigins: [allowedOrigin] })
  await new Promise((resolve, reject) => {
    api.server.once('error', reject)
    api.server.listen(0, '127.0.0.1', resolve)
  })
  api.baseUrl = `http://127.0.0.1:${api.server.address().port}`

  const restored = await request(api, '/v1/backups/restore', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: backup.payload.id })
  })
  assert.equal(restored.status, 200)
  assert.deepEqual(await restored.json(), { blob: backup.payload.blob })

  const duplicate = await request(api, '/v1/backups', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...backup.payload, blob: randomBytes(96).toString('base64url') })
  })
  assert.equal(duplicate.status, 409)
})

test('validates payload shape, content type and decoded blob size', async (t) => {
  const api = await startApi()
  t.after(() => api.close())
  const valid = fixture()
  const invalid = [
    { ...valid.payload, id: 'short' },
    { ...valid.payload, blob: 'not+base64url' },
    { ...valid.payload, deleteVerifier: 'short' },
    { id: valid.payload.id, blob: valid.payload.blob },
    { ...valid.payload, extra: true }
  ]

  for (const body of invalid) {
    const response = await request(api, '/v1/backups', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
    assert.equal(response.status, 400)
  }

  const wrongType = await request(api, '/v1/backups', {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify(valid.payload)
  })
  assert.equal(wrongType.status, 415)

  const oversized = fixture()
  oversized.payload.blob = randomBytes(262_145).toString('base64url')
  const tooLarge = await request(api, '/v1/backups', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(oversized.payload)
  })
  assert.equal(tooLarge.status, 413)
})

test('deletes only with the matching client secret and returns constant not-found responses', async (t) => {
  const api = await startApi()
  t.after(() => api.close())
  const backup = fixture()
  await request(api, '/v1/backups', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(backup.payload)
  })

  const missing = await request(api, '/v1/backups/restore', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: randomBytes(16).toString('base64url') })
  })
  const wrong = await request(api, '/v1/backups/delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: backup.payload.id, deleteSecret: randomBytes(32).toString('base64url') })
  })
  assert.equal(missing.status, 404)
  assert.equal(wrong.status, 404)
  assert.equal(await missing.text(), await wrong.text())

  const deleted = await request(api, '/v1/backups/delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: backup.payload.id, deleteSecret: backup.deleteSecret })
  })
  assert.equal(deleted.status, 204)
  assert.equal((await readdir(api.rootDir)).length, 0)
})

test('allows only configured origins and supports preflight', async (t) => {
  const api = await startApi()
  t.after(() => api.close())

  const allowed = await request(api, '/health', { headers: { origin: allowedOrigin } })
  assert.equal(allowed.headers.get('access-control-allow-origin'), allowedOrigin)
  const denied = await request(api, '/health', { headers: { origin: 'https://attacker.example' } })
  assert.equal(denied.status, 403)
  const preflight = await request(api, '/v1/backups', {
    method: 'OPTIONS',
    headers: {
      origin: allowedOrigin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type'
    }
  })
  assert.equal(preflight.status, 204)
})

test('separately rate limits uploads while restores and health remain available', async (t) => {
  const api = await startApi({ uploadRateLimit: { max: 1, windowMs: 60_000 } })
  t.after(() => api.close())
  const first = fixture()
  const second = fixture()
  const create = (backup) => request(api, '/v1/backups', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(backup.payload)
  })

  assert.equal((await create(first)).status, 201)
  assert.equal((await create(second)).status, 429)
  const restored = await request(api, '/v1/backups/restore', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: first.payload.id })
  })
  assert.equal(restored.status, 200)
  assert.equal((await request(api, '/health')).status, 200)
})

test('rate limits invalid request bodies before validation', async (t) => {
  const api = await startApi({ requestRateLimit: { max: 1, windowMs: 60_000 } })
  t.after(() => api.close())
  const sendInvalid = () => request(api, '/v1/backups', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ invalid: 'x'.repeat(300_000) })
  })

  assert.equal((await sendInvalid()).status, 400)
  assert.equal((await sendInvalid()).status, 429)
})

test('ignores forwarded client addresses from untrusted socket peers', async (t) => {
  const api = await startApi({
    trustedProxy: true,
    trustedProxyAddresses: [],
    rateLimit: { max: 1, windowMs: 60_000 }
  })
  t.after(() => api.close())
  const body = JSON.stringify({ id: randomBytes(16).toString('base64url') })
  const restore = (forwarded) => request(api, '/v1/backups/restore', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': forwarded },
    body
  })

  assert.equal((await restore('198.51.100.1')).status, 404)
  assert.equal((await restore('198.51.100.2')).status, 429)
  const created = await request(api, '/v1/backups', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.3' },
    body: JSON.stringify(fixture().payload)
  })
  assert.equal(created.status, 201)
})

test('uses the last forwarded address from an explicitly trusted proxy', async (t) => {
  const api = await startApi({
    trustedProxy: true,
    trustedProxyAddresses: ['127.0.0.1'],
    rateLimit: { max: 1, windowMs: 60_000 }
  })
  t.after(() => api.close())
  const body = JSON.stringify({ id: randomBytes(16).toString('base64url') })
  const restore = (forwarded) => request(api, '/v1/backups/restore', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': forwarded },
    body
  })

  assert.equal((await restore('198.51.100.1, 203.0.113.9')).status, 404)
  assert.equal((await restore('198.51.100.2, 203.0.113.9')).status, 429)
})

test('keeps concurrency leases until storage mutations finish', async (t) => {
  const api = await startApi({ maxConcurrentPerClient: 1, maxConcurrentTotal: 1 })
  t.after(() => api.close())
  const release = await lockfile.lock(api.rootDir, {
    realpath: false,
    lockfilePath: join(api.rootDir, '.storage.lock')
  })
  const create = (backup) => request(api, '/v1/backups', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(backup.payload)
  })
  const first = create(fixture())
  await new Promise((resolve) => setTimeout(resolve, 40))
  const second = create(fixture())
  let secondStatus
  try {
    secondStatus = await Promise.race([
      second.then((response) => response.status),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 100))
    ])
  } finally {
    await release()
  }
  assert.equal((await first).status, 201)
  if (secondStatus === 'pending') await second
  assert.equal(secondStatus, 429)
})

test('times out incomplete request bodies', async (t) => {
  const api = await startApi({ bodyTimeoutMs: 30 })
  t.after(() => api.close())
  const response = await new Promise((resolve, reject) => {
    const socket = createConnection(new URL(api.baseUrl).port, '127.0.0.1')
    let data = ''
    socket.setEncoding('utf8')
    socket.once('error', reject)
    socket.on('data', (chunk) => { data += chunk })
    socket.on('end', () => resolve(data))
    socket.once('connect', () => {
      socket.write('POST /v1/backups HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 10\r\nConnection: close\r\n\r\n{')
    })
  })

  assert.match(response, /^HTTP\/1\.1 408 /)
  assert.match(response, /request_timeout/)
})

test('caches health readiness instead of writing on every request', async (t) => {
  const api = await startApi({ healthCacheMs: 60_000 })
  t.after(() => api.close())

  assert.equal((await request(api, '/health')).status, 200)
  await rm(api.rootDir, { recursive: true, force: true })
  assert.equal((await request(api, '/health')).status, 200)
  await assert.rejects(stat(api.rootDir), { code: 'ENOENT' })
})

test('cleans orphaned temporary files and enforces a record limit', async (t) => {
  const api = await startApi({ maxRecords: 1 })
  t.after(() => api.close())
  const orphan = join(api.rootDir, `.${randomBytes(16).toString('hex')}.tmp`)
  await writeFile(orphan, 'orphan')
  const create = (backup) => request(api, '/v1/backups', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(backup.payload)
  })

  assert.equal((await create(fixture())).status, 201)
  assert.equal((await create(fixture())).status, 507)
  const files = await readdir(api.rootDir)
  assert.equal(files.some((name) => name.endsWith('.tmp')), false)
  assert.equal(files.filter((name) => name.endsWith('.json')).length, 1)
})

test('enforces atomic storage capacity without blocking existing restores', async (t) => {
  const api = await startApi({ maxStorageBytes: 420 })
  const secondServer = createBackupServer({ rootDir: api.rootDir, allowedOrigins: [allowedOrigin], maxStorageBytes: 420 })
  await new Promise((resolve, reject) => {
    secondServer.once('error', reject)
    secondServer.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => api.close())
  t.after(() => new Promise((resolve) => secondServer.close(resolve)))
  const first = fixture()
  const second = fixture()
  const create = (backup, baseUrl = api.baseUrl) => fetch(`${baseUrl}/v1/backups`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(backup.payload)
  })

  const results = await Promise.all([create(first), create(second, `http://127.0.0.1:${secondServer.address().port}`)])

  assert.deepEqual(results.map((response) => response.status).sort(), [201, 507])
  assert.equal((await readdir(api.rootDir)).length, 1)
})

test('never accepts record ids in URLs and stores no client delete secret', async (t) => {
  const api = await startApi()
  t.after(() => api.close())
  const backup = fixture()

  assert.equal((await request(api, `/v1/backups/${backup.payload.id}`)).status, 404)
  assert.equal((await request(api, `/v1/backups?backup=${backup.payload.id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(backup.payload)
  })).status, 404)

  await request(api, '/v1/backups', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(backup.payload)
  })
  const files = await readdir(api.rootDir)
  const stored = await readFile(join(api.rootDir, files[0]), 'utf8')
  assert.equal(stored.includes(backup.deleteSecret), false)
})
