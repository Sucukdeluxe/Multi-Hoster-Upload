const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeFilenameFilter,
  evaluateFilenameFilter,
  applyFilenameFilter
} = require('../lib/filename-filter');

describe('filename filter', () => {
  it('accepts every file when the filter is disabled or has no usable conditions', () => {
    const disabled = applyFilenameFilter(['Episode.1080p.mkv'], {
      enabled: false,
      action: 'exclude',
      conditions: [{ operator: 'contains', value: '1080p' }]
    });
    const empty = applyFilenameFilter(['Episode.1080p.mkv'], {
      enabled: true,
      action: 'include',
      conditions: [{ operator: 'contains', value: '   ' }]
    });

    assert.deepEqual(disabled.accepted, ['Episode.1080p.mkv']);
    assert.deepEqual(disabled.excluded, []);
    assert.equal(disabled.active, false);
    assert.deepEqual(empty.accepted, ['Episode.1080p.mkv']);
    assert.equal(empty.active, false);
  });

  it('includes only filenames that satisfy every condition without case sensitivity', () => {
    const filter = {
      enabled: true,
      action: 'include',
      matchMode: 'all',
      conditions: [
        { operator: 'contains', value: '720P' },
        { operator: 'notContains', value: 'sample' }
      ]
    };

    const result = applyFilenameFilter([
      { path: 'C:/Shows/Episode.720p.mkv', name: 'Episode.720p.mkv' },
      { path: 'C:/Shows/Episode.720p.Sample.mkv', name: 'Episode.720p.Sample.mkv' },
      { path: 'C:/Shows/Episode.1080p.mkv', name: 'Episode.1080p.mkv' }
    ], filter);

    assert.deepEqual(result.accepted.map(file => file.name), ['Episode.720p.mkv']);
    assert.deepEqual(result.excluded.map(file => file.name), ['Episode.720p.Sample.mkv', 'Episode.1080p.mkv']);
    assert.equal(result.total, 3);
    assert.equal(result.active, true);
  });

  it('supports matching any condition and excluding matching filenames', () => {
    const filter = {
      enabled: true,
      action: 'exclude',
      matchMode: 'any',
      conditions: [
        { operator: 'contains', value: '1080p' },
        { operator: 'contains', value: 'sample' }
      ]
    };

    assert.equal(evaluateFilenameFilter('Episode.720p.mkv', filter).accepted, true);
    assert.equal(evaluateFilenameFilter('Episode.1080p.mkv', filter).accepted, false);
    assert.equal(evaluateFilenameFilter('Episode.720p.Sample.mkv', filter).accepted, false);
  });

  it('normalizes unsupported values and derives names from paths', () => {
    const normalized = normalizeFilenameFilter({
      enabled: true,
      action: 'unknown',
      matchMode: 'unknown',
      conditions: [
        { operator: 'unknown', value: ' 720p ' },
        null,
        { operator: 'contains', value: '' }
      ]
    });
    const result = applyFilenameFilter(['C:\\Shows\\Episode.720p.mkv', '/shows/Episode.1080p.mkv'], normalized);

    assert.deepEqual(normalized, {
      enabled: true,
      action: 'include',
      matchMode: 'all',
      conditions: [{ operator: 'contains', value: '720p' }]
    });
    assert.deepEqual(result.accepted, ['C:\\Shows\\Episode.720p.mkv']);
    assert.deepEqual(result.excluded, ['/shows/Episode.1080p.mkv']);
  });
});
