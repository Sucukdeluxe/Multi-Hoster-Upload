const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');

const { isNewer, resolveReleaseVersion, fetchGithubReleaseNotes, prepareUpdate, launchPreparedUpdate, pickSetupAsset, parseLatestYml, createUpdateAnnouncementState, abortUpdate } = require('../lib/updater');
const releasePlanUrl = pathToFileURL(path.resolve(__dirname, '../scripts/release-plan.mjs')).href;

test('bridge title resolves product version instead of transport tag', () => {
  assert.equal(resolveReleaseVersion({ name: 'Multi-Hoster-Upload v2.0.1', tag_name: 'v3.3.109' }), '2.0.1');
  assert.equal(isNewer('2.0.1', '2.0.1'), false);
  assert.equal(isNewer('2.0.2', '2.0.1'), true);
});

test('release arguments reject a malformed transport tag', async () => {
  const { parseReleaseArgs } = await import(releasePlanUrl);
  assert.throws(
    () => parseReleaseArgs(['2.0.1', '--transport-tag', '3.3.109', 'Bridge', '--dry-run']),
    /--transport-tag must match vX\.Y\.Z/
  );
});

test('matching GitHub release notes replace the private release body', async () => {
  const calls = [];
  const notes = await fetchGithubReleaseNotes('2.1.0', 'Private fallback', async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ tag_name: 'v2.1.0', body: '## Public changes\n\n- English UI' }) };
  });

  assert.equal(notes, '## Public changes\n\n- English UI');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.github.com/repos/Sucukdeluxe/Multi-Hoster-Upload/releases/tags/v2.1.0');
});

test('GitHub release-note failures preserve the private release body', async () => {
  const notes = await fetchGithubReleaseNotes('2.1.0', 'Private fallback', async () => ({ ok: false }));
  assert.equal(notes, 'Private fallback');
});

