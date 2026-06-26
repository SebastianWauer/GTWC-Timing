'use strict';

const fs = require('fs');
const path = require('path');

const SESSIONS_DIR = path.join(__dirname, '..', 'data', 'sessions');
const INDEX_FILE = path.join(SESSIONS_DIR, 'index.json');

function ensureDir() {
  if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  }
}

function sanitize(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').slice(0, 60);
}

function readIndex() {
  try { return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); }
  catch { return []; }
}

function writeIndex(index) {
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2), 'utf8');
}

function saveSession(label, store, buildViewModel) {
  if (!store.cars.size) return null;
  ensureDir();

  const snapshot = store.getSnapshot(null);
  const vm = buildViewModel(snapshot, null);

  // Full car data with lap history for detail view in replay
  const carsDetail = [];
  for (const car of store.cars.values()) {
    carsDetail.push({
      nr: car.nr,
      lapHistory: car.lapHistory || [],
      _bestLapByDriver: car._bestLapByDriver || {},
      _bestSectors: car._bestSectors || {},
      _bestSectorsByDriver: car._bestSectorsByDriver || {},
    });
  }

  const now = new Date();
  const dateStr = now.toISOString().slice(0, 19).replace(/[T:]/g, '-');
  const id = `${dateStr}_${sanitize(label || 'unknown')}`;
  const filepath = path.join(SESSIONS_DIR, `${id}.json`);

  const record = {
    id,
    label: label || 'Unknown Session',
    savedAt: now.toISOString(),
    carCount: store.cars.size,
    vm,
    carsDetail,
  };

  fs.writeFileSync(filepath, JSON.stringify(record), 'utf8');

  const index = readIndex();
  // Avoid duplicates (e.g. server restart in same session)
  const existing = index.findIndex(e => e.id === id);
  const meta = { id, label: record.label, savedAt: record.savedAt, carCount: record.carCount };
  if (existing >= 0) index[existing] = meta;
  else index.unshift(meta);
  writeIndex(index);

  console.log(`[Archive] Saved "${label}" → ${id}.json (${store.cars.size} cars)`);
  return id;
}

function listSessions() {
  return readIndex();
}

function loadSession(id) {
  // Sanitize id to prevent path traversal
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '');
  const filepath = path.join(SESSIONS_DIR, `${safeId}.json`);
  try { return JSON.parse(fs.readFileSync(filepath, 'utf8')); }
  catch { return null; }
}

module.exports = { saveSession, listSessions, loadSession };
