const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

const UPDATE_REPO = 'Administrator/Multi-Hoster-Upload';
const GITEA_BASE = 'https://git.24-music.de';
const API_URL = `${GITEA_BASE}/api/v1/repos/${UPDATE_REPO}/releases?limit=1`;
const GITHUB_RELEASE_URL = 'https://api.github.com/repos/Sucukdeluxe/Multi-Hoster-Upload/releases/tags';

const CHECK_TIMEOUT = 15000;

let cachedCheck = null;
let cachedCheckTs = 0;
const CACHE_TTL = 10 * 60 * 1000; // 10 min

let activeAbort = null;
const launchedInstallerPaths = new Set();

function createUpdateAnnouncementState() {
  let announcedVersion = '';

  function versionOf(update) {
    return String(update?.remoteVersion || '').replace(/^v/i, '').trim();
  }

  return Object.freeze({
    canAnnounce(update, rendererReady) {
      const version = versionOf(update);
      return Boolean(rendererReady && update?.available && version && version !== announcedVersion);
    },
    markAnnounced(update) {
      announcedVersion = versionOf(update);
    },
    reset() {
      announcedVersion = '';
    }
  });
}

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

function pickSetupAsset(assets, remoteVersion = '') {
  if (!Array.isArray(assets)) return null;
  const candidates = assets.filter(asset => {
    const name = String(asset?.name || '');
    return /setup/i.test(name) && /\.exe$/i.test(name) && (!remoteVersion || name.includes(remoteVersion));
  });
  return candidates.length === 1 ? candidates[0] : null;
}

function findLatestYml(assets) {
  if (!Array.isArray(assets)) return null;
  return assets.find(a => /^latest\.yml$/i.test(a.name)) || null;
}

function cacheBustedUrl(url) {
  const parsed = new URL(url);
  parsed.searchParams.set('_mhu_update', crypto.randomUUID());
  return parsed.toString();
}

async function fetchJson(url, signal, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT);
  const onAbort = () => controller.abort();
  const forceRefresh = options.forceRefresh === true;
  const fetchImpl = options.fetchImpl || fetch;
  if (signal) signal.addEventListener('abort', onAbort);

  try {
    const res = await fetchImpl(forceRefresh ? cacheBustedUrl(url) : url, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'follow',
      ...(forceRefresh ? {
        cache: 'no-store',
        headers: {
          'Cache-Control': 'no-cache, no-store',
          Pragma: 'no-cache'
        }
      } : {})
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

async function fetchGithubReleaseNotes(remoteVersion, fallback = '', fetchImpl = fetch) {
  const version = String(remoteVersion || '').replace(/^v/i, '').trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) return String(fallback || '');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT);
  try {
    const response = await fetchImpl(`${GITHUB_RELEASE_URL}/v${version}`, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Multi-Hoster-Upload'
      }
    });
    if (!response.ok) return String(fallback || '');
    const release = await response.json();
    const notes = typeof release?.body === 'string' ? release.body.trim() : '';
    return notes || String(fallback || '');
  } catch {
    return String(fallback || '');
  } finally {
    clearTimeout(timeout);
  }
}

async function checkForUpdate(options = {}) {
  const forceRefresh = options.forceRefresh === true;
  const fetchImpl = options.fetchImpl || fetch;
  if (!forceRefresh && cachedCheck && (Date.now() - cachedCheckTs) < CACHE_TTL) {
    return cachedCheck;
  }

  const releases = await fetchJson(API_URL, undefined, { forceRefresh, fetchImpl });

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

  const setupAsset = pickSetupAsset(release.assets, remoteVersion);
  const latestYml = findLatestYml(release.assets);

  if (!setupAsset) {
    return { available: false, reason: 'Kein Setup-Asset im Release gefunden' };
  }

  const releaseNotes = await fetchGithubReleaseNotes(remoteVersion, release.body || '', fetchImpl);
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
    releaseNotes
  };
  cachedCheckTs = Date.now();
  return cachedCheck;
}

async function parseLatestYml(url, expected = {}, fetchImpl = fetch) {
  if (!url) throw new Error('Prüfsummen-Metadaten fehlen');
  try {
    const res = await fetchImpl(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`Prüfsummen-Metadaten konnten nicht geladen werden: HTTP ${res.status}`);
    const text = await res.text();
    const version = text.match(/^version:\s*([^\r\n]+)$/m)?.[1]?.trim() || '';
    const assetPath = text.match(/^path:\s*([^\r\n]+)$/m)?.[1]?.trim() || '';
    const sha512 = text.match(/^sha512:\s*([A-Za-z0-9+/=]+)$/m)?.[1] || '';
    const sizeText = text.match(/^\s*size:\s*(\d+)\s*$/m)?.[1] || '';
    const size = Number(sizeText);
    if (!version || !assetPath || !sha512 || !Number.isSafeInteger(size) || size <= 0) {
      throw new Error('Prüfsummen-Metadaten sind unvollständig');
    }
    const decodedSha = Buffer.from(sha512, 'base64');
    if (decodedSha.length !== 64 || decodedSha.toString('base64') !== sha512) {
      throw new Error('Prüfsummen-Metadaten enthalten keine gültige SHA-512-Prüfsumme');
    }
    if (expected.version && version !== expected.version) {
      throw new Error('Prüfsummen-Metadaten gehören zu einer anderen Version');
    }
    if (expected.assetName && path.basename(assetPath) !== path.basename(expected.assetName)) {
      throw new Error('Prüfsummen-Metadaten gehören nicht zum ausgewählten Installer');
    }
    if (expected.assetSize && size !== Number(expected.assetSize)) {
      throw new Error('Prüfsummen-Metadaten enthalten eine abweichende Dateigröße');
    }
    return { version, path: assetPath, size, sha512 };
  } catch (error) {
    if (error && /Prüfsummen-Metadaten/.test(error.message)) throw error;
    throw new Error(`Prüfsummen-Metadaten konnten nicht geladen werden: ${error.message}`);
  }
}