test('update preparation writes a verified installer without launching it', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mhu-updater-test-'));
  const installer = Buffer.alloc(128 * 1024, 0);
  installer[0] = 0x4d;
  installer[1] = 0x5a;
  let reads = 0;
  const progress = [];
  try {
    const prepared = await prepareUpdate(value => progress.push(value), {
      checkResult: {
        available: true,
        assetUrl: 'https://update.invalid/setup.exe',
        assetName: 'setup.exe',
        assetSize: installer.length,
        remoteVersion: '2.2.0',
        latestYmlUrl: 'https://update.invalid/latest.yml'
      },
      tempDir,
      fetchImpl: async url => url.endsWith('latest.yml')
        ? {
            ok: true,
            status: 200,
            text: async () => `version: 2.2.0\npath: setup.exe\nsha512: ${crypto.createHash('sha512').update(installer).digest('base64')}\nsize: ${installer.length}\n`
          }
        : {
            ok: true,
            status: 200,
            body: {
              getReader: () => ({
                read: async () => {
                  reads++;
                  return reads === 1 ? { done: false, value: installer } : { done: true };
                }
              })
            }
          }
    });

    assert.equal(prepared.installerPath, path.join(tempDir, 'setup.exe'));
    assert.deepEqual(fs.readFileSync(prepared.installerPath), installer);
    assert.equal(progress.at(-1).stage, 'prepared');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('buffered installer downloads yield between progress updates so the renderer can paint', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mhu-updater-progress-test-'));
  const installer = Buffer.alloc(128 * 1024, 0);
  installer[0] = 0x4d;
  installer[1] = 0x5a;
  const chunks = [
    installer.subarray(0, 32 * 1024),
    installer.subarray(32 * 1024, 64 * 1024),
    installer.subarray(64 * 1024, 96 * 1024),
    installer.subarray(96 * 1024)
  ];
  const progress = [];
  let readerIndex = 0;
  let preparationFinished = false;
  let rendererObservedProgressBeforeFinish = false;
  let rendererObservationScheduled = false;

  try {
    await prepareUpdate(value => {
      progress.push(value);
      if (value.stage !== 'downloading' || rendererObservationScheduled) return;
      rendererObservationScheduled = true;
      setImmediate(() => {
        rendererObservedProgressBeforeFinish = !preparationFinished;
      });
    }, {
      checkResult: {
        available: true,
        assetUrl: 'https://update.invalid/setup.exe',
        assetName: 'setup.exe',
        remoteVersion: '2.2.0',
        latestYmlUrl: 'https://update.invalid/latest.yml'
      },
      tempDir,
      fetchImpl: async url => url.endsWith('latest.yml')
        ? {
            ok: true,
            status: 200,
            text: async () => `version: 2.2.0\npath: setup.exe\nsha512: ${crypto.createHash('sha512').update(installer).digest('base64')}\nsize: ${installer.length}\n`
          }
        : {
            ok: true,
            status: 200,
            body: {
              getReader: () => ({
                read: async () => readerIndex < chunks.length
                  ? { done: false, value: chunks[readerIndex++] }
                  : { done: true }
              })
            }
          }
    });
    preparationFinished = true;
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(rendererObservedProgressBeforeFinish, true);
    assert.deepEqual(
      progress.filter(value => value.stage === 'downloading').map(value => value.percent),
      [25, 50, 75, 100]
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('cancelling an active installer download reports an aborted state', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mhu-updater-abort-test-'));
  const installer = Buffer.alloc(128 * 1024, 0);
  installer[0] = 0x4d;
  installer[1] = 0x5a;
  const progress = [];
  let reads = 0;

  try {
    await assert.rejects(
      prepareUpdate(value => {
        progress.push(value);
        if (value.stage === 'downloading') abortUpdate();
      }, {
        checkResult: {
          available: true,
          assetUrl: 'https://update.invalid/setup.exe',
          assetName: 'setup.exe',
          assetSize: installer.length,
          remoteVersion: '2.2.0',
          latestYmlUrl: 'https://update.invalid/latest.yml'
        },
        tempDir,
        fetchImpl: async url => url.endsWith('latest.yml')
          ? {
              ok: true,
              status: 200,
              text: async () => `version: 2.2.0\npath: setup.exe\nsha512: ${crypto.createHash('sha512').update(installer).digest('base64')}\nsize: ${installer.length}\n`
            }
          : {
              ok: true,
              status: 200,
              body: {
                getReader: () => ({
                  read: async () => {
                    reads++;
                    return reads === 1
                      ? { done: false, value: installer.subarray(0, installer.length / 2) }
                      : { done: false, value: installer.subarray(installer.length / 2) };
                  }
                })
              }
            }
      }),
      /Update abgebrochen/
    );

    assert.equal(progress.at(-1).stage, 'aborted');
    assert.equal(progress.at(-1).error, 'Update abgebrochen');
    assert.equal(fs.existsSync(path.join(tempDir, 'setup.exe')), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('update preparation refreshes a cached release before downloading the installer', async () => {
  const updaterPath = require.resolve('../lib/updater');
  const originalLoad = Module._load;
  const originalFetch = global.fetch;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mhu-updater-refresh-test-'));
  const installer = Buffer.alloc(128 * 1024, 0);
  installer[0] = 0x4d;
  installer[1] = 0x5a;
  const sha512 = crypto.createHash('sha512').update(installer).digest('base64');
  const oldVersion = '2.1.23';
  const latestVersion = '2.1.24';
  const createRelease = version => ({
    name: `Multi-Hoster-Upload v${version}`,
    tag_name: `v${version}`,
    html_url: `https://update.invalid/releases/${version}`,
    body: `Release ${version}`,
    assets: [
      {
        name: `Multi-Hoster-Upload Setup ${version}.exe`,
        size: installer.length,
        browser_download_url: `https://update.invalid/${version}/setup.exe`
      },
      {
        name: 'latest.yml',
        browser_download_url: `https://update.invalid/${version}/latest.yml`
      }
    ]
  });
  const createResponse = payload => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload),
    json: async () => payload
  });
  const createInstallerResponse = () => ({
    ok: true,
    status: 200,
    body: {
      getReader: () => {
        let served = false;
        return {
          read: async () => {
            if (served) return { done: true };
            served = true;
            return { done: false, value: installer };
          }
        };
      }
    }
  });
  const createManifestResponse = version => ({
    ok: true,
    status: 200,
    text: async () => `version: ${version}\npath: Multi-Hoster-Upload Setup ${version}.exe\nsha512: ${sha512}\nsize: ${installer.length}\n`
  });

  Module._load = function load(request, parent, isMain) {
    if (request === 'electron') return { app: { getVersion: () => '2.1.22', getPath: () => tempDir } };
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[updaterPath];
  const isolatedUpdater = require(updaterPath);

  try {
    global.fetch = async url => {
      const value = String(url);
      if (value.includes('/api/v1/repos/')) return createResponse([createRelease(oldVersion)]);
      if (value.includes('api.github.com')) return createResponse({ body: `Release ${oldVersion}` });
      throw new Error(`Unexpected initial request: ${value}`);
    };
    const oldCheck = await isolatedUpdater.checkForUpdate();
    assert.equal(oldCheck.remoteVersion, oldVersion);

    global.fetch = async url => {
      const value = String(url);
      if (value.includes('/api/v1/repos/')) return createResponse([createRelease(latestVersion)]);
      if (value.includes('api.github.com')) return createResponse({ body: `Release ${latestVersion}` });
      if (value.endsWith(`${oldVersion}/latest.yml`)) return createManifestResponse(oldVersion);
      if (value.endsWith(`${latestVersion}/latest.yml`)) return createManifestResponse(latestVersion);
      if (value.endsWith(`${oldVersion}/setup.exe`) || value.endsWith(`${latestVersion}/setup.exe`)) return createInstallerResponse();
      throw new Error(`Unexpected refreshed request: ${value}`);
    };

    const prepared = await isolatedUpdater.prepareUpdate(null, { tempDir });
    assert.equal(prepared.remoteVersion, latestVersion);
    assert.equal(prepared.assetName, `Multi-Hoster-Upload Setup ${latestVersion}.exe`);
  } finally {
    global.fetch = originalFetch;
    Module._load = originalLoad;
    delete require.cache[updaterPath];
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('an update found before renderer readiness remains announceable afterwards', () => {
  const state = createUpdateAnnouncementState();
  const update = { available: true, remoteVersion: '2.1.24' };

  assert.equal(state.canAnnounce(update, false), false);
  assert.equal(state.canAnnounce(update, true), true);
  assert.equal(state.canAnnounce(update, true), true);
  state.markAnnounced(update);
  assert.equal(state.canAnnounce(update, true), false);

  state.reset();
  assert.equal(state.canAnnounce(update, true), true);
});

test('update preparation fails closed when checksum metadata is unavailable', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mhu-updater-test-'));
  try {
    await assert.rejects(
      prepareUpdate(null, {
        checkResult: {
          available: true,
          assetUrl: 'https://update.invalid/setup.exe',
          assetName: 'setup.exe',
          assetSize: 128 * 1024,
          remoteVersion: '2.2.0',
          latestYmlUrl: null
        },
        tempDir,
        fetchImpl: async () => assert.fail('installer download must not start without checksum metadata')
      }),
      /Prüfsummen-Metadaten fehlen/
    );
    assert.equal(fs.existsSync(path.join(tempDir, 'setup.exe')), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('setup selection never falls back to a portable executable', () => {
  const portable = { name: 'Multi-Hoster-Upload 2.2.0.exe' };
  assert.equal(pickSetupAsset([portable], '2.2.0'), null);
  assert.deepEqual(
    pickSetupAsset([portable, { name: 'Multi-Hoster-Upload Setup 2.2.0.exe' }], '2.2.0'),
    { name: 'Multi-Hoster-Upload Setup 2.2.0.exe' }
  );
});

test('checksum metadata must match the selected version, installer name, size, and SHA-512 shape', async () => {
  const sha = crypto.randomBytes(64).toString('base64');
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    text: async () => `version: 2.2.0\npath: Multi-Hoster-Upload Setup 2.2.0.exe\nsha512: ${sha}\nsize: 456\n`
  });
  const metadata = await parseLatestYml('https://update.invalid/latest.yml', {
    version: '2.2.0',
    assetName: 'Multi-Hoster-Upload Setup 2.2.0.exe',
    assetSize: 456
  }, fetchImpl);

  assert.deepEqual(metadata, {
    version: '2.2.0',
    path: 'Multi-Hoster-Upload Setup 2.2.0.exe',
    size: 456,
    sha512: sha
  });
});

test('checksum metadata rejects a path that belongs to another artifact', async () => {
  const sha = crypto.randomBytes(64).toString('base64');
  await assert.rejects(
    parseLatestYml('https://update.invalid/latest.yml', {
      version: '2.2.0',
      assetName: 'Multi-Hoster-Upload Setup 2.2.0.exe',
      assetSize: 456
    }, async () => ({
      ok: true,
      status: 200,
      text: async () => `version: 2.2.0\npath: Multi-Hoster-Upload 2.2.0.exe\nsha512: ${sha}\nsize: 456\n`
    })),
    /gehören nicht zum ausgewählten Installer/
  );
});

test('a prepared installer launches at most once', () => {
  const calls = [];
  const child = { unrefCalls: 0, unref() { this.unrefCalls++; } };
  const prepared = { installerPath: 'C:\\Temp\\mhu-setup.exe' };
  const spawnImpl = (...args) => {
    calls.push(args);
    return child;
  };

  assert.equal(launchPreparedUpdate(prepared, { spawnImpl }), true);
  assert.equal(launchPreparedUpdate(prepared, { spawnImpl }), false);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [
    prepared.installerPath,
    ['/S', '--updated', '--force-run'],
    { detached: true, stdio: 'ignore' }
  ]);
  assert.equal(child.unrefCalls, 1);
});

test('release plan keeps product artifacts separate from the transport tag', async () => {
  const { createReleasePlan, parseReleaseArgs, renderLatestYml } = await import(releasePlanUrl);
  const plan = createReleasePlan(parseReleaseArgs(['2.0.7', '--transport-tag', 'v3.3.115', 'Update', 'visibility']));
  const latestYml = renderLatestYml(plan, 'abc123', 456, '2026-08-07T12:00:00.000Z');
  assert.deepEqual({
    version: plan.version,
    transportTag: plan.transportTag,
    releaseTitle: plan.releaseTitle,
    releaseBody: plan.releaseBody,
    expectedArtifacts: plan.expectedArtifacts,
    latestYml
  }, {
    version: '2.0.7',
    transportTag: 'v3.3.115',
    releaseTitle: 'Multi-Hoster-Upload v2.0.7',
    releaseBody: 'Update visibility',
    expectedArtifacts: [
      'Multi-Hoster-Upload Setup 2.0.7.exe',
      'Multi-Hoster-Upload 2.0.7.exe',
      'Multi-Hoster-Upload Setup 2.0.7.exe.blockmap',
      'latest.yml'
    ],
    latestYml: "version: 2.0.7\nfiles:\n  - url: Multi-Hoster-Upload Setup 2.0.7.exe\n    sha512: abc123\n    size: 456\npath: Multi-Hoster-Upload Setup 2.0.7.exe\nsha512: abc123\nreleaseDate: '2026-08-07T12:00:00.000Z'\n"
  });
});

test('compatible existing release preserves the recovery id', async () => {
  const { createReleasePlan, parseReleaseArgs, resolveExistingReleaseId } = await import(releasePlanUrl);
  const plan = createReleasePlan(parseReleaseArgs(['2.0.1', '--transport-tag', 'v3.3.109', 'Bridge notes']));
  const release = {
    id: 81,
    tag_name: 'v3.3.109',
    name: 'Multi-Hoster-Upload v2.0.1',
    body: 'Bridge notes',
    draft: false,
    prerelease: false,
    assets: []
  };

  assert.equal(resolveExistingReleaseId(plan, release), 81);
});

test('incompatible existing release title fails closed', async () => {
  const { createReleasePlan, parseReleaseArgs, resolveExistingReleaseId } = await import(releasePlanUrl);
  const plan = createReleasePlan(parseReleaseArgs(['2.0.1', '--transport-tag', 'v3.3.109', 'Bridge notes']));
  const release = {
    id: 81,
    tag_name: 'v3.3.109',
    name: 'Multi-Hoster-Upload v3.3.109',
    body: 'Old transport release',
    draft: false,
    prerelease: false,
    assets: []
  };

  assert.throws(
    () => resolveExistingReleaseId(plan, release),
    /Refusing recovery for v3\.3\.109: existing release title "Multi-Hoster-Upload v3\.3\.109" does not match "Multi-Hoster-Upload v2\.0\.1"/
  );
});
