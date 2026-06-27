import { DataStore } from './data-store.js';
import { buildViewModel } from './timing-logic.js';
import { parseXml } from './xml-parser.js';
import { openFtp, findSessionsPerSeries, checkFilesForSession, probeFtp } from './ftp-cf.js';
import { discover as prosyncDiscover, fetchUnit, buildSnapshot } from './prosync.js';

// How long one burst keeps the FTP connection open (ms).
// Longer = fewer reconnects = gentler on the connection-limited FTP server.
const BURST_DURATION_MS = 60_000;
// Delay between file-poll checks within a burst (ms)
const CHECK_INTERVAL_MS = 2_000;
// How often to re-walk the directory tree to discover sessions (ms).
// The tree changes rarely; walking it is expensive (many PASV connections).
const SESSION_SCAN_MS = 30_000;
// Gap between bursts (ms) — short reconnect pause
const BURST_GAP_MS = 2_000;
// ProSync poll interval (ms) — direct HTTP poll of Swiss Timing ps-cache
const PROSYNC_INTERVAL_MS = 2_000;
// Re-discover the current meeting/units less often (ms)
const PROSYNC_DISCOVER_MS = 20_000;

export class TimingState {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this._polling = false;
    this._probing = false;
    this._lastDiag = null;
    this._activeSessions = null; // Map<seriesKey, {path,label}> from last discovery
    this._lastScanAt = 0;
    this._prosyncDisc = null;    // last ProSync discovery result
    this._prosyncDiscAt = 0;

    // Per-series state: Map<seriesKey, { store, sessionLabel, lastVersions }>
    this._series = new Map();

    // Map<WebSocket, { classFilter: string|null, series: string|null }>
    this.connections = new Map();

