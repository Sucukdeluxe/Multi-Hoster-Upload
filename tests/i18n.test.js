const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const espree = require('espree');

const { normalizeLanguage, translateText } = require('../renderer/i18n');

test('translates permanent source deletion controls to English', () => {
  assert.equal(translateText('Quelldatei nach vollständigem Upload dauerhaft löschen', 'en'), 'Permanently delete source file after complete upload');
  assert.equal(translateText('Dauerhaftes Löschen aktivieren', 'en'), 'Enable permanent deletion');
});

test('translates the remaining upload size label', () => {
  assert.equal(translateText('Verbleibende Größe', 'en'), 'Remaining size');
  assert.equal(translateText('Remaining size', 'de'), 'Verbleibende Größe');
});

test('translates compact online backup labels in both directions', () => {
  assert.equal(translateText('Neuer Schlüssel', 'en'), 'Your new key');
  assert.equal(translateText('Your new key', 'de'), 'Neuer Schlüssel');
  assert.equal(translateText('Schlüssel importieren', 'en'), 'Import existing key');
  assert.equal(translateText('Import existing key', 'de'), 'Schlüssel importieren');
});

test('translates managed online backup controls in both directions', () => {
  const pairs = [
    ['Auf diesem Gerät erstellt', 'Created on this device'],
    ['Noch keine Schlüssel auf diesem Gerät erstellt.', 'No keys have been created on this device yet.'],
    ['Schlüssel kopieren', 'Copy key'],
    ['Online-Backup löschen', 'Delete online backup'],
    ['Dieses verschlüsselte Online-Backup wird dauerhaft vom Server gelöscht.', 'This encrypted online backup will be permanently deleted from the server.'],
    ['Schlüssel gelöscht', 'Key deleted'],
    ['Importieren', 'Import'],
    ['Neuer Schlüssel erstellt.', 'New key created.'],
    ['Erneut laden', 'Reload'],
    ['Gespeicherter Online-Schlüsselbund ist beschädigt', 'Stored online keyring is damaged'],
    ['Sichere Schlüsselspeicherung ist nicht verfügbar', 'Secure key storage is unavailable'],
    ['Gespeicherter Online-Sicherungsschlüssel konnte nicht entschlüsselt werden', 'Stored online backup key could not be decrypted'],
    ['Gespeicherte Online-Sicherungskennung stimmt nicht mit dem Schlüssel überein', 'Stored online backup ID does not match its key'],
    ['Gespeicherte Online-Sicherungskennung ist mehrdeutig', 'Stored online backup ID is ambiguous'],
    ['Online-Schlüsselbund wurde aus einer Wiederherstellungsdatei geladen', 'Online keyring was loaded from a recovery file']
  ];

  for (const [german, english] of pairs) {
    assert.equal(translateText(german, 'en'), english);
    assert.equal(translateText(english, 'de'), german);
  }
});

test('translates the account check timestamp label', () => {
  assert.equal(translateText('geprüft', 'en'), 'checked');
  assert.equal(translateText('checked', 'de'), 'geprüft');
});

test('translates settings search result labels in both directions', () => {
  assert.equal(translateText('Nach erfolgreichem Upload löschen', 'en'), 'Delete after successful upload');
  assert.equal(translateText('Delete after successful upload', 'de'), 'Nach erfolgreichem Upload löschen');
  assert.equal(translateText('Suchergebnisse', 'en'), 'Search results');
});

