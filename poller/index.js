'use strict';

/**
 * SFTP Poller – verbindet sich mit dem SRO-SFTP-Server und POSTet
 * Dateiinhalte an den Cloudflare Worker.
 *
 * Umgebungsvariablen (.env oder process.env):
 *   SRO_SFTP_HOST, SRO_SFTP_PORT, SRO_FTP_USER, SRO_FTP_PASS
 *   SRO_SFTP_ROOT  (default: "SRO")
 *   WORKER_URL     (z.B. https://gtwc-timing.example.workers.dev)
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
const seriesPriority = (process.env.SRO_SERIES_PRIORITY || 'GTWorldCh,GT4')
  .split(',').map(v => v.trim()).filter(Boolean);

const missing = [];
if (!host) missing.push('SRO_SFTP_HOST');
if (!user) missing.push('SRO_FTP_USER');
if (!password) missing.push('SRO_FTP_PASS');
if (missing.length > 0) {
  console.error('FATAL: Missing ENV:', missing.join(', '));
  process.exit(1);
}

const poller = new SroSftpPoller({ host, port, user, password, root, seriesPriority });

async function post(body) {
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
}

poller.on('connected', () => process.stdout.write('.'));
poller.on('error', (err) => console.warn('\n[SFTP] Error:', err.message));
poller.on('status', (msg) => console.log('\n[SFTP]', msg));

poller.on('session', (label) => {
  post({ type: 'sessionChanged', sessionLabel: label }).catch(() => {});
});

poller.on('sessionChanged', (label) => {
  post({ type: 'sessionChanged', sessionLabel: label }).catch(() => {});
});

poller.on('file', (filename, content) => {
  post({ type: 'file', filename, content }).catch(() => {});
});

poller.start().catch(err => {
  console.error('[SFTP] Start error:', err.message);
  process.exit(1);
});

console.log(`[Poller] Started → pushing to ${WORKER_URL}`);
