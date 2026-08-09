const test = require('node:test');
const assert = require('node:assert/strict');
const packageJson = require('../package.json');

test('packages every Electron preload referenced by the main process', () => {
  assert.ok(packageJson.build.files.includes('preload.js'));
  assert.ok(packageJson.build.files.includes('preload-drop-target.js'));
});
