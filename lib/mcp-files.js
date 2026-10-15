const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { McpAccessError, resolveGrantedFile } = require('./mcp-access');

function createMcpFiles({ getGrants, trashFile }) {
  const guard = context => {
    if (context.signal?.aborted || Date.now() >= context.deadline) throw new McpAccessError('REQUEST_EXPIRED');
  };
  const metadata = stat => ({ size: stat.size, modifiedAt: stat.mtime.toISOString(), directory: stat.isDirectory(), file: stat.isFile() });
  return {
    mhu_files_roots: async () => getGrants().map(({ id, label, readOnly }) => ({ id, label, readOnly: readOnly !== false })),
    mhu_files_stat: async (args, context) => {
      guard(context);
      const target = await resolveGrantedFile(getGrants(), args.rootId, args.relativePath);
      return { ...metadata(target.stat), relativePath: args.relativePath };
    },
    mhu_files_list: async (args, context) => {
      const target = await resolveGrantedFile(getGrants(), args.rootId, args.relativePath || '');
      if (!target.stat.isDirectory()) throw new McpAccessError('NOT_A_DIRECTORY');
      const names = [];
      for await (const entry of await fs.opendir(target.path)) {
        guard(context);
        if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) continue;
        names.push({ name: entry.name, directory: entry.isDirectory() });
        if (names.length > 100000) throw new McpAccessError('DIRECTORY_TOO_LARGE');
      }
      names.sort((a, b) => a.name.localeCompare(b.name));
      const offset = args.offset || 0;
      const limit = args.limit || 100;
      return { total: names.length, offset, items: names.slice(offset, offset + limit), nextOffset: offset + limit < names.length ? offset + limit : null };
    },
    mhu_files_hash: async (args, context) => {
      guard(context);
      const target = await resolveGrantedFile(getGrants(), args.rootId, args.relativePath, { regularFile: true });
      if (target.stat.size > 32 * 1024 ** 3) throw new McpAccessError('FILE_TOO_LARGE');
      const file = await fs.open(target.path, 'r');
      try {
        const initial = await file.stat();
        if (initial.ino !== target.stat.ino || initial.dev !== target.stat.dev || !initial.isFile()) throw new McpAccessError('FILE_CHANGED');
        const algorithm = args.algorithm || 'sha256';
        const hash = createHash(algorithm);
        for await (const chunk of file.createReadStream({ autoClose: false, highWaterMark: 256 * 1024 })) { guard(context); hash.update(chunk); }
        const final = await file.stat();
        if (initial.size !== final.size || initial.mtimeMs !== final.mtimeMs || initial.ctimeMs !== final.ctimeMs) throw new McpAccessError('FILE_CHANGED');
        return { algorithm, digest: hash.digest('hex'), size: final.size };
      } finally { await file.close(); }
    },
    mhu_files_delete: async (args, context) => {
      guard(context);
      const target = await resolveGrantedFile(getGrants(), args.rootId, args.relativePath, { regularFile: true, write: true });
      const checked = await fs.lstat(target.path);
      if (checked.isSymbolicLink() || checked.ino !== target.stat.ino || checked.dev !== target.stat.dev) throw new McpAccessError('FILE_CHANGED');
      const current = await resolveGrantedFile(getGrants(), args.rootId, args.relativePath, { regularFile: true, write: true });
      if (current.path !== target.path || current.stat.ino !== checked.ino || current.stat.dev !== checked.dev) throw new McpAccessError('FILE_CHANGED');
      guard(context);
      if (typeof trashFile !== 'function') throw new McpAccessError('TOOL_UNAVAILABLE');
      await trashFile(path.normalize(target.path));
      return { trashed: true, relativePath: args.relativePath };
    }
  };
}

module.exports = { createMcpFiles };
