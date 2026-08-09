import { resolve } from 'node:path'
import { createBackupServer } from './server.mjs'

const port = Number.parseInt(process.env.PORT ?? '8788', 10)
const host = process.env.HOST ?? '127.0.0.1'
const rootDir = resolve(process.env.BACKUP_DATA_DIR ?? './data')
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)
const rateLimit = {
  max: Number.parseInt(process.env.RATE_LIMIT_MAX ?? '60', 10),
  windowMs: Number.parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? '60000', 10)
}
const uploadRateLimit = {
  max: Number.parseInt(process.env.UPLOAD_RATE_LIMIT_MAX ?? '10', 10),
  windowMs: Number.parseInt(process.env.UPLOAD_RATE_LIMIT_WINDOW_MS ?? '3600000', 10)
}
const requestRateLimit = {
  max: Number.parseInt(process.env.REQUEST_RATE_LIMIT_MAX ?? '120', 10),
  windowMs: Number.parseInt(process.env.REQUEST_RATE_LIMIT_WINDOW_MS ?? '60000', 10)
}
const maxStorageBytes = Number.parseInt(process.env.MAX_STORAGE_BYTES ?? String(10 * 1024 * 1024 * 1024), 10)
const maxRecords = Number.parseInt(process.env.MAX_RECORDS ?? '10000', 10)
const bodyTimeoutMs = Number.parseInt(process.env.BODY_TIMEOUT_MS ?? '10000', 10)
const healthCacheMs = Number.parseInt(process.env.HEALTH_CACHE_MS ?? '5000', 10)
const maxConcurrentPerClient = Number.parseInt(process.env.MAX_CONCURRENT_PER_CLIENT ?? '8', 10)
const maxConcurrentTotal = Number.parseInt(process.env.MAX_CONCURRENT_TOTAL ?? '64', 10)
const trustedProxy = process.env.TRUST_PROXY === 'true'
const trustedProxyAddresses = (process.env.TRUSTED_PROXY_ADDRESSES ?? '127.0.0.1,::1,::ffff:127.0.0.1')
  .split(',')
  .map((address) => address.trim())
  .filter(Boolean)

if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('Invalid PORT')

const server = createBackupServer({
  rootDir,
  allowedOrigins,
  rateLimit,
  uploadRateLimit,
  requestRateLimit,
  maxStorageBytes,
  maxRecords,
  bodyTimeoutMs,
  healthCacheMs,
  maxConcurrentPerClient,
  maxConcurrentTotal,
  trustedProxy,
  trustedProxyAddresses
})

server.listen(port, host, () => {
  process.stdout.write(`Backup API listening on ${host}:${port}\n`)
})

function shutdown() {
  server.close((error) => {
    if (error) {
      process.stderr.write('Backup API shutdown failed\n')
      process.exitCode = 1
    }
  })
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
