const PRODUCT_NAME = 'Multi-Hoster-Upload';

export function parseReleaseArgs(args) {
  const version = Array.isArray(args) ? args[0] : '';
  if (!/^\d+\.\d+\.\d+$/.test(version || '')) {
    throw new Error('Usage: <version> --transport-tag <vX.Y.Z> [release notes] [--dry-run]');
  }

  const transportTagIndex = args.indexOf('--transport-tag');
  const transportTag = transportTagIndex >= 0 ? args[transportTagIndex + 1] : '';
  if (!/^v\d+\.\d+\.\d+$/.test(transportTag)) {
    throw new Error('--transport-tag must match vX.Y.Z');
  }

  const excludedIndexes = new Set([0, transportTagIndex, transportTagIndex + 1]);
  const notes = args.filter((arg, index) => !excludedIndexes.has(index) && arg !== '--dry-run').join(' ');
  return { version, transportTag, notes, dryRun: args.includes('--dry-run') };
}

export function createReleasePlan(options) {
  const releaseTitle = `${PRODUCT_NAME} v${options.version}`;
  const setupName = `${PRODUCT_NAME} Setup ${options.version}.exe`;
  const portableName = `${PRODUCT_NAME} ${options.version}.exe`;
  const blockmapName = `${setupName}.blockmap`;
  return {
    ...options,
    tag: options.transportTag,
    releaseTitle,
    releaseBody: options.notes || releaseTitle,
    setupName,
    portableName,
    blockmapName,
    expectedArtifacts: [setupName, portableName, blockmapName, 'latest.yml']
  };
}

export function resolveExistingReleaseId(plan, release) {
  const existingTitle = typeof release?.name === 'string' ? release.name : '';
  if (existingTitle !== plan.releaseTitle) {
    throw new Error(`Refusing recovery for ${plan.tag}: existing release title "${existingTitle}" does not match "${plan.releaseTitle}"`);
  }
  return release.id;
}

export function renderLatestYml(plan, sha, size, releaseDate = new Date().toISOString()) {
  const releaseAssetName = plan.setupName.replace(/ /g, '.');
  return `version: ${plan.version}\nfiles:\n  - url: ${releaseAssetName}\n    sha512: ${sha}\n    size: ${size}\npath: ${releaseAssetName}\nsha512: ${sha}\nreleaseDate: '${releaseDate}'\n`;
}
