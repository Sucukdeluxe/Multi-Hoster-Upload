const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

const UPDATE_REPO = 'Administrator/Multi-Hoster-Upload';
const GITEA_BASE = 'https://git.24-music.de';
const API_URL = `${GITEA_BASE}/api/v1/repos/${UPDATE_REPO}/releases?limit=1`;

const CHECK_TIMEOUT = 15000;

let cachedCheck = null;
let cachedCheckTs = 0;
const CACHE_TTL = 10 * 60 * 1000; // 10 min

let activeAbort = null;

function getCurrentVersion() {
  return app.getVersion();
}

function parseVersion(str) {
  const clean = String(str || '').replace(/^v/i, '').trim();
  const parts = clean.split('.').map(Number);
  return {
    major: parts[0] || 0,
    minor: parts[1] || 0,
    patch: parts[2] || 0
  };
}

function isNewer(remote, current) {
  const r = parseVersion(remote);
  const c = parseVersion(current);
  if (r.major !== c.major) return r.major > c.major;
  if (r.minor !== c.minor) return r.minor > c.minor;
  return r.patch > c.patch;
}

function resolveReleaseVersion(release) {
  for (const value of [release && release.name, release && release.tag_name]) {
    const match = String(value || '').match(/(?:^|[^\d])v?(\d+\.\d+\.\d+)(?=$|[^\d.])/i);
    if (match) return match[1];
  }
  return '';
}

function pickSetupAsset(assets) {
  if (!Array.isArray(assets)) return null;
  // Prefer asset with "setup" in the name (case-insensitive)
  const setup = assets.find(a =>
    /setup/i.test(a.name) && /\.exe$/i.test(a.name)
  );
  if (setup) return setup;
  // Fallback: any .exe
  return assets.find(a => /\.exe$/i.test(a.name)) || null;
}

function findLatestYml(assets) {
  if (!Array.isArray(assets)) return null;
  return assets.find(a => /^latest\.yml$/i.test(a.name)) || null;
}

