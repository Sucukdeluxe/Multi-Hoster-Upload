const fs = require('node:fs/promises');
const path = require('node:path');
const { constants } = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
const { McpAccessError, resolveGrantedFile } = require('./mcp-access');

const CHUNK_BYTES = 1024 * 1024;
const MAX_BYTES = 32 * 1024 ** 3;
const unchanged = (a, b) => a.isFile() && b.isFile() && a.dev === b.dev && a.ino === b.ino && a.size === b.size
  && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && b.nlink === 1;
const inside = (root, file) => { const relative = path.relative(root, file); return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)); };

function sanitizeTransferResult(name, value, sanitize) {
  const fail = () => { throw new McpAccessError('INVALID_TRANSFER_RESULT'); };
  const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
  const integer = value => Number.isSafeInteger(value) && value >= 0 && value <= MAX_BYTES;
  const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const keys = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));
  const metadata = item => {
    if (!keys(item, ['transferId', 'fileName', 'bytes', 'state', 'sha256', 'expiresAt', 'chunkBytes', 'checkedBytes', 'error', 'reference'])
      || !uuid(item.transferId) || typeof item.fileName !== 'string' || item.fileName.length > 1024 || !integer(item.bytes)
      || !['preparing', 'ready', 'failed'].includes(item.state) || (item.sha256 !== null && !digest(item.sha256))
      || (item.state === 'ready' && !digest(item.sha256)) || item.chunkBytes !== CHUNK_BYTES
      || (item.checkedBytes !== undefined && (!integer(item.checkedBytes) || item.checkedBytes > item.bytes))
      || typeof item.expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(item.expiresAt) || !Number.isFinite(Date.parse(item.expiresAt))
      || (item.error !== undefined && (typeof item.error !== 'string' || !/^[A-Z_]{1,60}$/.test(item.error)))) fail();
    if (item.reference !== undefined) {
      if (typeof item.reference !== 'string' || !/^media-mcp-file:v1:[A-Za-z0-9_-]{1,1000}$/.test(item.reference)) fail();
      let ref;
      try { ref = JSON.parse(Buffer.from(item.reference.slice('media-mcp-file:v1:'.length), 'base64url').toString('utf8')); } catch { fail(); }
      if (!keys(ref, ['v', 'installationId', 'kind', 'transferId']) || ref.v !== 1 || ref.kind !== 'uploader' || !uuid(ref.installationId) || ref.transferId !== item.transferId) fail();
    }
    return { ...item, fileName: sanitize(item.fileName) };
  };
  if (name === 'mhu_files_transfer_read') {
    if (!keys(value, ['transferId', 'offset', 'bytesRead', 'nextOffset', 'bytes', 'sha256', 'base64']) || !uuid(value.transferId)
      || ![value.offset, value.bytesRead, value.bytes].every(integer) || value.bytesRead > CHUNK_BYTES
      || value.offset + value.bytesRead > value.bytes
      || value.nextOffset !== (value.offset + value.bytesRead < value.bytes ? value.offset + value.bytesRead : null) || !digest(value.sha256)
      || typeof value.base64 !== 'string' || value.base64.length > 4 * Math.ceil(CHUNK_BYTES / 3)) fail();
    const bytes = Buffer.from(value.base64, 'base64');
    if (bytes.length !== value.bytesRead || bytes.toString('base64') !== value.base64 || createHash('sha256').update(bytes).digest('hex') !== value.sha256) fail();
    return value;
  }
  if (name === 'mhu_files_transfer_list') {
    if (!keys(value, ['transfers']) || !Array.isArray(value.transfers) || value.transfers.length > 4) fail();
    return { transfers: value.transfers.map(metadata) };
  }
  if (name === 'mhu_files_transfer_close') {
    if (!keys(value, ['closed']) || typeof value.closed !== 'boolean') fail();
    return { closed: value.closed };
  }
  return metadata(value);
}

