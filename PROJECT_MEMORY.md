# Projekt-Memory

## Zweck

Multi-Hoster-Upload ist eine Electron-Desktopanwendung für Windows zum Hochladen von Dateien an mehrere Hoster. Diese Datei enthält ausschließlich öffentlich geeignete Projektinformationen. Zugangsdaten, persönliche Arbeitsumgebungen, konkrete Serverpfade, Sicherungsnachweise und Betriebsprotokolle gehören nicht in das Repository.

## Aktueller Zustand

- Veröffentlicht: Version `2.1.50`.
- Einstiegspunkt: `main.js`; Oberfläche: `renderer/`; Fachlogik: `lib/`; optionaler Sicherungsdienst: `services/backup-api/`.
- Version `2.1.50` enthält verbesserte Sicherungsmenüs, getrennte Online-Backup-Bereiche, einheitliche Automatik- und Log-Einstellungen sowie korrigierte Such- und Update-Anzeigen.
- Ordnerüberwachung lässt sich unabhängig von ihrem Aktivierungszustand mit gespeicherten Regeln schreibgeschützt testen. Testscans starten keine Uploads und verändern keine laufende Überwachung.
- Nach dem Release wurden ausschließlich Wartebedingungen zweier Electron-Tests korrigiert. Die Anwendungsversion bleibt unverändert.
- Regressionstests sind in das private Repository `Multi-Hoster-Upload-Tests` ausgelagert. Beide privaten Remotes enthalten Desktop- und Backup-API-Tests. Öffentliche CI führt nur Lint, Abhängigkeitsprüfung und Build aus. Historische Commits und Tags bleiben unverändert.

## Entscheidungen

- DoodStream-Webaccounts verwenden ausdrücklich die Web-Sitzung; ein gespeicherter API-Key darf diese Auswahl nicht übersteuern. Parallele Accountchecks teilen ihre OTP-Anforderung.
- Accountchecks melden einzelne Ergebnisse sofort an die Oberfläche.
- Accountbezogene Speicherfehler führen zum nächsten verfügbaren Fallback-Account; vorübergehende Netzwerkfehler bleiben davon getrennt.
- Hoster-Dateigrößenlimits werden in GB eingegeben und kompatibel im bestehenden MB-Format gespeichert. Zu große Dateien werden für den jeweiligen Hoster übersprungen.
- Online-Backups sind clientseitig verschlüsselt. Neue Schlüssel sind standardmäßig unbegrenzt gültig; bestehende Ablaufdaten bleiben erhalten.
- Wiederherstellungsschlüssel bleiben außerhalb des Repositorys und des Sicherungsdienstes. Datensatzformatänderungen benötigen einen datenerhaltenden Kompatibilitätsplan.
- Backup-Importe übertragen Einstellungen; Warteschlange, Verlauf und laufzeitgebundene Zustände bleiben davon getrennt.
- Nicht vorhandene Überwachungspfade bleiben gespeichert; die Überwachung wird bis zur Korrektur deaktiviert.
- Erfolgreiche Uploads erhalten einen persistenten Abschlussnachweis. Bei einem Speicherfehler bleibt die Warteschlange erhalten, um unbeabsichtigte Wiederholungen zu vermeiden.
- Dropdowns benötigen ausreichenden Pfeilabstand und müssen auch in schmalen Fenstern bedienbar bleiben. Kopierbare Inhalte und Eingabefelder behalten ihre Textauswahl.
- Update-Metadaten müssen zu den tatsächlich veröffentlichten Dateinamen, Größen und Prüfsummen passen. Versionsmeldungen zeigen gültige Veröffentlichungszeitpunkte in lokaler Gerätezeit.
- Release-Changelogs sind auf GitHub englisch und auf Forgejo deutsch, bei inhaltlich gleichem Umfang.
- Die aktive Arbeitslinie ist `master`; der zweite Remote verwendet `sync/github-master`. Eine getrennte ältere Historie darf nicht überschrieben werden.

## Start- und Testbefehle

Node.js 24 und die im Lockfile festgelegten Abhängigkeiten verwenden.

```powershell
npm ci
npm start
npm run dev
npm run verify
```

Enthält der Projektpfad Shell-Sonderzeichen wie `&`, scheitern die npm-`.cmd`-Shims unter `cmd.exe`. Dann eine lokale, nicht versionierte `.npmrc` mit `script-shell=pwsh` anlegen (über `.git/info/exclude` ausschließen); danach funktionieren alle npm-Skripte.

## Bekannte Probleme und nächste Schritte

- Nach jedem App-Push die private Testsuite mit dem vollständigen App-Commit starten: `gh workflow run tests.yml --repo Sucukdeluxe/Multi-Hoster-Upload-Tests -f source_ref=<Commit>`. Mit `-f ui_smoke=true` läuft zusätzlich der Electron-UI-Smoke auf dem Runner. Ein erfolgreicher öffentlicher Build ersetzt diesen Testlauf nicht. Lokale Ausführung ist in der privaten README dokumentiert.
- Der DoodStream-Web-Upload funktioniert laut Nutzerrückmeldung vom 26.09.2026 wieder.
- Wird eine vollständig abgelehnte Dateiauswahl gemeldet, zeigt der Hinweis die Vorabprüfungsbilanz statt eines kurzen Duplikathinweises. Eine verständlichere Einzeldatei-Meldung wäre möglich.
- Öffentliche Dokumentation auf Architektur, Verhalten und reproduzierbare Entwicklung beschränken. Keine betrieblichen Einzelfalldaten ergänzen.

## Zuletzt verifiziert

- Stand: 22.09.2026.
- Release `2.1.50`: 845 Haupttests und 18 Servertests erfolgreich; Lint und Abhängigkeitsprüfung erfolgreich. Installer, portable Anwendung und Update-Metadaten beider Plattformen einschließlich Download-Prüfsummen geprüft.
- CI-Timingkorrektur: beide betroffenen Tests zehnmal hintereinander erfolgreich. Gesamte lokale Suite und GitHub-CI einschließlich Windows-Build erfolgreich. Tests warten mit Zeitlimit auf verarbeitete Eingaben beziehungsweise den angekommenen Dateikandidaten, ohne Zustandsprüfungen abzuschwächen.
- Öffentliche Dokumentation von konkreten Betriebs-, Sicherungs- und Diagnosedetails bereinigt. Keine Anwendungscodeänderung und keine Umschreibung der Git-Historie; ältere Dokumentfassungen bleiben historisch erreichbar.
- 26.09.2026: Das Recent-Panel wird zusätzlich neu begrenzt, wenn sich Höhen innerhalb der Warteschlangenansicht ändern (z. B. umbrechende Werkzeugleiste). Vorher konnte die Warteschlange bei kleinem Fenster auf 69 px schrumpfen. UI-Smoke lokal dreimal hintereinander mit 303/303 erfolgreich. CI-Actions auf `checkout@v7` und `setup-node@v7` (Node 24) umgestellt. `npm run verify` lokal mit `script-shell=pwsh` erfolgreich.
- 26.09.2026: Schließt sich der Update-Dialog ohne brauchbares Rücksprungziel, landet der Fokus auf dem Update-Button im Header statt auf einem ausgeblendeten Dialogbutton. Private Suite einschließlich UI-Smoke auf dem Windows-Runner zweimal gegen `bbc4a98` erfolgreich; öffentliche CI grün.
