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
    'automation-resume': (_args, guard) => window.resumeAutomationPausedJobs(guard),
    'update-park': async () => {
      cancelStartupQueueAutoStart();
      _cancelAutoRetry(true);
      const jobIds = queueJobs.filter(job => !['done', 'error', 'skipped', 'aborted'].includes(job.status)).map(job => job.id);
      if (jobIds.length > 50000) throw new Error('UPDATE_QUEUE_TOO_LARGE');
      await persistQueueStateNow();
      return { wasUploading: uploading, jobIds };
    },
    'update-resume': async (args, guard) => {
      await guard();
      const ids = new Set(args.jobIds || []);
      const jobs = queueJobs.filter(job => ids.has(job.id) && !['done', 'error', 'skipped'].includes(job.status));
      for (const job of jobs) if (job.status === 'aborted') Object.assign(job, { status: 'preview', error: null });
      redraw();
      if (!jobs.length) return { started: false, reason: 'NO_ELIGIBLE_JOBS' };
      const result = await startSelectedUpload(jobs, { guard });
      if (result?.ok !== true) throw new Error('UPDATE_RESUME_FAILED');
      return { resumed: true };
    },
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
      await dismissRemovedAutomationJobs(jobs);
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
  let busy = false;
  let saving = false;
  const configuration = area => ({
    enabled: true,
    name: area.querySelector('#mcpName').value.trim(),
    capabilities: [...area.querySelectorAll('.mcp-permissions input:checked')].map(input => input.value)
  });
  const hasChanges = (area, state) => {
    if (!state) return false;
    const draft = configuration(area);
    return draft.name !== (state.name || 'Multi-Hoster-Uploader')
      || draft.capabilities.slice().sort().join('|') !== (state.capabilities || []).slice().sort().join('|');
  };
  const syncConfiguration = (area, state) => {
    area.querySelector('#mcpName').value = state.name || 'Multi-Hoster-Uploader';
    for (const input of area.querySelectorAll('.mcp-permissions input')) input.checked = state.capabilities?.includes(input.value) === true;
  };
  window.getMcpSettingsSaveState = () => {
    const area = document.getElementById('mcpControls');
    return { dirty: !!area && hasChanges(area, current), saving };
  };
  window.saveMcpSettings = () => document.querySelector('#mcpControls [data-mcp-action="enable"]')?.onclick?.();
  const refreshControls = () => {
    const area = document.getElementById('mcpControls');
    if (!area) return;
    const ready = current?.available !== false && current?.connection !== 'starting' && !!current;
    const dirty = hasChanges(area, current);
    area.setAttribute('aria-busy', String(busy));
    for (const input of area.querySelectorAll('input')) input.disabled = busy || !ready;
    const enable = area.querySelector('[data-mcp-action="enable"]');
    enable.disabled = busy || !ready || (current?.enabled && !dirty && ['online', 'connecting'].includes(current.connection));
    enable.textContent = saving ? text('Wird gespeichert…', 'Saving…') : current?.enabled ? text('Änderungen speichern', 'Save changes') : text('Speichern und aktivieren', 'Save and enable');
    area.querySelector('[data-mcp-save-state]').textContent = saving ? text('Änderungen werden übernommen.', 'Applying changes.')
      : dirty ? text('Änderungen noch nicht gespeichert.', 'Changes have not been saved yet.')
        : current?.enabled ? text('Alle Einstellungen gespeichert.', 'All settings saved.')
          : text('Erst speichern und aktivieren, dann den Verbindungscode kopieren.', 'Save and enable first, then copy the connection code.');
    area.querySelector('[data-mcp-save-state]').classList.toggle('pending', dirty);
    area.querySelector('[data-mcp-action="copy"]').disabled = busy || !current?.enabled || !current?.installationId;
    area.querySelector('[data-mcp-action="rotate"]').disabled = busy || !current?.enabled;
    area.querySelector('[data-mcp-action="disable"]').disabled = busy || (!current?.enabled && !current?.installationId);
    area.querySelector('[data-mcp-action="grant"]').disabled = busy || !ready;
    for (const button of area.querySelectorAll('.mcp-grant button')) button.disabled = busy || !ready;
    window.syncSettingsSaveState?.();
  };
  const renderStatus = (state, resetDraft = false) => {
    const area = document.getElementById('mcpControls');
    if (!area) { current = state; return; }
    const preserveDraft = !resetDraft && hasChanges(area, current);
    current = state;
    if (!preserveDraft) syncConfiguration(area, state);
    const states = {
      disabled: text('Deaktiviert', 'Disabled'), connecting: text('Verbindung wird hergestellt', 'Connecting'), online: text('Verbunden', 'Connected'), offline: text('Nicht verbunden – erneuter Versuch', 'Offline – retrying'),
      blocked: text('Zugang abgelehnt', 'Access rejected'), 'storage-error': text('Zugangsdaten nicht lesbar', 'Credentials unavailable'), 'enrollment-error': text('Registrierung fehlgeschlagen', 'Enrollment failed'), starting: text('Wird geladen', 'Loading')
    };
    const descriptions = {
      disabled: text('Fernzugriff ist ausgeschaltet. Berechtigungen auswählen und mit „Speichern und aktivieren“ übernehmen.', 'Remote access is off. Select permissions and choose “Save and enable”.'),
      online: text('Fernzugriff ist aktiv. Den Verbindungscode im MCP-Client hinterlegen.', 'Remote access is enabled. Add the connection code to your MCP client.'),
      connecting: text('Einstellungen gespeichert. Die Verbindung wird hergestellt.', 'Settings saved. Establishing the connection.'),
      offline: text('Einstellungen gespeichert. Die Verbindung wird automatisch erneut versucht.', 'Settings saved. The connection will be retried automatically.'),
      blocked: text('Der Zugang wurde abgelehnt. Zugang erneuern und den neuen Code im Client hinterlegen.', 'Access was rejected. Rotate access and add the new code to the client.'),
      'storage-error': text('Die gespeicherten Zugangsdaten sind nicht lesbar. Lokalen Zugangsdaten-Speicher prüfen.', 'The saved credentials cannot be read. Check local credential storage.'),
      'enrollment-error': text('Die Registrierung ist fehlgeschlagen. Verbindung prüfen und erneut aktivieren.', 'Registration failed. Check the connection and enable access again.')
    };
    const status = area.querySelector('[data-mcp-status]');
    status.textContent = states[state.connection] || text('Status nicht verfügbar', 'Status unavailable');
    status.dataset.state = state.connection || 'starting';
    area.querySelector('[data-mcp-summary]').textContent = descriptions[state.connection] || text('Der Verbindungsstatus wird geladen.', 'Loading the connection status.');
    area.querySelector('[data-mcp-contact]').textContent = state.lastContact ? new Date(state.lastContact).toLocaleString(getUiLocale()) : '—';
    area.querySelector('[data-mcp-pending]').textContent = Number(state.pendingRevocations || 0).toLocaleString(getUiLocale());
    area.querySelector('[data-mcp-grant-count]').textContent = Number(state.grants?.length || 0).toLocaleString(getUiLocale());
    const grants = area.querySelector('[data-mcp-grants]');
    const grantIds = JSON.stringify(state.grants || []);
    if (grants.dataset.snapshot !== grantIds) {
      grants.dataset.snapshot = grantIds;
      grants.replaceChildren(...(state.grants || []).map(grant => {
        const row = document.createElement('div'); row.className = 'mcp-grant';
        const name = document.createElement('p'); name.className = 'mcp-grant-path'; name.textContent = grant.path;
        const options = document.createElement('div'); options.className = 'mcp-grant-options';
        const label = document.createElement('label'); const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = !grant.readOnly;
        label.append(checkbox, text(' Schreibzugriff', ' Write access'));
        checkbox.onchange = () => act(() => window.api.mcpUpdateGrant({ id: grant.id, remove: false, readOnly: !checkbox.checked, allowTransfer: grant.allowTransfer === true }));
        const transferLabel = document.createElement('label'); const transfer = document.createElement('input'); transfer.type = 'checkbox'; transfer.checked = grant.allowTransfer === true;
        transferLabel.append(transfer, text(' Dateiinhalte übertragen', ' Transfer file contents'));
        transfer.onchange = () => act(() => window.api.mcpUpdateGrant({ id: grant.id, remove: false, readOnly: grant.readOnly, allowTransfer: transfer.checked }));
        const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'btn btn-sm btn-secondary'; remove.textContent = text('Entfernen', 'Remove');
        remove.onclick = () => act(() => window.api.mcpUpdateGrant({ id: grant.id, remove: true, readOnly: true }));
        options.append(label, transferLabel, remove); row.append(name, options); return row;
      }));
    }
    for (const [index, grant] of (state.grants || []).entries()) {
      const inputs = grants.children[index]?.querySelectorAll('input');
      if (inputs) { inputs[0].checked = !grant.readOnly; inputs[1].checked = grant.allowTransfer === true; }
    }
    area.querySelector('[data-mcp-grants-empty]').hidden = !!state.grants?.length;
    refreshControls();
  };
  const act = async (action, resetDraft = false) => {
    if (busy) return;
    busy = true;
    saving = resetDraft;
    refreshControls();
    try {
      const state = await action();
      if (state && typeof state === 'object') renderStatus(state, resetDraft);
    } catch {
      showCopyToast(text('MCP-Aktion fehlgeschlagen. Verbindung und lokale Berechtigungen prüfen.', 'MCP action failed. Check connection and local permissions.'), 6000, 'error');
      if (current) renderStatus(current);
    } finally { busy = false; saving = false; refreshControls(); }
  };
  window.renderMcpSettings = () => `<section id="mcpControls" class="mcp-controls">
    <section class="mcp-card mcp-connection" aria-labelledby="mcpConnectionTitle">
      <div class="mcp-card-heading"><h4 id="mcpConnectionTitle">${text('Verbindung', 'Connection')}</h4><span class="mcp-state" data-mcp-status data-state="starting" role="status">${text('Wird geladen', 'Loading')}</span></div>
      <p data-mcp-summary>${text('Der Verbindungsstatus wird geladen.', 'Loading the connection status.')}</p>
      <dl class="mcp-status"><div><dt>${text('Letzter Kontakt','Last contact')}</dt><dd data-mcp-contact>—</dd></div><div><dt>${text('Freigegebene Ordner','Granted directories')}</dt><dd data-mcp-grant-count>0</dd></div><div><dt>${text('Ausstehende Widerrufe','Pending revocations')}</dt><dd data-mcp-pending>0</dd></div></dl>
      <div class="mcp-code-row" data-settings-search-entry data-settings-search-label="Verbindungscode kopieren"><p>${text('Den Code auf diesem Gerät kopieren und im MCP-Client hinterlegen. Er gilt nur für diese Installation.', 'Copy the code on this device and add it to your MCP client. It applies only to this installation.')}</p><button type="button" class="btn btn-sm btn-secondary" data-mcp-action="copy" disabled>${text('Verbindungscode kopieren','Copy connection code')}</button></div>
    </section>
    <section class="mcp-card" aria-labelledby="mcpSetupTitle">
      <div class="mcp-card-heading"><h4 id="mcpSetupTitle">${text('Einrichtung und Berechtigungen', 'Setup and permissions')}</h4></div>
      <p>${text('Name und Berechtigungen auswählen. Änderungen werden erst mit dem Speichern wirksam.', 'Choose a name and permissions. Changes take effect only when saved.')}</p>
      <div class="mcp-name-row" data-settings-search-entry><label for="mcpName">${text('Installationsname', 'Installation name')}</label><input id="mcpName" class="key-input" maxlength="100" disabled></div>
      <fieldset class="mcp-permissions"><legend>${text('Lokale Berechtigungen', 'Local permissions')}</legend>${[
        ['read','Lesen und Diagnose','Read and diagnostics','Status, Uploads, Protokolle und Diagnose lesen.','Read status, uploads, logs and diagnostics.'],
        ['control','App steuern','Control app','Uploads und Konten verwalten. Kritische Aktionen lokal bestätigen.','Manage uploads and accounts. Confirm critical actions locally.'],
        ['files','Freigegebene Ordner','Granted directories','Auf ausgewählte Ordner zugreifen. Dateiinhalte separat freigeben.','Access selected directories. Allow file contents separately.'],
        ['updates','App-Updates installieren','Install app updates','Geprüfte Updates ohne erneute Bestätigung installieren. Uploads abschließen und danach fortsetzen. Keine Portable-Versionen.','Install verified updates without another confirmation. Finish uploads and resume afterwards. No portable versions.'],
        ['secrets','Zugangsdaten auslesen','Reveal credentials','Gespeicherte Zugangsdaten ausdrücklich freigeben. Zusätzliche lokale Bestätigung erforderlich.','Explicitly allow saved credentials to be read. Additional local confirmation required.'],
        ['full_access','Vollzugriff ohne Bestätigung','Full access without confirmation','Alle Aktionen ohne lokale Bestätigung ausführen, auch Löschen, Wiederholen mit Quelldatei-Löschung, Ordnerfreigaben und Zugangsdaten.','Run every action without local confirmation, including deletions, retries with source deletion, directory grants and credentials.']
      ].map(([value,de,en,description,englishDescription])=>`<label class="mcp-permission${['secrets', 'full_access'].includes(value) ? ' mcp-permission-sensitive' : ''}" data-settings-search-entry data-settings-search-label="${de}"><input type="checkbox" value="${value}"${value === 'updates' ? ' data-mcp-updates' : ''} disabled><span><strong>${text(de,en)}</strong><span class="mcp-permission-description">${text(description,englishDescription)}</span></span></label>`).join('')}</fieldset>
      <div class="mcp-save-row"><p data-mcp-save-state role="status">${text('Erst speichern und aktivieren, dann den Verbindungscode kopieren.', 'Save and enable first, then copy the connection code.')}</p><button type="button" class="btn btn-sm btn-primary" data-mcp-action="enable" disabled>${text('Speichern und aktivieren','Save and enable')}</button></div>
    </section>
    <section class="mcp-card" aria-labelledby="mcpGrantsTitle">
      <div class="mcp-card-heading"><h4 id="mcpGrantsTitle">${text('Ordnerfreigaben', 'Directory access')}</h4><button type="button" class="btn btn-sm btn-secondary" data-mcp-action="grant" disabled>${text('Ordner freigeben','Grant directory')}</button></div>
      <p>${text('Dateiinhalte werden nur nach zusätzlicher Freigabe pro Ordner übertragen. Bestehende Ordnerfreigaben erlauben dies nicht automatisch.', 'File contents are transferred only after additional permission for each directory. Existing directory grants do not allow this automatically.')}</p>
      <p class="mcp-empty" data-mcp-grants-empty>${text('Keine Ordner freigegeben.', 'No directories granted.')}</p><div data-mcp-grants></div>
    </section>
    <section class="mcp-card" aria-labelledby="mcpAccessTitle">
      <div class="mcp-card-heading"><h4 id="mcpAccessTitle">${text('Zugang verwalten', 'Manage access')}</h4></div>
      <p>${text('Der Verbindungscode ist ein Zugangsschlüssel. Er wird weder im Backup gespeichert noch auf andere Installationen übertragen. Löschungen und andere gefährliche Aktionen verlangen eine lokale Bestätigung, außer bei Vollzugriff.', 'The connection code is a credential. It is not stored in backups or transferred to other installations. Deletions and other dangerous actions require local confirmation unless full access is granted.')}</p>
      <p>${text('Zugang erneuern macht den bisherigen Code ungültig. Deaktivieren beendet den Fernzugriff und widerruft den Zugang.', 'Rotating access invalidates the previous code. Disabling remote access revokes access.')}</p>
      <div class="mcp-actions"><button type="button" class="btn btn-sm btn-secondary" data-mcp-action="rotate" disabled>${text('Zugang erneuern','Rotate access')}</button><button type="button" class="btn btn-sm btn-secondary" data-mcp-action="disable" disabled>${text('Deaktivieren und widerrufen','Disable and revoke')}</button></div>
    </section>
    <p class="mcp-footnote">${text('Strukturierter Fernzugriff über HTTPS. Nur bei laufender Anwendung; keine Portfreigabe erforderlich. Berechtigungen werden ausschließlich hier vergeben.', 'Structured remote access over HTTPS. Available while the app is running; no inbound port required. Permissions can only be granted here.')}</p>
  </section>`;
  window.bindMcpSettings = async () => {
    const area = document.getElementById('mcpControls'); if (!area) return;
    const state = await window.api.mcpStatus(); if (!state || !area.isConnected) return;
    renderStatus(state, true);
    for (const input of area.querySelectorAll('#mcpName, .mcp-permissions input')) input.addEventListener('input', refreshControls);
    area.querySelector('[data-mcp-action="enable"]').onclick = () => act(() => window.api.mcpConfigure(configuration(area)), true);
    area.querySelector('[data-mcp-action="disable"]').onclick = () => act(() => window.api.mcpConfigure({ enabled: false, name: current.name, capabilities: current.capabilities }));
    area.querySelector('[data-mcp-action="rotate"]').onclick = () => act(() => window.api.mcpRotate());
    area.querySelector('[data-mcp-action="copy"]').onclick = () => act(async () => { await window.api.mcpCopyCode(); showCopyToast(text('Verbindungscode kopiert.', 'Connection code copied.')); });
    area.querySelector('[data-mcp-action="grant"]').onclick = () => act(() => window.api.mcpAddGrant());
  };
  window.api.onMcpStatus(renderStatus);
})();
