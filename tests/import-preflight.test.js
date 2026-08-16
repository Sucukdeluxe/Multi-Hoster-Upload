const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  getEligibleImportHosters,
  inspectImportEntries,
  inspectReadableImportPath,
  summarizeImportPlan
} = require('../lib/import-preflight');

describe('import preflight', () => {
  it('accounts for candidates, existing and repeated paths, filename filters, unreadable entries and accepted files', async () => {
    const sizes = new Map([
      ['C:\\incoming\\duplicate-new.bin', 2 * 1024 * 1024],
      ['C:\\incoming\\missing.bin', null],
      ['C:\\incoming\\unreadable.bin', 'unreadable'],
      ['C:\\incoming\\empty.bin', 0],
      ['C:\\incoming\\accepted.xyz', 5 * 1024 * 1024]
    ]);
    const inspection = await inspectImportEntries([
      'C:/queue/existing.bin',
      'C:/incoming/duplicate-new.bin',
      'C:\\incoming\\duplicate-new.bin',
      'C:/incoming/skip.sample.bin',
      'C:/incoming/missing.bin',
      'C:/incoming/unreadable.bin',
      'C:/incoming/empty.bin',
      'C:/incoming/accepted.xyz'
    ], {
      existingPaths: ['C:\\QUEUE\\existing.bin'],
      filenameFilter: {
        enabled: true,
        action: 'exclude',
        conditions: [{ operator: 'contains', value: '.sample.' }]
      },
      inspectPath: async filePath => {
        const value = sizes.get(filePath);
        if (value === null) return { exists: false };
        if (value === 'unreadable') return { exists: true, readable: false, size: 10 };
        return { exists: true, readable: true, size: value };
      }
    });

    assert.equal(inspection.candidateCount, 8);
    assert.equal(inspection.duplicateCount, 2);
    assert.equal(inspection.filteredCount, 1);
    assert.equal(inspection.unavailableCount, 3);
    assert.equal(inspection.acceptedCount, 2);
    assert.deepEqual(inspection.unavailable.map(entry => entry.reason).sort(), ['empty', 'missing', 'unreadable']);
    assert.deepEqual(inspection.accepted.map(entry => entry.name).sort(), ['accepted.xyz', 'duplicate-new.bin']);
    assert.equal(inspection.accepted.find(entry => entry.name === 'accepted.xyz').size, 5 * 1024 * 1024);
  });

  it('counts jobs and only removes jobs blocked by configured host maximum sizes', () => {
    const summary = summarizeImportPlan({
      inspection: {
        candidateCount: 8,
        duplicateCount: 2,
        filteredCount: 1,
        unavailableCount: 3,
        accepted: [
          { path: 'C:\\incoming\\small.bin', name: 'small.bin', size: 2 * 1024 * 1024 },
          { path: 'C:\\incoming\\large.custom', name: 'large.custom', size: 5 * 1024 * 1024 }
        ]
      },
      selectedHosters: ['unlimited.example', 'limited.example', 'unlimited.example'],
      hosterSettings: {
        'unlimited.example': { maxSizeMb: 0 },
        'limited.example': { maxSizeMb: 3 },
        'unknown.example': { maxSizeMb: 1 }
      }
    });

    assert.deepEqual(summary, {
      candidateCount: 8,
      duplicateCount: 2,
      filteredCount: 1,
      unavailableCount: 3,
      acceptedCount: 2,
      targetCount: 2,
      jobCount: 3,
      sizeLimitedJobCount: 1
    });
  });

  it('uses the same configured size eligibility for summaries and queue admission', () => {
    const file = { path: 'C:\\incoming\\large.custom', name: 'large.custom', size: 5 * 1024 * 1024 };
    const selectedHosters = ['limited.example', 'unlimited.example', 'limited.example'];
    const hosterSettings = {
      'limited.example': { maxSizeMb: 3 },
      'unlimited.example': { maxSizeMb: 0 }
    };

    assert.deepEqual(getEligibleImportHosters(file, selectedHosters, hosterSettings), ['unlimited.example']);
    assert.deepEqual(summarizeImportPlan({
      inspection: { candidateCount: 1, accepted: [file] },
      selectedHosters,
      hosterSettings
    }), {
      candidateCount: 1,
      duplicateCount: 0,
      filteredCount: 0,
      unavailableCount: 0,
      acceptedCount: 1,
      targetCount: 2,
      jobCount: 1,
      sizeLimitedJobCount: 1
    });
  });

  it('deduplicates Windows drive and UNC namespace aliases canonically', async () => {
    const inspectedPaths = [];
    const inspection = await inspectImportEntries([
      '\\\\?\\C:\\incoming\\same.bin',
      'C:\\incoming\\same.bin',
      '\\\\?\\UNC\\server\\share\\same.bin',
      '\\\\server\\share\\same.bin'
    ], {
      caseInsensitive: true,
      inspectPath: async filePath => {
        inspectedPaths.push(filePath);
        return { exists: true, readable: true, size: 1 };
      }
    });

    assert.equal(inspection.acceptedCount, 2);
    assert.equal(inspection.duplicateCount, 2);
    assert.deepEqual(inspectedPaths, ['C:\\incoming\\same.bin', '\\\\server\\share\\same.bin']);
  });

  it('inspects type and size through one opened read handle and closes it', async () => {
    const calls = [];
    const fileHandle = {
      stat: async () => {
        calls.push('stat');
        return { isFile: () => true, size: 42 };
      },
      close: async () => {
        calls.push('close');
      }
    };

    const result = await inspectReadableImportPath('C:\\incoming\\readable.bin', async (filePath, flags) => {
      calls.push(['open', filePath, flags]);
      return fileHandle;
    });

    assert.deepEqual(result, { exists: true, readable: true, size: 42 });
    assert.deepEqual(calls, [['open', 'C:\\incoming\\readable.bin', 'r'], 'stat', 'close']);
  });

  it('limits concurrent file inspections', async () => {
    let active = 0;
    let maximumActive = 0;
    const inspection = await inspectImportEntries(
      Array.from({ length: 12 }, (_, index) => `C:/incoming/file-${index}.bin`),
      {
        concurrency: 3,
        inspectPath: async () => {
          active++;
          maximumActive = Math.max(maximumActive, active);
          await new Promise(resolve => setTimeout(resolve, 5));
          active--;
          return { exists: true, readable: true, size: 1 };
        }
      }
    );

    assert.equal(inspection.acceptedCount, 12);
    assert.equal(maximumActive, 3);
  });
});
