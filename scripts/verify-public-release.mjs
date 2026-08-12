import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const failures = new Map();
const publicActionsDir = `.${['git', 'hub'].join('')}`;
const privateActionsDir = `.${['gi', 'tea'].join('')}`;
const sourceFiles = [
  '.gitignore',
  'README.md',
  'SECURITY.md',
  'assets/app_icon.ico',
  'assets/app_icon.png',
  'eslint.config.mjs',
  `${privateActionsDir}/workflows/ci.yml`,
  `${publicActionsDir}/workflows/ci.yml`,
  'lib/account-auth.js',
  'lib/account-rotation.js',
  'lib/backup-crypto.js',
  'lib/clouddrop-upload.js',
  'lib/coalesced-set.js',
  'lib/config-store.js',
  'lib/diagnostics-agent.js',
  'lib/diagnostics-collectors.js',
  'lib/doodstream-upload.js',
  'lib/file-probe.js',
  'lib/file-discovery.js',
  'lib/folder-monitor.js',
  'lib/hosters.js',
  'lib/ip-allowlist.js',
  'lib/log-mode.js',
  'lib/log-policy.js',
  'lib/log-rotation.js',
  'lib/online-backup.js',
  'lib/orphan-tmp.js',
  'lib/queue-dedup.js',
  'lib/queue-prune.js',
  'lib/remote-capture-preload.js',
  'lib/remote-capture.html',
  'lib/remote-server.js',
  'lib/secret-store.js',
  'lib/semaphore.js',
  'lib/serialized-runner.js',
  'lib/settings-backup.js',
  'lib/settings-import-gate.js',
  'lib/source-cleanup-policy.js',
  'lib/source-delete-journal.js',
  'lib/source-file-cleanup.js',
  'lib/speed-history.js',
  'lib/startup-renderer.js',
  'lib/stats.js',
  'lib/support-bundle.js',
  'lib/session-report.js',
  'lib/throttle-timer.js',
  'lib/throttle.js',
  'lib/throttled-cache.js',
  'lib/updater.js',
  'lib/upload-log.js',
  'lib/upload-confirmation.js',
  'lib/upload-diagnostics.js',
  'lib/upload-manager.js',
  'lib/vidmoly-upload.js',
  'lib/voe-upload.js',
  'lib/webhook-notify.js',
  'main.js',
  'package-lock.json',
  'package.json',
  'preload-drop-target.js',
  'preload.js',
  'renderer/account-status.js',
  'renderer/account-submit.js',
  'renderer/app.js',
  'renderer/auto-resume.js',
  'renderer/drop-target.html',
  'renderer/i18n.js',
  'renderer/index.html',
  'renderer/history-status.js',
  'renderer/queue-stats.js',
  'renderer/styles.css',
  'scripts/afterPack.cjs',
  'scripts/dev-runner.cjs',
  'scripts/release-plan.mjs',
  'scripts/verify-public-release.mjs',
  'services/backup-api/package-lock.json',
  'services/backup-api/package.json',
  'services/backup-api/src/cli.mjs',
  'services/backup-api/src/server.mjs',
  'services/backup-api/test/server.test.mjs',
  'tests/account-auth.test.js',
  'tests/account-rotation.test.js',
  'tests/account-status.test.js',
  'tests/auto-resume.test.js',
  'tests/backup-crypto.test.js',
  'tests/byse-reject-recovery.test.js',
  'tests/coalesced-set.test.js',
  'tests/config-store.test.js',
  'tests/diagnostics-agent.test.js',
  'tests/diagnostics-collectors.test.js',
  'tests/diagnostics-protocol.test.js',
  'tests/dev-runner.test.js',
  'tests/doodstream-api-upload.test.js',
  'tests/doodstream-upload.test.js',
  'tests/file-probe.test.js',
  'tests/file-discovery.test.js',
  'tests/folder-monitor.test.js',
  'tests/history-status.test.js',
  'tests/history-retention.test.js',
  'tests/hosters.test.js',
  'tests/i18n.test.js',
  'tests/ip-allowlist.test.js',
  'tests/log-mode.test.js',
  'tests/log-policy.test.js',
  'tests/log-rotation.test.js',
  'tests/online-backup-service.test.js',
  'tests/online-backup.test.js',
  'tests/orphan-tmp.test.js',
  'tests/package-build-files.test.js',
  'tests/public-release-verifier.test.js',
  'tests/queue-dedup-property.test.js',
  'tests/queue-dedup.test.js',
  'tests/queue-persistence-scenario.test.js',
  'tests/queue-prune.test.js',
  'tests/queue-stats.test.js',
  'tests/remote-config.test.js',
  'tests/remote-server.test.js',
  'tests/semaphore.test.js',
  'tests/secret-store.test.js',
  'tests/serialized-runner.test.js',
  'tests/settings-backup.test.js',
  'tests/settings-import-gate.test.js',
  'tests/speed-history.test.js',
  'tests/source-cleanup-policy.test.js',
  'tests/source-delete-journal.test.js',
  'tests/source-file-cleanup.test.js',
  'tests/startup-renderer.test.js',
  'tests/stats.test.js',
  'tests/support-bundle.test.js',
  'tests/suspect-reject-alternates.test.js',
  'tests/throttle-timer.test.js',
  'tests/throttle.test.js',
  'tests/throttled-cache.test.js',
  'tests/ui-smoke.js',
  'tests/updater-version.test.js',
  'tests/upload-log.test.js',
  'tests/upload-confirmation.test.js',
  'tests/upload-diagnostics.test.js',
  'tests/upload-manager.test.js',
  'tests/session-report.test.js',
  'tests/validate-credentials.test.js',
  'tests/webhook-notify.test.js'
];
const screenshotFiles = [
  'assets/product-overview.png',
  'docs/screenshots/upload-workspace.png',
  'docs/screenshots/account-management.png',
  'docs/screenshots/automation-settings.png',
  'docs/screenshots/history.png'
];
const allowedFiles = new Set([...sourceFiles, ...screenshotFiles]);
const textExtensions = new Set(['.cjs', '.css', '.html', '.js', '.json', '.md', '.mjs', '.txt', '.yaml', '.yml']);
const binaryExtensions = new Set(['.ico', '.png']);
const expectedScripts = {
  start: 'electron .',
  dev: 'node scripts/dev-runner.cjs',
  test: 'node --test tests/*.test.js tests/ui-smoke.js',
  'test:backup-api': 'npm --prefix services/backup-api test',
  verify: 'npm run lint && npm test && npm run test:backup-api && npm audit --omit=dev',
  lint: 'eslint .',
  dist: 'electron-builder --publish never --win',
  'release:win': 'electron-builder --publish never --win nsis portable'
};
const expectedBuildFiles = [
  'main.js',
  'preload.js',
  'preload-drop-target.js',
  'lib/**/*',
  'renderer/**/*',
  'assets/app_icon.ico',
  'assets/app_icon.png'
];
const deniedBasenames = new Set([
  'agents.md',
  'app.py',
  `${['clau', 'de'].join('')}.md`,
  'credentials.json',
  'gemini.md',
  'hosters.py',
  'memory.md',
  'memory_summary.md',
  'raw_memories.md',
  'requirements.txt',
  ['release_', ['gi', 'tea'].join(''), '.mjs'].join('')
]);
const aiTerms = [
  ['clau', 'de'].join(''),
  ['co', 'dex'].join(''),
  ['chat', 'gpt'].join('')
].join('|');
const personalTerms = [
  ['pl', 'oet'].join(''),
  ['baker', 'edwin318'].join('')
].join('|');
const internalTerms = [
  ['internal', ' investigation'].join(''),
  ['interne', ' untersuchung'].join(''),
  ['audit', ' method'].join(''),
  ['test', ' chronicle'].join(''),
  ['generated', ' by'].join(''),
  ['co-authored', '-by'].join('')
].join('|');
const forbiddenAiPattern = new RegExp(`\\b(?:${aiTerms}|multi[\\s-]+agents?)\\b`, 'i');
const forbiddenPersonalPattern = new RegExp(`(?:[a-z]:[\\\\/]+users[\\\\/]+|\\b(?:${personalTerms})\\b|\\bdesktop-[a-z0-9-]+\\b)`, 'i');
const forbiddenInternalPattern = new RegExp(`\\b(?:${internalTerms})\\b`, 'i');
const updaterOnlyPattern = new RegExp([
  ['gi', 'tea'].join(''),
  ['git', '24-music', 'de'].join('\\.'),
  [['Admin', 'istrator'].join(''), 'Multi-Hoster-Upload'].join('\\/')
].join('|'), 'i');

