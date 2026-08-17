const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

const { isNewer, resolveReleaseVersion, fetchGithubReleaseNotes, prepareUpdate, launchPreparedUpdate, pickSetupAsset, parseLatestYml } = require('../lib/updater');
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
