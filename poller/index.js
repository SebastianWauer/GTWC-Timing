'use strict';

/**
 * SFTP Poller (Multi-Series) – verbindet sich mit dem SRO-SFTP-Server und
 * POSTet Dateiinhalte an den Cloudflare Worker.
 *
 * Läuft auf einer beim Timing-Anbieter freigeschalteten (whitelisted) IP,
 * weil die Cloudflare-Worker-IPs vom Server blockiert werden.
 *
 * Für JEDE konfigurierte Serie (z.B. GTWorldCh + GT4) wird eine eigene
 * Poller-Instanz gestartet. Jedes Event wird mit seinem `series`-Key an
 * /ingest gepusht, sodass der Worker beide Serien getrennt führt.
 *
 * Umgebungsvariablen (.env oder process.env):
 *   SRO_SFTP_HOST, SRO_SFTP_PORT, SRO_FTP_USER, SRO_FTP_PASS
 *   SRO_SFTP_ROOT  (default: "SRO")
 *   SRO_SERIES_PRIORITY (default: "GTWorldCh,GT4")
 *   WORKER_URL     (z.B. https://gtwc-timing.digiwtal.workers.dev)
 *   INGEST_SECRET  (muss mit Cloudflare Worker Secret übereinstimmen)
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const { SroSftpPoller } = require('../src/sftp-client');

const WORKER_URL = process.env.WORKER_URL;
const INGEST_SECRET = process.env.INGEST_SECRET || '';

if (!WORKER_URL) {
  console.error('FATAL: WORKER_URL not set');
  process.exit(1);
}

const host = process.env.SRO_SFTP_HOST;
const port = parseInt(process.env.SRO_SFTP_PORT || '22', 10);
const user = process.env.SRO_FTP_USER;
const password = process.env.SRO_FTP_PASS;
const root = process.env.SRO_SFTP_ROOT || 'SRO';
const seriesKeys = (process.env.SRO_SERIES_PRIORITY || 'GTWorldCh,GT4')
  .split(',').map(v => v.trim()).filter(Boolean);

const missing = [];
if (!host) missing.push('SRO_SFTP_HOST');
if (!user) missing.push('SRO_FTP_USER');
if (!password) missing.push('SRO_FTP_PASS');
if (missing.length > 0) {
  console.error('FATAL: Missing ENV:', missing.join(', '));
  process.exit(1);
}

async function post(body) {
  try {
    const res = await fetch(`${WORKER_URL}/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Ingest-Secret': INGEST_SECRET,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(`[Poller] Ingest failed ${res.status}: ${text}`);
    }
  } catch (e) {
    console.warn('[Poller] Ingest error:', e.message);
  }
}

/**
 * Start one SFTP poller per series. Each instance only surfaces sessions
 * for its own series (seriesPriority = [seriesKey]) and tags every event
 * with that key when pushing to the Worker.
 */
function startSeries(seriesKey) {
  const poller = new SroSftpPoller({
    host, port, user, password, root,
    seriesPriority: [seriesKey],
  });

  let lastDot = 0;
  poller.on('connected', () => {
    const now = Date.now();
    if (now - lastDot > 1000) { process.stdout.write(`·${seriesKey[0]}`); lastDot = now; }
  });
  poller.on('error', (err) => console.warn(`\n[${seriesKey}] SFTP Error:`, err.message));
  poller.on('status', (msg) => console.log(`\n[${seriesKey}]`, msg));

  poller.on('session', (label) => {
    post({ type: 'sessionChanged', series: seriesKey, sessionLabel: label });
  });
  poller.on('sessionChanged', (label) => {
    console.log(`\n[${seriesKey}] Session changed → ${label}`);
    post({ type: 'sessionChanged', series: seriesKey, sessionLabel: label });
  });
  poller.on('file', (filename, content) => {
    post({ type: 'file', series: seriesKey, filename, content });
  });

  poller.start().catch(err => {
    console.error(`[${seriesKey}] Start error:`, err.message);
  });

  console.log(`[Poller] Started series "${seriesKey}"`);
  return poller;
}

console.log(`[Poller] Multi-series → pushing to ${WORKER_URL}`);
console.log(`[Poller] Series: ${seriesKeys.join(', ')}`);

const pollers = seriesKeys.map(startSeries);

// Graceful shutdown
function shutdown() {
  console.log('\n[Poller] Shutting down…');
  for (const p of pollers) { try { p.stop(); } catch (_) {} }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
