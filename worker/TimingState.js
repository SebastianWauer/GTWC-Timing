import { DataStore } from './data-store.js';
import { buildViewModel } from './timing-logic.js';
import { parseXml } from './xml-parser.js';
import { pollFtp } from './ftp-cf.js';

// Poll interval for FTP via DO Alarm (ms)
const POLL_INTERVAL_MS = 15_000;

export class TimingState {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.store = new DataStore();
    this.currentSessionLabel = '';
    this._lastVersions = {};
    this._polling = false;

    // Map<WebSocket, { classFilter: string|null }>
    this.connections = new Map();

    this.state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('ping', 'pong')
    );
  }

  async fetch(request) {
    const url = new URL(request.url);

    // WebSocket upgrade
    if (request.headers.get('Upgrade') === 'websocket') {
      return this._handleWebSocket(request);
    }

    // Ingest from external poller (fallback if FTP polling is unavailable)
    if (url.pathname === '/ingest' && request.method === 'POST') {
      return this._handleIngest(request);
    }

    // REST API
    if (url.pathname === '/api/snapshot') {
      const classFilter = url.searchParams.get('class') || null;
      const snapshot = this.store.getSnapshot(classFilter);
      const vm = buildViewModel(snapshot, classFilter);
      vm.sessionLabel = this.currentSessionLabel;
      return Response.json(vm);
    }

    if (url.pathname.startsWith('/api/car/')) {
      const nr = url.pathname.split('/').pop();
      const car = this.store.cars.get(nr);
      if (!car) return new Response('Not found', { status: 404 });
      return Response.json(car);
    }

    // Cron ping — triggers/resets the polling alarm
    if (url.pathname === '/_cron') {
      await this._scheduleAlarm(0);
      return Response.json({ ok: true, next: 'alarm scheduled' });
    }

    return new Response('Not found', { status: 404 });
  }

  // -----------------------------------------------------------------------
  // DO Alarm — FTP polling
  // -----------------------------------------------------------------------

  async alarm() {
    if (this._polling) return; // prevent concurrent runs
    this._polling = true;
    try {
      await this._runFtpPoll();
    } catch (err) {
      console.error('[TimingState] alarm error:', err.message);
    } finally {
      this._polling = false;
      // Always reschedule so polling continues
      await this._scheduleAlarm(POLL_INTERVAL_MS);
    }
  }

  async _runFtpPoll() {
    const ftpConfig = {
      host: this.env.SRO_FTP_HOST || 'xml-motorsport.sportresult.com',
      port: parseInt(this.env.SRO_FTP_PORT || '21', 10),
      user: this.env.SRO_FTP_USER || 'racing-sro',
      pass: this.env.SRO_FTP_PASS,
      root: this.env.SRO_FTP_ROOT || 'SRO',
      seriesPriority: (this.env.SRO_SERIES_PRIORITY || 'GTWorldCh,GT4')
        .split(',').map(v => v.trim()).filter(Boolean),
    };

    if (!ftpConfig.pass) {
      console.warn('[TimingState] SRO_FTP_PASS not set — skipping FTP poll');
      return;
    }

    const { session, files, newVersions } = await pollFtp(ftpConfig, this._lastVersions);
    this._lastVersions = newVersions;

    if (session && session.label !== this.currentSessionLabel) {
      if (this.currentSessionLabel) {
        this.store.reset();
        this._lastVersions = {};
      }
      this.currentSessionLabel = session.label;
    }

    let changed = false;
    for (const { filename, content } of files) {
      const parsed = parseXml(filename, content);
      if (!parsed) continue;
      switch (parsed.type) {
        case 'entryList':       this.store.applyEntryList(parsed); break;
        case 'resultList':      this.store.applyResultList(parsed); break;
        case 'announcements':   this.store.applyAnnouncements(parsed); break;
        case 'eventListTotal':  this.store.applyEventList({ ...parsed, isTotal: true }); break;
        case 'eventListUpdate': this.store.applyEventList({ ...parsed, isTotal: false }); break;
      }
      changed = true;
    }

    if (changed) this._broadcast();
  }

  async _scheduleAlarm(delayMs) {
    const next = Date.now() + delayMs;
    await this.state.storage.setAlarm(next);
  }

  // -----------------------------------------------------------------------
  // WebSocket
  // -----------------------------------------------------------------------

  _handleWebSocket(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.state.acceptWebSocket(server);
    this.connections.set(server, { classFilter: null });

    // Kick-start polling if not already running
    this._scheduleAlarm(0).catch(() => {});

    const snapshot = this.store.getSnapshot(null);
    const vm = buildViewModel(snapshot, null);
    vm.sessionLabel = this.currentSessionLabel;
    server.send(JSON.stringify({ type: 'update', data: vm }));

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    let msg;
    try { msg = JSON.parse(message); } catch { return; }

    const conn = this.connections.get(ws);
    if (!conn) return;

    if (msg.type === 'setClassFilter') {
      conn.classFilter = msg.data || null;
      const snapshot = this.store.getSnapshot(conn.classFilter);
      const vm = buildViewModel(snapshot, conn.classFilter);
      vm.sessionLabel = this.currentSessionLabel;
      ws.send(JSON.stringify({ type: 'update', data: vm }));
    }

    if (msg.type === 'getCarDetail') {
      const car = this.store.cars.get(String(msg.data));
      if (car) ws.send(JSON.stringify({ type: 'carDetail', data: car }));
    }
  }

  async webSocketClose(ws) {
    this.connections.delete(ws);
  }

  async webSocketError(ws) {
    this.connections.delete(ws);
    try { ws.close(); } catch (_) {}
  }

  // -----------------------------------------------------------------------
  // Ingest endpoint — fallback for external poller
  // -----------------------------------------------------------------------

  async _handleIngest(request) {
    const secret = this.env.INGEST_SECRET;
    if (secret) {
      const auth = request.headers.get('X-Ingest-Secret');
      if (auth !== secret) return new Response('Unauthorized', { status: 401 });
    }

    let body;
    try { body = await request.json(); } catch {
      return new Response('Bad JSON', { status: 400 });
    }

    const { type, sessionLabel, filename, content } = body;

    if (type === 'sessionChanged' && sessionLabel) {
      if (sessionLabel !== this.currentSessionLabel) {
        this.store.reset();
        this.currentSessionLabel = sessionLabel;
        this._broadcast();
      }
      return Response.json({ ok: true });
    }

    if (type === 'file' && filename && content) {
      const parsed = parseXml(filename, content);
      if (parsed) {
        switch (parsed.type) {
          case 'entryList':       this.store.applyEntryList(parsed); break;
          case 'resultList':      this.store.applyResultList(parsed); break;
          case 'announcements':   this.store.applyAnnouncements(parsed); break;
          case 'eventListTotal':  this.store.applyEventList({ ...parsed, isTotal: true }); break;
          case 'eventListUpdate': this.store.applyEventList({ ...parsed, isTotal: false }); break;
        }
        this._broadcast();
      }
    }

    return Response.json({ ok: true });
  }

  // -----------------------------------------------------------------------
  // Broadcast to all connected WebSocket clients
  // -----------------------------------------------------------------------

  _broadcast() {
    const websockets = this.state.getWebSockets();
    for (const ws of websockets) {
      try {
        const conn = this.connections.get(ws) || { classFilter: null };
        const snapshot = this.store.getSnapshot(conn.classFilter);
        const vm = buildViewModel(snapshot, conn.classFilter);
        vm.sessionLabel = this.currentSessionLabel;
        ws.send(JSON.stringify({ type: 'update', data: vm }));
      } catch (_) {}
    }
  }
}
