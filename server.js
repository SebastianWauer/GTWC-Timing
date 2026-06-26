'use strict';

require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server: SocketServer } = require('socket.io');
const path = require('path');

const { createSftpPoller } = require('./src/sftp-client');
const { parseXml } = require('./src/xml-parser');
const { DataStore } = require('./src/data-store');
const { buildViewModel } = require('./src/timing-logic');
const { saveSession, listSessions, loadSession } = require('./src/session-archive');

const PORT = process.env.PORT || 3000;

const app = express();
const httpServer = http.createServer(app);
const io = new SocketServer(httpServer, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

const store = new DataStore();
let activeClassFilter = null;
let currentSessionLabel = '';

// -----------------------------------------------------------------------
// Broadcast
// -----------------------------------------------------------------------
function broadcast() {
  const snapshot = store.getSnapshot(activeClassFilter);
  const vm = buildViewModel(snapshot, activeClassFilter);
  vm.sessionLabel = currentSessionLabel;
  io.emit('update', vm);
}

// -----------------------------------------------------------------------
// SFTP Poller
// -----------------------------------------------------------------------
let poller;
try {
  poller = createSftpPoller();
} catch (e) {
  console.error('FATAL:', e.message);
  process.exit(1);
}

poller.on('connected', () => process.stdout.write('.'));
poller.on('error', (err) => console.warn('\n[SFTP] Error – reconnecting…', err.message));
poller.on('status', (msg) => console.log('[SFTP]', msg));

poller.on('session', (label) => {
  if (label !== currentSessionLabel) {
    if (currentSessionLabel) {
      saveSession(currentSessionLabel, store, buildViewModel);
      store.reset();
      activeClassFilter = null;
      console.log('\n[Session Changed →]', label);
      broadcast();
    }
    currentSessionLabel = label;
    console.log('\n[Session]', label);
  }
});

poller.on('sessionChanged', (label) => {
  if (label !== currentSessionLabel) {
    saveSession(currentSessionLabel, store, buildViewModel);
    store.reset();
    activeClassFilter = null;
    currentSessionLabel = label;
    console.log('\n[Session Changed (path) →]', label);
    broadcast();
  }
});

poller.on('file', (filename, content) => {
  const parsed = parseXml(filename, content);
  if (!parsed) return;

  switch (parsed.type) {
    case 'entryList':       store.applyEntryList(parsed); break;
    case 'resultList':      store.applyResultList(parsed); break;
    case 'announcements':   store.applyAnnouncements(parsed); break;
    case 'eventListTotal':  store.applyEventList({ ...parsed, isTotal: true }); break;
    case 'eventListUpdate': store.applyEventList({ ...parsed, isTotal: false }); break;
  }
  broadcast();
});

poller.start().catch(err => console.error('[SFTP] Start error:', err.message));

// -----------------------------------------------------------------------
// Socket.IO
// -----------------------------------------------------------------------
io.on('connection', (socket) => {
  console.log('\n[WS] Client connected:', socket.id);

  const snapshot = store.getSnapshot(activeClassFilter);
  const vm = buildViewModel(snapshot, activeClassFilter);
  vm.sessionLabel = currentSessionLabel;
  socket.emit('update', vm);

  socket.on('setClassFilter', (cls) => {
    activeClassFilter = cls || null;
    const snap = store.getSnapshot(activeClassFilter);
    const vm2 = buildViewModel(snap, activeClassFilter);
    vm2.sessionLabel = currentSessionLabel;
    socket.emit('update', vm2);
  });

  socket.on('getCarDetail', (nr) => {
    const car = store.cars.get(String(nr));
    if (car) socket.emit('carDetail', car);
  });

  socket.on('disconnect', () => console.log('\n[WS] Disconnected:', socket.id));
});

// -----------------------------------------------------------------------
// REST
// -----------------------------------------------------------------------
app.get('/api/snapshot', (_req, res) => {
  const snapshot = store.getSnapshot(activeClassFilter);
  res.json(buildViewModel(snapshot, activeClassFilter));
});

app.get('/api/car/:nr', (req, res) => {
  const car = store.cars.get(req.params.nr);
  if (!car) return res.status(404).json({ error: 'Not found' });
  res.json(car);
});

app.get('/api/sessions', (_req, res) => {
  res.json(listSessions());
});

app.get('/api/sessions/:id', (req, res) => {
  const session = loadSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Not found' });
  res.json(session);
});

app.post('/api/sessions/save', (_req, res) => {
  const id = saveSession(currentSessionLabel, store, buildViewModel);
  if (!id) return res.status(400).json({ error: 'No data to save' });
  res.json({ id });
});

httpServer.listen(PORT, () => {
  console.log(`GTWC Timing Dashboard → http://localhost:${PORT}`);
});
