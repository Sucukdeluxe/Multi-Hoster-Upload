# Projekt-Memory

## Zweck

Multi-Hoster-Upload ist eine Electron-Desktopanwendung für Windows, die große Dateimengen aus einer gemeinsamen Queue gleichzeitig zu Doodstream, VOE, Vidmoly, Byse und Clouddrop hochlädt.

## Aktueller Zustand

- Aktive Arbeitslinie: `master` aus `Sucukdeluxe/Multi-Hoster-Upload`.
- Zuletzt geprüfter Code-Stand: Version `2.1.40`, Commit `bf33ab3e9937d8b0ad23d8956730f2020f861942`.
- Einstiegspunkt des Electron-Hauptprozesses: `main.js`.
- Oberfläche: `renderer/`; gekapselte Fachlogik: `lib/`; Online-Backup-Dienst: `services/backup-api/`.
- Die Abhängigkeiten sind lokal mit Node.js 24 installiert.

## Entscheidungen

- Weiterarbeit erfolgt im aktiven Repository `Multi-Hoster-Upload`, nicht im archivierten `Multi-Hoster-Upload-Private-Archive` und nicht im älteren Tauri-Versuch `Multi-Hoster-Upload-2`.
- Die jüngste Automatik schützt erfolgreiche Uploads mit einem atomar gespeicherten Abschlussnachweis aus vollständigem Pfad, Hoster, Dateigröße und Änderungszeit.
- Schlägt dieser Nachweis fehl, bleibt die Queue erhalten und der Fehler wird als lokale Persistenzstörung behandelt, damit kein stiller Doppel-Upload entsteht.
- Es wurde kein Release und kein Deployment ausgeführt.
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

- Lint: erfolgreich.
- Haupttests: 797 erfolgreich, 0 fehlgeschlagen.
- Backup-API-Tests: 15 erfolgreich, 0 fehlgeschlagen.
- Produktionsabhängigkeiten: `npm audit --omit=dev` meldet 0 Schwachstellen.
- GitHub `origin/master` und Forgejo `release/v2.1.40` enthielten vor diesem Dokumentationscommit beide exakt den geprüften Code-Commit `bf33ab3e9937d8b0ad23d8956730f2020f861942`.
