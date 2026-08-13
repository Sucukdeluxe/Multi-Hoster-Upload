const nodePath = require('path');
const { formatUploadPlanLogLine } = require('./upload-log');

function getUploadAuditLogPath(uploadLogPath, pathApi = nodePath) {
  if (typeof uploadLogPath !== 'string' || !uploadLogPath.trim()) return null;
  return pathApi.join(pathApi.dirname(uploadLogPath), 'upload-audit.log');
}

async function appendDurably(fs, targetPath, line) {
  const handle = await fs.promises.open(targetPath, 'a');
  let appendError = null;
  let closeError = null;
  try {
    await handle.appendFile(line, 'utf-8');
    await handle.sync();
  } catch (error) {
    appendError = error;
  }
  try {
    await handle.close();
  } catch (error) {
    closeError = error;
  }
  if (appendError && closeError) throw new AggregateError([appendError, closeError], 'Audit append and close failed');
  if (appendError) throw appendError;
  if (closeError) throw closeError;
}

function createUploadAuditWriter(options) {
  const source = options && typeof options === 'object' ? options : {};
  const fs = source.fs;
  const path = source.path || nodePath;
  const resolveUploadLogTarget = source.resolveUploadLogTarget;
  const rotateLogFile = typeof source.rotateLogFile === 'function' ? source.rotateLogFile : () => {};
  const invalidateUploadLogTarget = typeof source.invalidateUploadLogTarget === 'function' ? source.invalidateUploadLogTarget : () => {};
  const persistFallbackLogPath = typeof source.persistFallbackLogPath === 'function' ? source.persistFallbackLogPath : async () => false;
  const reportError = typeof source.reportError === 'function' ? source.reportError : () => {};
  const retryDelays = Array.isArray(source.retryDelays) && source.retryDelays.length > 0 ? source.retryDelays : [0, 100, 250];
  const maxBytes = Number.isFinite(source.maxBytes) ? source.maxBytes : 10 * 1024 * 1024;
  const maxBackups = Number.isFinite(source.maxBackups) ? source.maxBackups : 2;
  let activePath = null;

  if (!fs || !fs.promises || typeof fs.promises.open !== 'function' || typeof resolveUploadLogTarget !== 'function') {
    throw new TypeError('createUploadAuditWriter requires fs and resolveUploadLogTarget');
  }

  async function append(line, label) {
    const excludedPaths = new Set();
    for (const delay of retryDelays) {
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      const uploadTarget = resolveUploadLogTarget(excludedPaths);
      if (!uploadTarget || excludedPaths.has(uploadTarget.path)) continue;
      const targetPath = uploadTarget && getUploadAuditLogPath(uploadTarget.path, path);
      if (!targetPath) continue;
      try {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        if (uploadTarget.isFallback) {
          let persisted = false;
          try {
            persisted = await persistFallbackLogPath(uploadTarget.path);
          } catch (error) {
            reportError('audit-fallback-persist', error);
          }
          if (persisted !== true) {
            excludedPaths.add(uploadTarget.path);
            invalidateUploadLogTarget();
            reportError('audit-fallback-persist', new Error('Fallback log path could not be persisted'));
            continue;
          }
        }
        rotateLogFile(targetPath, maxBytes, maxBackups);
        await appendDurably(fs, targetPath, line);
        activePath = targetPath;
        return true;
      } catch (error) {
        excludedPaths.add(uploadTarget.path);
        invalidateUploadLogTarget();
        reportError(label, error);
      }
    }
    return false;
  }

  return { append, getActivePath: () => activePath };
}

function createUploadAuditEvents(writer, now = () => new Date()) {
  if (!writer || typeof writer.append !== 'function') throw new TypeError('createUploadAuditEvents requires an audit writer');
  return {
    appendSourceCleanup: event => writer.append(`# SOURCE-CLEANUP ${JSON.stringify(event)}\r\n`, 'source-cleanup'),
    appendUploadPlan: (plan, mode) => writer.append(formatUploadPlanLogLine(now(), plan, mode), 'upload-plan')
  };
}

async function runAfterDurableAudit(audit, action) {
  let persisted = false;
  try {
    persisted = await audit();
  } catch {}
  if (persisted !== true) return { ok: false };
  return { ok: true, value: await action() };
}

function getUploadAuditFailureMessage(language) {
  return language === 'de'
    ? 'Der Uploadplan konnte nicht dauerhaft protokolliert werden. Bitte prüfe den Log-Pfad und versuche es erneut.'
    : 'The upload plan could not be recorded durably. Check the log path and try again.';
}

module.exports = { getUploadAuditLogPath, createUploadAuditWriter, createUploadAuditEvents, runAfterDurableAudit, getUploadAuditFailureMessage };
