const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const rootFiles = [
  '.gitignore',
  'README.md',
  'SECURITY.md',
  'eslint.config.mjs',
  'main.js',
  'package-lock.json',
  'package.json',
  'preload-drop-target.js',
  'preload.js'
];
const directoryRoots = ['assets', 'lib', 'renderer', 'services/backup-api', 'tests'];
const scriptFiles = ['scripts/afterPack.cjs', 'scripts/dev-runner.cjs', 'scripts/release-plan.mjs', 'scripts/verify-public-release.mjs'];
const currentVersion = require('../package.json').version;

function copyDirectory(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (/^_ui-inject\..+\.tmp\.js$/.test(entry.name)) continue;
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) copyDirectory(sourcePath, destinationPath);
    else if (entry.isFile()) fs.copyFileSync(sourcePath, destinationPath);
  }
}

function createStage() {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'mhu-public-verifier-'));
  for (const relativePath of rootFiles) {
    const destination = path.join(stage, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(root, relativePath), destination);
  }
  for (const relativePath of directoryRoots) copyDirectory(path.join(root, relativePath), path.join(stage, relativePath));
  for (const relativePath of scriptFiles) {
    const destination = path.join(stage, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(root, relativePath), destination);
  }
  fs.rmSync(path.join(stage, 'assets', 'product-overview.png'), { force: true });
  return stage;
}

function verify(stage, version = currentVersion) {
  return spawnSync(process.execPath, ['scripts/verify-public-release.mjs', '--source-only', '--version', version], {
    cwd: stage,
    encoding: 'utf8'
  });
}

test('public release verifier accepts only the exact source manifest and target version', (t) => {
  const stage = createStage();
  t.after(() => fs.rmSync(stage, { recursive: true, force: true }));

  const baseline = verify(stage);
  assert.equal(baseline.status, 0, baseline.stderr);
  assert.match(baseline.stdout, /layout=exact/);

  fs.writeFileSync(path.join(stage, 'tests', 'unexpected.json'), '{}');
  const extra = verify(stage);
  assert.equal(extra.status, 1);
  assert.match(extra.stderr, /tests\/unexpected\.json\tsource-layout-allowlist/);
  fs.rmSync(path.join(stage, 'tests', 'unexpected.json'));

  const wrongVersion = verify(stage, '2.0.5');
  assert.equal(wrongVersion.status, 1);
  assert.match(wrongVersion.stderr, /package\.json\tpackage-version-target/);
});