async function fetchJson(url, signal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT);
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', onAbort);

  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'follow'
    });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Update-Server Antwort war kein JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }
  } finally {
    clearTimeout(timeout);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

async function checkForUpdate() {
  // Return cached result if fresh
  if (cachedCheck && (Date.now() - cachedCheckTs) < CACHE_TTL) {
    return cachedCheck;
  }

  const releases = await fetchJson(API_URL);

  if (!Array.isArray(releases) || releases.length === 0) {
    return { available: false };
  }

  const release = releases[0];
  const remoteVersion = resolveReleaseVersion(release);
  const transportTag = release.tag_name || '';
  const currentVersion = getCurrentVersion();

  if (!isNewer(remoteVersion, currentVersion)) {
    cachedCheck = { available: false, currentVersion, remoteVersion, transportTag };
    cachedCheckTs = Date.now();
    return cachedCheck;
  }

  const setupAsset = pickSetupAsset(release.assets);
  const latestYml = findLatestYml(release.assets);

  if (!setupAsset) {
    return { available: false, reason: 'Kein Setup-Asset im Release gefunden' };
  }

  cachedCheck = {
    available: true,
    currentVersion,
    remoteVersion,
    transportTag,
    releaseUrl: release.html_url,
    assetUrl: setupAsset.browser_download_url,
    assetSize: setupAsset.size,
    assetName: setupAsset.name,
    latestYmlUrl: latestYml ? latestYml.browser_download_url : null,
    releaseNotes: release.body || ''
  };
  cachedCheckTs = Date.now();
  return cachedCheck;
}

async function parseLatestYml(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, { redirect: 'follow' });
    const text = await res.text();
    // Extract sha512 from latest.yml
    const match = text.match(/sha512:\s*([A-Za-z0-9+/=]+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function verifyExeHeader(buf) {
  // Check MZ header
  if (buf.length < 128 * 1024) return false;
  return buf[0] === 0x4D && buf[1] === 0x5A; // 'MZ'
}

async function installUpdate(onProgress) {
  if (activeAbort) activeAbort.abort();
  activeAbort = new AbortController();
  const signal = activeAbort.signal;

  try {
    // Stage: starting
    if (onProgress) onProgress({ stage: 'starting', percent: 0 });

    // Check or use cached
    let check = cachedCheck;
    if (!check || !check.available) {
      check = await checkForUpdate();
    }
    if (!check || !check.available) {
      throw new Error('Kein Update verfuegbar');
    }
    if (!check.assetUrl || !check.assetName) {
      throw new Error('Update-Asset unvollstaendig (URL oder Name fehlt)');
    }

    // Stage: downloading
    const tmpDir = app.getPath('temp');
    const installerPath = path.join(tmpDir, check.assetName);

    const res = await fetch(check.assetUrl, {
      method: 'GET',
      signal,
      redirect: 'follow'
    });

    if (!res.ok) {
      throw new Error(`Download fehlgeschlagen: HTTP ${res.status}`);
    }

    const totalBytes = check.assetSize || 0;
    let downloadedBytes = 0;
    const chunks = [];

    const DOWNLOAD_STALL_MS = 45000;
    let stallTimer = null;
    const reader = res.body.getReader();
    while (true) {
      if (signal.aborted) throw new Error('Abgebrochen');
      let chunk;
      try {
        chunk = await Promise.race([
          reader.read(),
          new Promise((_, reject) => { stallTimer = setTimeout(() => reject(new Error('__STALL__')), DOWNLOAD_STALL_MS); })
        ]);
      } catch (e) {
        if (e && e.message === '__STALL__') {
          try { activeAbort.abort(); } catch {}
          throw new Error('Download hängt — seit 45 s keine Daten (Netzwerk/Server überlastet). Bitte laufende Uploads stoppen und erneut versuchen.');
        }
        throw e;
      } finally {
        if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
      }
      const { done, value } = chunk;
      if (done) break;
      chunks.push(value);
      downloadedBytes += value.length;
      if (onProgress) {
        onProgress({
          stage: 'downloading',
          percent: totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0,
          bytesDownloaded: downloadedBytes,
          bytesTotal: totalBytes
        });
      }
    }

    const fileBuffer = Buffer.concat(chunks);

    // Stage: verifying
    if (onProgress) onProgress({ stage: 'verifying', percent: 0 });

    if (!verifyExeHeader(fileBuffer)) {
      throw new Error('Heruntergeladene Datei ist keine gueltige EXE');
    }

    // Optional SHA-512 verification from latest.yml
    const expectedSha = await parseLatestYml(check.latestYmlUrl);
    if (expectedSha) {
      const actualSha = crypto.createHash('sha512').update(fileBuffer).digest('base64');
      if (actualSha !== expectedSha) {
        // Try hex comparison
        const actualHex = crypto.createHash('sha512').update(fileBuffer).digest('hex');
        if (actualHex !== expectedSha.toLowerCase()) {
          throw new Error('SHA-512 Pruefung fehlgeschlagen');
        }
      }
    }

    // Write to disk
    fs.writeFileSync(installerPath, fileBuffer);

    // Stage: launching
    if (onProgress) onProgress({ stage: 'launching', percent: 100 });

    const { spawn } = require('child_process');
    spawn(installerPath, ['/S', '--updated', '--force-run'], {
      detached: true,
      stdio: 'ignore'
    }).unref();

    // Stage: done
    if (onProgress) onProgress({ stage: 'done', percent: 100 });

    const _doQuit = () => setTimeout(() => app.quit(), 900);
    const _getActive = () => {
      try { return globalThis._mhuUploadManagerRef && globalThis._mhuUploadManagerRef.getActiveJobCount ? globalThis._mhuUploadManagerRef.getActiveJobCount() : 0; }
      catch { return 0; }
    };
    if (_getActive() > 0) {
      const POLL_MS = 3000;
      const poller = setInterval(() => {
        if (_getActive() === 0) { clearInterval(poller); _doQuit(); }
      }, POLL_MS);
      setTimeout(() => { try { clearInterval(poller); } catch {} _doQuit(); }, 30 * 60 * 1000);
    } else {
      _doQuit();
    }

  } catch (err) {
    if (onProgress) onProgress({ stage: 'error', error: err.message });
    throw err;
  } finally {
    activeAbort = null;
  }
}

function abortUpdate() {
  if (activeAbort) {
    activeAbort.abort();
    activeAbort = null;
  }
}

module.exports = { checkForUpdate, installUpdate, abortUpdate, isNewer, resolveReleaseVersion };