test('translates every automation control center label in both directions', () => {
  const pairs = [
    ['Ordnerüberwachung testen', 'Test folder monitoring'],
    ['Maximale automatische Queue-Größe', 'Maximum automatic queue size'],
    ['Abgleichintervall', 'Reconciliation interval'],
    ['Abschließen und pausieren', 'Finish and pause'],
    ['Fortsetzen', 'Resume'],
    ['Queue-Limit erreicht', 'Queue limit reached'],
    ['Ordner getrennt', 'Folder disconnected'],
    ['Pausiert', 'Paused'],
    ['Wegen Queue-Limit zurückgestellt', 'Deferred by queue limit'],
    ['Überwachung läuft seit', 'Monitoring since'],
    ['Ordner erreichbar', 'Folder reachable'],
    ['Letzte erkannte Datei', 'Last detected file'],
    ['Heute erkannt', 'Detected today'],
    ['Heute eingereiht', 'Queued today'],
    ['Heute übersprungen', 'Skipped today'],
    ['Aktuelle Queue-Auslastung', 'Current queue usage'],
    ['Letzter Abgleich', 'Last reconciliation'],
    ['Nächster Abgleich', 'Next reconciliation'],
    ['Letzter Fehler', 'Last error'],
    ['Nie', 'Never'],
    ['Ja', 'Yes'],
    ['Nein', 'No'],
    ['Keine Datei erkannt', 'No file detected'],
    ['Test der Ordnerüberwachung', 'Folder monitoring test'],
    ['Ordner wird geprüft…', 'Scanning folder…'],
    ['Der Test verändert weder Queue noch Einstellungen.', 'The test does not change the queue or settings.'],
    ['Prüft den aktuellen Ordner schreibgeschützt mit denselben Regeln.', 'Checks the current folder read-only with the same rules.'],
    ['Ordnerüberwachung konnte nicht getestet werden.', 'Folder monitoring could not be tested.'],
    ['Gefundene Dateien', 'Files found'],
    ['Passend zum Dateifilter', 'Matching file filter'],
    ['Bereits verarbeitet', 'Already processed'],
    ['Fehlend, leer oder nicht lesbar', 'Missing, empty, or unreadable'],
    ['Durch Größenlimits ausgeschlossen', 'Excluded by size limits'],
    ['Entstehende Upload-Jobs', 'Resulting upload jobs'],
    ['Verfügbare Jobs bis zum Queue-Limit', 'Available jobs before queue limit'],
    ['Aktuell zurückzustellende Dateien', 'Files currently deferred'],
    ['0 = unbegrenzt', '0 = unlimited'],
    ['Unbegrenzt', 'Unlimited'],
    ['1 Minute', '1 minute'],
    ['5 Minuten', '5 minutes'],
    ['15 Minuten', '15 minutes'],
    ['30 Minuten', '30 minutes'],
    ['60 Minuten', '60 minutes'],
    ['Automatik konnte nicht pausiert werden.', 'Automation could not be paused.'],
    ['Automatik konnte nicht fortgesetzt werden.', 'Automation could not be resumed.'],
    ['Ordnerüberwachung konnte nicht pausiert werden', 'Folder monitoring could not be paused'],
    ['Ordnerüberwachung fehlgeschlagen', 'Folder monitoring failed'],
    ['Ordner nicht erreichbar', 'Folder unavailable'],
    ['Ordnerscan fehlgeschlagen', 'Folder scan failed'],
    ['Keine Ordnerkonfiguration vorhanden', 'No folder configuration is available']
  ];

  for (const [german, english] of pairs) {
    assert.equal(translateText(german, 'en'), english, german);
    assert.equal(translateText(english, 'de'), german, english);
  }
});

test('translates account cooldown and manual pause labels', () => {
  const pairs = [
    ['Pausiert – noch', 'Paused –'],
    ['Pausiert – Aktion nötig', 'Paused – action required'],
    ['Account automatisch wieder aktiv', 'Account automatically active again'],
    ['Account wieder aktiv – nächste Batch verwendet ihn', 'Account active again – the next batch will use it']
  ];
  for (const [german, english] of pairs) {
    assert.equal(translateText(german, 'en'), english);
    assert.equal(translateText(english, 'de'), german);
  }
});

test('translates the failure detail clipboard action', () => {
  assert.equal(translateText('Fehlerdetails kopieren', 'en'), 'Copy failure details');
  assert.equal(translateText('Failure details copied', 'de'), 'Fehlerdetails kopiert');
  assert.equal(translateText('Antwortauszug', 'en'), 'Response excerpt');
});

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
  assert.equal(translateText('Alle Status', 'en'), 'Any status');
  assert.equal(translateText('Any status', 'de'), 'Alle Status');
  assert.equal(translateText('Filter', 'en'), 'Filters');
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

test('translates duplicate desktop drop feedback to English', () => {
  assert.equal(translateText('Auswahl ist bereits in den Upload-Aufträgen.', 'en'), 'The selection is already in the upload jobs.');
});

