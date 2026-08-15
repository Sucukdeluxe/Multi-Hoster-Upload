const PRODUCT_NAME = 'Multi Hoster Uploader';
const ARTIFACT_NAME = 'Multi-Hoster-Upload';
const NON_ENGLISH_RELEASE_PATTERN = /\b(?:das|dies(?:e|er|es)|fehler|für|hinzugefügt|jetzt|korrigiert|laufen|mit|nach|probleme|programm|sicherheit|stabil|und|verbessert|verbesserungen|werden|wieder|wurde|wurden|zuverlässig\w*|amélior\w*|après|avec|corrig\w*|et|les|mises|pour|reprennent|réseau|sécurité|téléversements)\b/iu;
const ENGLISH_RELEASE_PATTERN = /\b(?:added|after|and|are|bridge|cancel|changes|credential|files?|faster|fixed|hardened|improved|installation|more|new|notes?|now|recovery|release|reliable|resume|security|safer|smoother|source|the|updates?|uploads?|with|without)\b/i;

function requireEnglishReleaseNotes(value) {
  const notes = typeof value === 'string' ? value.trim() : '';
  const words = notes.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) || [];
  if (words.length < 2 || /(?![A-Za-z])\p{L}/u.test(notes) || NON_ENGLISH_RELEASE_PATTERN.test(notes) || !ENGLISH_RELEASE_PATTERN.test(notes)) {
    throw new Error('English release notes are required');
  }
  return notes;
}

export function parseReleaseArgs(args) {
  const version = Array.isArray(args) ? args[0] : '';
  if (!/^\d+\.\d+\.\d+$/.test(version || '')) {
    throw new Error('Usage: <version> --transport-tag <vX.Y.Z> --notes <English release notes> [--dry-run]');
  }

  let transportTag = '';
  let dryRun = false;
  let notes = '';
  const legacyNoteParts = [];
  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--transport-tag') {
      if (transportTag) {
        throw new Error('Duplicate option: --transport-tag');
      }
      transportTag = args[++index] || '';
      if (!/^v\d+\.\d+\.\d+$/.test(transportTag)) {
        throw new Error('--transport-tag must match vX.Y.Z');
      }
      continue;
    }
    if (arg === '--notes') {
      if (notes) {
        throw new Error('Duplicate option: --notes');
      }
      const value = args[++index];
      if (typeof value !== 'string' || !value.trim() || value.startsWith('-')) {
        throw new Error('--notes requires English release notes');
      }
      notes = value;
      continue;
    }
    if (arg === '--dry-run') {
      if (dryRun) {
        throw new Error('Duplicate option: --dry-run');
      }
      dryRun = true;
      continue;
    }
    if (typeof arg !== 'string' || arg.startsWith('-')) {
      throw new Error(`Unknown option: ${String(arg)}`);
    }
    if (notes) {
      throw new Error(`Unexpected release note argument: ${arg}`);
    }
    legacyNoteParts.push(arg);
  }

  if (!/^v\d+\.\d+\.\d+$/.test(transportTag)) {
    throw new Error('--transport-tag must match vX.Y.Z');
  }

  const releaseNotes = requireEnglishReleaseNotes(notes || legacyNoteParts.join(' '));
  return { version, transportTag, notes: releaseNotes, dryRun };
}

export function createReleasePlan(options) {
  const releaseBody = requireEnglishReleaseNotes(options.notes);
  const releaseTitle = `${PRODUCT_NAME} v${options.version}`;
  const setupName = `${ARTIFACT_NAME} Setup ${options.version}.exe`;
  const portableName = `${ARTIFACT_NAME} ${options.version}.exe`;
  const blockmapName = `${setupName}.blockmap`;
  const githubSetupName = setupName.replaceAll(' ', '.');
  const githubPortableName = portableName.replaceAll(' ', '.');
  const githubBlockmapName = blockmapName.replaceAll(' ', '.');
  return {
    ...options,
    tag: options.transportTag,
    releaseTitle,
    releaseBody,
    setupName,
    portableName,
    blockmapName,
    githubSetupName,
    githubPortableName,
    githubBlockmapName,
    expectedArtifacts: [setupName, portableName, blockmapName, 'latest.yml'],
    githubExpectedArtifacts: [githubSetupName, githubPortableName, githubBlockmapName, 'latest.yml']
  };
}

export function resolveExistingReleaseId(plan, release) {
  const existingTitle = typeof release?.name === 'string' ? release.name : '';
  const existingTag = typeof release?.tag_name === 'string' ? release.tag_name : '';
  if (existingTag !== plan.tag) {
    throw new Error(`Refusing recovery for ${plan.tag}: existing release tag "${existingTag}" does not match "${plan.tag}"`);
  }
  if (existingTitle !== plan.releaseTitle) {
    throw new Error(`Refusing recovery for ${plan.tag}: existing release title "${existingTitle}" does not match "${plan.releaseTitle}"`);
  }
  return release.id;
}

export function renderLatestYml(plan, sha, size, releaseDate = new Date().toISOString(), setupName = plan.setupName) {
  return `version: ${plan.version}\nfiles:\n  - url: ${setupName}\n    sha512: ${sha}\n    size: ${size}\npath: ${setupName}\nsha512: ${sha}\nreleaseDate: '${releaseDate}'\n`;
}
