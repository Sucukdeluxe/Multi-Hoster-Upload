const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const test = require('node:test');

for (const consumer of ['@electron/universal', 'app-builder-lib']) {
  test(consumer + ' resolves compatible file matching', () => {
    const fromConsumer = createRequire(require.resolve(consumer));
    const { minimatch, Minimatch } = fromConsumer('minimatch');
    assert.equal(minimatch('Resources/bin/helper.node', '*.node', { matchBase: true }), true);
    assert.equal(minimatch('Resources/bin/helper.js', '*.node', { matchBase: true }), false);
    assert.equal(new Minimatch('**/*.{js,json}').match('lib/index.js'), true);
    assert.equal(new Minimatch('**/*.{js,json}').match('lib/private.pem'), false);
    assert.equal(minimatch('Contents/Info.plist', 'Info.plist', { matchBase: true }), true);
  });
}