function verifyExeHeader(buf) {
  // Check MZ header
  if (buf.length < 128 * 1024) return false;
  return buf[0] === 0x4D && buf[1] === 0x5A; // 'MZ'
}

async function prepareUpdate(onProgress, options = {}) {
  if (activeAbort) activeAbort.abort();
  activeAbort = new AbortController();
  const signal = activeAbort.signal;
  const fetchImpl = options.fetchImpl || fetch;
  let stagedInstallerPath = '';

  try {
    // Stage: starting
    if (onProgress) onProgress({ stage: 'starting', percent: 0 });

    let check = options.checkResult || null;
    if (!check || !check.available) {
      check = await checkForUpdate({ forceRefresh: true, fetchImpl });
    }
    if (!check || !check.available) {
      throw new Error('Kein Update verfügbar');
    }
    if (!check.assetUrl || !check.assetName) {
      throw new Error('Update-Asset unvollständig (URL oder Name fehlt)');
    }
    if (!check.latestYmlUrl) {
      throw new Error('Prüfsummen-Metadaten fehlen');
    }
    const manifest = await parseLatestYml(check.latestYmlUrl, {
      version: check.remoteVersion,
      assetName: check.assetName,
      assetSize: check.assetSize
    }, fetchImpl);
    const expectedSha = manifest.sha512;

    // Stage: downloading
    const tmpDir = options.tempDir || app.getPath('temp');
    const installerPath = path.join(tmpDir, check.assetName);

    const res = await fetchImpl(check.assetUrl, {
      method: 'GET',
      signal,
      redirect: 'follow'
    });

    if (!res.ok) {
      throw new Error(`Download fehlgeschlagen: HTTP ${res.status}`);
    }

    const totalBytes = manifest.size;
    let downloadedBytes = 0;
    let lastReportedPercent = -1;
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
      const percent = Math.max(0, Math.min(100, Math.floor((downloadedBytes / totalBytes) * 100)));
      if (onProgress && percent !== lastReportedPercent) {
        lastReportedPercent = percent;
        onProgress({
          stage: 'downloading',
          percent,
          bytesDownloaded: downloadedBytes,
          bytesTotal: totalBytes
        });
        await new Promise(resolve => setImmediate(resolve));
      }
    }

    const fileBuffer = Buffer.concat(chunks);
    if (fileBuffer.length !== manifest.size) {
      throw new Error('Heruntergeladene Datei hat eine abweichende Größe');
    }

    // Stage: verifying
    if (onProgress) onProgress({ stage: 'verifying', percent: 0 });

    if (!verifyExeHeader(fileBuffer)) {
      throw new Error('Heruntergeladene Datei ist keine gültige EXE');
    }

    const actualSha = crypto.createHash('sha512').update(fileBuffer).digest('base64');
    if (actualSha !== expectedSha) {
      const actualHex = crypto.createHash('sha512').update(fileBuffer).digest('hex');
      if (actualHex !== expectedSha.toLowerCase()) {
        throw new Error('SHA-512 Prüfung fehlgeschlagen');
      }
    }

    stagedInstallerPath = path.join(tmpDir, `${path.basename(check.assetName)}.${crypto.randomUUID()}.download`);
    fs.writeFileSync(stagedInstallerPath, fileBuffer);
    fs.rmSync(installerPath, { force: true });
    fs.renameSync(stagedInstallerPath, installerPath);
    stagedInstallerPath = '';

    const prepared = {
      installerPath,
      assetName: check.assetName,
      remoteVersion: check.remoteVersion || '',
      transportTag: check.transportTag || ''
    };
    if (onProgress) onProgress({ stage: 'prepared', percent: 100 });
    return prepared;

  } catch (err) {
    const failure = signal.aborted ? new Error('Update abgebrochen') : err;
    if (stagedInstallerPath) fs.rmSync(stagedInstallerPath, { force: true });
    if (onProgress) onProgress({ stage: signal.aborted ? 'aborted' : 'error', error: failure.message });
    throw failure;
  } finally {
    activeAbort = null;
  }
}

function launchPreparedUpdate(prepared, options = {}) {
  const installerPath = prepared && typeof prepared.installerPath === 'string' ? prepared.installerPath : '';
  if (!installerPath) throw new Error('Vorbereitetes Update ist unvollständig');
  const key = path.resolve(installerPath).toLowerCase();
  if (launchedInstallerPaths.has(key)) return false;
  const spawnImpl = options.spawnImpl || require('child_process').spawn;
  launchedInstallerPaths.add(key);
  try {
    spawnImpl(installerPath, ['/S', '--updated', '--force-run'], {
      detached: true,
      stdio: 'ignore'
    }).unref();
    return true;
  } catch (error) {
    launchedInstallerPaths.delete(key);
    throw error;
  }
}

function abortUpdate() {
  if (!activeAbort) return false;
  activeAbort.abort();
  return true;
}

module.exports = { checkForUpdate, fetchGithubReleaseNotes, prepareUpdate, launchPreparedUpdate, abortUpdate, isNewer, resolveReleaseVersion, pickSetupAsset, parseLatestYml, createUpdateAnnouncementState };
