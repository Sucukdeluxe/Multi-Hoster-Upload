import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { parseConnectionCode } from './mcp-connection.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digest = /^[0-9a-f]{64}$/;
const prefixes = { downloader: 'mdd', uploader: 'mhu' };
const chunkBytes = 1_048_576;

async function relayFetch(input, init) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.origin !== 'https://downloader.24-music.de' || !url.pathname.startsWith('/mcp-relay/mcp/') || url.username || url.password || url.search || url.hash) throw new Error('Nicht erlaubtes MCP-Ziel.');
  const response = await fetch(input, { ...init, redirect: 'error' });
  const maximum = 2 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > maximum) { await response.body?.cancel(); throw new Error('MCP-Antwort ist zu groß.'); }
  if (!response.body) return response;
  const reader = response.body.getReader();
  let bytes = 0;
  return new Response(new ReadableStream({
    async pull(controller) {
      try {
        const part = await reader.read();
        if (part.done) { controller.close(); return; }
        bytes += part.value.byteLength;
        if (bytes > maximum) { await reader.cancel(); controller.error(new Error('MCP-Antwort ist zu groß.')); return; }
        controller.enqueue(part.value);
      } catch (error) { controller.error(error); }
    },
    cancel: reason => reader.cancel(reason)
  }), { status: response.status, statusText: response.statusText, headers: response.headers });
}

export function parseTransferReference(raw) {
  const prefix = 'media-mcp-file:v1:';
  if (typeof raw !== 'string' || raw.length > 2048 || !raw.startsWith(prefix)) throw new Error('Ungültige Dateireferenz.');
  let value;
  try { value = JSON.parse(Buffer.from(raw.slice(prefix.length), 'base64url').toString('utf8')); }
  catch { throw new Error('Ungültige Dateireferenz.'); }
  if (value?.v !== 1 || !Object.hasOwn(prefixes, value.kind) || !uuid.test(value.installationId) || !uuid.test(value.transferId)) throw new Error('Ungültige Dateireferenz.');
  return value;
}

