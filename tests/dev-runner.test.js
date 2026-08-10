const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('dev runner cannot let an old child exit clear the current Electron process', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'dev-runner.cjs'), 'utf8');

  assert.match(source, /const startedChild = spawn\(electron/u);
  assert.match(source, /if \(child !== startedChild\) return;\s*child = null;/u);
});
