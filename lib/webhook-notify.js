function isDiscordWebhook(url) {
  return /^https?:\/\/(ptb\.|canary\.)?(discord(app)?\.com)\/api\/webhooks\/\d+\/[\w-]+/i.test(String(url || ''));
}

const DISCORD_CONTENT_LIMIT = 1900;

function clampDiscordContent(text) {
  const s = String(text || '');
  if (s.length <= DISCORD_CONTENT_LIMIT) return s;
  return s.slice(0, DISCORD_CONTENT_LIMIT - 1) + '…';
}

function formatDurationShort(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${r}s`;
  return `${r}s`;
}

function summarizePerHosterFromBatch(summary) {
  const out = {};
  if (!summary || !Array.isArray(summary.files)) return out;
  for (const f of summary.files) {
    if (!f || !Array.isArray(f.results)) continue;
    for (const r of f.results) {
      if (!r || !r.hoster) continue;
      const b = out[r.hoster] || (out[r.hoster] = { ok: 0, fail: 0 });
      if (r.status === 'done') b.ok++;
      else b.fail++;
    }
  }
  return out;
}

function resolveDiscordMention(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const keyword = s.replace(/^@/, '').toLowerCase();
  if (keyword === 'here' || keyword === 'everyone') {
    return { token: `@${keyword}`, allowed: { parse: ['everyone'] } };
  }
  const roleMatch = s.match(/^(?:<@&(\d+)>|role:(\d+))$/i);
  if (roleMatch) {
    const id = roleMatch[1] || roleMatch[2];
    return { token: `<@&${id}>`, allowed: { roles: [id] } };
  }
  const userMatch = s.match(/^(?:<@!?(\d+)>|user:(\d+)|(\d{5,30}))$/i);
  if (userMatch) {
    const id = userMatch[1] || userMatch[2] || userMatch[3];
    return { token: `<@${id}>`, allowed: { users: [id] } };
  }
  return null;
}

function buildWebhookRequest(url, summary, meta) {
  const m = meta || {};
  const language = String(m.language || 'en').toLowerCase() === 'de' ? 'de' : 'en';
  const total = Number(summary && summary.total) || 0;
  const succeeded = Number(summary && summary.succeeded) || 0;
  const failed = Number(summary && summary.failed) || 0;
  const perHoster = summarizePerHosterFromBatch(summary);
  const duration = formatDurationShort(m.durationSec);

  let body;
  if (isDiscordWebhook(url)) {
    const headline = language === 'de'
      ? (m.aborted ? 'Batch abgebrochen' : 'Batch fertig')
      : (m.aborted ? 'Batch canceled' : 'Batch completed');
    const hosterEntries = Object.entries(perHoster);
    const MAX_HOSTER_LINES = 12;
    let hosterLines = hosterEntries.slice(0, MAX_HOSTER_LINES)
      .map(([h, b]) => `${h}: ${b.ok}/${b.ok + b.fail}`)
      .join(' · ');
    if (hosterEntries.length > MAX_HOSTER_LINES) hosterLines += ` · …+${hosterEntries.length - MAX_HOSTER_LINES}`;
    const lines = [
      `**Multi-Hoster-Upload — ${headline}**${m.machineName ? ` (${m.machineName})` : ''}`,
      language === 'de'
        ? `✅ ${succeeded} ok · ❌ ${failed} Fehler · 📦 ${total} gesamt · ⏱ ${duration}`
        : `✅ ${succeeded} succeeded · ❌ ${failed} failed · 📦 ${total} total · ⏱ ${duration}`
    ];
    if (hosterLines) lines.push(hosterLines);
    const mention = resolveDiscordMention(m.mention);
    const content = clampDiscordContent((mention ? mention.token + ' ' : '') + lines.join('\n'));
    const payload = { content };
    payload.allowed_mentions = mention ? mention.allowed : { parse: [] };
    body = JSON.stringify(payload);
  } else {
    body = JSON.stringify({
      event: 'batch-done',
      app: 'multi-hoster-upload',
      version: m.appVersion || null,
      machine: m.machineName || null,
      total,
      succeeded,
      failed,
      durationSec: Math.round(Number(m.durationSec) || 0),
      aborted: !!m.aborted,
      perHoster,
      timestamp: m.timestamp || null
    });
  }

  return {
    url: String(url),
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body
  };
}

function isAllAborted(summary) {
  if (!summary || !Array.isArray(summary.files) || summary.files.length === 0) return false;
  let sawResult = false;
  for (const f of summary.files) {
    if (!f || !Array.isArray(f.results)) continue;
    for (const r of f.results) {
      if (!r) continue;
      sawResult = true;
      if (r.status !== 'aborted') return false;
    }
  }
  return sawResult;
}

module.exports = { isDiscordWebhook, formatDurationShort, summarizePerHosterFromBatch, buildWebhookRequest, resolveDiscordMention, isAllAborted, clampDiscordContent, DISCORD_CONTENT_LIMIT };
