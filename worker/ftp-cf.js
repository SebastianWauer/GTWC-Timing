/**
 * Minimal FTP client for Cloudflare Workers using cloudflare:sockets.
 * Implements passive mode (PASV) for both directory listing and file download.
 */

// eslint-disable-next-line import/no-unresolved
import { connect } from 'cloudflare:sockets';

const enc = new TextEncoder();
const dec = new TextDecoder();

class FtpSession {
  constructor() {
    this.ctrl = null;
    this.ctrlReader = null;
    this.ctrlWriter = null;
    this._buf = '';
  }

  async open(host, port = 21) {
    this.ctrl = connect({ hostname: host, port });
    this.ctrlReader = this.ctrl.readable.getReader();
    this.ctrlWriter = this.ctrl.writable.getWriter();
    await this._response(); // 220 welcome
  }

  async auth(user, pass) {
    await this._cmd(`USER ${user}`);
    await this._response(); // 331
    await this._cmd(`PASS ${pass}`);
    const r = await this._response();
    if (!r.startsWith('230')) throw new Error(`FTP auth failed: ${r}`);
  }

  async list(path) {
    return this._parseListing(await this.listRaw(path));
  }

  async listRaw(path) {
    await this._cmd('TYPE A');
    await this._response();
    const [dh, dp] = await this._pasv();
    await this._cmd(path ? `LIST ${path}` : 'LIST');
    const r = await this._response();
    if (!r.startsWith('150') && !r.startsWith('125')) throw new Error(`LIST failed: ${r}`);
    const raw = await this._readData(dh, dp);
    await this._response(); // 226
    return dec.decode(raw);
  }

  async get(path) {
    await this._cmd('TYPE I');
    await this._response();
    const [dh, dp] = await this._pasv();
    await this._cmd(`RETR ${path}`);
    const r = await this._response();
    if (!r.startsWith('150') && !r.startsWith('125')) throw new Error(`RETR failed: ${r}`);
    const data = await this._readData(dh, dp);
    await this._response(); // 226
    return data;
  }

  async quit() {
    try {
      await this._cmd('QUIT');
      await this._response();
      this.ctrl.close();
    } catch (_) {}
  }

  // -----------------------------------------------------------------------

  async _pasv() {
    await this._cmd('PASV');
    const r = await this._response();
    const m = r.match(/\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/);
    if (!m) throw new Error(`PASV parse failed: ${r}`);
    const host = `${m[1]}.${m[2]}.${m[3]}.${m[4]}`;
    const port = parseInt(m[5]) * 256 + parseInt(m[6]);
    return [host, port];
  }

  async _readData(host, port) {
    const sock = connect({ hostname: host, port });
    const reader = sock.readable.getReader();
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    return _concat(chunks);
  }

  async _cmd(cmd) {
    await this.ctrlWriter.write(enc.encode(cmd + '\r\n'));
  }

  async _response() {
    let line = await this._line();
    // Multi-line: "NNN-..." until "NNN " with same code
    if (line.length >= 4 && line[3] === '-') {
      const code = line.slice(0, 3);
      while (!(line.startsWith(code) && line[3] === ' ')) {
        line = await this._line();
      }
    }
    return line;
  }

  async _line() {
    while (!this._buf.includes('\r\n')) {
      const { done, value } = await this.ctrlReader.read();
      if (done) throw new Error('FTP control connection closed');
      this._buf += dec.decode(value);
    }
    const idx = this._buf.indexOf('\r\n');
    const line = this._buf.slice(0, idx);
    this._buf = this._buf.slice(idx + 2);
    return line;
  }

  _parseListing(text) {
    const entries = [];
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line) continue;

      // Unix: drwxrwxrwx 1 user group size month day time name
      const unix = line.match(/^([d-])[rwx-]{9}\s+\d+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+(.+)$/);
      if (unix) {
        entries.push({ type: unix[1] === 'd' ? 'd' : 'f', name: unix[3].trim(), size: parseInt(unix[2]) });
        continue;
      }
      // Windows: MM-DD-YY  HH:MMAM  <DIR>  name  or  MM-DD-YY  HH:MMAM  size  name
      const win = line.match(/^\d{2}-\d{2}-\d{2}\s+\d{2}:\d{2}[AP]M\s+(<DIR>|\d+)\s+(.+)$/);
      if (win) {
        entries.push({ type: win[1] === '<DIR>' ? 'd' : 'f', name: win[2].trim(), size: win[1] === '<DIR>' ? 0 : parseInt(win[1]) });
      }
    }
    return entries;
  }
}

