const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const releasePlanUrl = pathToFileURL(path.resolve(__dirname, '../scripts/release-plan.mjs')).href;

test('release planning rejects omitted or blank English release notes', async () => {
  const { parseReleaseArgs } = await import(releasePlanUrl);

  assert.throws(
    () => parseReleaseArgs(['2.1.20', '--transport-tag', 'v2.1.20']),
    /English release notes are required/
  );
  assert.throws(
    () => parseReleaseArgs(['2.1.20', '--transport-tag', 'v2.1.20', '   ']),
    /English release notes are required/
  );
});

test('release planning preserves dual-host asset names with English release notes', async () => {
  const { createReleasePlan, parseReleaseArgs } = await import(releasePlanUrl);
  const plan = createReleasePlan(parseReleaseArgs([
    '2.1.20',
    '--transport-tag',
    'v2.1.20',
    'Security hardening and reliability fixes.'
  ]));

  assert.equal(plan.releaseBody, 'Security hardening and reliability fixes.');
  assert.deepEqual(plan.expectedArtifacts, [
    'Multi-Hoster-Upload Setup 2.1.20.exe',
    'Multi-Hoster-Upload 2.1.20.exe',
    'Multi-Hoster-Upload Setup 2.1.20.exe.blockmap',
    'latest.yml'
  ]);
  assert.deepEqual(plan.githubExpectedArtifacts, [
    'Multi-Hoster-Upload.Setup.2.1.20.exe',
    'Multi-Hoster-Upload.2.1.20.exe',
    'Multi-Hoster-Upload.Setup.2.1.20.exe.blockmap',
    'latest.yml'
  ]);
});
