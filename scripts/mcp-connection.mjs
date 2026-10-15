export function parseConnectionCode(raw) {
  const prefix = 'media-mcp:v1:';
  if (typeof raw !== 'string' || raw.length > 16384 || !raw.trim().startsWith(prefix)) throw new Error('Ungültiger Verbindungscode.');
  let value;
  let url;
  try { value = JSON.parse(Buffer.from(raw.trim().slice(prefix.length), 'base64url').toString('utf8')); url = new URL(value.url); }
  catch { throw new Error('Ungültiger Verbindungscode.'); }
  if (value.v !== 1 || !['downloader', 'uploader'].includes(value.kind)
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.installationId)
    || !/^[A-Za-z0-9_-]{43}$/.test(value.token) || url.origin !== 'https://downloader.24-music.de'
    || url.username || url.password || url.search || url.hash || url.pathname !== `/mcp-relay/mcp/${value.installationId}`) throw new Error('Ungültiger Verbindungscode.');
  return { v: 1, kind: value.kind, installationId: value.installationId, url: url.href, token: value.token };
}
