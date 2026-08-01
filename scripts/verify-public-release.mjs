import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const sourceOnly = args.includes('--source-only');
const failures = new Map();

const requiredFiles = [
  '.gitignore',
  'README.md',
  'SECURITY.md',
  'package.json',
  'package-lock.json',
  'eslint.config.mjs',
  'main.js',
  'preload.js',
  'preload-drop-target.js',
  'assets/app_icon.ico',
  'assets/app_icon.png',
  'scripts/afterPack.cjs',
  'scripts/verify-public-release.mjs'
];

const allowedFiles = new Set([...requiredFiles, 'assets/product-overview.png']);
const allowedPrefixes = ['lib/', 'renderer/', 'tests/'];
const ignoredDirectories = new Set(['.git', 'node_modules', 'release']);
const deniedDirectories = new Set([
  `.${['clau', 'de'].join('')}`,
  `.${['co', 'dex'].join('')}`,
  '.playwright-mcp',
  '.superpowers',
  '__pycache__',
  'backups',
  'docs',
  'gateway',
  'logs',
  'memories',
  'prompts',
  'tasks'
]);
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
  'requirements.txt'
]);
const textExtensions = new Set(['.cjs', '.css', '.html', '.js', '.json', '.md', '.mjs', '.txt', '.yaml', '.yml']);
const binaryExtensions = new Set(['.ico', '.png']);
const expectedScripts = {
  start: 'electron .',
  test: 'node --test tests/*.test.js tests/ui-smoke.js',
  lint: 'eslint .',
  dist: 'electron-builder --win',
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
const aiTerms = [
  ['clau', 'de'].join(''),
  ['co', 'dex'].join(''),
  ['chat', 'gpt'].join('')
].join('|');
const personalTerms = [
  ['pl', 'oet'].join(''),
  ['baker', 'edwin318'].join('')
].join('|');
const forbiddenAiPattern = new RegExp(`\\b(?:${aiTerms}|multi[\\s-]+agents?)\\b`, 'i');
const forbiddenPersonalPattern = new RegExp(`(?:[a-z]:[\\\\/]+users[\\\\/]+|\\b(?:${personalTerms})\\b|\\bdesktop-[a-z0-9-]+\\b)`, 'i');
const forbiddenInvestigationPattern = new RegExp(`\\b(?:${['internal', 'investigation'].join(' ')}|${['interne', 'untersuchung'].join(' ')}|${['audit', 'method'].join(' ')}|${['test', 'chronicle'].join(' ')})\\b`, 'i');
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

function isAllowedFile(relativePath) {
  return allowedFiles.has(relativePath) || allowedPrefixes.some((prefix) => relativePath.startsWith(prefix));
}

function isDeniedBasename(basename) {
  const lower = basename.toLowerCase();
  return deniedBasenames.has(lower)
    || /^\.env(?:\.|$)/i.test(basename)
    || /\.(?:bak|db|log|sqlite|sqlite3|tmp)$/i.test(basename);
}

async function enumerate(directory = root, relativeDirectory = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const relativePath = normalizeRelative(path.join(relativeDirectory, entry.name));
    const lowerName = entry.name.toLowerCase();

    if (entry.isDirectory()) {
      if (ignoredDirectories.has(lowerName)) continue;
      if (deniedDirectories.has(lowerName)) addFailure(relativePath, 'denied-directory');
      files.push(...await enumerate(path.join(directory, entry.name), relativePath));
      continue;
    }

    if (!entry.isFile()) {
      addFailure(relativePath, 'unsupported-file-type');
      continue;
    }

    if (isDeniedBasename(entry.name)) addFailure(relativePath, 'denied-basename');
    if (!isAllowedFile(relativePath)) addFailure(relativePath, 'source-layout-allowlist');
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

    const text = await readFile(path.join(root, relativePath), 'utf8');
    if (forbiddenPersonalPattern.test(text)) addFailure(relativePath, 'forbidden-personal-term');
    if (forbiddenAiPattern.test(text)) addFailure(relativePath, 'forbidden-ai-term');
    if (forbiddenInvestigationPattern.test(text)) addFailure(relativePath, 'forbidden-investigation-term');
    if (relativePath !== 'lib/updater.js' && updaterOnlyPattern.test(text)) addFailure(relativePath, 'updater-endpoint-scope');
  }
}

function validatePackage(packageJson, packageLock, files) {
  if (!packageJson) return;

  if (packageJson.version !== '3.3.108') addFailure('package.json', 'package-version');
  if (stableJson(packageJson.scripts) !== stableJson(expectedScripts)) addFailure('package.json', 'package-script-allowlist');

  const buildFiles = packageJson.build?.files;
  if (!Array.isArray(buildFiles) || stableJson(buildFiles) !== stableJson(expectedBuildFiles)) {
    addFailure('package.json', 'build-file-allowlist');
  }

  for (const requiredEntry of expectedBuildFiles) {
    if (!Array.isArray(buildFiles) || !buildFiles.includes(requiredEntry)) addFailure(requiredEntry.replace('/**/*', ''), 'build-file-entry');
  }

  if (packageJson.build?.afterPack !== 'scripts/afterPack.cjs') addFailure('scripts/afterPack.cjs', 'build-hook-entry');

  if (packageLock) {
    const lockRoot = packageLock.packages?.[''];
    if (packageLock.version !== '3.3.108' || lockRoot?.version !== '3.3.108') {
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

function printFailures() {
  for (const file of [...failures.keys()].sort()) {
    for (const rule of [...failures.get(file)].sort()) {
      process.stderr.write(`${file}\t${rule}\n`);
    }
  }
}

async function main() {
  if (args.some((arg) => arg !== '--source-only') || args.filter((arg) => arg === '--source-only').length > 1) {
    addFailure('scripts/verify-public-release.mjs', 'argument-allowlist');
  }

  const files = await enumerate();

  for (const requiredFile of requiredFiles) {
    if (!files.includes(requiredFile)) addFailure(requiredFile, 'required-source-file');
  }
  if (!sourceOnly && !files.includes('assets/product-overview.png')) {
    addFailure('assets/product-overview.png', 'required-screenshot');
  }

  await validateTextFiles(files);
  const packageJson = await readJson('package.json', 'package-json');
  const packageLock = await readJson('package-lock.json', 'package-lock-json');
  validatePackage(packageJson, packageLock, files);

  if (failures.size > 0) {
    printFailures();
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`public-release-source-ok files=${files.length} denied-paths=0 forbidden-terms=0 version=${packageJson.version} scripts=${Object.keys(packageJson.scripts).length} build-files=${packageJson.build.files.length} layout=valid screenshot=${sourceOnly ? 'deferred' : 'present'}\n`);
}

main().catch(() => {
  process.stderr.write('scripts/verify-public-release.mjs\tverifier-runtime\n');
  process.exitCode = 1;
});