    this.state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('ping', 'pong')
    );

    // Persisted lap history is restored lazily on the first poll (NOT in the
    // constructor): loading a large store under blockConcurrencyWhile could
    // crash the DO on startup and take down every request.
    this._persistLoaded = false;
  }

  // -----------------------------------------------------------------------
  // Persistence of ProSync lap history (DO storage)
  //   ph:<series>:label        → current session label
  //   ph:<series>:bs           → best-sector store {nr: {S1:{...}}}
  //   ph:<series>:lh:<nr>      → that car's lap history array
  // -----------------------------------------------------------------------

  async _loadPersisted() {
    const all = await this.state.storage.list({ prefix: 'ph:' });
    for (const [k, v] of all) {
      const parts = k.split(':'); // ph, series, type, [nr]
      const series = parts[1], type = parts[2];
      if (!series) continue;
      const s = this._getOrCreateSeries(series);
      if (!s.lapHistoryStore) s.lapHistoryStore = new Map();
      if (!s.bestSectorStore) s.bestSectorStore = new Map();
      if (!s.persistedCounts) s.persistedCounts = new Map();
      if (type === 'label') s.sessionLabel = v;
      else if (type === 'bs') s.bestSectorStore = new Map(Object.entries(v || {}));
      else if (type === 'lh') {
        const nr = parts.slice(3).join(':');
        s.lapHistoryStore.set(nr, v);
        s.persistedCounts.set(nr, (v || []).length);
      }
    }
  }

  async _persistSeries(key, s) {
    if (!s.persistedCounts) s.persistedCounts = new Map();
    const writes = {};
    let changed = false;
    for (const [nr, laps] of (s.lapHistoryStore || new Map())) {
      if ((s.persistedCounts.get(nr) || 0) !== laps.length) {
        // Cap to the most recent 800 laps to stay well under the 128 KB
        // per-value DO storage limit.
        writes[`ph:${key}:lh:${nr}`] = laps.length > 800 ? laps.slice(-800) : laps;
        s.persistedCounts.set(nr, laps.length);
        changed = true;
      }
    }
    if (!changed) return; // only write when a lap was actually added
    writes[`ph:${key}:label`] = s.sessionLabel || '';
    writes[`ph:${key}:bs`] = Object.fromEntries(s.bestSectorStore || new Map());
    const keys = Object.keys(writes);
    for (let i = 0; i < keys.length; i += 120) {
      const chunk = {};
      for (const k of keys.slice(i, i + 120)) chunk[k] = writes[k];
      await this.state.storage.put(chunk);
    }
  }

  async _clearPersistedSeries(key) {
    const old = await this.state.storage.list({ prefix: `ph:${key}:` });
    if (old.size) await this.state.storage.delete([...old.keys()]);
  }

  _getSeriesKeys() {
    return (this.env.SRO_SERIES_PRIORITY || 'GTWorldCh,GT4')
      .split(',').map(v => v.trim()).filter(Boolean);
  }

  _getOrCreateSeries(key) {
    if (!this._series.has(key)) {
      this._series.set(key, { store: new DataStore(), sessionLabel: '', lastVersions: {} });
    }
    return this._series.get(key);
  }

  _defaultSeriesKey() {
    return this._getSeriesKeys()[0] || 'GTWorldCh';
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.headers.get('Upgrade') === 'websocket') {
      return this._handleWebSocket(request);
    }

    if (url.pathname === '/ingest' && request.method === 'POST') {
      return this._handleIngest(request);
    }

    if (url.pathname === '/api/snapshot') {
      const seriesKey = url.searchParams.get('series') || this._defaultSeriesKey();
      const classFilter = url.searchParams.get('class') || null;
      const s = this._series.get(seriesKey);
      if (!s) return Response.json({ cars: [], session: {}, classes: [] });
      const snapshot = s.snapshot || s.store?.getSnapshot(classFilter);
      const vm = buildViewModel(snapshot, classFilter);
      vm.sessionLabel = s.sessionLabel;
      vm.series = seriesKey;
      return Response.json(vm);
    }

    if (url.pathname.startsWith('/api/car/')) {
      const nr = url.pathname.split('/').pop();
      const seriesKey = url.searchParams.get('series') || this._defaultSeriesKey();
      const s = this._series.get(seriesKey);
      const car = s?.snapshot
        ? s.snapshot.cars.find(c => c.nr === String(nr))
        : s?.store.cars.get(nr);
      if (!car) return new Response('Not found', { status: 404 });
      return Response.json(car);
    }

    if (url.pathname === '/api/sessions' && request.method === 'GET') {
      return this._handleListSessions();
    }
    if (url.pathname.startsWith('/api/sessions/') && request.method === 'GET') {
      const id = url.pathname.slice('/api/sessions/'.length);
      return this._handleGetSession(id);
    }

    if (url.pathname === '/_cron') {
      if (this._ftpEnabled()) await this._scheduleAlarm(0);
      return Response.json({ ok: true, ftpEnabled: this._ftpEnabled() });
    }

    // Probe: test which FTP transport/port the server accepts
    if (url.pathname === '/api/debug/probe') {
      const auth = request.headers.get('X-Ingest-Secret');
      if (this.env.INGEST_SECRET && auth !== this.env.INGEST_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }
      const host = this.env.SRO_FTP_HOST || 'xml-motorsport.sportresult.com';
      this._probing = true; // pause burst polling during the probe
      try {
        const results = await probeFtp(host);
        return Response.json({ host, results });
      } catch (e) {
        return Response.json({ host, error: e.message, stack: e.stack });
      } finally {
        this._probing = false;
      }
    }

    // Debug: show what's currently detected per series (protected)
    if (url.pathname === '/api/debug/ftp') {
      const auth = request.headers.get('X-Ingest-Secret');
      if (this.env.INGEST_SECRET && auth !== this.env.INGEST_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }
      return this._handleFtpDebug();
    }

    // Info: show active series state (public, no credentials exposed)
    if (url.pathname === '/api/series') {
      const result = {};
      for (const [key, s] of this._series) {
        const carCount = s.snapshot ? s.snapshot.cars.length : (s.store?.cars.size || 0);
        result[key] = { sessionLabel: s.sessionLabel, carCount };
      }
      return Response.json({ configured: this._getSeriesKeys(), active: result, dataSource: this._dataSource(), lastDiag: this._lastDiag });
    }

    return new Response('Not found', { status: 404 });
  }

  // -----------------------------------------------------------------------
  // DO Alarm — FTP burst polling
  // -----------------------------------------------------------------------

  // Data source: 'poller' = data arrives via /ingest from an external poller
  // (the Cloudflare egress IPs are blocked by the timing FTP server, so the
  // Worker cannot poll FTP itself). Any other value = Worker polls FTP itself.
  _dataSource() {
    return this.env.DATA_SOURCE || 'worker-ftp';
  }

  // Whether the DO should self-schedule polling (true for any pull mode).
  _ftpEnabled() {
    return this._dataSource() !== 'poller';
  }

  async alarm() {
    const mode = this._dataSource();
    if (mode === 'poller') return; // data pushed in via /ingest — no polling
    if (this._polling) return;
    if (mode !== 'prosync' && this._probing) { await this._scheduleAlarm(BURST_GAP_MS); return; }
    this._polling = true;
    try {
      if (mode === 'prosync') {
        await this._runProSyncPoll();
      } else {
        await this._runBurst();
      }
    } catch (err) {
      console.error('[TimingState] poll error:', err.message);
      this._lastDiag = { time: new Date().toISOString(), error: err.message, stack: err.stack };
    } finally {
      this._polling = false;
      await this._scheduleAlarm(mode === 'prosync' ? PROSYNC_INTERVAL_MS : BURST_GAP_MS);
    }
  }

  // -----------------------------------------------------------------------
  // ProSync poll (Swiss Timing ps-cache, direct HTTP — no whitelist needed)
  // -----------------------------------------------------------------------

  async _runProSyncPoll() {
    const seriesKeys = this._getSeriesKeys();

    // Lazy, fail-safe restore of persisted lap history (once).
    if (!this._persistLoaded) {
      this._persistLoaded = true;
      try { await this._loadPersisted(); } catch (e) { console.error('[loadPersisted]', e.message); }
    }

    // Re-discover the current meeting + live units periodically (cheap to skip)
    if (!this._prosyncDisc || (Date.now() - this._prosyncDiscAt) > PROSYNC_DISCOVER_MS) {
      const disc = await prosyncDiscover(seriesKeys);
      if (disc) { this._prosyncDisc = disc; this._prosyncDiscAt = Date.now(); }
    }
    const disc = this._prosyncDisc;
    if (!disc) { this._lastDiag = { time: new Date().toISOString(), error: 'ProSync discover returned null' }; return; }

    let changed = false;
    for (const key of seriesKeys) {
      const u = disc.perSeries[key];
      if (!u) continue;
      const s = this._getOrCreateSeries(key);
      if (!s.lapHistoryStore) s.lapHistoryStore = new Map();
      if (!s.bestSectorStore) s.bestSectorStore = new Map();

      const label = [disc.meetingName, u.competitionName, u.unitName].filter(Boolean).join(' › ');
      if (label !== s.sessionLabel) {
        if (s.sessionLabel && s.snapshot) {
          await this._archiveSnapshotSession(key, s).catch(e => console.error('[archive]', e.message));
        }
        s.sessionLabel = label;
        s.lapHistoryStore = new Map();
        s.bestSectorStore = new Map();
        s.persistedCounts = new Map();
        await this._clearPersistedSeries(key).catch(e => console.error('[clearPersist]', e.message));
      }

      const { timing, detail } = await fetchUnit(disc.season, u.unitId);
      if (!timing || !detail) continue;
      s.snapshot = buildSnapshot({ timing, detail, sessionName: label, lapHistoryStore: s.lapHistoryStore, bestSectorStore: s.bestSectorStore });
      await this._persistSeries(key, s).catch(e => console.error('[persist]', e.message));
      changed = true;
    }

    this._lastDiag = {
      time: new Date().toISOString(),
      meeting: disc.meetingName,
      detected: Object.entries(disc.perSeries).map(([k, v]) => ({ key: k, unit: v.unitName, comp: v.competitionName })),
    };
    if (changed) this._broadcast();
  }

  async _runBurst() {
    const ftpConfig = {
      host: this.env.SRO_FTP_HOST || 'xml-motorsport.sportresult.com',
      port: parseInt(this.env.SRO_FTP_PORT || '21', 10),
      user: this.env.SRO_FTP_USER || 'racing-sro',
      pass: this.env.SRO_FTP_PASS,
      root: this.env.SRO_FTP_ROOT || 'SRO',
    };
    const seriesKeys = this._getSeriesKeys();

    if (!ftpConfig.pass) {
      console.warn('[TimingState] SRO_FTP_PASS not set');
      return;
    }

    const ftp = await openFtp(ftpConfig);
    const burstEnd = Date.now() + BURST_DURATION_MS;

    try {
      while (Date.now() < burstEnd) {
        const t0 = Date.now();

        // --- Discovery: walk the directory tree only every SESSION_SCAN_MS ---
        // The tree (events/competitions/sessions) changes rarely; only the
        // file versions inside the active session change every second.
        // Re-walking the whole tree every 2s opens far too many PASV data
        // connections and gets the connection closed by the server.
        if (!this._activeSessions || (Date.now() - (this._lastScanAt || 0)) > SESSION_SCAN_MS) {
          const diag = { time: new Date().toISOString() };
          this._activeSessions = await findSessionsPerSeries(ftp, ftpConfig.root, seriesKeys, diag);
          diag.detected = Array.from(this._activeSessions.entries()).map(([k, v]) => ({ key: k, label: v.label }));
          this._lastDiag = diag;
          this._lastScanAt = Date.now();

          // Handle session changes detected during discovery
          for (const [key, session] of this._activeSessions) {
            const s = this._getOrCreateSeries(key);
            if (session.label !== s.sessionLabel) {
              if (s.sessionLabel) {
                await this._archiveSeriesSession(key, s).catch(e => console.error('[archive]', e.message));
                s.store.reset();
                s.lastVersions = {};
              }
              s.sessionLabel = session.label;
            }
          }
        }

        // --- File polling: only the known session paths (cheap) ---
        let anyChanged = false;
        for (const [key, session] of this._activeSessions) {
          const s = this._getOrCreateSeries(key);
          const { files, newVersions } = await checkFilesForSession(ftp, session.path, s.lastVersions);
          s.lastVersions = newVersions;

          let changed = false;
          for (const { filename, content } of files) {
            const parsed = parseXml(filename, content);
            if (!parsed) continue;
            switch (parsed.type) {
              case 'entryList':       s.store.applyEntryList(parsed); break;
              case 'resultList':      s.store.applyResultList(parsed); break;
              case 'announcements':   s.store.applyAnnouncements(parsed); break;
              case 'eventListTotal':  s.store.applyEventList({ ...parsed, isTotal: true }); break;
              case 'eventListUpdate': s.store.applyEventList({ ...parsed, isTotal: false }); break;
            }
            changed = true;
          }
          if (changed) anyChanged = true;
        }

        if (anyChanged) this._broadcast();

        const elapsed = Date.now() - t0;
        const wait = Math.max(0, CHECK_INTERVAL_MS - elapsed);
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
      }
    } finally {
      ftp.quit().catch(() => {});
    }
  }

  async _scheduleAlarm(delayMs) {
    await this.state.storage.setAlarm(Date.now() + delayMs);
  }

  // -----------------------------------------------------------------------
  // WebSocket
  // -----------------------------------------------------------------------

  _handleWebSocket(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.state.acceptWebSocket(server);
    this.connections.set(server, { classFilter: null, series: this._defaultSeriesKey() });

    if (this._ftpEnabled()) this._scheduleAlarm(0).catch(() => {});

    this._sendUpdate(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    let msg;
    try { msg = JSON.parse(message); } catch { return; }

    const conn = this.connections.get(ws);
    if (!conn) return;

    if (msg.type === 'setClassFilter') {
      conn.classFilter = msg.data || null;
      this._sendUpdate(ws);
    }

    if (msg.type === 'setSeries') {
      conn.series = msg.data || this._defaultSeriesKey();
      conn.classFilter = null; // reset class filter on series change
      conn.pinned = null;      // back to live for the new series
      this._sendUpdate(ws);
    }

    if (msg.type === 'setSession') {
      // msg.data = { unitId } | null/'live' → resume live
      const seriesKey = conn.series || this._defaultSeriesKey();
      const disc = this._prosyncDisc;
      const ps = disc?.perSeries?.[seriesKey];
      const unitId = msg.data && msg.data.unitId;
      if (!unitId || !ps || unitId === ps.unitId) {
        conn.pinned = null; // live
        this._sendUpdate(ws);
      } else {
        try {
          const { timing, detail } = await fetchUnit(disc.season, unitId);
          if (timing && detail) {
            const sess = ps.sessions.find(x => x.unitId === unitId);
            const label = [disc.meetingName, ps.competitionName, sess?.name].filter(Boolean).join(' › ');
            const snapshot = buildSnapshot({ timing, detail, sessionName: label, lapHistoryStore: new Map() });
            conn.pinned = { series: seriesKey, unitId, label, snapshot };
          }
        } catch (e) { console.error('[setSession]', e.message); }
        this._sendUpdate(ws);
      }
    }

    if (msg.type === 'getCarDetail') {
      const s = this._series.get(conn.series || this._defaultSeriesKey());
      const nr = String(msg.data);
      const car = s?.snapshot
        ? s.snapshot.cars.find(c => c.nr === nr)
        : s?.store.cars.get(nr);
      if (car) ws.send(JSON.stringify({ type: 'carDetail', data: car }));
    }
  }

  async webSocketClose(ws) { this.connections.delete(ws); }
  async webSocketError(ws) { this.connections.delete(ws); try { ws.close(); } catch (_) {} }

  _sendUpdate(ws) {
    const conn = this.connections.get(ws) || { classFilter: null, series: this._defaultSeriesKey() };
    const seriesKey = conn.series || this._defaultSeriesKey();
    const s = this._series.get(seriesKey);

    // A pinned (manually selected) session overrides the live one for this client.
    const pinned = conn.pinned && conn.pinned.series === seriesKey ? conn.pinned : null;

    // ProSync mode keeps a prebuilt snapshot; FTP/poller modes use the DataStore.
    const snapshot = pinned?.snapshot || s?.snapshot || (s?.store || new DataStore()).getSnapshot(conn.classFilter);
    const vm = buildViewModel(snapshot, conn.classFilter);
    vm.sessionLabel = pinned?.label || s?.sessionLabel || '';
    vm.series = seriesKey;
    vm.availableSeries = this._getSeriesKeys().map(k => ({
      key: k,
      label: seriesLabel(k),
      active: this._series.has(k) && !!this._series.get(k).sessionLabel,
    }));

    // Session picker: list of sessions for this series + which one is shown
    const disc = this._prosyncDisc;
    const ps = disc?.perSeries?.[seriesKey];
    vm.availableSessions = ps?.sessions || [];
    vm.liveUnitId = ps?.unitId || null;
    vm.currentUnitId = pinned?.unitId || ps?.unitId || null;
    vm.isLive = !pinned;

    try { ws.send(JSON.stringify({ type: 'update', data: vm })); } catch (_) {}
  }

  _broadcast() {
    for (const ws of this.state.getWebSockets()) {
      const conn = this.connections.get(ws);
      // Skip clients viewing a pinned (static, non-live) past session.
      if (conn?.pinned && conn.pinned.series === (conn.series || this._defaultSeriesKey())) continue;
      this._sendUpdate(ws);
    }
  }

  // -----------------------------------------------------------------------
  // Ingest endpoint (fallback)
  // -----------------------------------------------------------------------

  async _handleIngest(request) {
    const secret = this.env.INGEST_SECRET;
    if (secret && request.headers.get('X-Ingest-Secret') !== secret) {
      return new Response('Unauthorized', { status: 401 });
    }
    let body;
    try { body = await request.json(); } catch { return new Response('Bad JSON', { status: 400 }); }

    const { type, sessionLabel, filename, content, series: seriesKey } = body;
    const key = seriesKey || this._defaultSeriesKey();
    const s = this._getOrCreateSeries(key);

    if (type === 'sessionChanged' && sessionLabel) {
      if (sessionLabel !== s.sessionLabel) {
        s.store.reset();
        s.sessionLabel = sessionLabel;
        this._broadcast();
      }
      return Response.json({ ok: true });
    }

    if (type === 'file' && filename && content) {
      const parsed = parseXml(filename, content);
      if (parsed) {
        switch (parsed.type) {
          case 'entryList':       s.store.applyEntryList(parsed); break;
          case 'resultList':      s.store.applyResultList(parsed); break;
          case 'announcements':   s.store.applyAnnouncements(parsed); break;
          case 'eventListTotal':  s.store.applyEventList({ ...parsed, isTotal: true }); break;
          case 'eventListUpdate': s.store.applyEventList({ ...parsed, isTotal: false }); break;
        }
        this._broadcast();
      }
    }
    return Response.json({ ok: true });
  }

  // -----------------------------------------------------------------------
  // Session archive (Cloudflare KV)
  // -----------------------------------------------------------------------

  async _archiveSeriesSession(seriesKey, s) {
    if (!this.env.SESSION_KV || !s.sessionLabel) return;

    const snapshot = s.store.getSnapshot(null);
    const vm = buildViewModel(snapshot, null);
    vm.sessionLabel = s.sessionLabel;
    vm.series = seriesKey;

    const carsDetail = [];
    for (const [, car] of s.store.cars) {
      carsDetail.push({
        nr: car.nr,
        drivers: car.drivers || [],
        class: car.class,
        team: car.team,
        car: car.car,
        lapHistory: car.lapHistory || [],
        bestLap: car.bestLap || null,
        _bestLapByDriver: car._bestLapByDriver
          ? Object.fromEntries(car._bestLapByDriver instanceof Map
              ? car._bestLapByDriver : Object.entries(car._bestLapByDriver))
          : {},
        _bestSectors: car._bestSectors || [],
        _bestSectorsByDriver: car._bestSectorsByDriver
          ? Object.fromEntries(car._bestSectorsByDriver instanceof Map
              ? car._bestSectorsByDriver : Object.entries(car._bestSectorsByDriver))
          : {},
      });
    }

    const id = slugify(`${seriesKey}-${s.sessionLabel}`) + '-' + Date.now();
    const savedAt = new Date().toISOString();
    const carCount = carsDetail.length;

    await this.env.SESSION_KV.put(
      `session:${id}`,
      JSON.stringify({ id, label: s.sessionLabel, series: seriesKey, savedAt, carCount, vm, carsDetail }),
      { expirationTtl: 60 * 60 * 24 * 90 }
    );

    const raw = await this.env.SESSION_KV.get('index');
    const index = raw ? JSON.parse(raw) : [];
    index.unshift({ id, label: s.sessionLabel, series: seriesKey, seriesLabel: seriesLabel(seriesKey), savedAt, carCount });
    if (index.length > 100) index.splice(100);
    await this.env.SESSION_KV.put('index', JSON.stringify(index));

    console.log(`[archive] Saved ${seriesKey} session "${s.sessionLabel}" (${carCount} cars)`);
  }

  // Archive a ProSync session straight from the prebuilt snapshot.
  async _archiveSnapshotSession(seriesKey, s) {
    if (!this.env.SESSION_KV || !s.sessionLabel || !s.snapshot) return;
    const vm = buildViewModel(s.snapshot, null);
    vm.sessionLabel = s.sessionLabel;
    vm.series = seriesKey;

    const carsDetail = s.snapshot.cars.map(car => ({
      nr: car.nr,
      drivers: car.drivers || [],
      class: car.className,
      team: car.team,
      car: car.car,
      lapHistory: car.lapHistory || [],
      bestLap: car.bestLap || null,
      _bestLapByDriver: car._bestLapByDriver || {},
      _bestSectors: [],
    }));

    const id = slugify(`${seriesKey}-${s.sessionLabel}`) + '-' + Date.now();
    const savedAt = new Date().toISOString();
    await this.env.SESSION_KV.put(
      `session:${id}`,
      JSON.stringify({ id, label: s.sessionLabel, series: seriesKey, savedAt, carCount: carsDetail.length, vm, carsDetail }),
      { expirationTtl: 60 * 60 * 24 * 90 }
    );
    const raw = await this.env.SESSION_KV.get('index');
    const index = raw ? JSON.parse(raw) : [];
    index.unshift({ id, label: s.sessionLabel, series: seriesKey, seriesLabel: seriesLabel(seriesKey), savedAt, carCount: carsDetail.length });
    if (index.length > 100) index.splice(100);
    await this.env.SESSION_KV.put('index', JSON.stringify(index));
    console.log(`[archive] Saved ${seriesKey} ProSync session "${s.sessionLabel}" (${carsDetail.length} cars)`);
  }

  async _handleFtpDebug() {
    // The burst poll holds the single allowed FTP connection, so we cannot
    // open our own. Instead we return the diagnostics captured by the poll.
    // Make sure polling is running.
    await this._scheduleAlarm(0).catch(() => {});
    return Response.json({
      seriesKeys: this._getSeriesKeys(),
      polling: this._polling,
      lastDiag: this._lastDiag || null,
      note: this._lastDiag ? undefined : 'No poll has completed yet — retry in a few seconds.',
    });
  }

  async _handleListSessions() {
    if (!this.env.SESSION_KV) return Response.json([]);
    const raw = await this.env.SESSION_KV.get('index');
    return Response.json(raw ? JSON.parse(raw) : []);
  }

  async _handleGetSession(id) {
    if (!this.env.SESSION_KV) return new Response('Not found', { status: 404 });
    const raw = await this.env.SESSION_KV.get(`session:${id}`);
    if (!raw) return new Response('Not found', { status: 404 });
    return new Response(raw, { headers: { 'Content-Type': 'application/json' } });
  }
}

function slugify(label) {
  return label.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase().slice(0, 60);
}

function seriesLabel(key) {
  if (key.includes('GTWorldCh') || key.includes('GTWC')) return 'GTWC';
  if (key.includes('GT4')) return 'GT4 European';
  return key;
}
