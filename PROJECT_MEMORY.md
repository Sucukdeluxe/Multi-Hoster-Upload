# Projekt-Memory

## Zweck

Multi-Hoster-Upload ist eine Electron-Desktopanwendung für Windows zum Hochladen von Dateien an mehrere Hoster. Diese Datei enthält ausschließlich öffentlich geeignete Projektinformationen. Zugangsdaten, persönliche Arbeitsumgebungen, konkrete Serverpfade, Sicherungsnachweise und Betriebsprotokolle gehören nicht in das Repository.

## Aktueller Zustand

- Veröffentlicht: Version `2.1.51`.
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
- Fokusringe erscheinen nur im Tastaturmodus (`html.keyboard-navigation`, gesetzt durch Tab oder Pfeiltasten in Menüs, entfernt durch Mausklick). Automatischer Fokus in Dialogen, Escape und Entf zeigen keinen Ring; Textfelder erhalten beim Fokus keinen farbigen Rahmen. Informationstexte sind nicht markierbar.
- Beschreibungen zu Einstellungen stehen in Info-Tooltips (`.info-tip`), die fixiert positioniert werden und nicht von Containern abgeschnitten werden.
- Meldungen erscheinen als Toast oben rechts mit Zustand `success`, `warning` oder `error`. Online-Backup-Erfolge und -Fehler laufen darüber; der Inline-Status zeigt nur laufende Vorgänge.
- Die Content-Security-Policy bleibt bei `default-src 'self'`; Symbole daher per CSS statt Data-URI.
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

- Kleine Änderungen: Lint und private Testsuite lokal ausführen (der UI-Smoke läuft dabei unsichtbar offscreen mit), committen und pushen, ohne auf CI zu warten. Den privaten Remote-Lauf (`gh workflow run tests.yml --repo Sucukdeluxe/Multi-Hoster-Upload-Tests -f source_ref=<Commit>`, mit `-f ui_smoke=true` inklusive Electron-UI-Smoke) nur vor Releases oder nach größeren Umbauten starten und abwarten. Ein erfolgreicher öffentlicher Build ersetzt diesen Testlauf nicht. Lokale Ausführung ist in der privaten README dokumentiert.
- Der DoodStream-Web-Upload funktioniert laut Nutzerrückmeldung vom 26.09.2026 wieder.
- Anzeigefehler auf Windows Server über RDP (Inhalt versetzt, weiße Ränder, gelegentlich beim ersten Start): Nach dem Anzeigen wird einmal ein Neu-Layout erzwungen und `window-content: …` protokolliert. Wirksamkeit auf dem Server noch zu bestätigen.
- Wird eine vollständig abgelehnte Dateiauswahl gemeldet, zeigt der Hinweis die Vorabprüfungsbilanz statt eines kurzen Duplikathinweises. Eine verständlichere Einzeldatei-Meldung wäre möglich.
- Öffentliche Dokumentation auf Architektur, Verhalten und reproduzierbare Entwicklung beschränken. Keine betrieblichen Einzelfalldaten ergänzen.

## Zuletzt verifiziert

- Release `2.1.51` (26.09.2026, Tag auf `103139d`): 845 Haupttests einschließlich UI-Smoke lokal und auf dem Windows-Runner, 18 Servertests, Lint und Abhängigkeitsprüfung erfolgreich. Paketinhalt gegen Quellstand geprüft. Beide Plattformen mit je vier Dateien veröffentlicht; Downloads per Größe und SHA-512 bestätigt; der Updater erkennt 2.1.51 ausgehend von 2.1.50. Changelogs beginnen ohne Titelzeile direkt mit dem Einleitungssatz.
- Stand: 22.09.2026.
- Release `2.1.50`: 845 Haupttests und 18 Servertests erfolgreich; Lint und Abhängigkeitsprüfung erfolgreich. Installer, portable Anwendung und Update-Metadaten beider Plattformen einschließlich Download-Prüfsummen geprüft.
- CI-Timingkorrektur: beide betroffenen Tests zehnmal hintereinander erfolgreich. Gesamte lokale Suite und GitHub-CI einschließlich Windows-Build erfolgreich. Tests warten mit Zeitlimit auf verarbeitete Eingaben beziehungsweise den angekommenen Dateikandidaten, ohne Zustandsprüfungen abzuschwächen.
- Öffentliche Dokumentation von konkreten Betriebs-, Sicherungs- und Diagnosedetails bereinigt. Keine Anwendungscodeänderung und keine Umschreibung der Git-Historie; ältere Dokumentfassungen bleiben historisch erreichbar.
- 26.09.2026: Das Recent-Panel wird zusätzlich neu begrenzt, wenn sich Höhen innerhalb der Warteschlangenansicht ändern (z. B. umbrechende Werkzeugleiste). Vorher konnte die Warteschlange bei kleinem Fenster auf 69 px schrumpfen. UI-Smoke lokal dreimal hintereinander mit 303/303 erfolgreich. CI-Actions auf `checkout@v7` und `setup-node@v7` (Node 24) umgestellt. `npm run verify` lokal mit `script-shell=pwsh` erfolgreich.
- 26.09.2026 (UI-Überarbeitung, veröffentlicht als 2.1.51): Sprachwechsel mit 3.314 Verlaufseinträgen von 1,1–1,8 s auf 30–50 ms beschleunigt (gecachte Datumsformatierer, identische Ausgabe). Fokusringe, Textauswahl, Toasts, Online-Backup-Ablauf, Upload-Einstellungen, 14-Tage-Verlaufsoption und Diagnose-Adressfeld überarbeitet. 844 Haupttests, 18 Servertests und Lint erfolgreich; Darstellung per Offscreen-Screenshots bei 1100×750 und 820×560 geprüft.
- 26.09.2026: Schließt sich der Update-Dialog ohne brauchbares Rücksprungziel, landet der Fokus auf dem Update-Button im Header statt auf einem ausgeblendeten Dialogbutton. Private Suite einschließlich UI-Smoke auf dem Windows-Runner zweimal gegen `bbc4a98` erfolgreich; öffentliche CI grün.
