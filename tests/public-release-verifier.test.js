const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const screenshotFiles = [
  'assets/product-overview.png',
  'docs/screenshots/upload-workspace.png',
  'docs/screenshots/account-management.png',
  'docs/screenshots/automation-settings.png',
  'docs/screenshots/history.png'
];
const currentVersion = require('../package.json').version;

function createStage() {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'mhu-public-verifier-'));
  const tracked = spawnSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' });
  assert.equal(tracked.status, 0, tracked.stderr);
  for (const relativePath of tracked.stdout.trim().split(/\r?\n/u)) {
    const destination = path.join(stage, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(root, relativePath), destination);
  }
  return stage;
}

function verify(stage, version = currentVersion, sourceOnly = true) {
  const args = ['scripts/verify-public-release.mjs'];
  if (sourceOnly) args.push('--source-only');
  args.push('--version', version);
  return spawnSync(process.execPath, args, {
    cwd: stage,
    encoding: 'utf8'
  });
}

test('public release verifier accepts only the exact source manifest and target version', (t) => {
  const stage = createStage();
  t.after(() => fs.rmSync(stage, { recursive: true, force: true }));

  const baseline = verify(stage);
  assert.equal(baseline.status, 0, baseline.stderr);
  assert.equal(
    baseline.stdout,
    `public-release-source-ok files=157 denied-paths=0 internal-terms=0 version=${currentVersion} scripts=8 build-files=7 layout=exact screenshot=deferred\n`
  );

  fs.writeFileSync(path.join(stage, 'tests', 'unexpected.json'), '{}');
  const extra = verify(stage);
  assert.equal(extra.status, 1);
  assert.match(extra.stderr, /tests\/unexpected\.json\tsource-layout-allowlist/);
  fs.rmSync(path.join(stage, 'tests', 'unexpected.json'));

  fs.copyFileSync(path.join(stage, screenshotFiles[1]), path.join(stage, 'docs', 'screenshots', 'unexpected.png'));
  const extraDocumentation = verify(stage);
  assert.equal(extraDocumentation.status, 1);
  assert.match(extraDocumentation.stderr, /docs\/screenshots\/unexpected\.png\tsource-layout-allowlist/);
  fs.rmSync(path.join(stage, 'docs', 'screenshots', 'unexpected.png'));

  const wrongVersion = verify(stage, '2.0.5');
  assert.equal(wrongVersion.status, 1);
  assert.match(wrongVersion.stderr, /package\.json\tpackage-version-target/);
});

test('public release verifier requires and validates every approved screenshot', (t) => {
  const stage = createStage();
  t.after(() => fs.rmSync(stage, { recursive: true, force: true }));

  const baseline = verify(stage, currentVersion, false);
  assert.equal(baseline.status, 0, baseline.stderr);

  for (const relativePath of screenshotFiles) {
    const absolutePath = path.join(stage, relativePath);
    const original = fs.readFileSync(absolutePath);
    const invalid = Buffer.from(original);
    invalid.writeUInt32BE(999, 16);
    fs.writeFileSync(absolutePath, invalid);

    const invalidScreenshot = verify(stage, currentVersion, false);
    assert.equal(invalidScreenshot.status, 1);
    assert.ok(invalidScreenshot.stderr.includes(`${relativePath}\tproduct-screenshot`), invalidScreenshot.stderr);
    fs.writeFileSync(absolutePath, original);
  }

  const missingPath = screenshotFiles.at(-1);
  fs.rmSync(path.join(stage, missingPath));
  const missingScreenshot = verify(stage, currentVersion, false);
  assert.equal(missingScreenshot.status, 1);
  assert.ok(missingScreenshot.stderr.includes(`${missingPath}\trequired-screenshot`), missingScreenshot.stderr);
});
