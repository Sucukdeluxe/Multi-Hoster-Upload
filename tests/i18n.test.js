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

test('runtime queue, account, toast, and shutdown copy translates completely', () => {
  const cases = [
    ['Wartet', 'Waiting'],
    ['Abgebrochen', 'Canceled'],
    ['Fehlgeschlagen: Verbindung verloren', 'Failed: Connection lost'],
    ['Retry 2/3 · Primär nicht verfügbar', 'Retry 2/3 · Primary unavailable'],
    ['Link kopiert', 'Link copied'],
    ['Kopiert!', 'Copied!'],
    ['Sende…', 'Sending…'],
    ['Lade…', 'Loading…'],
    ['Upload-Statistiken', 'Upload statistics'],
    ['Ruhezustand in 30s...', 'Sleep in 30s...'],
    ['Herunterfahren in 30s...', 'Shut down in 30s...']
  ];

  for (const [german, english] of cases) {
    assert.equal(translateText(german, 'en'), english);
    assert.equal(translateText(english, 'de'), german);
  }
});

test('English copy uses complete actions and correct singular plurals', () => {
  assert.equal(translateText('Fehlgeschlagene erneut', 'en'), 'Retry failed uploads');
  assert.equal(translateText('Suche Aktualisierungen', 'en'), 'Check for updates');
  assert.equal(translateText('1 Job zum erneuten Upload zurückgesetzt', 'en'), '1 job reset for upload');
  assert.equal(translateText('2 Jobs zum erneuten Upload zurückgesetzt', 'en'), '2 jobs reset for upload');
  assert.equal(translateText('1 Verlaufseintrag wird dauerhaft entfernt.', 'en'), '1 history entry will be permanently removed.');
  assert.equal(translateText('2 Verlaufseinträge werden dauerhaft entfernt.', 'en'), '2 history entries will be permanently removed.');
  assert.equal(translateText('Wiederholungen', 'en'), 'Retries');
  assert.equal(translateText('Maximale Geschwindigkeit (MB/s)', 'en'), 'Maximum speed (MB/s)');
  assert.equal(translateText('Neustart unter (kB/s)', 'en'), 'Restart below (kB/s)');
  assert.equal(translateText('Maximale Größe (MB)', 'en'), 'Maximum size (MB)');
  assert.equal(translateText('Aktiv auf Port 9100 — 1 Client verbunden', 'en'), 'Active on port 9100 — 1 client connected');
  assert.equal(translateText('Aktiv auf Port 9100 — 2 Clients verbunden', 'en'), 'Active on port 9100 — 2 clients connected');
});
