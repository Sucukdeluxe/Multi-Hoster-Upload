const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const { isNewer, resolveReleaseVersion } = require('../lib/updater');

test('bridge title resolves product version instead of transport tag', () => {
  assert.equal(resolveReleaseVersion({ name: 'Multi-Hoster-Upload v2.0.1', tag_name: 'v3.3.109' }), '2.0.1');
  assert.equal(isNewer('2.0.1', '2.0.1'), false);
  assert.equal(isNewer('2.0.2', '2.0.1'), true);
});

test('release CLI rejects a malformed transport tag before release work', () => {
  const script = path.resolve(__dirname, '../scripts/release_gitea.mjs');
  const result = spawnSync(process.execPath, [script, '2.0.1', '--transport-tag', '3.3.109', 'Bridge', '--dry-run'], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8'
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--transport-tag must match vX\.Y\.Z/);
  assert.doesNotMatch(result.stdout, /npm run release:win/);
});

test('release plan keeps product artifacts separate from the transport tag', () => {
  const script = path.resolve(__dirname, '../scripts/release_gitea.mjs');
  const moduleUrl = pathToFileURL(script).href;
  const source = `
    import { createReleasePlan, parseReleaseArgs, renderLatestYml } from ${JSON.stringify(moduleUrl)};
    const plan = createReleasePlan(parseReleaseArgs(['2.0.1', '--transport-tag', 'v3.3.109', 'Bridge', 'notes']));
    const latestYml = renderLatestYml(plan, 'abc123', 456, '2026-08-07T12:00:00.000Z');
    process.stdout.write(JSON.stringify({
      version: plan.version,
      transportTag: plan.transportTag,
      releaseTitle: plan.releaseTitle,
      releaseBody: plan.releaseBody,
      expectedArtifacts: plan.expectedArtifacts,
      latestYml
    }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    version: '2.0.1',
    transportTag: 'v3.3.109',
    releaseTitle: 'Multi-Hoster-Upload v2.0.1',
    releaseBody: 'Bridge notes',
    expectedArtifacts: [
      'Multi-Hoster-Upload Setup 2.0.1.exe',
      'Multi-Hoster-Upload 2.0.1.exe',
      'latest.yml'
    ],
    latestYml: "version: 2.0.1\nfiles:\n  - url: Multi-Hoster-Upload Setup 2.0.1.exe\n    sha512: abc123\n    size: 456\npath: Multi-Hoster-Upload Setup 2.0.1.exe\nsha512: abc123\nreleaseDate: '2026-08-07T12:00:00.000Z'\n"
  });
});

test('compatible existing release preserves the recovery id', async () => {
  const moduleUrl = pathToFileURL(path.resolve(__dirname, '../scripts/release_gitea.mjs')).href;
  const { createReleasePlan, parseReleaseArgs, resolveExistingReleaseId } = await import(moduleUrl);
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
  const moduleUrl = pathToFileURL(path.resolve(__dirname, '../scripts/release_gitea.mjs')).href;
  const { createReleasePlan, parseReleaseArgs, resolveExistingReleaseId } = await import(moduleUrl);
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
