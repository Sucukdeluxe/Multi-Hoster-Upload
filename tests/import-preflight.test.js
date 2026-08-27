const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('inspects duplicates, unavailable files, accepted files, and configured size-limit pairs', async () => {
  const { inspectImportEntries, summarizeImportPlan } = require('../lib/import-preflight');
  const inspection = await inspectImportEntries([
    { path: 'C:\\queue\\duplicate.mkv', name: 'duplicate.mkv' },
    { path: 'C:\\queue\\accepted.mkv', name: 'accepted.mkv' },
    { path: 'C:\\queue\\empty.mkv', name: 'empty.mkv' },
    { path: 'C:\\queue\\missing.mkv', name: 'missing.mkv' }
  ], {
    existingPaths: ['C:\\queue\\duplicate.mkv'],
    inspectPath: async filePath => {
      if (filePath.endsWith('accepted.mkv')) return { exists: true, readable: true, size: 2 * 1024 * 1024, mtimeMs: 1787828400123 };
      if (filePath.endsWith('empty.mkv')) return { exists: true, readable: true, size: 0 };
      return { exists: false };
    }
  });
  const plan = summarizeImportPlan({
    inspection,
    selectedHosters: ['doodstream.com', 'voe.sx'],
    hosterSettings: {
      'doodstream.com': { maxSizeMb: 1 },
      'voe.sx': { maxSizeMb: 0 }
    }
  });

  assert.deepEqual({
    candidates: inspection.candidateCount,
    duplicates: inspection.duplicateCount,
    unavailable: inspection.unavailableCount,
    accepted: inspection.acceptedCount
  }, { candidates: 4, duplicates: 1, unavailable: 2, accepted: 1 });
  assert.deepEqual(plan, {
    candidateCount: 4,
    duplicateCount: 1,
    unavailableCount: 2,
    acceptedCount: 1,
    targetCount: 2,
    jobCount: 1,
    sizeLimitedJobCount: 1
  });
  assert.equal(inspection.accepted[0].mtimeMs, 1787828400123);
});

test('connects the import preflight through the main process, preload, renderer, and hoster dialog', () => {
  const root = path.join(__dirname, '..');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'renderer', 'styles.css'), 'utf8');

  assert.match(main, /ipcMain\.handle\('inspect-import-files'/);
  assert.match(preload, /inspectImportFiles/);
  assert.match(renderer, /coordinateImportEntries/);
  assert.match(renderer, /isImportPairEligible/);
  assert.match(renderer, /toLocaleString\(getUiLocale\(\)\)/);
  assert.match(html, /id="importPlanSummary"/);
  assert.match(css, /hoster-modal-list \+ \.import-plan-summary \+ \.modal-hint/);
});