test('rare account, backup, update, and confirmation states translate in both directions', () => {
  const cases = [
    ['Einstellungen konnten vor dem Update nicht gespeichert werden', 'Settings could not be saved before the update'],
    ['Das Update wurde nicht gestartet, weil die Einstellungen vor dem Beenden nicht gespeichert werden konnten', 'The update was not started because the settings could not be saved before quitting'],
    ['Login ok, Upload-Seite bereit', 'Login successful, upload page ready'],
    ['Login oder API Key fehlt', 'Login or API key is missing'],
    ['Account-Check lieferte kein gültiges JSON', 'Account check did not return valid JSON'],
    ['Account-Check fehlgeschlagen', 'Account check failed'],
    ['Upload-Server-Check lieferte kein gültiges JSON', 'Upload server check did not return valid JSON'],
    ['API Key gültig, Upload-Server verfügbar', 'API key is valid, upload server available'],
    ['API Key gültig, aktuell kein Server von API (Uploader nutzt Fallback)', 'API key is valid, but the API currently provides no server (the uploader uses a fallback)'],
    ['API Key gültig, Upload-Server aktuell nicht geliefert', 'API key is valid, but the API currently provides no upload server'],
    ['Username oder Passwort fehlt', 'Username or password is missing'],
    ['Upload-URL wurde nicht erkannt', 'Upload URL was not recognized'],
    ['API Key gültig, aktuell kein Server verfügbar', 'API key is valid, but no server is currently available'],
    ['API Key ungültig oder Server nicht erreichbar', 'API key is invalid or the server is unreachable'],
    ['Login ok, aber Upload-Seite liefert kein CSRF-Token', 'Login successful, but the upload page did not provide a CSRF token'],
    ['API Key fehlt', 'API key is missing'],
    ['API lieferte kein gültiges JSON', 'API did not return valid JSON'],
    ['API Key gültig', 'API key is valid'],
    ['Clouddrop Auth fehlgeschlagen', 'Clouddrop authentication failed'],
    ['Account-ID fehlt im Check-Payload', 'Account ID is missing from the check payload'],
    ['Kein Health-Check für diesen Hoster', 'No health check is available for this host'],
    ['Health-Check fehlgeschlagen', 'Health check failed'],
    ['Hoster fehlt', 'Host is missing'],
    ['Validierung fehlgeschlagen', 'Validation failed'],
    ['Ein Upload wird bereits ausgeführt oder abgeschlossen', 'An upload is already running or completed'],
    ['Kein gültiger Account für diesen Hoster', 'No valid account is available for this host'],
    ['Keine gültigen Zugangsdaten für die gewählten Hoster.', 'No valid credentials are available for the selected hosts.'],
    ['Unbekannter Fehler', 'Unknown error'],
    ['Kein Log-Pfad gefunden', 'No log path was found'],
    ['Ungültige URL (muss mit http(s):// beginnen)', 'Invalid URL (must start with http(s)://)'],
    ['Backup-Datei ist zu groß oder ungültig', 'The backup file is too large or invalid'],
    ['Online-Sicherungsschlüssel ist ungültig', 'The online backup key is invalid'],
    ['Ein Update wird bereits vorbereitet', 'An update is already being prepared'],
    ['Die Anwendung ist noch nicht bereit, das Update sicher zu installieren', 'The application is not yet ready to install the update safely'],
    ['Update abgebrochen', 'Update canceled'],
    ['Filter zurücksetzen', 'Reset filters'],
    ['Download abbrechen', 'Cancel download'],
    ['Abbrechen…', 'Cancelling…'],
    ['Download abgebrochen', 'Download canceled'],
    ['Wiederholen', 'Retry'],
    ['Update konnte nicht abgebrochen werden', 'The update could not be canceled'],
    ['Ausgewählte Einträge entfernen?', 'Remove selected entries?'],
    ['Export fehlgeschlagen', 'Export failed'],
    ['Backup exportiert', 'Backup exported'],
    ['Online-Backup importiert', 'Online backup imported'],
    ['Passwort', 'Password'],
    ['Backup importiert', 'Backup imported'],
    ['Import fehlgeschlagen', 'Import failed'],
    ['Upload-Start fehlgeschlagen', 'Failed to start upload'],
    ['erneut versuchbar', 'retryable'],
    ['manuell', 'manual'],
    ['Abgebrochen.', 'Canceled.'],
    ['API-Token neu erzeugen?', 'Generate a new API token?'],
    ['Der bisherige Token wird sofort ungültig. Verbundene Clients müssen den neuen Token verwenden.', 'The current token will become invalid immediately. Connected clients must use the new token.'],
    ['Neu erzeugen', 'Generate new'],
    ['Verbindungs-Code neu erzeugen?', 'Generate a new connection code?'],
    ['Der bisherige Diagnose-Code wird sofort ungültig.', 'The current diagnostics code will become invalid immediately.'],
    ['Aktivieren', 'Enable'],
    ['Bitte den OTP-Code eingeben.', 'Enter the OTP code.'],
    ['Login fehlgeschlagen', 'Login failed'],
    ['Aufbewahrung ändern?', 'Change retention?'],
    ['Update fehlgeschlagen', 'Update failed']
  ];

  for (const [german, english] of cases) {
    assert.equal(translateText(german, 'en'), english, german);
    assert.equal(translateText(english, 'de'), german, english);
  }
});

test('interpolated rare errors translate without leaking German copy', () => {
  const cases = [
    ['Login ok, Upload-Form bereit (Dateifeld: file)', 'Login successful, upload form ready (file field: file)'],
    ['Klartext-Backup ist kein gültiges JSON: Unexpected token', 'Plain JSON backup is not valid JSON: Unexpected token'],
    ['Export fehlgeschlagen: Zugriff verweigert', 'Export failed: Zugriff verweigert'],
    ['Import fehlgeschlagen: Datei beschädigt', 'Import failed: Datei beschädigt'],
    ['Initialisierung fehlgeschlagen: Konfiguration fehlt', 'Initialization failed: Konfiguration fehlt']
  ];

  for (const [german, english] of cases) assert.equal(translateText(german, 'en'), english, german);
});

