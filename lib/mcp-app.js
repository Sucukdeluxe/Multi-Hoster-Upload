const { randomUUID } = require('node:crypto');
const { getUploadReadSnapshot, setUploadReadLimit } = require('./upload-file-io');
const path = require('node:path');
const { McpAccessError, resolveGrantedFile } = require('./mcp-access');
const { createMcpFiles } = require('./mcp-files');
const { createMcpTransfers } = require('./mcp-transfers');
const { createMcpDiagnostics } = require('./mcp-diagnostics');
const { createMcpSanitizer } = require('./mcp-security');
const { MCP_TOOLS, requiresMcpConfirmation } = require('./mcp-tools');
const { redactLogText, collectSecretValues } = require('./support-bundle');

function page(items, args) {
  const offset = args.offset || 0;
  const limit = args.limit || 100;
  return { total: items.length, offset, items: items.slice(offset, offset + limit), nextOffset: offset + limit < items.length ? offset + limit : null };
}

function createMcpApp({ loadConfig, invoke, invokeGuarded = (_context, channel, ...args) => invoke(channel, ...args), renderer, collectors, getGrants, trashFile, canWrite,
  getCapabilities, getProtectedPaths, getInstallationId, getDiagnosticSources, getRuntimeDiagnostics = () => null, getPerformance = () => null, getSystemMetrics = () => null, profile, updates }) {
  const transfers = createMcpTransfers({ getGrants, getCapabilities, getProtectedPaths, getInstallationId });
  const sanitize = createMcpSanitizer(loadConfig);
  const guard = context => {
    if (context.signal?.aborted || Date.now() >= context.deadline) throw new McpAccessError('REQUEST_EXPIRED');
  };
  const accounts = () => Object.entries(loadConfig().hosters).flatMap(([hoster, list]) => Array.isArray(list) ? list.map(account => ({ hoster, ...account })) : []);
  const find = id => {
    const found = accounts().find(account => account.id === id);
    if (!found) throw new McpAccessError('ACCOUNT_NOT_FOUND');
    return found;
  };
  const refresh = async context => { if (!context.signal?.aborted) await renderer('refresh', {}, context).catch(() => {}); };
  const saveAccount = async (id, patch, context, remove = false) => {
    canWrite(); guard(context);
    const latest = loadConfig();
    const found = find(id);
    const next = latest.hosters[found.hoster].filter(account => !remove || account.id !== id).map(account => account.id === id ? { ...account, ...patch } : account);
    await invoke('save-config', { hosters: { ...latest.hosters, [found.hoster]: next } });
    await refresh(context);
    return { accountId: id, saved: true };
  };
  const check = async (ids, context, options = {}) => {
    const results = [];
    for (const id of [...new Set(ids)]) {
      guard(context);
      const found = find(id);
      const result = await invoke('run-health-check', { hosters: [{ hoster: found.hoster, accountId: id, ...options }] });
      results.push(...result.results);
    }
    await renderer('account-results', { results }, context).catch(() => {});
    return { results };
  };
  const saveGlobal = async (patch, context) => {
    canWrite(); guard(context);
    const current = loadConfig().globalSettings;
    await invoke('save-global-settings', { ...current, ...patch, ...(patch.scramble ? { scramble: { ...current.scramble, ...patch.scramble } } : {}) });
    await refresh(context);
    return { saved: true };
  };
  const automationAction = async (channel, code, context) => {
    canWrite(); guard(context);
    const result = await invoke(channel);
    if (result?.error || result?.monitorError) throw new McpAccessError(code);
    if (channel === 'automation:resume') await renderer('automation-resume', {}, context);
    return result;
  };
  const handlers = {
    ...createMcpFiles({ getGrants, trashFile }),
    ...transfers.handlers,
    ...createMcpDiagnostics({ getSources: getDiagnosticSources, redact: text => sanitize(redactLogText(text, collectSecretValues(loadConfig()))) }),
    mhu_app_info: () => invoke('get-app-info'),
    mhu_capabilities: () => {
      const permissions = getCapabilities?.() || [];
      const settings = loadConfig().globalSettings;
      return { permissions, tools: MCP_TOOLS.filter(tool => tool.requiredScopes.every(scope => permissions.includes(scope))).map(tool => ({
        name: tool.name, readOnly: tool.annotations.readOnlyHint, requiredScopes: tool.requiredScopes,
        localConfirmation: tool.destructive || requiresMcpConfirmation(tool.name, {}, settings),
        conditionalConfirmation: tool.name === 'mhu_settings_update'
      })), boundaries: ['Permissions and directory grants can only be changed locally.', 'Destructive actions require an exact local confirmation; MCP cannot approve it.', 'No arbitrary shell, SQL, mouse/keyboard or screen control.', 'Paused automation is resumed with mhu_automation_resume. A disabled monitor requires mhu_automation_start.'] };
    },
    mhu_performance_get: () => getPerformance(),
    mhu_profile_start: args => profile.start(args.seconds),
    mhu_profile_get: () => profile.snapshot(),
    mhu_io_limits_get: () => getUploadReadSnapshot(),
    mhu_io_limits_update: ({ readConcurrency }, context) => {
      canWrite(); guard(context);
      return setUploadReadLimit(readConcurrency);
    },
    mhu_system_metrics: args => getSystemMetrics(args),
    mhu_app_state: async (args, context) => ({ ...(await renderer('state', {}, context)), automation: await invoke('automation:get-status') }),
    mhu_queue_list: (args, context) => renderer('queue-list', args, context),
    mhu_queue_job_log: async args => page(await invoke('get-job-log', args.jobId), args),
    mhu_queue_add: async (args, context) => {
      if (!args.paths.length || !args.hosters.length) throw new McpAccessError('INVALID_ARGUMENTS');
      const files = [];
      for (const relativePath of args.paths) { guard(context); const target = await resolveGrantedFile(getGrants(), args.rootId, relativePath, { regularFile: true }); files.push(target.path); }
      guard(context);
      return renderer('queue-add', { paths: files, hosters: args.hosters }, context);
    },
    mhu_queue_start: (args, context) => renderer('queue-start', args, context),
    mhu_queue_pause: (args, context) => automationAction('automation:pause-after-active', 'AUTOMATION_PAUSE_FAILED', context),
    mhu_queue_resume: (args, context) => automationAction('automation:resume', 'AUTOMATION_RESUME_FAILED', context),
    mhu_queue_retry: (args, context) => renderer('queue-retry', args, context),
    mhu_queue_cancel: (args, context) => renderer('queue-cancel', args, context),
    mhu_queue_remove: (args, context) => renderer('queue-remove', args, context),
    mhu_queue_clear: (args, context) => renderer('queue-clear', args, context),
    mhu_accounts_list: args => page(accounts().filter(account => !args.hoster || args.hoster === account.hoster), args),
    mhu_accounts_runtime: async args => {
      const state = await invoke('get-session-failed-account-states');
      return { revision: state.revision, now: state.now, ...page(state.accounts.filter(account => !args.hoster || account.hoster === args.hoster), args) };
    },
    mhu_accounts_check: (args, context) => { if (!args.accountIds.length) throw new McpAccessError('INVALID_ARGUMENTS'); return check(args.accountIds, context); },
    mhu_accounts_add: async (args, context) => {
      canWrite(); guard(context);
      if ((args.authType === 'login' && (!args.username || !args.password)) || (args.authType === 'api' && !args.apiKey)
        || (['byse.sx', 'clouddrop.cc'].includes(args.hoster) && args.authType !== 'api') || (args.hoster === 'vidmoly.me' && args.authType !== 'login')) throw new McpAccessError('INVALID_ARGUMENTS');
      const latest = loadConfig();
      const id = randomUUID();
      const { hoster, ...account } = args;
      await invoke('save-config', { hosters: { ...latest.hosters, [hoster]: [...latest.hosters[hoster], { ...account, id, enabled: false }] } });
      await refresh(context);
      return { accountId: id, enabled: false, verificationRequired: true };
    },
    mhu_accounts_update: ({ accountId, ...patch }, context) => saveAccount(accountId, patch, context),
    mhu_accounts_otp: (args, context) => check([args.accountId], context, { otp: args.code }),
    mhu_accounts_request_otp: (args, context) => check([args.accountId], context, { requestNewOtp: true }),
    mhu_accounts_priority: async (args, context) => {
      canWrite(); guard(context);
      const found = find(args.accountId);
      const latest = loadConfig();
      const list = [...latest.hosters[found.hoster]];
      const index = list.findIndex(account => account.id === args.accountId);
      const target = Math.max(0, Math.min(list.length - 1, index + (args.direction === 'up' ? -1 : 1)));
      const [item] = list.splice(index, 1); list.splice(target, 0, item);
      await invoke('save-config', { hosters: { ...latest.hosters, [found.hoster]: list } });
      await refresh(context);
      return { saved: true, position: target };
    },
    mhu_accounts_remove: (args, context) => saveAccount(args.accountId, {}, context, true),
    mhu_accounts_reset_failure: args => { const account = find(args.accountId); return invoke('reset-session-failed-account', { hoster: account.hoster, accountId: args.accountId }); },
    mhu_settings_get: () => { const config = loadConfig(); const settings = { ...config.globalSettings }; delete settings.pendingQueue; delete settings.uploadRecovery; return { globalSettings: settings, hosterSettings: config.hosterSettings }; },
    mhu_settings_update: async (args, context) => {
      const result = await saveGlobal(args, context);
      if (Object.hasOwn(args, 'shutdownAfterFinish')) await invoke('set-shutdown-after-finish', args.shutdownAfterFinish);
      return result;
    },
    mhu_hoster_settings_update: async ({ hoster, ...patch }, context) => {
      canWrite(); guard(context);
      const current = loadConfig().hosterSettings;
      await invoke('save-hoster-settings', { ...current, [hoster]: { ...current[hoster], ...patch } });
      await refresh(context);
      return { saved: true };
    },
    mhu_automation_status: () => invoke('automation:get-status'),
    mhu_automation_pause: (args, context) => automationAction('automation:pause-after-active', 'AUTOMATION_PAUSE_FAILED', context),
    mhu_automation_resume: (args, context) => automationAction('automation:resume', 'AUTOMATION_RESUME_FAILED', context),
    mhu_automation_update: async ({ rootId, ...patch }, context) => {
      const folder = await resolveGrantedFile(getGrants(), rootId, '');
      if (!folder.stat.isDirectory()) throw new McpAccessError('NOT_A_DIRECTORY');
      const result = await saveGlobal({ folderMonitor: { ...loadConfig().globalSettings.folderMonitor, ...patch, folderPath: folder.path, enabled: false } }, context);
      await invoke('folder-monitor:stop');
      return { ...result, enabled: false };
    },
    mhu_automation_start: async (args, context) => {
      const settings = loadConfig().globalSettings.folderMonitor;
      if (settings.paused === true) throw new McpAccessError('AUTOMATION_PAUSED');
      const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
      if (!settings.folderPath || !getGrants().some(grant => normalize(grant.path) === normalize(settings.folderPath))) throw new McpAccessError('PATH_NOT_GRANTED');
      await saveGlobal({ folderMonitor: { ...settings, enabled: true } }, context); guard(context);
      const result = await invoke('folder-monitor:start', { ...settings, enabled: true });
      if (result?.error) throw new McpAccessError('AUTOMATION_START_FAILED');
      return result;
    },
    mhu_automation_stop: async (args, context) => { await saveGlobal({ folderMonitor: { ...loadConfig().globalSettings.folderMonitor, enabled: false } }, context); return invoke('folder-monitor:stop'); },
    mhu_automation_scan: () => invoke('folder-monitor:test-scan'),
    mhu_automation_reconcile: () => invoke('folder-monitor:reconcile'),
    mhu_history_list: async args => {
      const batches = await invoke('get-history');
      const rows = batches.flatMap(batch => (batch.files || []).flatMap(file => (file.results || []).map(result => ({ timestamp: batch.timestamp, fileName: file.fileName || file.name, ...result }))));
      return page(rows, args);
    },
    mhu_history_prune: args => invoke('prune-history', { retention: args.retention, dryRun: false }),
    mhu_history_summary: args => collectors.getHistory({ limit: args.limit || 20 }),
    mhu_history_clear: () => invoke('clear-history'),
    mhu_diagnostics_summary: async () => {
      const server = await collectors.serverHealth({ errorLimit: 20 });
      return { system: server.server, health: collectors.getHealth(), rotation: collectors.getRotationState(), server, runtime: getRuntimeDiagnostics() };
    },
    mhu_app_events: (args, context) => collectors.getAppEvents(args, context),
    mhu_errors: args => collectors.listErrors(args),
    mhu_logs_list: () => collectors.listLogs(),
    mhu_logs_read: (args, context) => collectors.readLog(args, context),
    mhu_cloud_status: () => invoke('cloud-log:status'),
    mhu_cloud_configure: args => invoke('cloud-log:configure', args),
    mhu_cloud_backfill: () => invoke('cloud-log:backfill'),
    mhu_backup_list: () => invoke('online-backup:list-managed'),
    mhu_backup_create: args => invoke('online-backup:create-managed', args.retention),
    mhu_backup_delete: args => invoke('online-backup:delete-managed', args.id),
    mhu_backup_restore: async (args, context) => { const result = await invokeGuarded(context, 'online-backup:restore', args.key); if (!result.ok) throw new McpAccessError('RESTORE_FAILED'); await refresh(context); return { ok: true, warnings: result.warnings }; },
    mhu_update_check: () => invoke('app:check-updates', { forceRefresh: true }),
    mhu_update_install: (args, context) => updates.start(args, context),
    mhu_update_status: (args, context) => updates.status(args, context),
    mhu_app_restart: () => invoke('app:restart'),
    mhu_app_quit: () => invoke('app:quit'),
    mhu_shutdown_cancel: async (args, context) => {
      canWrite(); guard(context);
      await invoke('cancel-shutdown');
      await saveGlobal({ shutdownAfterFinish: 'nothing' }, context);
      return { cancelled: true, shutdownAfterFinish: 'nothing' };
    },
    mhu_secrets_read: args => { const { password, apiKey } = find(args.accountId); return { accountId: args.accountId, password: password || '', apiKey: apiKey || '' }; }
  };
  Object.defineProperty(handlers, 'dispose', { value: () => transfers.dispose() });
  return handlers;
}

module.exports = { createMcpApp, page };
