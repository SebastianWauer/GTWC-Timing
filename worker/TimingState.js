import { DataStore } from './data-store.js';
import { buildViewModel } from './timing-logic.js';
import { parseXml } from './xml-parser.js';
import { openFtp, findSessionsPerSeries, checkFilesForSession } from './ftp-cf.js';

// How long one burst keeps the FTP connection open (ms)
const BURST_DURATION_MS = 25_000;
// Delay between checks within a burst (ms)
const CHECK_INTERVAL_MS = 2_000;
// Gap between bursts (ms)
const BURST_GAP_MS = 1_000;

export class TimingState {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this._polling = false;

    // Per-series state: Map<seriesKey, { store, sessionLabel, lastVersions }>
    this._series = new Map();

    // Map<WebSocket, { classFilter: string|null, series: string|null }>
    this.connections = new Map();

    this.state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('ping', 'pong')
    );
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
      const vm = buildViewModel(s.store.getSnapshot(classFilter), classFilter);
      vm.sessionLabel = s.sessionLabel;
      vm.series = seriesKey;
      return Response.json(vm);
    }

    if (url.pathname.startsWith('/api/car/')) {
      const nr = url.pathname.split('/').pop();
      const seriesKey = url.searchParams.get('series') || this._defaultSeriesKey();
      const s = this._series.get(seriesKey);
      const car = s?.store.cars.get(nr);
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
      await this._scheduleAlarm(0);
      return Response.json({ ok: true });
    }

    return new Response('Not found', { status: 404 });
  }

  // -----------------------------------------------------------------------
  // DO Alarm — FTP burst polling
  // -----------------------------------------------------------------------

  async alarm() {
    if (this._polling) return;
    this._polling = true;
    try {
      await this._runBurst();
    } catch (err) {
      console.error('[TimingState] burst error:', err.message);
    } finally {
      this._polling = false;
      await this._scheduleAlarm(BURST_GAP_MS);
    }
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

        // Discover all active sessions per series on every burst check
        const activeSessions = await findSessionsPerSeries(ftp, ftpConfig.root, seriesKeys);

        let anyChanged = false;
        for (const [key, session] of activeSessions) {
          const s = this._getOrCreateSeries(key);

          // Session changed → archive old, reset
          if (session.label !== s.sessionLabel) {
            if (s.sessionLabel) {
              await this._archiveSeriesSession(key, s).catch(e => console.error('[archive]', e.message));
              s.store.reset();
              s.lastVersions = {};
            }
            s.sessionLabel = session.label;
          }

          // Poll files for this series
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

    this._scheduleAlarm(0).catch(() => {});

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
      this._sendUpdate(ws);
    }

    if (msg.type === 'getCarDetail') {
      const s = this._series.get(conn.series || this._defaultSeriesKey());
      const car = s?.store.cars.get(String(msg.data));
      if (car) ws.send(JSON.stringify({ type: 'carDetail', data: car }));
    }
  }

  async webSocketClose(ws) { this.connections.delete(ws); }
  async webSocketError(ws) { this.connections.delete(ws); try { ws.close(); } catch (_) {} }

  _sendUpdate(ws) {
    const conn = this.connections.get(ws) || { classFilter: null, series: this._defaultSeriesKey() };
    const seriesKey = conn.series || this._defaultSeriesKey();
    const s = this._series.get(seriesKey);
    const store = s?.store || new DataStore();
    const snapshot = store.getSnapshot(conn.classFilter);
    const vm = buildViewModel(snapshot, conn.classFilter);
    vm.sessionLabel = s?.sessionLabel || '';
    vm.series = seriesKey;
    // Tell client which series are available
    vm.availableSeries = this._getSeriesKeys().map(k => ({
      key: k,
      label: seriesLabel(k),
      active: this._series.has(k) && !!this._series.get(k).sessionLabel,
    }));
    try { ws.send(JSON.stringify({ type: 'update', data: vm })); } catch (_) {}
  }

  _broadcast() {
    for (const ws of this.state.getWebSockets()) {
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
