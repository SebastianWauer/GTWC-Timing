'use strict';

const SftpClient = require('ssh2-sftp-client');
const AdmZip = require('adm-zip');
const { EventEmitter } = require('events');

const POLL_INTERVAL_MS   = 50;    // fallback polling when inotifywait unavailable
const SESSION_SCAN_MS    = 30000;
const RECONNECT_DELAY_MS = 5000;

// Only surface sessions belonging to these competition series.
// Order matters: earlier entries are preferred when multiple series
// are active at the same time.
const DEFAULT_SERIES_PRIORITY = ['GTWorldCh', 'GT4'];

class SroSftpPoller extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this._seriesPriority = config.seriesPriority;
    this._running = false;
    this._lastVersions = {};
    this._entryCache = new Map();
    this._eventTotalCache = new Map();
    this._currentSessionPath = null;
    this._currentSession = null;
    this._sftp = null;
    this._sessionScanTimer = null;
    this._inotifyStream = null;
    this._useInotify = false;
    this._checkInProgress = false;
    this._inotifyDebounce = null;
  }

  async start() {
    this._running = true;
    this._connectAndPoll();
  }

  stop() {
    this._running = false;
    clearTimeout(this._sessionScanTimer);
    clearTimeout(this._inotifyDebounce);
    if (this._inotifyStream) {
      try { this._inotifyStream.close(); } catch (_) {}
      this._inotifyStream = null;
    }
    if (this._sftp) this._sftp.end().catch(() => {});
  }

  // -----------------------------------------------------------------------
  // Connection management
  // -----------------------------------------------------------------------

  async _connectAndPoll() {
    const sftp = new SftpClient();
    try {
      await sftp.connect({
        host: this.config.host,
        port: this.config.port,
        username: this.config.user,
        password: this.config.password,
        readyTimeout: 15000,
      });
      this._sftp = sftp;
      this.emit('connected');

      // Session scan runs independently — never blocks the file-check loop
      this._scheduleSessionScan(0);

      // Wait for first session to be discovered before polling files
      await this._waitForSession();

      // Try inotifywait for push-based real-time; fall back to fast polling
      const hasInotify = await this._tryInotifywait(sftp);
      if (!hasInotify) {
        await this._pollLoop(sftp);
      }
    } catch (err) {
      try { await sftp.end(); } catch (_) {}
      this._sftp = null;
      this.emit('error', err);
      if (this._running) setTimeout(() => this._connectAndPoll(), RECONNECT_DELAY_MS);
    }
  }

  _waitForSession() {
    return new Promise(resolve => {
      if (this._currentSession) return resolve();
      const t = setInterval(() => {
        if (this._currentSession || !this._running) { clearInterval(t); resolve(); }
      }, 100);
    });
  }

  // -----------------------------------------------------------------------
  // Session scan loop — independent, never blocks file polling
  // -----------------------------------------------------------------------

  _scheduleSessionScan(delay) {
    clearTimeout(this._sessionScanTimer);
    this._sessionScanTimer = setTimeout(() => this._doSessionScan(), delay ?? SESSION_SCAN_MS);
  }

  async _doSessionScan() {
    if (!this._running || !this._sftp) return;
    try {
      const session = await this._findLatestSession(this._sftp, this.config.root);
      if (session) {
        const changed = this._currentSessionPath && this._currentSessionPath !== session.path;
        if (changed) {
          this.emit('sessionChanged', session.label);
          // Restart inotifywait on the new session path
          if (this._useInotify) {
            if (this._inotifyStream) {
              try { this._inotifyStream.close(); } catch (_) {}
              this._inotifyStream = null;
            }
            this._currentSessionPath = session.path;
            this._currentSession = session;
            this._tryInotifywait(this._sftp);
            this._scheduleSessionScan();
            return;
          }
        }
        this._currentSessionPath = session.path;
        this._currentSession = session;
      } else {
        this.emit('status', 'No session found');
      }
    } catch (err) {
      this.emit('status', `Session scan error: ${err.message}`);
    }
    this._scheduleSessionScan();
  }

  // -----------------------------------------------------------------------
  // inotifywait via SSH exec — push-based real-time events
  // -----------------------------------------------------------------------

  async _tryInotifywait(sftp) {
    return new Promise((resolve) => {
      let resolved = false;
      const done = (val) => { if (!resolved) { resolved = true; resolve(val); } };

      const sshClient = sftp.client;
      if (!sshClient || typeof sshClient.exec !== 'function') return done(false);

      const sessionPath = this._currentSessionPath;
      const cmd = `inotifywait -q -m -r -e close_write,moved_to -- "${sessionPath}"`;

      // If neither stdout nor stderr arrives within 5s, inotifywait is not available
      const fallback = setTimeout(() => done(false), 5000);

      sshClient.exec(cmd, (err, stream) => {
        if (err) { clearTimeout(fallback); return done(false); }

        // stdout: file-change events (one per line after startup)
        stream.on('data', () => {
          // Debounce: merge rapid bursts (e.g. multiple files written at once)
          clearTimeout(this._inotifyDebounce);
          this._inotifyDebounce = setTimeout(() => {
            this._checkFiles(sftp).catch(() => {});
          }, 30);
        });

        // stderr: startup messages — "Watches established." confirms it's running
        stream.stderr.on('data', (chunk) => {
          if (chunk.toString().includes('Watches established') && !resolved) {
            clearTimeout(fallback);
            this._inotifyStream = stream;
            this._useInotify = true;
            this.emit('status', 'Real-time mode (inotifywait active)');
            done(true);
          }
        });

        stream.on('close', (code) => {
          clearTimeout(fallback);
          this._inotifyStream = null;
          if (code === 127 || !resolved) {
            // Command not found or never confirmed → not available
            this._useInotify = false;
            done(false);
          } else if (this._running) {
            // Was running but exited unexpectedly → restart or fall back
            this.emit('status', 'inotifywait exited — falling back to polling');
            this._useInotify = false;
            this._pollLoop(sftp).catch(() => {});
          }
        });
      });
    });
  }

  // -----------------------------------------------------------------------
  // Fast polling loop — used when inotifywait is not available
  // -----------------------------------------------------------------------

  async _pollLoop(sftp) {
    this.emit('status', 'Polling mode (50 ms)');
    while (this._running) {
      try {
        await this._checkFiles(sftp);
      } catch (err) {
        try { await sftp.end(); } catch (_) {}
        this._sftp = null;
        this.emit('error', err);
        if (this._running) setTimeout(() => this._connectAndPoll(), RECONNECT_DELAY_MS);
        return;
      }
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }
    try { await sftp.end(); } catch (_) {}
  }

  // -----------------------------------------------------------------------
  // File check — called by poll loop or inotifywait event
  // -----------------------------------------------------------------------

  async _checkFiles(sftp) {
    if (this._checkInProgress) return;
    this._checkInProgress = true;
    try {
      await this._doCheckFiles(sftp);
    } finally {
      this._checkInProgress = false;
    }
  }

  async _doCheckFiles(sftp) {
    const session = this._currentSession;
    if (!session) return;

    this.emit('session', session.label);

    // Entry list: load once per session
    if (!this._entryCache.has(session.path)) {
      const entryXml = await this._downloadLatestFile(sftp, session.path, 'ENTRY_LIST');
      if (entryXml) {
        this._entryCache.set(session.path, true);
        this.emit('file', 'ENTRY_LIST.XML', entryXml);
      }
    }

    const resultKey = session.path + ':RESULT_LIST';
    const updateKey = session.path + ':EVENT_LIST_UPDATE';

    const [latestResult, latestUpdate] = await Promise.all([
      this._findLatestVersionFile(sftp, session.path, 'RESULT_LIST').catch(() => null),
      this._findLatestVersionFile(sftp, session.path + '/Changes', 'EVENT_LIST_UPDATE').catch(() => null),
    ]);

    const pending = [];
    if (latestResult && latestResult.version !== this._lastVersions[resultKey]) {
      pending.push(
        this._downloadZip(sftp, session.path + '/' + latestResult.name)
          .then(xml => {
            if (xml) {
              this._lastVersions[resultKey] = latestResult.version;
              this.emit('file', 'RESULT_LIST.XML', xml);
            }
          }).catch(() => {})
      );
    }
    if (latestUpdate && latestUpdate.version !== this._lastVersions[updateKey]) {
      pending.push(
        this._downloadZip(sftp, session.path + '/Changes/' + latestUpdate.name)
          .then(xml => {
            if (xml) {
              this._lastVersions[updateKey] = latestUpdate.version;
              this.emit('file', 'EVENT_LIST_UPDATE.XML', xml);
            }
          }).catch(() => {})
      );
    }
    if (pending.length > 0) await Promise.all(pending);

    // Event list total: load once per session
    if (!this._eventTotalCache.has(session.path)) {
      try {
        const totalXml = await this._downloadLatestFile(sftp, session.path + '/FullVersion', 'EVENT_LIST_TOTAL');
        if (totalXml) {
          this._eventTotalCache.set(session.path, true);
          this.emit('file', 'EVENT_LIST_TOTAL.XML', totalXml);
        }
      } catch (_) {}
    }

    this.emit('connected');
  }

  // -----------------------------------------------------------------------
  // SFTP helpers
  // -----------------------------------------------------------------------

  async _findLatestSession(sftp, root) {
    const events = await sftp.list(root);
    const eventDirs = events.filter(f => f.type === 'd');

    // Parallel: all event dirs at once
    const perEvent = await Promise.all(eventDirs.map(async (ev) => {
      const evPath = `${root}/${ev.name}`;
      const competitions = await sftp.list(evPath);
      const matchingComps = competitions.filter(
        f => f.type === 'd' && this._seriesPriority.some(series => f.name.includes(series))
      );

      // Parallel: all competition dirs at once
      const perComp = await Promise.all(matchingComps.map(async (comp) => {
        const compPath = `${evPath}/${comp.name}`;
        const sessions = await sftp.list(compPath);
        return sessions.filter(f => f.type === 'd').map(sess => ({
          path: `${compPath}/${sess.name}`,
          label: `${ev.name} › ${comp.name} › ${sess.name}`,
          seriesPriority: this._resolveSeriesPriority(comp.name),
          modifyTime: sess.modifyTime || 0,
        }));
      }));

      return perComp.flat();
    }));

    const allSessions = perEvent.flat();
    if (allSessions.length === 0) return null;
    allSessions.sort((a, b) => {
      if (a.seriesPriority !== b.seriesPriority) {
        return a.seriesPriority - b.seriesPriority;
      }
      return b.modifyTime - a.modifyTime;
    });
    return allSessions[0];
  }

  _resolveSeriesPriority(competitionName) {
    const index = this._seriesPriority.findIndex(series => competitionName.includes(series));
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  }

  async _downloadLatestFile(sftp, sessionPath, prefix) {
    const info = await this._findLatestVersionFile(sftp, sessionPath, prefix);
    if (!info) return null;
    return this._downloadZip(sftp, sessionPath + '/' + info.name);
  }

  async _findLatestVersionFile(sftp, sessionPath, prefix) {
    const files = await sftp.list(sessionPath);
    const matching = files
      .filter(f => f.name.startsWith(prefix) && f.name.endsWith('.ZIP'))
      .map(f => ({ name: f.name, version: parseInt(f.name.match(/V_(\d+)/)?.[1] || '0', 10) }))
      .sort((a, b) => b.version - a.version);
    return matching[0] || null;
  }

  async _downloadZip(sftp, remotePath) {
    const result = await sftp.get(remotePath);
    const zipBuf = Buffer.isBuffer(result) ? result : Buffer.from(result);
    if (!zipBuf || zipBuf.length === 0) return null;

    const zip = new AdmZip(zipBuf);
    const entries = zip.getEntries();
    if (entries.length === 0) return null;
    return zip.readAsText(entries[0]);
  }
}

function createSftpPoller() {
  const host = process.env.SRO_SFTP_HOST;
  const port = parseInt(process.env.SRO_SFTP_PORT || '22', 10);
  const user = process.env.SRO_FTP_USER;
  const password = process.env.SRO_FTP_PASS;
  const root = process.env.SRO_SFTP_ROOT || '.';
  const seriesPriority = (process.env.SRO_SERIES_PRIORITY || DEFAULT_SERIES_PRIORITY.join(','))
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);

  const missing = [];
  if (!host) missing.push('SRO_SFTP_HOST');
  if (!user) missing.push('SRO_FTP_USER');
  if (!password) missing.push('SRO_FTP_PASS');
  if (missing.length > 0) throw new Error(`Missing ENV: ${missing.join(', ')}`);

  return new SroSftpPoller({ host, port, user, password, root, seriesPriority });
}

module.exports = { SroSftpPoller, createSftpPoller };
