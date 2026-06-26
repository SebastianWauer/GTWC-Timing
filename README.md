# GTWC Timing Dashboard

Ziel dieses Projekts ist ein Live-Timing-Monitor fuer die **GT World Challenge Europe** mit Fokus auf **Swisstiming** und einer klaren Rennstrategie-Ansicht.

Dieses README ist als **Arbeitsgrundlage fuer Claude/Coding-Agents** geschrieben: kompakt, eindeutig, umsetzbar.

## 1) Produktziel

Baue ein Live-Dashboard mit:
- zentraler Tabelle pro Fahrzeug
- rechter Analyse-Spalte (Bestzeiten, Hersteller, Detailansicht)
- farblicher Hervorhebung fuer Performance und Rennstatus
- Filterung nach Klasse
- Driver-/Stint-Analyse pro Auto
- Race Control Nachrichten oben

## 2) Muss-Anforderungen (funktional)

### 2.1 Haupttabelle pro Auto
Die Tabelle muss folgende Spalten enthalten:
- `Pos`
- `#` (Startnummer als Klassen-Badge farbig)
- `Driver` (aktiver Fahrer oben, Teamkollegen darunter)
- `Team / Car` (Team oben, Fahrzeug darunter)
- `Rd`
- `Gap` (zum Fuehrenden)
- `Int` (zum Vordermann)
- `Sektoren` (alle vorhandenen Sektoren)
- `Last`
- `Best`
- `Best Lap #` (Runde der persoenlichen Bestzeit)
- `PTIME` (Boxenstoppzeit)
- `PIT` (Anzahl Stopps)
- `Stint` (aktuelle Stintzeit)
- `TLW` (Track-Limit-Warnings)
- `CPos` (Klassenposition)

### 2.2 Rechte Analyse-Spalte (ca. 1/11 Breite)
Muss anzeigen:
- beste Sektorenzeiten (inkl. Auto)
- theoretische Bestzeit (Summe bester Sektoren)
- Hersteller inkl. Anzahl Fahrzeuge
- bei Klick auf Fahrzeugzeile: komplette Rundenhistorie inkl. Sektoren und Fahrer
- oberhalb der Detailhistorie: schnellste Rundenzeit je Fahrer auf diesem Auto

### 2.3 Session-/Header-Bereich
Muss anzeigen:
- lokale Zeit
- verbleibende Sessionzeit
- Flaggenstatus (Gruen/Gelb etc.)
- Race Control / Rennleitungs-Nachrichten

### 2.4 Boxenstatus
Wenn Auto in der Box:
- Badge `IN PIT` in `Last` (rot)
- aktiver Fahrer rot
- Team rot

### 2.5 Klassenfilter
Der Nutzer muss nach Klasse filtern koennen.
Bei aktivem Klassenfilter muessen sich **alle relativen Berechnungen** auf die gefilterte Klasse beziehen:
- `Gap` und `Int` relativ zum Klassenfuehrenden/naechsten Auto in Klasse
- Herstelleranzahl nur innerhalb der gefilterten Klasse

## 3) Muss-Anforderungen (farbliche Logik)

### 3.1 Klassenfarben fuer `#`-Badge
Nur die Nummer farbig als Badge:
- `PRO` = weiss
- `GOLD` = gelb
- `SILVER` = blau
- `BRONZE` = braun
- `PRO-AM` = rot

### 3.2 Farbregeln fuer Sektoren / Runden
Sektoren (`S1..Sn`) und letzte Runde analog einfärben:
- persoenliche Bestzeit Fahrer = gelb
- persoenliche Bestzeit Auto (alle Fahrer) = gruen
- Klassenbestzeit = blau
- Overall-Bestzeit = lila

Bestlap + Lap-Nummer:
- persoenliche Bestlap gruen
- Klassen-Bestlap blau
- Overall-Bestlap lila

## 4) Datenhaltung / Analyse-Tiefe

Muss dauerhaft in-memory (oder persistent) tracken:
- alle Rundenzeiten pro Auto
- alle Sektorenzeiten pro Runde
- Zuordnung jeder Runde/Sektorenzeit zu Fahrer-ID

Ziel:
- Fahrzeugvergleich
- Fahrervergleich (auch innerhalb desselben Autos)
- Berechnung theoretischer Bestzeit aus Session-Historie

Wichtig: fuer beste Sektoren nicht nur letzte Runde betrachten, sondern komplette Session.

## 5) Datenquellen

### 5.1 RaceMon
- Initialzustand: `GET /instances/instance/{key}`
- Live-Updates per Socket.IO:
  - `RESULTS_CHANGED` (Delta je Auto)
  - `FILE_CHANGED` (vollstaendiger Dateiersatz)

### 5.2 Erwartete XML-Inhalte
Mindestens verarbeiten:
- `current.xml`
- `lgView_RunInfo.xml`
- `announcements.xml`
- `lgView_Results.xml`

## 6) Technische Leitplanken fuer Claude

- Keine Breaking Changes an bestehenden Kern-Datenstrukturen ohne Migration.
- Live-Updates robust gegen Reconnects machen.
- Fehlertolerant parsen (fehlende Felder, `-`, leere Strings).
- Zeiten normalisieren (`ss.mmm`, `m:ss.mmm`).
- Jede neue Anzeige muss mit klarer Datenquelle hinterlegt sein.
- Klassenfilter darf niemals nur visuell sein; Logik muss mitfiltern.

## 7) Akzeptanzkriterien (Definition of Done)

1. Tabelle zeigt alle geforderten Spalten inkl. korrekter Werte.
2. Klassen-Badges sind farblich korrekt.
3. `IN PIT`-Darstellung greift korrekt und konsistent.
4. Sektor-/Rundenfarben folgen exakt der 4-stufigen Logik (gelb/gruen/blau/lila).
5. Rechte Analyse-Spalte zeigt Bestsektoren, theoretische Bestzeit, Herstelleranzahl.
6. Klick auf Auto zeigt komplette Runden-/Sektorenhistorie inkl. Fahrerzuordnung.
7. Klassenfilter passt Anzeige **und** Berechnungen (`Gap`, `Int`, Herstelleranzahl) korrekt an.
8. Race-Control-Nachrichten sind sichtbar und aktualisieren live.
9. Lokale Zeit und Session-Countdown sind sichtbar.

## 8) Offene Punkte fuer naechste Iteration

- Exakte Mapping-Liste aller Rohfelder auf UI-Spalten dokumentieren.
- Einheitliches Color-Token-System (`--color-*`) zentralisieren.
- Tests fuer Farbklassifikation und Klassenfilter-Logik ergaenzen.

## 9) Sicherheit

Im bisherigen Entwurf standen echte Zugangsdaten im README. Diese gehoeren **nicht** in Versionskontrolle.

Vorgehen:
- Zugangsdaten nur ueber `.env`
- README nur mit Platzhaltern dokumentieren, z. B.:
  - `SRO_FTP_HOST=...`
  - `SRO_FTP_USER=...`
  - `SRO_FTP_PASS=...`

## 10) Kurzbriefing fuer Claude

Wenn du als Agent an diesem Projekt arbeitest, priorisiere:
1. Datenkorrektheit unter Live-Updates
2. klare visuelle Rennlogik (Farben/Status)
3. Klassenfilter mit korrekter Berechnungsbasis
4. nachvollziehbare, testbare Funktionen fuer Zeit-/Sektorwertung
