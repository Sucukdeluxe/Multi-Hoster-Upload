(() => {
  const view = document.getElementById('history-view');
  const labels = { session: 'Sitzung', today: 'Heute', last24: 'Letzte 24 Stunden', week: 'Sieben Tage', month: '30 Tage', all: 'Gesamt' };
  const byId = id => document.getElementById(id);
  const text = value => window.localizeUiText(value);
  let range = 'session';
  let generation = 0;
  let pending = false;
  let resetting = false;
  let current = null;
  let lastSpeed = 0;
  let lastSpeedAt = 0;
  const points = [];
  const count = value => new Intl.NumberFormat(window.getUiLocale(), { maximumFractionDigits: 0 }).format(value);
  const decimal = value => new Intl.NumberFormat(window.getUiLocale(), { maximumFractionDigits: 1 }).format(value);
  function bytes(value) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let index = 0;
    while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
    return decimal(value) + ' ' + units[index];
  }
  function speed(value) {
    const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
    let index = 0;
    while (value >= 1000 && index < units.length - 1) { value /= 1000; index++; }
    return decimal(value) + ' ' + units[index];
  }
  function notice(message) {
    byId('statisticsNotice').hidden = !message;
    byId('statisticsNoticeText').textContent = message;
  }
  function controls(disabled) {
    view.querySelectorAll('[data-statistics-reset]').forEach(button => { button.disabled = disabled || (button.dataset.statisticsReset === 'errors' && !current?.failed); });
  }
  function render(data) {
    current = data;
    const message = data.historyImported
      ? 'Enthält vorhandenen Verlauf. Frühere Wiederholungen und aktive Uploadzeit sind nicht vollständig erfasst.'
      : 'Lokale Upload-Statistik. Wiederholungen zählen zum Datenverkehr; abgebrochene und übersprungene Uploads nicht zur Erfolgsquote.';
    byId('statisticsMessage').textContent = text(message);
    byId('statisticsProviderScope').textContent = text(labels[range]);
    const values = { bytes: bytes(data.bytes), completed: count(data.completed), successRate: data.successRate === null ? '–' : decimal(data.successRate) + ' %', averageSpeedBps: data.averageSpeedBps === null ? '–' : speed(data.averageSpeedBps), failed: count(data.failed) };
    const sources = { bytes: labels[range], completed: 'Erfolgreiche Uploads je Hoster', successRate: 'Erfolgreich / erfolgreich und fehlgeschlagen', averageSpeedBps: data.averageSpeedBps === null ? 'Keine vollständige aktive Uploadzeit verfügbar' : 'Seit Beginn der Datenverkehrserfassung', failed: 'Endgültig fehlgeschlagene Uploads' };
    for (const [key, value] of Object.entries(values)) {
      view.querySelector('[data-statistics-value="' + key + '"]').textContent = value;
      view.querySelector('[data-statistics-source="' + key + '"]').textContent = text(sources[key]);
    }
    view.querySelector('[data-statistics-card="failed"]').classList.toggle('statistics-kpi-danger', data.failed > 0);
    const rows = data.providers.map(provider => {
      const row = document.createElement('div');
      row.className = 'statistics-provider-row';
      row.setAttribute('role', 'row');
      for (const [index, value] of [provider.label, bytes(provider.bytes), count(provider.completed) + ' ' + text('fertig') + ' · ' + count(provider.failed) + ' ' + text('Fehler')].entries()) {
        const cell = document.createElement('span');
        cell.setAttribute('role', 'cell');
        cell.textContent = value;
        if (!index) cell.className = 'statistics-provider-name';
        if (index === 2 && provider.failed) cell.className = 'statistics-provider-errors';
        row.append(cell);
      }
      return row;
    });
    byId('statisticsProviders').replaceChildren(...rows);
    notice(data.persistenceError ? text(data.persistenceError) : '');
    controls(resetting);
    draw();
  }
  async function refresh(force = false) {
    if ((!force && (!view.classList.contains('active') || !view.classList.contains('statistics-mode'))) || pending || resetting) return;
    const request = ++generation;
    pending = true;
    try {
      const data = await window.api.getStatistics(range);
      if (request === generation) render(data);
    } catch {
      if (request === generation) {
        notice(text('Statistiken konnten nicht geladen werden. Erneut versuchen.'));
        controls(true);
      }
    } finally { if (request === generation) pending = false; }
  }
  function selectRange(value) {
    if (!Object.hasOwn(labels, value)) return;
    generation++;
    pending = false;
    current = null;
    range = value;
    view.classList.add('statistics-mode');
    window.closeHistoryRetentionMenu();
    view.querySelectorAll('[data-statistics-range]').forEach(button => {
      const active = button.dataset.statisticsRange === range;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
      if (active) window._syncSidebarIndicator(button, true);
    });
    view.querySelectorAll('[data-statistics-value]').forEach(node => { node.textContent = '–'; });
    byId('statisticsProviders').replaceChildren();
    byId('statisticsMessage').textContent = text('Statistiken werden geladen…');
    byId('statisticsProviderScope').textContent = text(labels[range]);
    controls(true);
    void refresh(true);
  }
  function showHistory() {
    view.classList.remove('statistics-mode');
    view.querySelectorAll('[data-statistics-range]').forEach(button => {
      button.classList.remove('active');
      button.setAttribute('aria-pressed', 'false');
    });
  }
  async function reset(scope) {
    if (resetting) return;
    const messages = {
      session: 'Statistikwerte dieser Sitzung zurücksetzen? Uploads, Dateien und Verlauf bleiben erhalten.',
      all: 'Alle gespeicherten Statistikwerte zurücksetzen? Uploads, Dateien und Verlauf bleiben erhalten.',
      errors: 'Fehlerzähler in allen Statistikzeiträumen zurücksetzen? Uploads und Verlauf bleiben unverändert.'
    };
    if (!await window.showAppConfirm({ title: 'Statistiken zurücksetzen?', message: messages[scope], confirmText: 'Zurücksetzen', danger: true })) return;
    generation++;
    pending = false;
    resetting = true;
    controls(true);
    try {
      await window.api.resetStatistics(scope);
      resetting = false;
      await refresh(true);
    } catch {
      resetting = false;
      notice(text('Statistiken konnten nicht zurückgesetzt werden. Erneut versuchen.'));
      controls(false);
    }
  }
  function draw() {
    if (!view.classList.contains('active') || !view.classList.contains('statistics-mode')) return;
    const canvas = byId('statisticsCanvas');
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.scale(dpr, dpr);
    const style = window.getComputedStyle(document.documentElement);
    const color = name => style.getPropertyValue(name).trim();
    ctx.font = '11px ' + window.getComputedStyle(document.body).fontFamily;
    const now = Date.now();
    const visible = points.filter(p => p.time >= now - 60000);
    const max = Math.max(1000000, ...visible.map(p => p.speed));
    const magnitude = Math.pow(10, Math.floor(Math.log10(max)));
    const ceiling = [1, 2, 5, 10].map(n => n * magnitude).find(n => n >= max);
    const left = Math.ceil(Math.max(...Array.from({ length: 6 }, (_, i) => ctx.measureText(speed(ceiling * i / 5)).width))) + 16;
    const chartWidth = Math.max(1, width - left - 20);
    const chartHeight = height - 50;
    ctx.strokeStyle = color('--border');
    ctx.fillStyle = color('--text-dim');
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 5; i++) {
      const y = 20 + chartHeight * i / 5;
      ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(width - 20, y); ctx.stroke();
      ctx.fillText(speed(ceiling * (1 - i / 5)), left - 8, y);
    }
    ctx.textAlign = 'center';
    ctx.fillText('60s', left, height - 12);
    ctx.fillText('30s', left + chartWidth / 2, height - 12);
    ctx.fillText('0s', width - 20, height - 12);
    canvas.setAttribute('aria-label', text('Upload-Bandbreitenverlauf der letzten 60 Sekunden') + ': ' + speed(lastSpeed));
    if (!visible.some(p => p.speed > 0)) {
      ctx.font = '13px ' + window.getComputedStyle(document.body).fontFamily;
      ctx.fillText(text('Kein Upload-Datenverkehr in den letzten 60 Sekunden'), left + chartWidth / 2, height / 2);
      return;
    }
    const coords = visible.map(p => ({ x: left + (p.time - now + 60000) / 60000 * chartWidth, y: 20 + chartHeight * (1 - p.speed / ceiling) }));
    ctx.beginPath();
    coords.forEach((p, index) => index ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
    ctx.lineTo(coords.at(-1).x, 20 + chartHeight); ctx.lineTo(coords[0].x, 20 + chartHeight); ctx.closePath();
    ctx.save(); ctx.globalAlpha = .15; ctx.fillStyle = color('--accent'); ctx.fill(); ctx.restore();
    ctx.beginPath(); coords.forEach((p, index) => index ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
    ctx.strokeStyle = color('--accent'); ctx.lineWidth = 2; ctx.stroke();
  }
  view.querySelectorAll('[data-statistics-range]').forEach(button => button.addEventListener('click', () => selectRange(button.dataset.statisticsRange)));
  view.querySelectorAll('[data-statistics-reset]').forEach(button => button.addEventListener('click', () => reset(button.dataset.statisticsReset)));
  byId('statisticsRetry').addEventListener('click', () => refresh(true));
  window.api.onUploadStats(data => {
    lastSpeed = data.state === 'idle' ? 0 : Math.max(0, Number(data.globalSpeedKbs) || 0) * 1000;
    lastSpeedAt = Date.now();
  });
  setInterval(() => {
    const now = Date.now();
    if (now - lastSpeedAt > 3000) lastSpeed = 0;
    points.push({ time: now, speed: lastSpeed });
    while (points.length && points[0].time < now - 60000) points.shift();
    void refresh();
    draw();
  }, 1000);
  new window.ResizeObserver(draw).observe(byId('statisticsCanvas'));
  window.UploadStatisticsView = { refresh, showHistory, selectRange, localize: () => { if (current) render(current); else draw(); } };
  controls(true);
})();
