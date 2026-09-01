# Projekt-Memory

## Zweck

Multi-Hoster-Upload ist eine Electron-Desktopanwendung für Windows, die große Dateimengen aus einer gemeinsamen Queue gleichzeitig zu Doodstream, VOE, Vidmoly, Byse und Clouddrop hochlädt.

## Aktueller Zustand

- Aktive Arbeitslinie: `master` aus `Sucukdeluxe/Multi-Hoster-Upload`.
- Zuletzt veröffentlichter Funktionsstand: Version `2.1.41`; aktueller unveröffentlichter Funktionsstand ist Commit `9e5c512`.
- Einstiegspunkt des Electron-Hauptprozesses: `main.js`.
- Oberfläche: `renderer/`; gekapselte Fachlogik: `lib/`; Online-Backup-Dienst: `services/backup-api/`.
- Die Abhängigkeiten sind lokal mit Node.js 24 installiert.

## Entscheidungen

- Weiterarbeit erfolgt im aktiven Repository `Multi-Hoster-Upload`, nicht im archivierten `Multi-Hoster-Upload-Private-Archive` und nicht im älteren Tauri-Versuch `Multi-Hoster-Upload-2`.
- Die jüngste Automatik schützt erfolgreiche Uploads mit einem atomar gespeicherten Abschlussnachweis aus vollständigem Pfad, Hoster, Dateigröße und Änderungszeit.
- Schlägt dieser Nachweis fehl, bleibt die Queue erhalten und der Fehler wird als lokale Persistenzstörung behandelt, damit kein stiller Doppel-Upload entsteht.
- DoodStream-OTP-Prüfungen verwenden dieselbe Cookie-Sitzung weiter, fassen identische oder parallele Checks zusammen und fordern einen neuen Code nur nach einer ausdrücklichen Aktion mit mindestens 60 Sekunden Abstand an.
- DoodStream-Accounts mit API-Key werden auch beim Health-Check über die API geprüft und lösen keinen Web-OTP aus.
- Sammelchecks melden jedes Account-Ergebnis einzeln an den Renderer, sodass fertige Karten sofort grün, rot oder als OTP-pflichtig erscheinen, während die übrigen Accounts weiter geprüft werden.
- Neue Online-Backups unterstützen `24 Stunden`, `3 Tage`, `7 Tage` (Standard), `31 Tage` und `Unbegrenzt`. Endliche Schlüssel werden lokal aus dem verschlüsselten Schlüsselbund entfernt und serverseitig ab Ablauf nicht mehr wiederhergestellt; der Dienst räumt abgelaufene Datensätze bei Zugriff oder der nächsten Speicherung auf.
- Vorhandene Online-Backups und alte Upload-Payloads ohne Ablaufangabe bleiben zur Abwärtskompatibilität unbegrenzt gültig.
- Backup-Importe wenden Sprache und automatischen Account-Check sofort an. Alle Konfigurationsfelder werden übertragen; Warteschlange, Upload-Wiederherstellungsstatus, letzter Dateiauswahlordner, Automatik-Telemetrie und Pausenzustand bleiben bewusst geräte- beziehungsweise laufzeitgebunden.
- Ein nicht vorhandener Ordnerüberwachungspfad bleibt nach dem Import sichtbar gespeichert, die Überwachung wird aber deaktiviert und der Nutzer erhält eine Warnung. Ein nicht vorhandener Log-Ordner wird ebenfalls gemeldet, ohne den konfigurierten Pfad still zu löschen.
- Version `2.1.41` ist als GitHub- und Forgejo-Release veröffentlicht; produktive Server wurden dadurch nicht neu gestartet.
- Der eingebaute Updater liest Releases und Binärdateien von Forgejo; GitHub liefert ergänzend die öffentlichen Release Notes. Ein Release ist deshalb erst vollständig, wenn die vier Assets auch im Forgejo-Release vorhanden sind.
- Forgejo bewahrt Leerzeichen in Asset-Namen, GitHub normalisiert sie zu Punkten. Das Forgejo-`latest.yml` und der Release-Plan verwenden Namen wie `Multi-Hoster-Upload Setup 2.1.41.exe`; das GitHub-Manifest muss auf den dort tatsächlich veröffentlichten Punktnamen zeigen.
- `forgejo/master` besitzt eine getrennte ältere Historie. Die aktuelle GitHub-Arbeitslinie wird deshalb zerstörungsfrei unter `forgejo/sync/github-master` gespiegelt.

## Start- und Testbefehle

```powershell
npm ci
npm start
npm run verify
```

Im aktuellen übergeordneten Windows-Pfad enthält der Ordnername ein `&`. Dadurch können von npm erzeugte `.cmd`-Shims zerlegt werden. Die verifizierten direkten Aufrufe sind:

```powershell
node node_modules/eslint/bin/eslint.js .
$testFiles = @((Get-ChildItem tests -Filter '*.test.js').FullName) + (Resolve-Path tests/ui-smoke.js).Path
node --test @testFiles
node --test services/backup-api/test/server.test.mjs
npm audit --omit=dev
```

## Bekannte Probleme

- `npm run verify` bricht in diesem konkreten Arbeitsverzeichnis bereits beim npm-Shim ab, obwohl Linter und Tests bei direktem Aufruf erfolgreich sind.
- Der Forgejo-Standardzweig ist nicht mit dem aktuellen GitHub-`master` verwandt und darf nicht ohne gesonderte Prüfung oder ausdrückliche Freigabe überschrieben werden.
- Der optionale, nur mit `RUN_UI_SMOKE=1` aktivierte Langzeit-UI-Test meldet reproduzierbar 16 bestehende Timing-/Fixture-Abweichungen außerhalb des Accounts-/OTP-Pfads; die reguläre CI aktiviert diesen Test nicht.

## Offene nächste Schritte

- Der Ablaufzeit-Code ist noch nicht veröffentlicht oder produktiv ausgerollt. Bei einer späteren ausdrücklichen Release-Freigabe zuerst den kompatiblen Backup-API-Dienst ausrollen und prüfen, danach den Desktop-Client veröffentlichen; Rollback sind der vorherige Dienststand und Version `2.1.41`.
- Bei Bedarf einen Arbeitsweg ohne `&` im absoluten Pfad verwenden oder die npm-Aufrufe weiterhin direkt ausführen.

## Zuletzt verifiziert

Stand: 01.09.2026

- Lint: erfolgreich, 0 Warnungen und 0 Fehler.
- Haupttests: 805 erfolgreich, 0 fehlgeschlagen.
- Backup-API-Tests: 17 erfolgreich, 0 fehlgeschlagen.
- Der vollständige opt-in UI-Smoke bestätigte alle neu ergänzten Prüfungen für fortlaufende Account-Statusmeldungen, Ablauf-Auswahl, Schlüsselbereinigung, Metadatenanzeige sowie sofortige Sprach-/Auto-Check-Übernahme; die 16 bekannten themenfremden Abweichungen blieben unverändert.
- Produktionsabhängigkeiten: `npm audit --omit=dev` meldet 0 Schwachstellen.
- Der unveröffentlichte Funktionsstand `9e5c512` wurde auf GitHub `origin/master` und Forgejo `sync/github-master` mit identischem Commit-Hash verifiziert.
- GitHub- und Forgejo-Release `v2.1.41` wurden jeweils mit Installer, Portable-Build, Blockmap und einem zum Anbieter passenden Update-Manifest veröffentlicht.
- Der von Version `2.1.40` verwendete Forgejo-Endpoint liefert `2.1.41` als neuesten stabilen Release.