function addFailure(file, rule) {
  if (!failures.has(file)) failures.set(file, new Set());
  failures.get(file).add(rule);
}

function normalizeRelative(value) {
  return value.split(path.sep).join('/');
}

function buildAllowedDirectories(files) {
  const directories = new Set();
  for (const file of files) {
    let current = path.posix.dirname(file);
    while (current && current !== '.') {
      directories.add(current);
      current = path.posix.dirname(current);
    }
  }
  return directories;
}

const allowedDirectories = buildAllowedDirectories(allowedFiles);

function isDeniedBasename(basename) {
  const lower = basename.toLowerCase();
  return deniedBasenames.has(lower)
    || /^\.env(?:\.|$)/i.test(basename)
    || /\.(?:bak|db|log|sqlite|sqlite3|tmp)$/i.test(basename);
}

function parseArguments() {
  const sourceOnlyCount = args.filter((arg) => arg === '--source-only').length;
  const versionFlagIndexes = args.map((arg, index) => arg === '--version' ? index : -1).filter((index) => index >= 0);
  const versionIndex = versionFlagIndexes[0] ?? -1;
  const expectedVersion = versionIndex >= 0 ? args[versionIndex + 1] : '';
  const consumed = new Set();

  if (sourceOnlyCount === 1) consumed.add(args.indexOf('--source-only'));
  if (sourceOnlyCount > 1) addFailure('scripts/verify-public-release.mjs', 'duplicate-source-only');
  if (versionFlagIndexes.length !== 1 || !/^\d+\.\d+\.\d+$/.test(expectedVersion || '')) {
    addFailure('scripts/verify-public-release.mjs', 'expected-version-argument');
  } else {
    consumed.add(versionIndex);
    consumed.add(versionIndex + 1);
  }

  for (let index = 0; index < args.length; index++) {
    if (!consumed.has(index)) addFailure('scripts/verify-public-release.mjs', 'argument-allowlist');
  }

  return { sourceOnly: sourceOnlyCount === 1, expectedVersion };
}

