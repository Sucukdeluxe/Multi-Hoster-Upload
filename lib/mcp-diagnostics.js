const fs = require('node:fs/promises');
const path = require('node:path');
const { constants } = require('node:fs');
const { createHash } = require('node:crypto');
const { McpAccessError } = require('./mcp-access');

function createMcpDiagnostics({ getSources = () => [], redact }) {
  let reading = 0;
  const guard = context => { if (context.signal?.aborted || !Number.isFinite(context.deadline) || Date.now() >= context.deadline) throw new McpAccessError('REQUEST_EXPIRED'); };
  const sources = () => getSources().slice(0, 64).map(source => ({ ...source, id: createHash('sha256').update(source.path).digest('hex').slice(0, 24) }));
  const resolve = async source => {
    const actual = await fs.realpath(source.path);
    const parent = await fs.realpath(source.directory);
    const expectedParent = path.resolve(source.directory);
    if (process.platform === 'win32' ? parent.toLowerCase() !== expectedParent.toLowerCase() : parent !== expectedParent) throw new McpAccessError('PATH_NOT_GRANTED');
    if (actual !== path.join(parent, path.basename(source.path))) throw new McpAccessError('PATH_NOT_GRANTED');
    const stat = await fs.lstat(actual);
    if (!stat.isFile() || stat.nlink !== 1) throw new McpAccessError('PATH_NOT_GRANTED');
    return { actual, stat };
  };
  return {
    mhu_diagnostics_files: async (args, context) => {
      const files = [];
      for (const source of sources()) {
        guard(context);
        try { const { stat } = await resolve(source); files.push({ id: source.id, name: source.label, sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString() }); }
        catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) files.push({ id: source.id, name: source.label, unavailable: true }); }
      }
      const offset = args.offset || 0; const limit = args.limit || 50;
      return { total: files.length, offset, files: files.slice(offset, offset + limit), nextOffset: offset + limit < files.length ? offset + limit : null };
    },
    mhu_diagnostics_read: async (args, context) => {
      guard(context);
      const source = sources().find(item => item.id === args.artifactId);
      if (!source) throw new McpAccessError('DIAGNOSTIC_NOT_FOUND');
      if (reading >= 4) throw new McpAccessError('TOO_MANY_REQUESTS');
      reading++;
      let file;
      try {
        const { actual, stat } = await resolve(source);
        if (stat.size > 8 * 1024 * 1024) throw new McpAccessError('FILE_TOO_LARGE');
        file = await fs.open(actual, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        const initial = await file.stat();
        if (initial.ino !== stat.ino || initial.dev !== stat.dev || initial.size !== stat.size || !initial.isFile()) throw new McpAccessError('FILE_CHANGED');
        const buffer = Buffer.alloc(initial.size);
        let offset = 0;
        while (offset < buffer.length) {
          guard(context);
          const { bytesRead } = await file.read(buffer, offset, Math.min(256 * 1024, buffer.length - offset), offset);
          if (!bytesRead) throw new McpAccessError('FILE_CHANGED');
          offset += bytesRead;
        }
        const final = await file.stat();
        if (final.size !== initial.size || final.mtimeMs !== initial.mtimeMs || final.ctimeMs !== initial.ctimeMs) throw new McpAccessError('FILE_CHANGED');
        const current = await resolve(source);
        if (current.stat.ino !== initial.ino || current.stat.dev !== initial.dev) throw new McpAccessError('FILE_CHANGED');
        guard(context);
        const text = redact(buffer.toString('utf8'));
        if (typeof text !== 'string') throw new McpAccessError('REDACTION_UNAVAILABLE');
        const start = args.offset || 0; const limit = args.limit || 65536;
        if (start > text.length) throw new McpAccessError('INVALID_ARGUMENTS');
        const content = text.slice(start, start + limit);
        return { artifactId: source.id, name: source.label, sizeBytes: initial.size, modifiedAt: initial.mtime.toISOString(),
          offset: start, returnedCharacters: content.length, totalCharacters: text.length, content,
          nextOffset: start + content.length < text.length ? start + content.length : null };
      } finally { reading--; if (file) await file.close().catch(() => {}); }
    }
  };
}

module.exports = { createMcpDiagnostics };
