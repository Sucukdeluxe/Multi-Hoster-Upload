const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeLanguage, translateText } = require('../renderer/i18n');

test('English is the fallback language and German remains selectable', () => {
  assert.equal(normalizeLanguage(), 'en');
  assert.equal(normalizeLanguage('fr'), 'en');
  assert.equal(normalizeLanguage('en'), 'en');
  assert.equal(normalizeLanguage('de'), 'de');
});

test('translations cover static labels and interpolated status text in both languages', () => {
  assert.equal(translateText('Einstellungen', 'en'), 'Settings');
  assert.equal(translateText('Update v2.1.0 verfügbar', 'en'), 'Update v2.1.0 available');
  assert.equal(translateText('Settings', 'de'), 'Einstellungen');
  assert.equal(translateText('Update v2.1.0 available', 'de'), 'Update v2.1.0 verfügbar');
});

test('sidebar hierarchy uses distinct English and German kicker labels', () => {
  assert.equal(translateText('Arbeitsbereich', 'en'), 'Workspace');
  assert.equal(translateText('Accounts verwalten', 'en'), 'Manage accounts');
  assert.equal(translateText('Archiv', 'en'), 'Archive');
  assert.equal(translateText('Workspace', 'de'), 'Arbeitsbereich');
  assert.equal(translateText('Manage accounts', 'de'), 'Accounts verwalten');
  assert.equal(translateText('Archive', 'de'), 'Archiv');
});