function createMcpTransfers({ getGrants, getCapabilities = () => [], getProtectedPaths = () => [], getInstallationId = () => null,
  now = Date.now, ttlMs = 60 * 60 * 1000, idleMs = 10 * 60 * 1000, maximum = 4 }) {
  const records = new Map();
  let opening = 0;
  let generation = 0;
  let timer = null;
  const authorized = () => ['read', 'files'].every(scope => getCapabilities().includes(scope));
  const guard = context => {
    if (!authorized()) throw new McpAccessError('SCOPE_DENIED');
    if (context && (context.signal?.aborted || !Number.isFinite(context.deadline) || now() >= context.deadline)) throw new McpAccessError('REQUEST_EXPIRED');
  };
  const closeFile = record => record.closing || (record.closing = record.file.close().catch(() => {}));
  const remove = async record => {
    if (records.get(record.id) === record) records.delete(record.id);
    record.abort.abort();
    await record.task;
    await closeFile(record);
  };
  const expired = record => now() >= record.until || now() - record.touched >= idleMs;
  const purge = async () => { await Promise.all([...records.values()].filter(expired).map(remove)); };
  const ensureTimer = () => {
    if (timer) return;
    timer = setInterval(() => { void purge().catch(() => {}); }, Math.max(10, Math.min(30000, idleMs)));
    timer.unref?.();
  };
  const protectedFile = async file => {
    for (const entry of getProtectedPaths()) {
      const blocked = path.resolve(entry);
      if (inside(blocked, file)) return true;
      try { if (inside(await fs.realpath(blocked), file)) return true; }
      catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw new McpAccessError('PATH_NOT_GRANTED'); }
    }
    return false;
  };
  const verify = async record => {
    guard();
    if (record.abort.signal.aborted || expired(record)) throw new McpAccessError('TRANSFER_EXPIRED');
    if (!getGrants().some(grant => grant.id === record.rootId && grant.allowTransfer === true)) throw new McpAccessError('TRANSFER_NOT_GRANTED');
    const target = await resolveGrantedFile(getGrants(), record.rootId, record.relativePath, { regularFile: true });
    if (target.path !== record.path || !unchanged(record.initial, target.stat) || await protectedFile(target.path)
      || !unchanged(record.initial, await record.file.stat())) throw new McpAccessError('FILE_CHANGED');
  };
  const metadata = record => {
    const installationId = getInstallationId();
    return { transferId: record.id, fileName: record.name, bytes: record.initial.size, state: record.state,
      sha256: record.sha256, expiresAt: new Date(record.until).toISOString(), chunkBytes: CHUNK_BYTES, checkedBytes: record.checkedBytes,
      ...(record.error ? { error: record.error } : {}),
      ...(installationId ? { reference: 'media-mcp-file:v1:' + Buffer.from(JSON.stringify({ v: 1, installationId, kind: 'uploader', transferId: record.id })).toString('base64url') } : {}) };
  };
  const find = async (id, context) => {
    guard(context);
    await purge();
    const record = records.get(id);
    if (!record || record.owner !== context.principalId) throw new McpAccessError('TRANSFER_NOT_FOUND');
    record.touched = now();
    if (record.state !== 'failed') {
      try { await verify(record); }
      catch (error) { record.state = 'failed'; record.error = error instanceof McpAccessError ? error.code : 'FILE_CHANGED'; record.abort.abort(); await record.task; await closeFile(record); }
    }
    guard(context);
    return record;
  };
  const hash = async record => {
    try {
      const digest = createHash('sha256');
      const buffer = Buffer.alloc(CHUNK_BYTES);
      for (let offset = 0; offset < record.initial.size;) {
        await verify(record);
        const count = Math.min(buffer.length, record.initial.size - offset);
        const result = await record.file.read(buffer, 0, count, offset);
        if (result.bytesRead !== count) throw new McpAccessError('FILE_CHANGED');
        digest.update(buffer.subarray(0, count)); offset += count; record.checkedBytes = offset;
      }
      await verify(record);
      record.sha256 = digest.digest('hex'); record.state = 'ready';
    } catch (error) {
      record.state = 'failed'; record.error = error instanceof McpAccessError ? error.code : 'FILE_UNAVAILABLE';
      await closeFile(record);
    }
  };
  const handlers = {
    mhu_files_transfer_open: async (args, context) => {
      guard(context); await purge();
      if (records.size + opening >= maximum) throw new McpAccessError('TRANSFER_LIMIT');
      if (typeof context.principalId !== 'string' || !context.principalId) throw new McpAccessError('INVALID_REQUEST');
      opening++;
      const expectedGeneration = generation;
      let file;
      try {
        if (!getGrants().some(grant => grant.id === args.rootId && grant.allowTransfer === true)) throw new McpAccessError('TRANSFER_NOT_GRANTED');
        const target = await resolveGrantedFile(getGrants(), args.rootId, args.relativePath, { regularFile: true });
        if (target.stat.size > MAX_BYTES) throw new McpAccessError('FILE_TOO_LARGE');
        if (target.stat.nlink !== 1 || await protectedFile(target.path)) throw new McpAccessError('PATH_NOT_GRANTED');
        file = await fs.open(target.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        const initial = await file.stat();
        if (!unchanged(target.stat, initial)) throw new McpAccessError('FILE_CHANGED');
        const record = { id: randomUUID(), owner: context.principalId, rootId: args.rootId, relativePath: args.relativePath,
          path: target.path, name: path.basename(target.path), initial, file, state: 'preparing', sha256: null, checkedBytes: 0,
          until: now() + ttlMs, touched: now(), abort: new AbortController(), task: Promise.resolve() };
        await verify(record); guard(context);
        if (generation !== expectedGeneration) throw new McpAccessError('TRANSFER_EXPIRED');
        records.set(record.id, record); ensureTimer();
        record.task = hash(record);
        file = null;
        return metadata(record);
      } finally { opening--; if (file) await file.close().catch(() => {}); }
    },
    mhu_files_transfer_get: async (args, context) => metadata(await find(args.transferId, context)),
    mhu_files_transfer_list: async (_args, context) => {
      guard(context); await purge();
      const items = [];
      for (const record of records.values()) if (record.owner === context.principalId) items.push(metadata(await find(record.id, context)));
      return { transfers: items };
    },
    mhu_files_transfer_read: async (args, context) => {
      const record = await find(args.transferId, context);
      if (record.state !== 'ready') throw new McpAccessError(record.state === 'failed' ? record.error : 'TRANSFER_NOT_READY');
      const length = args.length ?? CHUNK_BYTES;
      if (!Number.isSafeInteger(args.offset) || args.offset < 0 || args.offset > record.initial.size
        || !Number.isSafeInteger(length) || length < 1 || length > CHUNK_BYTES) throw new McpAccessError('INVALID_ARGUMENTS');
      const count = Math.min(length, record.initial.size - args.offset);
      const buffer = Buffer.alloc(count);
      try {
        await verify(record); guard(context);
        const result = await record.file.read(buffer, 0, count, args.offset);
        if (result.bytesRead !== count) throw new McpAccessError('FILE_CHANGED');
        await verify(record); guard(context);
        return { transferId: record.id, offset: args.offset, bytesRead: count, nextOffset: args.offset + count < record.initial.size ? args.offset + count : null,
          bytes: record.initial.size, sha256: createHash('sha256').update(buffer).digest('hex'), base64: buffer.toString('base64') };
      } catch (error) { record.state = 'failed'; record.error = error instanceof McpAccessError ? error.code : 'FILE_UNAVAILABLE'; await remove(record); throw error; }
    },
    mhu_files_transfer_close: async (args, context) => {
      guard(context); await purge();
      const record = records.get(args.transferId);
      if (!record || record.owner !== context.principalId) return { closed: false };
      await remove(record); return { closed: true };
    }
  };
  return { handlers, async dispose() { generation++; clearInterval(timer); timer = null; await Promise.all([...records.values()].map(remove)); } };
}

module.exports = { createMcpTransfers, sanitizeTransferResult, CHUNK_BYTES, MAX_BYTES };
