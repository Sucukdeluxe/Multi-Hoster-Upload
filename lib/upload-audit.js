const nodePath = require('path');

function getUploadAuditLogPath(uploadLogPath, pathApi = nodePath) {
  if (typeof uploadLogPath !== 'string' || !uploadLogPath.trim()) return null;
  return pathApi.join(pathApi.dirname(uploadLogPath), 'upload-audit.log');
}

function createUploadAuditWriter(options) {
  const source = options && typeof options === 'object' ? options : {};
  const fs = source.fs;
  const path = source.path || nodePath;
  const resolveUploadLogTarget = source.resolveUploadLogTarget;
  const rotateLogFile = typeof source.rotateLogFile === 'function' ? source.rotateLogFile : () => {};
  const invalidateUploadLogTarget = typeof source.invalidateUploadLogTarget === 'function' ? source.invalidateUploadLogTarget : () => {};
  const persistFallbackLogPath = typeof source.persistFallbackLogPath === 'function' ? source.persistFallbackLogPath : async () => {};
  const reportError = typeof source.reportError === 'function' ? source.reportError : () => {};
  const retryDelays = Array.isArray(source.retryDelays) && source.retryDelays.length > 0 ? source.retryDelays : [0, 100, 250];
  const maxBytes = Number.isFinite(source.maxBytes) ? source.maxBytes : 10 * 1024 * 1024;
  const maxBackups = Number.isFinite(source.maxBackups) ? source.maxBackups : 2;
  let activePath = null;

  if (!fs || !fs.promises || typeof fs.promises.appendFile !== 'function' || typeof resolveUploadLogTarget !== 'function') {
    throw new TypeError('createUploadAuditWriter requires fs and resolveUploadLogTarget');
  }

  async function append(line, label) {
    let excludedPath = null;
    for (const delay of retryDelays) {
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      const uploadTarget = resolveUploadLogTarget(excludedPath);
      const targetPath = uploadTarget && getUploadAuditLogPath(uploadTarget.path, path);
      if (!targetPath) continue;
      try {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        rotateLogFile(targetPath, maxBytes, maxBackups);
        await fs.promises.appendFile(targetPath, line, 'utf-8');
        activePath = targetPath;
        if (uploadTarget.isFallback) {
          try {
            await persistFallbackLogPath(uploadTarget.path);
          } catch (error) {
            reportError('audit-fallback-persist', error);
          }
        }
        return true;
      } catch (error) {
        excludedPath = uploadTarget.path;
        invalidateUploadLogTarget();
        reportError(label, error);
      }
    }
    return false;
  }

  return { append, getActivePath: () => activePath };
}

module.exports = { getUploadAuditLogPath, createUploadAuditWriter };