async function enumerate(directory = root, relativeDirectory = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const relativePath = normalizeRelative(path.join(relativeDirectory, entry.name));
    if (relativePath === '.git') continue;
    const absolutePath = path.join(directory, entry.name);
    const stats = await lstat(absolutePath);

    if (stats.isSymbolicLink()) {
      addFailure(relativePath, 'unsupported-file-type');
      continue;
    }

    if (entry.isDirectory()) {
      if (!allowedDirectories.has(relativePath)) {
        addFailure(relativePath, 'source-layout-allowlist');
        continue;
      }
      files.push(...await enumerate(absolutePath, relativePath));
      continue;
    }

    if (!entry.isFile()) {
      addFailure(relativePath, 'unsupported-file-type');
      continue;
    }

    if (isDeniedBasename(entry.name)) addFailure(relativePath, 'denied-basename');
    if (!allowedFiles.has(relativePath)) addFailure(relativePath, 'source-layout-allowlist');
    files.push(relativePath);
  }

  return files;
}

async function readJson(relativePath, rule) {
  try {
    return JSON.parse(await readFile(path.join(root, relativePath), 'utf8'));
  } catch {
    addFailure(relativePath, rule);
    return null;
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function validateTextFiles(files) {
  for (const relativePath of files) {
    const extension = path.extname(relativePath).toLowerCase();
    const isTextFile = textExtensions.has(extension) || relativePath === '.gitignore';
    if (!isTextFile) {
      if (!binaryExtensions.has(extension)) addFailure(relativePath, 'source-extension-allowlist');
      continue;
    }

    const value = await readFile(path.join(root, relativePath), 'utf8');
    if (forbiddenPersonalPattern.test(value)) addFailure(relativePath, 'forbidden-personal-term');
    if (forbiddenAiPattern.test(value)) addFailure(relativePath, 'forbidden-ai-term');
    if (forbiddenInternalPattern.test(value)) addFailure(relativePath, 'forbidden-internal-term');
    if (relativePath !== 'lib/updater.js' && updaterOnlyPattern.test(value)) addFailure(relativePath, 'updater-endpoint-scope');
  }
}

function validatePackage(packageJson, packageLock, files, expectedVersion) {
  if (!packageJson) return;
  if (packageJson.version !== expectedVersion) addFailure('package.json', 'package-version-target');
  if (stableJson(packageJson.scripts) !== stableJson(expectedScripts)) addFailure('package.json', 'package-script-allowlist');

  const buildFiles = packageJson.build?.files;
  if (!Array.isArray(buildFiles) || stableJson(buildFiles) !== stableJson(expectedBuildFiles)) {
    addFailure('package.json', 'build-file-allowlist');
  }
  if (packageJson.build?.afterPack !== 'scripts/afterPack.cjs') addFailure('scripts/afterPack.cjs', 'build-hook-entry');

  if (packageLock) {
    const lockRoot = packageLock.packages?.[''];
    if (packageLock.version !== expectedVersion || lockRoot?.version !== expectedVersion) {
      addFailure('package-lock.json', 'package-lock-version');
    }
    if (!lockRoot
      || lockRoot.name !== packageJson.name
      || stableJson(lockRoot.dependencies) !== stableJson(packageJson.dependencies)
      || stableJson(lockRoot.devDependencies) !== stableJson(packageJson.devDependencies)) {
      addFailure('package-lock.json', 'package-lock-root-metadata');
    }
  }

  for (const entry of expectedBuildFiles) {
    if (entry.endsWith('/**/*')) {
      const prefix = entry.slice(0, -4);
      if (!files.some((file) => file.startsWith(prefix))) addFailure(entry.slice(0, -5), 'build-entry-target');
    } else if (!files.includes(entry)) {
      addFailure(entry, 'build-entry-target');
    }
  }
}

function validateServicePackage(packageJson, packageLock) {
  if (!packageJson || !packageLock) return;
  const lockRoot = packageLock.packages?.[''];
  if (packageLock.version !== packageJson.version || lockRoot?.version !== packageJson.version) {
    addFailure('services/backup-api/package-lock.json', 'service-lock-version');
  }
  if (!lockRoot || lockRoot.name !== packageJson.name || stableJson(lockRoot.dependencies) !== stableJson(packageJson.dependencies)) {
    addFailure('services/backup-api/package-lock.json', 'service-lock-root-metadata');
  }
}

async function validateScreenshots(sourceOnly) {
  if (sourceOnly) return;
  for (const screenshotFile of screenshotFiles) {
    try {
      const data = await readFile(path.join(root, screenshotFile));
      const signature = data.subarray(0, 8).toString('hex');
      const width = data.length >= 24 ? data.readUInt32BE(16) : 0;
      const height = data.length >= 24 ? data.readUInt32BE(20) : 0;
      if (signature !== '89504e470d0a1a0a' || width < 1000 || height < 650) {
        addFailure(screenshotFile, 'product-screenshot');
      }
    } catch {
      addFailure(screenshotFile, 'required-screenshot');
    }
  }
}

function printFailures() {
  for (const file of [...failures.keys()].sort()) {
    for (const rule of [...failures.get(file)].sort()) {
      process.stderr.write(`${file}\t${rule}\n`);
    }
  }
}

async function main() {
  const { sourceOnly, expectedVersion } = parseArguments();
  const files = await enumerate();
  const requiredFiles = sourceOnly ? sourceFiles : [...sourceFiles, ...screenshotFiles];
  for (const requiredFile of requiredFiles) {
    if (!files.includes(requiredFile)) addFailure(requiredFile, 'required-source-file');
  }

  await validateTextFiles(files);
  const packageJson = await readJson('package.json', 'package-json');
  const packageLock = await readJson('package-lock.json', 'package-lock-json');
  const servicePackage = await readJson('services/backup-api/package.json', 'service-package-json');
  const serviceLock = await readJson('services/backup-api/package-lock.json', 'service-package-lock-json');
  validatePackage(packageJson, packageLock, files, expectedVersion);
  validateServicePackage(servicePackage, serviceLock);
  await validateScreenshots(sourceOnly);

  if (failures.size > 0) {
    printFailures();
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`public-release-source-ok files=${files.length} denied-paths=0 internal-terms=0 version=${packageJson.version} scripts=${Object.keys(packageJson.scripts).length} build-files=${packageJson.build.files.length} layout=exact screenshot=${sourceOnly ? 'deferred' : 'valid'}\n`);
}

main().catch(() => {
  process.stderr.write('scripts/verify-public-release.mjs\tverifier-runtime\n');
  process.exitCode = 1;
});
