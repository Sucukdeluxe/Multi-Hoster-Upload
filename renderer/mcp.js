(() => {
  const cancelled = new Set();
  const text = (de, _en) => de;
  const page = (items, args) => {
    const offset = args.offset || 0;
    const limit = args.limit || 100;
    return { total: items.length, offset, items: items.slice(offset, offset + limit), nextOffset: offset + limit < items.length ? offset + limit : null };
  };
  const refresh = async () => {
    config = await window.api.getConfig();
    hosterSettings = config.hosterSettings || {};
    ensureAccountStatusEntries(); syncSelectedUploadHosters(); renderAccounts(); renderHosterSummary();
  };
  const redraw = () => { rebuildJobIndex(); _queueStatsCache = null; syncSelectedFilesFromQueue(); renderQueueTable(); updateUploadView({ rebuildPreview: false }); updateStatusBar(); };
  const select = args => {
    const ids = new Set(args.jobIds || []);
    const jobs = queueJobs.filter(job => ids.has(job.id));
    if (jobs.length !== ids.size) throw new Error('JOB_NOT_FOUND');
    return jobs;
  };
  const handlers = {
    state: async () => ({ source: 'live', stale: false, uploading, queueCount: queueJobs.length, selectedFileCount: selectedFiles.length, selectedHosters: getSelectedHosters(), counts: queueJobs.reduce((out, job) => { out[job.status] = (out[job.status] || 0) + 1; return out; }, {}) }),
    refresh,
    'account-results': async args => { for (const row of args.results) { if (findAccountById(row.accountId)) accountStatuses[row.accountId] = { status: row.status, message: row.message, storage: row.storage, checkedAt: row.checkedAt || new Date().toISOString() }; } renderAccounts(); return { updated: args.results.length }; },
    'queue-list': async args => page(queueJobs.filter(job => !args.status || job.status === args.status).map(job => ({ id: job.id, file: job.file, fileName: job.fileName, hoster: job.hoster, status: job.status, bytesUploaded: job.bytesUploaded, bytesTotal: job.bytesTotal, speedKbs: job.speedKbs, error: job.error, result: job.result, attempt: job.attempt })), args),
    'queue-add': async (args, guard) => {
      const inspection = await window.api.inspectImportFiles(args.paths, existingImportPaths());
      await guard();
      const jobs = inspection.accepted.flatMap(file => args.hosters.filter(hoster => window.ImportPreflight.isImportPairEligible(file, hoster, hosterSettings)).map(hoster => ({ ...createAutomationPreviewJob(file, hoster), automationAdmission: false, mcpAdmission: true })));
      clearDedupKeysForPaths(new Set(inspection.accepted.map(file => file.path)));
      queueJobs.push(...jobs); redraw(); await persistQueueStateNow();
      return { addedJobs: jobs.length, rejectedFiles: inspection.duplicateCount + inspection.unavailableCount };
    },
    'queue-start': async (args, guard) => {
      const jobs = args.jobIds?.length ? select(args) : queueJobs.filter(job => isStartableQueueStatus(job.status));
      await guard();
      if (!jobs.length) return { started: false, reason: 'NO_ELIGIBLE_JOBS' };
      return await startSelectedUpload(jobs, { guard }) || { started: false };
    },
    'queue-retry': async (args, guard) => {
      const jobs = select(args);
      if (jobs.some(job => !['error', 'aborted', 'skipped'].includes(job.status))) throw new Error('JOB_NOT_RETRYABLE');
      await guard();
      for (const job of jobs) {
        if (job.uploadId) { _jobIndexByUploadId.delete(job.uploadId); _deletedJobIds.add(job.uploadId); }
        Object.assign(job, { status: 'preview', error: null, result: null, bytesUploaded: 0, progress: 0, uploadId: null, mcpAdmission: true });
      }
      redraw(); await persistQueueStateNow(); await guard();
      return await startSelectedUpload(jobs, { guard }) || { started: false };
    },
    'queue-cancel': async (args, guard) => {
      const jobs = select(args);
      await guard();
      await window.api.cancelSelectedJobs(jobs.map(job => job.id));
      for (const job of jobs) if (!['done', 'error', 'skipped'].includes(job.status)) Object.assign(job, { status: 'aborted', speedKbs: 0, error: 'Abgebrochen' });
      redraw(); await persistQueueStateNow(); return { cancelled: jobs.length };
    },
    'queue-remove': async (args, guard) => {
      const jobs = select(args);
      if (jobs.some(job => !['preview', 'done', 'error', 'skipped', 'aborted'].includes(job.status))) throw new Error('CANCEL_ACTIVE_JOBS_FIRST');
      await guard();
      const ids = new Set(jobs.map(job => job.id));
      jobs.forEach(job => removeJobFromIndex(job)); queueJobs = queueJobs.filter(job => !ids.has(job.id));
      redraw(); await persistQueueStateNow(); return { removed: jobs.length };
    },
    'queue-clear': async (args, guard) => handlers['queue-remove']({ jobIds: queueJobs.filter(job => ['preview', 'done', 'error', 'skipped', 'aborted'].includes(job.status)).map(job => job.id) }, guard)
  };
  window.api.onMcpCancel(id => { cancelled.add(id); if (cancelled.size > 128) cancelled.delete(cancelled.values().next().value); });
  window.api.onMcpAction(async request => {
    const guard = async () => { if (cancelled.has(request.id) || Date.now() >= request.deadline || !await window.api.mcpCheck(request.id)) throw new Error('REQUEST_EXPIRED'); };
    try {
      if (!Object.hasOwn(handlers, request.action)) throw new Error('ACTION_UNAVAILABLE');
      await guard();
      const result = await handlers[request.action](request.args, guard);
      window.api.mcpReply({ id: request.id, ok: true, result });
    } catch { window.api.mcpReply({ id: request.id, ok: false }); }
    finally { cancelled.delete(request.id); }
  });
  let current = null;
  const renderStatus = state => {
    current = state;
    const area = document.getElementById('mcpControls');
    if (!area) return;
    const states = {
      disabled: text('Deaktiviert', 'Disabled'), connecting: text('Verbindung wird hergestellt', 'Connecting'), online: text('Verbunden', 'Connected'), offline: text('Nicht verbunden – erneuter Versuch', 'Offline – retrying'),
      blocked: text('Zugang abgelehnt', 'Access rejected'), 'storage-error': text('Zugangsdaten nicht lesbar', 'Credentials unavailable'), 'enrollment-error': text('Registrierung fehlgeschlagen', 'Enrollment failed'), starting: text('Wird geladen', 'Loading')
    };
    area.querySelector('[data-mcp-status]').textContent = states[state.connection] || state.connection;
    area.querySelector('[data-mcp-status]').className = `mcp-state ${state.connection === 'online' ? 'connected' : ''}`;
    area.querySelector('[data-mcp-contact]').textContent = state.lastContact ? new Date(state.lastContact).toLocaleString(getUiLocale()) : '—';
    area.querySelector('[data-mcp-pending]').textContent = Number(state.pendingRevocations || 0).toLocaleString(getUiLocale());
    for (const action of ['copy', 'rotate']) area.querySelector(`[data-mcp-action="${action}"]`).disabled = !state.enabled;
    area.querySelector('[data-mcp-action="disable"]').disabled = !state.enabled && !state.installationId;
    area.querySelector('[data-mcp-grants]').replaceChildren(...(state.grants || []).map(grant => {
      const row = document.createElement('div'); row.className = 'mcp-grant';
      const name = document.createElement('span'); name.textContent = grant.path;
      const label = document.createElement('label'); const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = !grant.readOnly;
      label.append(checkbox, text(' Schreibzugriff', ' Write access'));
      checkbox.onchange = () => act(() => window.api.mcpUpdateGrant({ id: grant.id, remove: false, readOnly: !checkbox.checked, allowTransfer: grant.allowTransfer === true }));
      const transferLabel = document.createElement('label'); const transfer = document.createElement('input'); transfer.type = 'checkbox'; transfer.checked = grant.allowTransfer === true;
      transferLabel.append(transfer, text(' Dateiinhalte übertragen', ' Transfer file contents'));
      transfer.onchange = () => act(() => window.api.mcpUpdateGrant({ id: grant.id, remove: false, readOnly: grant.readOnly, allowTransfer: transfer.checked }));
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'btn btn-sm btn-secondary'; remove.textContent = text('Entfernen', 'Remove');
      remove.onclick = () => act(() => window.api.mcpUpdateGrant({ id: grant.id, remove: true, readOnly: true }));
      row.append(name, label, transferLabel, remove); return row;
    }));
  };
  const act = async action => {
    try { const state = await action(); if (state && typeof state === 'object') renderStatus(state); }
    catch { showCopyToast(text('MCP-Aktion fehlgeschlagen. Verbindung und lokale Berechtigungen prüfen.', 'MCP action failed. Check connection and local permissions.'), 6000, 'error'); if (current) renderStatus(current); }
  };
  window.renderMcpSettings = () => `<section id="mcpControls" class="mcp-controls">
    <div class="settings-section-label">MCP</div>
    <p>${text('Strukturierter Fernzugriff über HTTPS. Nur bei laufender Anwendung; keine Portfreigabe erforderlich. Berechtigungen werden ausschließlich hier vergeben.', 'Structured remote access over HTTPS. Available while the app is running; no inbound port required. Permissions can only be granted here.')}</p>
    <div class="settings-row"><label for="mcpName">${text('Installationsname', 'Installation name')}</label><input id="mcpName" class="key-input" maxlength="100"></div>
    <fieldset class="mcp-permissions"><legend>${text('Lokale Berechtigungen', 'Local permissions')}</legend>${[['read','Lesen und Diagnose','Read and diagnostics'],['control','App steuern','Control app'],['files','Freigegebene Ordner','Granted directories'],['secrets','Zugangsdaten explizit auslesen','Explicitly reveal secrets']].map(([value,de,en])=>`<label><input type="checkbox" value="${value}"> ${text(de,en)}</label>`).join('')}</fieldset>
    <div class="mcp-actions"><button class="btn btn-sm btn-primary" data-mcp-action="enable">${text('Speichern und aktivieren','Save and enable')}</button><button class="btn btn-sm btn-secondary" data-mcp-action="disable">${text('Deaktivieren und widerrufen','Disable and revoke')}</button><button class="btn btn-sm btn-secondary" data-mcp-action="copy">${text('Verbindungscode kopieren','Copy connection code')}</button><button class="btn btn-sm btn-secondary" data-mcp-action="rotate">${text('Zugang erneuern','Rotate access')}</button></div>
    <dl class="mcp-status"><div><dt>Status</dt><dd data-mcp-status>—</dd></div><div><dt>${text('Letzter Kontakt','Last contact')}</dt><dd data-mcp-contact>—</dd></div><div><dt>${text('Ausstehende Widerrufe','Pending revocations')}</dt><dd data-mcp-pending>0</dd></div></dl>
    <p>${text('Der Verbindungscode ist ein Zugangsschlüssel. Er wird weder im Backup gespeichert noch auf andere Installationen übertragen. Löschungen und andere gefährliche Aktionen verlangen eine lokale Bestätigung.', 'The connection code is a credential. It is not stored in backups or transferred to other installations. Deletions and other dangerous actions require local confirmation.')}</p>
    <div class="mcp-actions"><button class="btn btn-sm btn-secondary" data-mcp-action="grant">${text('Ordner freigeben','Grant directory')}</button></div>
    <p>${text('Dateiinhalte werden nur nach zusätzlicher Freigabe pro Ordner übertragen. Bestehende Ordnerfreigaben erlauben dies nicht automatisch.', 'File contents are transferred only after additional permission for each directory. Existing directory grants do not allow this automatically.')}</p><div data-mcp-grants></div>
  </section>`;
  window.bindMcpSettings = async () => {
    const area = document.getElementById('mcpControls'); if (!area) return;
    const state = await window.api.mcpStatus(); if (!state) return;
    renderStatus(state);
    area.querySelector('#mcpName').value = state.name || 'Multi-Hoster-Uploader';
    for (const input of area.querySelectorAll('.mcp-permissions input')) input.checked = state.capabilities?.includes(input.value) === true;
    const configuration = enabled => ({ enabled, name: area.querySelector('#mcpName').value.trim(), capabilities: [...area.querySelectorAll('.mcp-permissions input:checked')].map(input => input.value) });
    area.querySelector('[data-mcp-action="enable"]').onclick = () => act(() => window.api.mcpConfigure(configuration(true)));
    area.querySelector('[data-mcp-action="disable"]').onclick = () => act(() => window.api.mcpConfigure(configuration(false)));
    area.querySelector('[data-mcp-action="rotate"]').onclick = () => act(() => window.api.mcpRotate());
    area.querySelector('[data-mcp-action="copy"]').onclick = () => act(async () => { await window.api.mcpCopyCode(); showCopyToast(text('Verbindungscode kopiert.', 'Connection code copied.')); });
    area.querySelector('[data-mcp-action="grant"]').onclick = () => act(() => window.api.mcpAddGrant());
  };
  window.api.onMcpStatus(renderStatus);
})();