test('main-process user-facing copy contains no mojibake', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.doesNotMatch(source, /Ã|Â|â€/u);
});

test('library and updater errors exposed in the UI translate to English', () => {
  const cases = [
    ['Ungültiges Backup-Format', 'Invalid backup format'],
    ['Keine gültige .mhu Backup-Datei', 'Not a valid .mhu backup file'],
    ['Falsches Passwort oder beschädigte Datei', 'Incorrect password or damaged file'],
    ['Online-Sicherungsdienst ist nicht erreichbar', 'The online backup service is unavailable'],
    ['Online-Sicherung wurde nicht gefunden', 'Online backup was not found'],
    ['Online-Sicherung konnte nicht gelöscht werden', 'Online backup could not be deleted'],
    ['Kein Ordnerpfad angegeben', 'No folder path was provided'],
    ['Kein Update verfügbar', 'No update available'],
    ['Update-Asset unvollständig (URL oder Name fehlt)', 'The update asset is incomplete (URL or name is missing)'],
    ['Heruntergeladene Datei ist keine gültige EXE', 'The downloaded file is not a valid EXE'],
    ['SHA-512 Prüfung fehlgeschlagen', 'SHA-512 verification failed'],
    ['Datei nicht gefunden', 'File not found'],
    ['Netzwerkfehler', 'Network error']
  ];

  for (const [german, english] of cases) {
    assert.equal(translateText(german, 'en'), english, german);
    assert.equal(translateText(english, 'de'), german, english);
  }
});

test('interpolated host and updater errors translate their user-facing copy', () => {
  const cases = [
    ['Clouddrop: Datei nicht lesbar: video.mkv', 'Clouddrop: File cannot be read: video.mkv'],
    ['Doodstream: konnte Upload-Server nicht ermitteln (Endpoint geändert?). Details', 'Doodstream: Could not determine the upload server (endpoint changed?). Details'],
    ['Doodstream Upload fehlgeschlagen: rejected', 'Doodstream upload failed: rejected'],
    ['Upload zu VOE wurde vom Server abgelehnt.', 'The upload to VOE was rejected by the server.'],
    ['Vidmoly Upload abgelehnt: rejected', 'Vidmoly upload rejected: rejected'],
    ['VOE Upload-Fehler: rejected', 'VOE upload error: rejected'],
    ['Download fehlgeschlagen: HTTP 503', 'Download failed: HTTP 503']
  ];

  for (const [german, english] of cases) assert.equal(translateText(german, 'en'), english, german);
});

test('German runtime error copy in the application source has an English translation', () => {
  const files = [
    path.join(__dirname, '..', 'main.js'),
    path.join(__dirname, '..', 'renderer', 'app.js'),
    ...fs.readdirSync(path.join(__dirname, '..', 'lib'))
      .filter(file => file.endsWith('.js'))
      .map(file => path.join(__dirname, '..', 'lib', file))
  ];
  const germanCopy = /[äöüß]|\b(?:der|die|das|ein|eine|kein|keine|nicht|fehlgeschlagen|ungültig|beschädigt|wurde|werden|konnte|können|verfügbar|gefunden|erhalten|abgelehnt|Antwort|Datei|Einstellungen|Upload-Server|Prüfung|Passwort|Session|Verlauf|Sicherung|Fehler)\b/i;
  const candidates = [];

  const addCandidate = (file, node) => {
    if (node?.type === 'Literal' && typeof node.value === 'string') candidates.push([file, node.loc.start.line, node.value]);
    if (node?.type === 'TemplateLiteral') {
      if (node.expressions.some(expression => expression.type === 'ConditionalExpression')) return;
      let sample = '';
      node.quasis.forEach((part, index) => {
        sample += part.value.cooked;
        if (index < node.expressions.length) sample += 'X';
      });
      candidates.push([file, node.loc.start.line, sample]);
    }
  };

  const walk = (file, node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'NewExpression' && ['Error', 'AggregateError'].includes(node.callee?.name)) addCandidate(file, node.arguments?.[0]);
    if (node.type === 'Property' && ['error', 'message', 'reason'].includes(node.key?.name || node.key?.value)) addCandidate(file, node.value);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(child => walk(file, child));
      else if (value && typeof value === 'object' && value.type) walk(file, value);
    }
  };

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const tree = espree.parse(source, { ecmaVersion: 'latest', sourceType: 'script', loc: true });
    walk(path.relative(path.join(__dirname, '..'), file), tree);
  }

  const untranslated = candidates
    .filter(([, , value]) => germanCopy.test(value) && translateText(value, 'en') === value)
    .map(([file, line, value]) => `${file}:${line} ${value}`);
  assert.deepEqual(untranslated, []);
});
