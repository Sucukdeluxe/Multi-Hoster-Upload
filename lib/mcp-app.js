const { randomUUID } = require('node:crypto');
const { McpAccessError, resolveGrantedFile } = require('./mcp-access');
const { createMcpFiles } = require('./mcp-files');

function page(items, args) {
  const offset = args.offset || 0;
  const limit = args.limit || 100;
  return { total: items.length, offset, items: items.slice(offset, offset + limit), nextOffset: offset + limit < items.length ? offset + limit : null };
}

function createMcpApp({ loadConfig, invoke, invokeGuarded = (_context, channel, ...args) => invoke(channel, ...args), renderer, collectors, getGrants, trashFile, canWrite }) {
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
    await invoke('save-global-settings', { ...loadConfig().globalSettings, ...patch });
    await refresh(context);
    return { saved: true };
  };
  return {
    ...createMcpFiles({ getGrants, trashFile }),
    mhu_app_info: () => invoke('get-app-info'),
    mhu_app_state: async (args, context) => ({ ...(await renderer('state', {}, context)), automation: await invoke('automation:get-status') }),
    mhu_queue_list: (args, context) => renderer('queue-list', args, context),
    mhu_queue_add: async (args, context) => {
      if (!args.paths.length || !args.hosters.length) throw new McpAccessError('INVALID_ARGUMENTS');
      const files = [];
      for (const relativePath of args.paths) { guard(context); const target = await resolveGrantedFile(getGrants(), args.rootId, relativePath, { regularFile: true }); files.push(target.path); }
      guard(context);
      return renderer('queue-add', { paths: files, hosters: args.hosters }, context);
    },
    mhu_queue_start: (args, context) => renderer('queue-start', args, context),
    mhu_queue_pause: () => invoke('automation:pause-after-active'),
    mhu_queue_resume: async (args, context) => { guard(context); return invoke('automation:resume'); },
    mhu_queue_retry: (args, context) => renderer('queue-retry', args, context),
    mhu_queue_cancel: (args, context) => renderer('queue-cancel', args, context),
    mhu_queue_remove: (args, context) => renderer('queue-remove', args, context),
    mhu_queue_clear: (args, context) => renderer('queue-clear', args, context),
    mhu_accounts_list: args => page(accounts().filter(account => !args.hoster || args.hoster === account.hoster), args),
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
    mhu_settings_update: (args, context) => saveGlobal(args, context),
    mhu_hoster_settings_update: async ({ hoster, ...patch }, context) => {
      canWrite(); guard(context);
      const current = loadConfig().hosterSettings;
      await invoke('save-hoster-settings', { ...current, [hoster]: { ...current[hoster], ...patch } });
      await refresh(context);
      return { saved: true };
    },
    mhu_automation_status: () => invoke('automation:get-status'),
    mhu_automation_update: async ({ rootId, ...patch }, context) => {
      const folder = await resolveGrantedFile(getGrants(), rootId, '');
      if (!folder.stat.isDirectory()) throw new McpAccessError('NOT_A_DIRECTORY');
      const result = await saveGlobal({ folderMonitor: { ...loadConfig().globalSettings.folderMonitor, ...patch, folderPath: folder.path, enabled: false } }, context);
      await invoke('folder-monitor:stop');
      return { ...result, enabled: false };
    },
    mhu_automation_start: async (args, context) => {
      const settings = loadConfig().globalSettings.folderMonitor;
      if (!getGrants().some(grant => grant.path === settings.folderPath)) throw new McpAccessError('PATH_NOT_GRANTED');
      await saveGlobal({ folderMonitor: { ...settings, enabled: true } }, context); guard(context);
      return invoke('folder-monitor:start', { ...settings, enabled: true });
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
    mhu_history_clear: () => invoke('clear-history'),
    mhu_diagnostics_summary: () => ({ system: collectors.getSystemInfo(), health: collectors.getHealth(), rotation: collectors.getRotationState() }),
    mhu_logs_list: () => collectors.listLogs(),
    mhu_logs_read: args => collectors.readLog(args),
    mhu_cloud_status: () => invoke('cloud-log:status'),
    mhu_cloud_configure: args => invoke('cloud-log:configure', args),
    mhu_cloud_backfill: () => invoke('cloud-log:backfill'),
    mhu_backup_list: () => invoke('online-backup:list-managed'),
    mhu_backup_create: args => invoke('online-backup:create-managed', args.retention),
    mhu_backup_delete: args => invoke('online-backup:delete-managed', args.id),
    mhu_backup_restore: async (args, context) => { const result = await invokeGuarded(context, 'online-backup:restore', args.key); if (!result.ok) throw new McpAccessError('RESTORE_FAILED'); await refresh(context); return { ok: true, warnings: result.warnings }; },
    mhu_update_check: () => invoke('app:check-updates', { forceRefresh: true }),
    mhu_update_install: (args, context) => invokeGuarded(context, 'app:install-update'),
    mhu_app_restart: () => invoke('app:restart'),
    mhu_app_quit: () => invoke('app:quit'),
    mhu_secrets_read: args => { const { password, apiKey } = find(args.accountId); return { accountId: args.accountId, password: password || '', apiKey: apiKey || '' }; }
  };
}

module.exports = { createMcpApp, page };
