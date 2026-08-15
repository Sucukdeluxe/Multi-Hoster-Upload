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
  const tracked = spawnSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'buffer'
  });
  assert.equal(tracked.status, 0, tracked.stderr?.toString('utf8'));
  const trackedFiles = tracked.stdout.toString('utf8').split('\0').filter(Boolean);
  for (const relativePath of trackedFiles) {
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

function verifyTracked(stage) {
  return spawnSync(process.execPath, [
    'scripts/verify-public-release.mjs',
    '--source-only',
    '--tracked',
    '--package-version'
  ], {
    cwd: stage,
    encoding: 'utf8'
  });
}

function git(stage, args) {
  const result = spawnSync('git', args, {
    cwd: stage,
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
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

  fs.copyFileSync(path.join(stage, screenshotFiles[1]), path.join(stage, 'docs', 'screenshots', 'unexpected.png'));
  const extraDocumentation = verify(stage);
  assert.equal(extraDocumentation.status, 1);
  assert.match(extraDocumentation.stderr, /docs\/screenshots\/unexpected\.png\tsource-layout-allowlist/);
  fs.rmSync(path.join(stage, 'docs', 'screenshots', 'unexpected.png'));

  const wrongVersion = verify(stage, '2.0.5');
  assert.equal(wrongVersion.status, 1);
  assert.match(wrongVersion.stderr, /package\.json\tpackage-version-target/);
});

test('public source verification runs against the actual checkout at its package version', () => {
  const executable = process.platform === 'win32' ? process.env.ComSpec : 'npm';
  const args = process.platform === 'win32'
    ? ['/d', '/s', '/c', 'npm run --silent verify:public-source']
    : ['run', '--silent', 'verify:public-source'];
  const result = spawnSync(executable, args, {
    cwd: root,
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  assert.match(result.stdout, new RegExp(`version=${currentVersion.replaceAll('.', '\\.')}\\b`));
  assert.match(result.stdout, /layout=exact/);
});

test('public release verifier rejects known credential patterns in approved text files', async (t) => {
  const stage = createStage();
  t.after(() => fs.rmSync(stage, { recursive: true, force: true }));
  const target = path.join(stage, 'README.md');
  const original = fs.readFileSync(target, 'utf8');
  const assignment = (name, value) => `${name} = "${value}"`;
  const fixtures = [
    ['access token', ['gh', 'p_'].join('') + 'SYNTHETICNOTREAL'.padEnd(36, '0')],
    ['fine-grained access token', ['github', 'pat'].join('_') + '_' + 'A'.repeat(82)],
    ['forge token assignment', assignment(['access', 'token'].join('_'), 'a'.repeat(40))],
    ['npm token', ['npm', ''].join('_') + 'A'.repeat(36)],
    ['Slack token', ['xox', 'b'].join('') + '-' + ['1'.repeat(12), '2'.repeat(12), 'A'.repeat(24)].join('-')],
    ['JWT', ['eyJ', 'hbGciOiJIUzI1NiJ9'].join('') + '.' + ['eyJ', 'zdWIiOiIxMjM0NTY3ODkwIn0'].join('') + '.signaturevalue'],
    ['Bearer token', ['Bear', 'er '].join('') + 'A'.repeat(32)],
    ['password assignment', assignment(['pass', 'word'].join(''), 'CorrectHorseBatteryStaple')],
    ['API key assignment', assignment(['api', 'key'].join('_'), 'A1b2C3d4E5f6G7h8')],
    ['unquoted password assignment', ['pass', 'word'].join('') + ': CorrectHorseBatteryStaple'],
    ['unquoted API key assignment', ['api', 'key'].join('_') + ': abcdefghijklmnop'],
    ['cookie assignment', assignment(['cook', 'ie'].join(''), 'session-value-123456789')],
    ['session assignment', assignment(['sess', 'ion'].join(''), 'session-value-123456789')],
    ['private key', ['-----BEGIN ', 'PRIVATE KEY-----'].join('') + '\nSYNTHETICNOTAKEY\n-----END PRIVATE KEY-----'],
    ['secret', ['aws', '_secret_access_key'].join('') + ' = ' + 'SYNTHETICNOTREALSECRET'.padEnd(40, '0')]
  ];

  for (const [name, fixture] of fixtures) {
    await t.test(name, () => {
      fs.writeFileSync(target, `${original}\n${fixture}\n`);
      const result = verify(stage);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /README\.md\tcredential-pattern/);
      fs.writeFileSync(target, original);
    });
  }
});

test('public release verifier rejects realistic credentials inside approved test files', (t) => {
  const stage = createStage();
  t.after(() => fs.rmSync(stage, { recursive: true, force: true }));
  const target = path.join(stage, 'tests', 'account-status.test.js');
  const original = fs.readFileSync(target, 'utf8');
  const fixture = ['pass', 'word'].join('') + ': CorrectHorseBatteryStaple';
  fs.writeFileSync(target, `${original}\n${fixture}\n`);

  const result = verify(stage);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /tests\/account-status\.test\.js\tcredential-pattern/);
});

test('--tracked validates tracked source and every untracked Electron build input', (t) => {
  const stage = createStage();
  t.after(() => fs.rmSync(stage, { recursive: true, force: true }));
  git(stage, ['init', '--quiet']);
  git(stage, ['add', '--all']);

  fs.writeFileSync(path.join(stage, 'tests', 'unexpected.json'), '{}');
  fs.writeFileSync(path.join(stage, 'tests', 'untracked.json'), '{}');
  fs.writeFileSync(path.join(stage, 'renderer', 'private-config.js'), 'module.exports = {};');
  git(stage, ['add', '--', 'tests/unexpected.json']);
  const result = verifyTracked(stage);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /tests\/unexpected\.json\tsource-layout-allowlist/);
  assert.match(result.stderr, /renderer\/private-config\.js\tsource-layout-allowlist/);
  assert.doesNotMatch(result.stderr, /tests\/untracked\.json/);
});

test('public release verifier detects private updater endpoints hidden by string concatenation', (t) => {
  const stage = createStage();
  t.after(() => fs.rmSync(stage, { recursive: true, force: true }));
  const target = path.join(stage, 'README.md');
  const original = fs.readFileSync(target, 'utf8');
  const hiddenEndpoint = String.fromCharCode(
    99, 111, 110, 115, 116, 32, 104, 111, 115, 116, 32, 61, 32, 39, 103, 105, 116, 39, 32, 43, 32, 39, 46,
    50, 52, 45, 39, 32, 43, 32, 39, 109, 117, 115, 105, 99, 46, 100, 101, 39, 59
  );
  fs.writeFileSync(target, `${original}\n${hiddenEndpoint}\n`);

  const result = verify(stage);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /README\.md\tupdater-endpoint-scope/);
});

test('public release verifier requires and validates every approved screenshot', (t) => {
  const stage = createStage();
  t.after(() => fs.rmSync(stage, { recursive: true, force: true }));
  fs.copyFileSync(path.join(root, screenshotFiles[0]), path.join(stage, screenshotFiles[0]));

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
