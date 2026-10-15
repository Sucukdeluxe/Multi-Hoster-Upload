const { McpAccessError, validateInput, actionDigest } = require('./mcp-access');
const { sanitizeTransferResult } = require('./mcp-transfers');

const text = (maxLength = 4096) => ({ type: 'string', maxLength });
const id = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_.:-]+$' };
const integer = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
const boolean = { type: 'boolean' };
const enumeration = values => ({ type: 'string', enum: values });
const array = (items, maxItems = 100) => ({ type: 'array', items, maxItems });
const object = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const page = { offset: integer(0, 1000000), limit: integer(1, 200) };
const account = { accountId: id };
const jobIds = { jobIds: array(id, 1000) };
const hoster = enumeration(['doodstream.com', 'voe.sx', 'vidmoly.me', 'byse.sx', 'clouddrop.cc']);
const retention = enumeration(['all', '7d', '14d', '30d', '90d', '1000', '100']);
const file = { rootId: id, relativePath: text() };

const definitions = [
  ['app_info', 'Read application version and runtime information.', 'read', {}, []],
  ['app_state', 'Read live transfer and automation summary.', 'read', {}, []],
  ['queue_list', 'Read a bounded page of upload jobs.', 'read', { ...page, status: text(40) }, []],
  ['queue_job_log', 'Read a bounded, secret-filtered log for one upload job.', 'read', { jobId: id, ...page }, ['jobId']],
  ['queue_add', 'Add files from a granted directory to the upload queue.', 'control', { rootId: id, paths: array(text(), 1000), hosters: array(hoster, 5) }, ['rootId', 'paths', 'hosters']],
  ['queue_start', 'Start eligible queued uploads.', 'control', jobIds, []],
  ['queue_pause', 'Pause new uploads after current transfers.', 'control', {}, []],
  ['queue_resume', 'Resume the shared upload and automation pause.', 'control', {}, []],
  ['queue_retry', 'Retry selected failed jobs.', 'control', jobIds, ['jobIds']],
  ['queue_cancel', 'Cancel selected running or queued jobs.', 'control', jobIds, ['jobIds']],
  ['queue_remove', 'Remove selected jobs without deleting source files.', 'control', jobIds, ['jobIds'], true],
  ['queue_clear', 'Clear inactive jobs without deleting source files.', 'control', {}, [], true],
  ['accounts_list', 'Read a bounded page of configured accounts with secrets hidden.', 'read', { ...page, hoster }, []],
  ['accounts_runtime', 'Read temporary account cooldowns and manual-action states.', 'read', { ...page, hoster }, []],
  ['accounts_check', 'Check selected account credentials without revealing them.', 'accounts', { accountIds: array(id, 100) }, ['accountIds']],
  ['accounts_add', 'Add a hoster account with explicit credentials.', 'accounts', { hoster, label: text(200), username: text(320), password: text(), apiKey: text(), authType: enumeration(['login', 'api']) }, ['hoster', 'authType']],
  ['accounts_update', 'Update one account without exposing stored credentials.', 'accounts', { ...account, label: text(200), username: text(320), password: text(), apiKey: text(), enabled: boolean }, ['accountId']],
  ['accounts_otp', 'Submit a one-time code for a selected account.', 'accounts', { ...account, code: { type: 'string', minLength: 4, maxLength: 12, pattern: '^[A-Za-z0-9]+$' } }, ['accountId', 'code']],
  ['accounts_request_otp', 'Explicitly request a new one-time code for an account.', 'accounts', account, ['accountId']],
  ['accounts_priority', 'Move an account in the hoster fallback order.', 'accounts', { ...account, direction: enumeration(['up', 'down']) }, ['accountId', 'direction']],
  ['accounts_remove', 'Remove one configured account.', 'accounts', account, ['accountId'], true],
  ['accounts_reset_failure', 'Reset the temporary failure state of one account.', 'accounts', account, ['accountId']],
  ['settings_get', 'Read settings with secrets masked.', 'read', {}, []],
  ['settings_update', 'Update explicitly supported application settings.', 'settings', {
    language: enumeration(['de', 'en']), globalMaxSpeedKbs: integer(0, 100000000), parallelUploadCount: integer(0, 100),
    autoRetryRounds: integer(0, 5), autoRetryDelayMin: integer(1, 1440), autoHealthCheckEnabled: boolean,
    resumeQueueOnLaunch: boolean, autoStartRestoredQueue: boolean, removeFromQueueOnDone: boolean,
    logMode: enumeration(['single', 'daily', 'session']), logVerbose: boolean
  }, []],
  ['hoster_settings_update', 'Update one hoster transfer configuration.', 'settings', {
    hoster, retries: integer(0, 20), parallelCount: integer(1, 100), maxSpeedKbs: integer(0, 100000000),
    restartBelowKbs: integer(0, 100000000), timeIntervalSec: integer(0, 86400), maxSizeMb: integer(0, 100000000),
    rotateAccounts: boolean, logToFile: boolean
  }, ['hoster']],
  ['automation_status', 'Read folder-monitor and automatic retry state.', 'read', {}, []],
  ['automation_update', 'Configure monitoring for an explicitly granted directory.', 'settings', {
    rootId: id, recursive: boolean, includeExisting: boolean, filterMode: enumeration(['include', 'exclude']),
    extensions: text(200), delaySec: integer(0, 3600), autoStart: boolean, hosters: array(hoster, 5),
    queueLimitJobs: integer(0, 100000), reconcileIntervalMinutes: integer(1, 1440)
  }, ['rootId'], true],
  ['automation_start', 'Start configured folder monitoring.', 'control', {}, []],
  ['automation_stop', 'Stop folder monitoring without removing queued jobs.', 'control', {}, []],
  ['automation_scan', 'Run a read-only folder monitoring test scan.', 'read', {}, []],
  ['automation_reconcile', 'Reconcile the monitored directory with the queue.', 'control', {}, []],
  ['history_list', 'Read a bounded page of upload history.', 'read', page, []],
  ['history_summary', 'Read aggregate hoster statistics and recent batch summaries.', 'read', { limit: integer(1, 200) }, []],
  ['history_prune', 'Apply a retention policy to upload history.', 'control', { retention }, ['retention'], true],
  ['history_clear', 'Clear upload history.', 'control', {}, [], true],
  ['diagnostics_summary', 'Read filtered application diagnostics.', 'diagnostics', {}, []],
  ['app_events', 'Read recent secret-filtered application events.', 'read', { limit: integer(1, 200) }, []],
  ['errors', 'Read classified upload failures from persisted history.', 'read', { limit: integer(1, 200), sinceMs: integer(0, 8640000000000000), category: text(80), hoster }, []],
  ['logs_list', 'List the application-managed diagnostic logs.', 'diagnostics', {}, []],
  ['logs_read', 'Read a bounded, secret-filtered application log tail.', 'diagnostics', {
    name: enumeration(['debug', 'fileuploader', 'uploadAudit', 'accountRotation', 'crash']),
    tailKb: integer(1, 256), backup: integer(0, 2), grep: text(200)
  }, ['name']],
  ['diagnostics_files', 'List startup journals, native logs and saved startup failure reports.', 'diagnostics', page, []],
  ['diagnostics_read', 'Read a page of a fully secret-filtered startup diagnostic artifact. Offsets and limits count redacted characters.', 'diagnostics',
    { artifactId: id, offset: integer(0, 100000000), limit: integer(1, 65536) }, ['artifactId']],
  ['files_roots', 'List configured directory grants, without granting new access.', 'files', {}, []],
  ['files_list', 'List a bounded page within a granted directory.', 'files', { ...file, ...page }, ['rootId']],
  ['files_stat', 'Read metadata for a file within a granted directory.', 'files', file, ['rootId', 'relativePath']],
  ['files_hash', 'Compute a bounded file checksum within a granted directory.', 'files', { ...file, algorithm: enumeration(['sha256', 'sha512']) }, ['rootId', 'relativePath']],
  ['files_transfer_open', 'Prepare a stable read-only file transfer from a directory with explicit content-transfer permission. Use a receiver to stream chunks outside chat.', 'files', file, ['rootId', 'relativePath']],
  ['files_transfer_get', 'Read preparation state, byte size and SHA-256 for an owned file transfer.', 'files', { transferId: id }, ['transferId']],
  ['files_transfer_list', 'List this authenticated client\'s active file transfers.', 'files', {}, []],
  ['files_transfer_read', 'Read one verified binary chunk of an owned prepared transfer. Intended for a streaming receiver, not rendering in chat.', 'files',
    { transferId: id, offset: integer(0, 32 * 1024 ** 3), length: integer(1, 1024 * 1024) }, ['transferId', 'offset']],
  ['files_transfer_close', 'Close an owned temporary transfer handle without modifying its source file.', 'files', { transferId: id }, ['transferId']],
  ['files_delete', 'Delete a specifically selected file inside a writable grant.', 'files.write', file, ['rootId', 'relativePath'], true],
  ['cloud_status', 'Read CloudDrop log synchronization state.', 'read', {}, []],
  ['cloud_configure', 'Enable or disable CloudDrop log sync with the saved or supplied key.', 'settings', { enabled: boolean, apiKey: text(200) }, ['enabled']],
  ['cloud_backfill', 'Queue missing entries from the current local upload log.', 'control', {}, []],
  ['backup_list', 'List online backups with keys masked.', 'read', {}, []],
  ['backup_create', 'Create an encrypted settings-only online backup.', 'backup', { retention: enumeration(['1d', '3d', '7d', '31d', 'forever']) }, ['retention']],
  ['backup_delete', 'Delete a selected managed online backup.', 'backup', { id }, ['id'], true],
  ['backup_restore', 'Restore settings from an explicitly supplied online key.', 'backup', { key: text(200) }, ['key'], true],
  ['update_check', 'Check for an application update without installing it.', 'read', {}, []],
  ['update_install', 'Install an available application update.', 'lifecycle', {}, [], true],
  ['app_restart', 'Restart the application after persisting its state.', 'lifecycle', {}, [], true],
  ['app_quit', 'Close the application after persisting its state.', 'lifecycle', {}, [], true],
  ['secrets_read', 'Explicitly reveal credentials for one account; disabled by default.', 'secrets.read', account, ['accountId']]
];

