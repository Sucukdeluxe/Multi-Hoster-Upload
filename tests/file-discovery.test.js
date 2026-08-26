const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { walkFolderAsync } = require('../lib/file-discovery');

function directory(name) {
  return { name, isDirectory: () => true, isFile: () => false };
}

function file(name) {
  return { name, isDirectory: () => false, isFile: () => true };
}

test('folder discovery preserves UNC and Unicode paths', async () => {
  const root = '\\\\server\\share\\Übertragungen';
  const child = path.win32.join(root, 'Staffel 1');
  const target = path.win32.join(child, 'Folge äöü.mkv');
  const fsPromises = {
    readdir: async dir => dir === root ? [directory('Staffel 1')] : [file('Folge äöü.mkv')],
    stat: async value => ({ size: value === target ? 1234 : 0 })
  };
  const result = await walkFolderAsync(root, { fsPromises, pathImpl: path.win32 });
  assert.deepEqual(result, [{ path: target, name: 'Folge äöü.mkv', size: 1234 }]);
});

test('folder discovery does not truncate long absolute paths', async () => {
  const root = `C:\\${'sehr-langer-ordner\\'.repeat(18)}ziel`;
  const target = path.win32.join(root, 'video.mp4');
  const result = await walkFolderAsync(root, {
    fsPromises: {
      readdir: async () => [file('video.mp4')],
      stat: async () => ({ size: 77 })
    },
    pathImpl: path.win32
  });
  assert.equal(result[0].path, target);
  assert.ok(result[0].path.length > 260);
});

test('nonrecursive folder discovery never reads child directories', async () => {
  const root = 'C:\\watch';
  const child = path.win32.join(root, 'nested');
  const reads = [];
  const result = await walkFolderAsync(root, {
    recursive: false,
    fsPromises: {
      readdir: async (dir) => {
        reads.push(dir);
        if (dir === root) return [file('root.mkv'), directory('nested')];
        if (dir === child) return [file('nested.mkv')];
        return [];
      },
      stat: async () => ({ size: 1 })
    },
    pathImpl: path.win32
  });
  assert.deepEqual(reads, [root]);
  assert.deepEqual(result.map((entry) => entry.name), ['root.mkv']);
});