async function exists(file) {
  try { await fs.lstat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function openRegular(file, flags) {
  const handle = await fs.open(file, flags, 0o600);
  try {
    const [named, opened] = await Promise.all([fs.lstat(file), handle.stat()]);
    if (!opened.isFile() || named.isSymbolicLink() || named.dev !== opened.dev || named.ino !== opened.ino) throw new Error('Lokale Transferdatei ist keine reguläre Datei.');
    return handle;
  } catch (error) { await handle.close(); throw error; }
}

async function removeOwned(file, identity) {
  try {
    const current = await fs.lstat(file);
    if (current.dev !== identity.dev || current.ino !== identity.ino) return false;
    await fs.unlink(file);
    return true;
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function delay(ms, signal) {
  signal.throwIfAborted();
  await new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new Error('Dateitransfer abgebrochen.')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

function validateInfo(info, expectedId) {
  if (!info || !uuid.test(info.transferId) || (expectedId && info.transferId !== expectedId) || !Number.isSafeInteger(info.bytes) || info.bytes < 0 || !['preparing', 'ready', 'failed'].includes(info.state) || (info.state === 'ready' && !digest.test(info.sha256))) throw new Error('Ungültige Transfermetadaten.');
  return info;
}

export async function receiveMcpFile({ call, installationId, kind, source, transferId, destination, resume = false, signal = new AbortController().signal, onProgress = () => {} }) {
  if (!uuid.test(installationId) || !Object.hasOwn(prefixes, kind)) throw new Error('Ungültige Installation.');
  if (!source && !uuid.test(transferId || '')) throw new Error('Quelle oder Dateireferenz fehlt.');
  const requested = path.resolve(destination);
  const parent = await fs.realpath(path.dirname(requested));
  const target = path.join(parent, path.basename(requested));
  const part = `${target}.mcp-part`;
  const stateFile = `${target}.mcp-transfer.json`;
  const lockFile = `${target}.mcp-lock`;
  if (await exists(target)) throw new Error('Zieldatei existiert bereits; sie wird nicht überschrieben.');
  const lock = await openRegular(lockFile, 'wx');
  const lockIdentity = await lock.stat();
  let handle;
  let stateIdentity;
  let info;
  let checkpoint;
  let completed = 0;
  const hash = crypto.createHash('sha256');
  const tool = (suffix, args) => { signal.throwIfAborted(); return call(`${prefixes[kind]}_files_transfer_${suffix}`, args, signal); };
  const safeCall = async (suffix, args) => {
    for (let attempt = 0; ; attempt++) {
      try { return await tool(suffix, args); }
      catch (error) { if (attempt >= 2 || signal.aborted) throw error; await delay(300 * (attempt + 1), signal); }
    }
  };
  const save = async (create = false) => {
    const value = { v: 1, installationId, kind, ...(source ? { source } : {}), transferId: info.transferId, bytes: info.bytes, sha256: info.sha256, completed, prefixSha256: hash.copy().digest('hex') };
    const temporary = `${stateFile}.${crypto.randomUUID()}.tmp`;
    const saved = await fs.open(create ? stateFile : temporary, 'wx', 0o600);
    let savedIdentity;
    try { await saved.writeFile(JSON.stringify(value)); await saved.sync(); savedIdentity = await saved.stat(); } finally { await saved.close(); }
    if (!create) {
      try {
        const current = await fs.lstat(stateFile);
        if (!stateIdentity || current.dev !== stateIdentity.dev || current.ino !== stateIdentity.ino || current.isSymbolicLink()) throw new Error('Fortsetzungsdatei wurde ausgetauscht.');
        await fs.rename(temporary, stateFile);
      }
      catch (error) { await fs.unlink(temporary).catch(() => {}); throw error; }
    }
    stateIdentity = savedIdentity;
  };
  try {
    if (resume) {
      const stateHandle = await openRegular(stateFile, 'r');
      try {
        if ((await stateHandle.stat()).size > 32_768) throw new Error('Ungültiger Fortsetzungsstand.');
        checkpoint = JSON.parse(await stateHandle.readFile('utf8'));
        stateIdentity = await stateHandle.stat();
      } finally { await stateHandle.close(); }
      if (checkpoint.v !== 1 || checkpoint.installationId !== installationId || checkpoint.kind !== kind || !uuid.test(checkpoint.transferId) || !digest.test(checkpoint.sha256) || !digest.test(checkpoint.prefixSha256) || !Number.isSafeInteger(checkpoint.completed) || checkpoint.completed < 0 || !Number.isSafeInteger(checkpoint.bytes) || checkpoint.bytes < checkpoint.completed || (transferId && checkpoint.transferId !== transferId) || (source && JSON.stringify(checkpoint.source) !== JSON.stringify(source))) throw new Error('Fortsetzungsstand passt nicht zu dieser Quelle.');
      transferId = checkpoint.transferId;
    } else if (await exists(part) || await exists(stateFile)) throw new Error('Unvollständiger Transfer vorhanden. Zum Fortsetzen --resume verwenden.');
    if (transferId) {
      try { info = validateInfo(await safeCall('get', { transferId }), transferId); }
      catch (error) { if (!source || signal.aborted) throw error; }
    }
    if (!info) info = validateInfo(await tool('open', source));
    const deadline = Date.now() + 1_800_000;
    while (info.state === 'preparing') {
      if (Date.now() >= deadline) throw new Error('Zeitlimit der Quellprüfung erreicht.');
      onProgress({ phase: 'checking', bytes: info.checkedBytes || 0, total: info.bytes });
      await delay(500, signal);
      info = validateInfo(await safeCall('get', { transferId: info.transferId }), info.transferId);
    }
    if (info.state !== 'ready') throw new Error('Quelldatei ist nicht stabil oder konnte nicht geprüft werden.');
    if (checkpoint && (checkpoint.sha256 !== info.sha256 || checkpoint.bytes !== info.bytes)) throw new Error('Quelldatei hat sich geändert; vorhandener Teiltransfer bleibt unverändert.');
    handle = await openRegular(part, resume ? 'r+' : 'wx+');
    if (checkpoint) {
      if ((await handle.stat()).size < checkpoint.completed) throw new Error('Lokale Teildatei ist kürzer als der Fortsetzungsstand.');
      const buffer = Buffer.alloc(chunkBytes);
      while (completed < checkpoint.completed) {
        signal.throwIfAborted();
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, checkpoint.completed - completed), completed);
        if (!bytesRead) throw new Error('Lokale Teildatei ist unvollständig.');
        hash.update(buffer.subarray(0, bytesRead));
        completed += bytesRead;
      }
      if (hash.copy().digest('hex') !== checkpoint.prefixSha256) throw new Error('Prüfsumme der lokalen Teildatei stimmt nicht.');
      await handle.truncate(completed);
      await handle.sync();
      await save();
    } else await save(true);
    while (completed < info.bytes) {
      const length = Math.min(chunkBytes, info.bytes - completed);
      const chunk = await safeCall('read', { transferId: info.transferId, offset: completed, length });
      if (!chunk || chunk.transferId !== info.transferId || chunk.offset !== completed || chunk.bytes !== info.bytes || chunk.bytesRead !== length || chunk.nextOffset !== (completed + length < info.bytes ? completed + length : null) || typeof chunk.base64 !== 'string' || chunk.base64.length !== 4 * Math.ceil(length / 3) || !digest.test(chunk.sha256)) throw new Error('Ungültiger Transferblock.');
      const buffer = Buffer.from(chunk.base64, 'base64');
      if (buffer.length !== length || buffer.toString('base64') !== chunk.base64 || crypto.createHash('sha256').update(buffer).digest('hex') !== chunk.sha256) throw new Error('Prüfsumme eines Transferblocks stimmt nicht.');
      signal.throwIfAborted();
      let written = 0;
      while (written < buffer.length) {
        const result = await handle.write(buffer, written, buffer.length - written, completed + written);
        if (!result.bytesWritten) throw new Error('Lokale Datei konnte nicht geschrieben werden.');
        written += result.bytesWritten;
      }
      hash.update(buffer);
      completed += buffer.length;
      await handle.sync();
      await save();
      onProgress({ phase: 'receiving', bytes: completed, total: info.bytes });
    }
    if ((await handle.stat()).size !== info.bytes || hash.copy().digest('hex') !== info.sha256) throw new Error('Gesamtgröße oder SHA-256 stimmt nicht. Die Datei bleibt als Teiltransfer erhalten.');
    await handle.sync();
    const beforeVerify = await handle.stat();
    const diskHash = crypto.createHash('sha256');
    const verifyBuffer = Buffer.alloc(chunkBytes);
    let verified = 0;
    while (verified < info.bytes) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(verifyBuffer, 0, Math.min(verifyBuffer.length, info.bytes - verified), verified);
      if (!bytesRead) throw new Error('Lokale Datei während der Prüfung verändert.');
      diskHash.update(verifyBuffer.subarray(0, bytesRead));
      verified += bytesRead;
      onProgress({ phase: 'verifying', bytes: verified, total: info.bytes });
    }
    const afterVerify = await handle.stat();
    const namedPart = await fs.lstat(part);
    if (diskHash.digest('hex') !== info.sha256 || afterVerify.size !== info.bytes || afterVerify.mtimeMs !== beforeVerify.mtimeMs || afterVerify.ctimeMs !== beforeVerify.ctimeMs || namedPart.isSymbolicLink() || namedPart.dev !== afterVerify.dev || namedPart.ino !== afterVerify.ino) throw new Error('Lokale Dateiprüfung fehlgeschlagen. Die Teildatei bleibt erhalten.');
    const finalInfo = validateInfo(await safeCall('get', { transferId: info.transferId }), info.transferId);
    if (finalInfo.state !== 'ready' || finalInfo.sha256 !== info.sha256 || finalInfo.bytes !== info.bytes) throw new Error('Quelldatei während des Transfers verändert.');
    signal.throwIfAborted();
    await handle.sync();
    if (await fs.realpath(path.dirname(requested)) !== parent) throw new Error('Zielordner während des Transfers verändert.');
    await fs.link(part, target);
    const published = await fs.lstat(target);
    const finalStat = await handle.stat();
    if (published.isSymbolicLink() || published.dev !== afterVerify.dev || published.ino !== afterVerify.ino || finalStat.size !== info.bytes || finalStat.mtimeMs !== afterVerify.mtimeMs) {
      await removeOwned(target, published);
      throw new Error('Zieldatei wurde während der Veröffentlichung ausgetauscht.');
    }
    await handle.close();
    handle = null;
    await removeOwned(part, afterVerify);
    await removeOwned(stateFile, stateIdentity);
    await tool('close', { transferId: info.transferId }).catch(() => {});
    return { filePath: target, bytes: completed, sha256: info.sha256, resumed: resume };
  } finally {
    await handle?.close().catch(() => {});
    await lock.close();
    await removeOwned(lockFile, lockIdentity).catch(() => {});
  }
}

export async function pullMcpFile({ codeFile, ...options }) {
  if (typeof codeFile !== 'string' || !codeFile || codeFile.includes('media-mcp:')) throw new Error('Private Schlüsseldatei angeben, keinen Verbindungscode als Befehlsargument.');
  const codeHandle = await openRegular(codeFile, 'r');
  let code;
  try {
    if ((await codeHandle.stat()).size > 16_384) throw new Error('Ungültige Schlüsseldatei.');
    code = parseConnectionCode(await codeHandle.readFile('utf8'));
  } finally { await codeHandle.close(); }
  if (options.reference) {
    const reference = parseTransferReference(options.reference);
    if (reference.installationId !== code.installationId || reference.kind !== code.kind) throw new Error('Dateireferenz gehört zu einer anderen Installation.');
    options.transferId = reference.transferId;
  }
  const client = new Client({ name: 'media-mcp-file-receiver', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(code.url), { requestInit: { headers: { Authorization: `Bearer ${code.token}` } }, fetch: relayFetch });
  try {
    await client.connect(transport);
    return await receiveMcpFile({ ...options, installationId: code.installationId, kind: code.kind, call: async (name, args, signal) => {
      let response;
      try { response = await client.callTool({ name, arguments: args }, undefined, { signal, timeout: 120_000 }); }
      catch { throw new Error('MCP-Verbindung unterbrochen oder Zugriff abgewiesen.'); }
      if (response.isError || !response.structuredContent || !Object.hasOwn(response.structuredContent, 'result')) throw new Error('MCP-Dateizugriff abgewiesen oder Quelldatei nicht verfügbar.');
      return response.structuredContent.result;
    } });
  } finally { await client.close().catch(() => {}); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const args = process.argv.slice(2);
    const resume = args.includes('--resume');
    const values = args.filter(arg => arg !== '--resume');
    let options;
    if (values.length === 4 && values[1] === '--transfer') options = { codeFile: values[0], reference: values[2], destination: values[3] };
    else if (values.length === 4 && !values[1].startsWith('--')) options = { codeFile: values[0], source: { rootId: values[1], relativePath: values[2] }, destination: values[3] };
    else throw new Error('Aufruf: node scripts/pull-mcp-file.mjs <private-code-file> <rootId> <relativePath> <destination> [--resume] oder <private-code-file> --transfer <reference> <destination> [--resume]');
    let last = 0;
    const result = await pullMcpFile({ ...options, resume, signal: abort.signal, onProgress: progress => {
      if (Date.now() - last < 1000) return;
      last = Date.now();
      process.stderr.write(`${progress.phase}: ${progress.bytes}/${progress.total}\n`);
    } });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : 'Dateitransfer fehlgeschlagen.'}\n`); process.exitCode = 1; }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
