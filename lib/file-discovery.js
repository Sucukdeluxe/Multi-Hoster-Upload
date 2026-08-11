const fs = require('fs');
const path = require('path');

async function walkFolderAsync(rootDir, options = {}) {
  const fsPromises = options.fsPromises || fs.promises;
  const pathImpl = options.pathImpl || path;
  const yieldFn = options.yieldFn || (() => new Promise(setImmediate));
  const files = [];
  const stack = [rootDir];
  let scanned = 0;

  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fsPromises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = pathImpl.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        let size = 0;
        try {
          size = (await fsPromises.stat(fullPath)).size;
        } catch {}
        files.push({ path: fullPath, name: entry.name, size });
      }
    }
    scanned++;
    if (scanned % 8 === 0) await yieldFn();
  }

  return files;
}

module.exports = { walkFolderAsync };
