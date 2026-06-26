# GTWC Timing – SFTP Poller

Der Cloudflare-Worker kann den Timing-Server **nicht direkt** erreichen: Der
Anbieter (Swiss/HH Timing) lässt nur **freigeschaltete IP-Adressen** zu, und
Cloudflare nutzt einen großen Pool wechselnder IPs. Dieser kleine Poller läuft
deshalb auf deinem PC (dessen IP freigeschaltet ist), zieht die Daten per SFTP
und schiebt sie an den Worker.

Alles andere – Dashboard, WebSockets, Archiv, Multi-Series – läuft komplett in
Cloudflare. Nur diese Datenabholung läuft lokal.

## Einrichtung (einmalig)

```bash
cd GTWC-Timing
npm install
```

Die Zugangsdaten stehen bereits in `poller/.env`. Falls dein alter SFTP-Zugang
andere Werte hatte, dort anpassen.

## Starten (während eines Renn-Wochenendes)

```bash
npm run poller
```

Du siehst Heartbeat-Punkte (`·G` für GTWC, `·G` für GT4) und Meldungen bei
Session-Wechseln. Solange der Poller läuft, ist das Dashboard unter
**https://gtwc-timing.digiwtal.workers.dev** live – inkl. beider Serien.

Zum Beenden: `Strg+C`.

## Wie es funktioniert

- Pro Serie (GTWorldCh, GT4) wird eine eigene SFTP-Poller-Instanz gestartet.
- Jede Datei wird mit ihrem `series`-Key an `POST /ingest` des Workers gepusht
  (abgesichert über `INGEST_SECRET`).
- Der Worker hält pro Serie einen eigenen Datenstand, broadcastet an alle
  Browser und archiviert Sessions automatisch beim Wechsel.