const capabilities = { diagnostics: 'read', accounts: 'control', settings: 'control', backup: 'control', lifecycle: 'control', 'secrets.read': 'secrets', 'files.write': 'files' };
const MCP_TOOLS = Object.freeze(definitions.map(([name, description, scope, properties, required, destructive = false]) => Object.freeze({
  name: 'mhu_' + name, description, scope: capabilities[scope] || scope, destructive, inputSchema: object(properties, required),
  requiredScopes: [...new Set([capabilities[scope] || scope, ...(['queue_add', 'automation_update'].includes(name) ? ['files'] : []), ...(name === 'files_delete' ? ['control'] : []), ...(name.startsWith('files_transfer_') ? ['read'] : [])])],
  annotations: { readOnlyHint: ['read', 'diagnostics', 'files', 'secrets.read'].includes(scope) && !['files_transfer_open', 'files_transfer_close'].includes(name), destructiveHint: destructive,
    idempotentHint: ['read', 'diagnostics', 'files', 'secrets.read'].includes(scope) && name !== 'files_transfer_open', openWorldHint: /^(?:queue_(?:start|retry|resume)|accounts_(?:check|otp|request_otp)|automation_(?:start|reconcile)|cloud_|backup_|update_)/.test(name) }
})));

function createMcpToolAdapter({ handlers, authorizeConfirmation, sanitize, audit = () => {}, getCapabilities, requiresConfirmation = () => false }) {
  const byName = new Map(MCP_TOOLS.map(tool => [tool.name, tool]));
  const active = new Map();
  const recent = new Map();
  const mutations = { tail: Promise.resolve() };
  async function call(name, args, context) {
    const tool = byName.get(name);
    if (!tool || typeof handlers[name] !== 'function') throw new McpAccessError('TOOL_UNAVAILABLE');
    const allowed = () => getCapabilities ? getCapabilities() : context?.scopes;
    const permitted = () => Array.isArray(allowed()) && tool.requiredScopes.every(scope => allowed().includes(scope));
    if (!permitted()) throw new McpAccessError('SCOPE_DENIED');
    validateInput(args, tool.inputSchema);
    if (context.signal?.aborted || !Number.isFinite(context.deadline) || context.deadline <= Date.now()) throw new McpAccessError('REQUEST_EXPIRED');
    const digest = actionDigest(name, args);
    const requestKey = `${context.principalId}:${context.requestId}`;
    if (typeof context.principalId !== 'string' || !/^[A-Za-z0-9_:-]{1,128}$/.test(context.principalId)
      || typeof context.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(context.requestId)) throw new McpAccessError('INVALID_REQUEST');
    for (const [key, entry] of recent) if (entry.until < Date.now()) recent.delete(key);
    const previous = active.get(requestKey) || recent.get(requestKey);
    if (previous) {
      if (previous.digest !== digest) throw new McpAccessError('REQUEST_CONFLICT');
      return previous.promise;
    }
    if (active.size >= 32 || recent.size >= 512) throw new McpAccessError('TOO_MANY_REQUESTS');
    const execute = async () => {
      const startedAt = Date.now();
      if (context.signal?.aborted || Date.now() >= context.deadline) throw new McpAccessError('REQUEST_EXPIRED');
      if (!permitted()) throw new McpAccessError('SCOPE_DENIED');
      if ((tool.destructive || requiresConfirmation(name, args)) && (!authorizeConfirmation || !await authorizeConfirmation({ tool: name, digest, args, context }))) throw new McpAccessError('CONFIRMATION_REQUIRED');
      if (context.signal?.aborted || Date.now() >= context.deadline) throw new McpAccessError('REQUEST_EXPIRED');
      if (!permitted()) throw new McpAccessError('SCOPE_DENIED');
      audit({ tool: name, event: 'started', requestId: context.requestId, durationMs: 0 });
      const value = await handlers[name](args, context);
      if (context.signal?.aborted || Date.now() >= context.deadline) throw new McpAccessError('REQUEST_EXPIRED');
      if (!permitted()) throw new McpAccessError('SCOPE_DENIED');
      const result = name.startsWith('mhu_files_transfer_') ? sanitizeTransferResult(name, value, sanitize) : name === 'mhu_secrets_read' ? value : await sanitize(value);
      if (Buffer.byteLength(JSON.stringify(result) || 'null') > (name === 'mhu_files_transfer_read' ? 2 : 1) * 1024 * 1024) throw new McpAccessError('RESULT_TOO_LARGE');
      audit({ tool: name, event: 'completed', requestId: context.requestId, durationMs: Date.now() - startedAt });
      return result;
    };
    const promise = tool.annotations.readOnlyHint ? execute() : mutations.tail.then(execute);
    if (!tool.annotations.readOnlyHint) mutations.tail = promise.catch(() => {});
    active.set(requestKey, { digest, promise });
    try { return await promise; }
    catch (error) { audit({ tool: name, event: 'failed', requestId: context.requestId, code: error instanceof McpAccessError ? error.code : 'ACTION_FAILED' }); throw error instanceof McpAccessError ? error : new McpAccessError('ACTION_FAILED'); }
    finally { active.delete(requestKey); recent.set(requestKey, { digest, promise, until: Date.now() + 120000 }); }
  }
  return { list: () => MCP_TOOLS.filter(tool => typeof handlers[tool.name] === 'function'), call };
}

module.exports = { MCP_TOOLS, createMcpToolAdapter };
