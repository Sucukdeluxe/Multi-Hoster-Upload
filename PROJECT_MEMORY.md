# Projekt-Memory

## Zweck

Multi-Hoster-Upload ist eine Electron-Desktopanwendung für Windows, die große Dateimengen aus einer gemeinsamen Queue gleichzeitig zu Doodstream, VOE, Vidmoly, Byse und Clouddrop hochlädt.

## Aktueller Zustand

- Aktive Arbeitslinie: `master` aus `Sucukdeluxe/Multi-Hoster-Upload`.
- Zuletzt geprüfter Funktionsstand: Version `2.1.41`, Fix-Commit `40ce83d`.
- Einstiegspunkt des Electron-Hauptprozesses: `main.js`.
- Oberfläche: `renderer/`; gekapselte Fachlogik: `lib/`; Online-Backup-Dienst: `services/backup-api/`.
- Die Abhängigkeiten sind lokal mit Node.js 24 installiert.

## Entscheidungen

- Weiterarbeit erfolgt im aktiven Repository `Multi-Hoster-Upload`, nicht im archivierten `Multi-Hoster-Upload-Private-Archive` und nicht im älteren Tauri-Versuch `Multi-Hoster-Upload-2`.
- Die jüngste Automatik schützt erfolgreiche Uploads mit einem atomar gespeicherten Abschlussnachweis aus vollständigem Pfad, Hoster, Dateigröße und Änderungszeit.
- Schlägt dieser Nachweis fehl, bleibt die Queue erhalten und der Fehler wird als lokale Persistenzstörung behandelt, damit kein stiller Doppel-Upload entsteht.
- DoodStream-OTP-Prüfungen verwenden dieselbe Cookie-Sitzung weiter, fassen identische oder parallele Checks zusammen und fordern einen neuen Code nur nach einer ausdrücklichen Aktion mit mindestens 60 Sekunden Abstand an.
- DoodStream-Accounts mit API-Key werden auch beim Health-Check über die API geprüft und lösen keinen Web-OTP aus.
- Release-Ziel dieser Sitzung ist `2.1.41`; produktive Server werden dadurch nicht neu gestartet.
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

## Offene nächste Schritte

- Die nächste fachliche Änderung mit Sascha festlegen und auf Basis des verifizierten Stands umsetzen.
- Bei Bedarf einen Arbeitsweg ohne `&` im absoluten Pfad verwenden oder die npm-Aufrufe weiterhin direkt ausführen.

## Zuletzt verifiziert

Stand: 31.08.2026

- Lint: erfolgreich, 0 Warnungen und 0 Fehler.
- Haupttests: 803 erfolgreich, 0 fehlgeschlagen.
- Backup-API-Tests: 15 erfolgreich, 0 fehlgeschlagen.
- Produktionsabhängigkeiten: `npm audit --omit=dev` meldet 0 Schwachstellen.
- Der Fix-Commit `40ce83d` wurde auf GitHub `origin/master` und Forgejo `sync/github-master` verifiziert.
