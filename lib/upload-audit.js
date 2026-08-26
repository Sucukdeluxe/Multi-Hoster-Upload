const nodePath = require('path');

function createInternalLogPathResolver(options) {
  const source = options && typeof options === 'object' ? options : {};
  const fs = source.fs;
  const path = source.path || nodePath;
  const userDataPath = typeof source.userDataPath === 'string' ? source.userDataPath.trim() : '';

  if (!fs || typeof fs.mkdirSync !== 'function' || !userDataPath) {
    throw new TypeError('createInternalLogPathResolver requires fs and userDataPath');
  }

  const directories = [path.join(userDataPath, 'logs'), path.join(userDataPath, 'internal-logs')];

  return function resolveInternalLogPath(fileName, excludedPaths = new Set()) {
    if (typeof fileName !== 'string' || !fileName || path.basename(fileName) !== fileName) return null;
    const excluded = excludedPaths instanceof Set
      ? excludedPaths
      : new Set(Array.isArray(excludedPaths) ? excludedPaths : [excludedPaths]);
    for (const directory of directories) {
      const targetPath = path.join(directory, fileName);
      if (excluded.has(targetPath)) continue;
      try {
        fs.mkdirSync(directory, { recursive: true });
        return targetPath;
      } catch {}
    }
    return null;
  };
}

function createInternalLogWriter(options) {
  const source = options && typeof options === 'object' ? options : {};
  const fs = source.fs;
  const path = source.path || nodePath;
  const fileName = source.fileName;
  const resolveInternalLogPath = source.resolveInternalLogPath;
  const rotateLogFile = typeof source.rotateLogFile === 'function' ? source.rotateLogFile : () => {};
  const reportError = typeof source.reportError === 'function' ? source.reportError : () => {};
  const retryDelays = Array.isArray(source.retryDelays) && source.retryDelays.length > 0 ? source.retryDelays : [0, 100, 250];
  const maxBytes = Number.isFinite(source.maxBytes) ? source.maxBytes : 10 * 1024 * 1024;
  const maxBackups = Number.isFinite(source.maxBackups) ? source.maxBackups : 2;
  let activePath = null;

  if (!fs || !fs.promises || typeof fs.promises.appendFile !== 'function' || typeof resolveInternalLogPath !== 'function' || typeof fileName !== 'string') {
    throw new TypeError('createInternalLogWriter requires fs, fileName and resolveInternalLogPath');
  }

  async function append(line, label) {
    const excludedPaths = new Set();
    for (const delay of retryDelays) {
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      const targetPath = resolveInternalLogPath(fileName, excludedPaths);
      if (!targetPath) break;
      excludedPaths.add(targetPath);
      try {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        rotateLogFile(targetPath, maxBytes, maxBackups);
        await fs.promises.appendFile(targetPath, line, 'utf-8');
        activePath = targetPath;
        return true;
      } catch (error) {
        reportError(label, error);
      }
    }
    return false;
  }

  return {
    append,
    getActivePath: () => activePath,
    getPath: () => activePath || resolveInternalLogPath(fileName)
  };
}

function createUploadAuditWriter(options) {
  return createInternalLogWriter({ ...options, fileName: 'upload-audit.log' });
}

function getLogOpenDirectory(targetPath, fallbackDirectory, pathApi = nodePath) {
  return typeof targetPath === 'string' && targetPath ? pathApi.dirname(targetPath) : fallbackDirectory;
}

module.exports = { createInternalLogPathResolver, createInternalLogWriter, createUploadAuditWriter, getLogOpenDirectory };