function _concat(chunks) {
  const total = chunks.reduce((s, c) => s + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

// -----------------------------------------------------------------------
// High-level: open a persistent FTP connection for burst polling
// -----------------------------------------------------------------------

const DEFAULT_SERIES = ['GTWorldCh', 'GT4'];

/** Open + authenticate. Returns the FtpSession (caller must call .quit()). */
export async function openFtp(config) {
  const { host, port = 21, user, pass } = config;
  const ftp = new FtpSession();
  await ftp.open(host, port);
  await ftp.auth(user, pass);
  return ftp;
}

// -----------------------------------------------------------------------
// Connection probe — figure out which transport the server actually wants
// -----------------------------------------------------------------------

function _readWithTimeout(reader, ms) {
  return Promise.race([
    reader.read(),
    new Promise((_, rej) => setTimeout(() => rej(new Error('read timeout')), ms)),
  ]);
}

async function _probeMode(host, port, opts, label) {
  const result = { mode: label, port };
  let socket;
  try {
    socket = opts ? connect({ hostname: host, port }, opts) : connect({ hostname: host, port });
    const reader = socket.readable.getReader();
    try {
      const { done, value } = await _readWithTimeout(reader, 8000);
      if (done) { result.outcome = 'closed-immediately (no bytes)'; }
      else { result.outcome = 'GOT DATA'; result.welcome = dec.decode(value).slice(0, 120); }
    } catch (e) {
      result.outcome = `read-error: ${e.message}`;
    } finally {
      try { reader.releaseLock(); } catch (_) {}
    }
  } catch (e) {
    result.outcome = `connect-error: ${e.message}`;
  } finally {
    try { socket && socket.close(); } catch (_) {}
  }
  return result;
}

/** Try multiple transports/ports and report how far each gets. */
export async function probeFtp(host) {
  const results = [];
  results.push(await _probeMode(host, 21, null, 'plain-21'));
  results.push(await _probeMode(host, 21, { secureTransport: 'on' }, 'implicit-tls-21'));
  results.push(await _probeMode(host, 990, { secureTransport: 'on' }, 'implicit-tls-990'));
  results.push(await _probeMode(host, 21, { secureTransport: 'starttls' }, 'starttls-handle-21'));
  return results;
}

/**
 * Find the latest active session for EACH series key.
 * Returns Map<seriesKey, { path, label }> — only series with an active session are included.
 * If `diag` is passed, it is filled with the full directory structure for debugging.
 */
export async function findSessionsPerSeries(ftp, root, seriesKeys, diag = null) {
  const byKey = new Map(); // seriesKey -> [{ path, label, eventName }]

  let eventDirs;
  try { eventDirs = (await ftp.list(root)).filter(e => e.type === 'd'); } catch { return new Map(); }

  if (diag) diag.structure = {};

  for (const ev of eventDirs) {
    const evPath = `${root}/${ev.name}`;
    let comps;
    try { comps = (await ftp.list(evPath)).filter(c => c.type === 'd'); } catch { continue; }
    if (diag) diag.structure[ev.name] = {};

    for (const comp of comps) {
      const matchedKey = seriesKeys.find(k => comp.name.includes(k));
      const compPath = `${evPath}/${comp.name}`;
      let sessions;
      try { sessions = (await ftp.list(compPath)).filter(s => s.type === 'd'); } catch { sessions = []; }
      if (diag) diag.structure[ev.name][comp.name] = { matchedKey: matchedKey || '(NO MATCH)', sessions: sessions.map(s => s.name) };

      if (!matchedKey) continue;
      for (const sess of sessions) {
        if (!byKey.has(matchedKey)) byKey.set(matchedKey, []);
        byKey.get(matchedKey).push({
          path: `${compPath}/${sess.name}`,
          label: `${ev.name} › ${comp.name} › ${sess.name}`,
        });
      }
    }
  }

  // For each key: pick the most recent session (latest lexicographic label)
  const result = new Map();
  for (const [key, sessions] of byKey) {
    sessions.sort((a, b) => b.label.localeCompare(a.label));
    result.set(key, sessions[0]);
  }
  return result;
}

/**
 * Check for changed files at a known session path on an already-open FTP connection.
 * Returns { files, newVersions }.
 */
export async function checkFilesForSession(ftp, sessionPath, lastVersions) {
  const newVersions = { ...lastVersions };
  const results = [];

  const entryKey = sessionPath + ':ENTRY_LIST';
  if (!lastVersions[entryKey]) {
    const xml = await downloadLatestZip(ftp, sessionPath, 'ENTRY_LIST');
    if (xml) { newVersions[entryKey] = 'loaded'; results.push({ filename: 'ENTRY_LIST.XML', content: xml }); }
  }

  const resultInfo = await findLatestVersion(ftp, sessionPath, 'RESULT_LIST');
  const resultKey = sessionPath + ':RESULT_LIST';
  if (resultInfo && resultInfo.version !== lastVersions[resultKey]) {
    const xml = await downloadZip(ftp, sessionPath + '/' + resultInfo.name);
    if (xml) { newVersions[resultKey] = resultInfo.version; results.push({ filename: 'RESULT_LIST.XML', content: xml }); }
  }

  const updateInfo = await findLatestVersion(ftp, sessionPath + '/Changes', 'EVENT_LIST_UPDATE');
  const updateKey = sessionPath + ':EVENT_LIST_UPDATE';
  if (updateInfo && updateInfo.version !== lastVersions[updateKey]) {
    const xml = await downloadZip(ftp, sessionPath + '/Changes/' + updateInfo.name);
    if (xml) { newVersions[updateKey] = updateInfo.version; results.push({ filename: 'EVENT_LIST_UPDATE.XML', content: xml }); }
  }

  const totalKey = sessionPath + ':EVENT_LIST_TOTAL';
  if (!lastVersions[totalKey]) {
    const xml = await downloadLatestZip(ftp, sessionPath + '/FullVersion', 'EVENT_LIST_TOTAL');
    if (xml) { newVersions[totalKey] = 'loaded'; results.push({ filename: 'EVENT_LIST_TOTAL.XML', content: xml }); }
  }

  return { files: results, newVersions };
}

async function findLatestSession(ftp, root, seriesPriority) {
  let eventDirs;
  try { eventDirs = (await ftp.list(root)).filter(e => e.type === 'd'); } catch { return null; }

  const allSessions = [];
  for (const ev of eventDirs) {
    const evPath = `${root}/${ev.name}`;
    let comps;
    try { comps = await ftp.list(evPath); } catch { continue; }
    const matching = comps.filter(c => c.type === 'd' && seriesPriority.some(s => c.name.includes(s)));
    for (const comp of matching) {
      const compPath = `${evPath}/${comp.name}`;
      let sessions;
      try { sessions = await ftp.list(compPath); } catch { continue; }
      for (const sess of sessions.filter(s => s.type === 'd')) {
        allSessions.push({
          path: `${compPath}/${sess.name}`,
          label: `${ev.name} › ${comp.name} › ${sess.name}`,
          seriesPriority: seriesPriority.findIndex(s => comp.name.includes(s)),
        });
      }
    }
  }
  if (!allSessions.length) return null;
  allSessions.sort((a, b) => a.seriesPriority - b.seriesPriority);
  return allSessions[0];
}

async function findLatestVersion(ftp, path, prefix) {
  let files;
  try { files = await ftp.list(path); } catch { return null; }
  const matching = files
    .filter(f => f.type === 'f' && f.name.startsWith(prefix) && f.name.endsWith('.ZIP'))
    .map(f => ({ name: f.name, version: parseInt(f.name.match(/V_(\d+)/)?.[1] || '0', 10) }))
    .sort((a, b) => b.version - a.version);
  return matching[0] || null;
}

async function downloadLatestZip(ftp, path, prefix) {
  const info = await findLatestVersion(ftp, path, prefix);
  if (!info) return null;
  return downloadZip(ftp, path + '/' + info.name);
}

async function downloadZip(ftp, remotePath) {
  const raw = await ftp.get(remotePath);
  if (!raw || raw.length === 0) return null;
  return await extractFirstZipEntry(raw);
}

// Minimal ZIP extractor — no external dependency required
// Supports DEFLATE (method 8) and stored (method 0) entries
async function extractFirstZipEntry(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let offset = 0;

  while (offset + 30 < buf.length) {
    const sig = view.getUint32(offset, true);
    if (sig !== 0x04034b50) break; // Local file header signature

    const method = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const fnLen = view.getUint16(offset + 26, true);
    const extraLen = view.getUint16(offset + 28, true);
    const dataOffset = offset + 30 + fnLen + extraLen;

    const compressed = buf.slice(dataOffset, dataOffset + compressedSize);

    if (method === 0) {
      // Stored
      return new TextDecoder().decode(compressed);
    } else if (method === 8) {
      // DEFLATE – use DecompressionStream (available in Workers)
      try {
        const ds = new DecompressionStream('deflate-raw');
        const writer = ds.writable.getWriter();
        const reader = ds.readable.getReader();
        writer.write(compressed);
        writer.close();
        const chunks = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
        return new TextDecoder().decode(_concat(chunks));
      } catch (_) {
        return null;
      }
    }

    offset = dataOffset + compressedSize;
    // Check for data descriptor (bit 3 of flags)
    const flags = view.getUint16(offset + 6, true);
    if (flags & 0x8) offset += 12; // skip data descriptor
  }
  return null;
}
