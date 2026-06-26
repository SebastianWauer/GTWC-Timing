'use strict';

import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: true,
  trimValues: true,
  isArray: (name) => ['ENTR', 'RES', 'PASS', 'FLAG', 'MSGE'].includes(name),
});

export function formatMs(ms) {
  if (ms === null || ms === undefined || ms < 0) return '-';
  const totalSec = Math.floor(ms / 1000);
  const msRem = ms % 1000;
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  if (minutes > 0) {
    return `${minutes}:${String(seconds).padStart(2, '0')}.${String(msRem).padStart(3, '0')}`;
  }
  return `${seconds}.${String(msRem).padStart(3, '0')}`;
}

export function formatGap(ms) {
  if (!ms || ms === 0) return '-';
  const sec = Math.floor(ms / 1000);
  const rem = ms % 1000;
  if (sec >= 60) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `+${m}:${String(s).padStart(2, '0')}.${String(rem).padStart(3, '0')}`;
  }
  return `+${sec}.${String(rem).padStart(3, '0')}`;
}

export function parseTimeToMs(raw) {
  if (!raw || raw === '-' || raw === '') return null;
  const s = String(raw).trim();
  const mMatch = s.match(/^(\d+):(\d{2})\.(\d{1,3})$/);
  if (mMatch) {
    return (parseInt(mMatch[1], 10) * 60 + parseInt(mMatch[2], 10)) * 1000
      + parseInt(mMatch[3].padEnd(3, '0'), 10);
  }
  const sMatch = s.match(/^(\d+)\.(\d{1,3})$/);
  if (sMatch) {
    return parseInt(sMatch[1], 10) * 1000 + parseInt(sMatch[2].padEnd(3, '0'), 10);
  }
  const n = parseInt(s, 10);
  if (!isNaN(n)) return n;
  return null;
}

function intVal(v, fallback = 0) {
  const n = parseInt(v, 10);
  return isNaN(n) ? fallback : n;
}

function strVal(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

const MAKES = [
  'Aston Martin', 'Mercedes-AMG', 'Lamborghini', 'Rolls-Royce',
  'Porsche', 'Ferrari', 'McLaren', 'Bentley', 'BMW', 'Audi',
  'Nissan', 'Honda', 'Lexus', 'Acura', 'Ford', 'Chevrolet',
  'Dodge', 'Cadillac', 'Ginetta', 'Lotus', 'Alpine', 'Renault',
];

function extractMake(carName) {
  if (!carName) return 'Unknown';
  for (const make of MAKES) {
    if (carName.startsWith(make)) return make;
  }
  return carName.split(' ')[0];
}

export function parseEntryListXml(xmlStr) {
  let doc;
  try { doc = parser.parse(xmlStr); } catch { return { session: {}, entries: new Map() }; }

  const file = doc?.FILE || doc;
  const sessNode = file?.SESS || {};
  const startTimeStr = strVal(sessNode.StartTime);
  let startTimeMs = null;
  const stm = startTimeStr.match(/(\d+)\.(\d+)\.(\d+) (\d+):(\d+):(\d+)/);
  if (stm) {
    startTimeMs = new Date(`${stm[3]}-${stm[2]}-${stm[1]}T${stm[4]}:${stm[5]}:${stm[6]}Z`).getTime();
  }
  const session = {
    type: 'runInfo',
    sessionName: strVal(sessNode.Session),
    competition: strVal(sessNode.Competition),
    meeting: strVal(sessNode.Meeting),
    trackName: strVal(sessNode.Track),
    startTime: startTimeStr,
    startTimeMs,
    flag: 'CHEQUERED',
  };

  const rawEntries = Array.isArray(file?.ENTR) ? file.ENTR : [];
  const entries = new Map();

  for (const e of rawEntries) {
    const bib = strVal(e.Bib);
    if (!bib) continue;

    const drivers = [];
    for (let i = 1; i <= 4; i++) {
      const d = e[`Driver${i}`];
      if (!d) continue;
      const first = strVal(d.First);
      const last = strVal(d.Last);
      if (!first && !last) continue;
      const sourceId = strVal(d.Id) || String(i);
      drivers.push({
        id: sourceId,
        sourceId,
        seatIndex: String(i),
        name: `${first} ${last}`.trim(),
        short: strVal(d.Short),
        country: strVal(d.Country),
      });
    }

    entries.set(bib, {
      nr: bib,
      className: strVal(e.Class),
      vehicle: strVal(e.Car),
      manufacturer: extractMake(strVal(e.Car)),
      team: strVal(e.Team),
      drivers,
    });
  }

  return { session, entries };
}

export function parseResultListXml(xmlStr) {
  let doc;
  try { doc = parser.parse(xmlStr); } catch { return []; }

  const file = doc?.FILE || doc;
  const rawRes = Array.isArray(file?.RES) ? file.RES : [];

  return rawRes.map(r => {
    const bestMs = intVal(r.BestTime, 0) || intVal(r.Time, 0);
    const lastMs = intVal(r.LastTime, 0);
    const gapMs = intVal(r.Gap, 0);
    const diffMs = intVal(r.Diff, 0);

    return {
      nr: strVal(r.Bib),
      pos: intVal(r.Pos),
      classPos: intVal(r.Pos),
      rank: intVal(r.Rank),
      startPos: intVal(r.StartPos),
      laps: intVal(r.Laps),
      bestLap: {
        ms: bestMs > 0 ? bestMs : null,
        raw: bestMs > 0 ? formatMs(bestMs) : '-',
      },
      bestLapNr: intVal(r.BestLap),
      lastLap: {
        ms: lastMs > 0 ? lastMs : null,
        raw: lastMs > 0 ? formatMs(lastMs) : '-',
      },
      gap: gapMs === 0 ? '-' : formatGap(gapMs),
      gapMs,
      interval: diffMs === 0 ? '-' : formatGap(diffMs),
      intervalMs: diffMs,
      inPit: false,
      pitCount: intVal(r.PitCount) || intVal(r.Pit) || 0,
      pitTime: '-',
      stintTime: '-',
      tlw: intVal(r.TLW) || intVal(r.Warning) || intVal(r.Warnings) || intVal(r.TrackLimitWarning) || 0,
      sectors: {},
    };
  });
}

function parseDt(dtStr) {
  if (!dtStr) return 0;
  const m = dtStr.match(/(\d+)\.(\d+)\.(\d+) (\d+):(\d+):(\d+)\.(\d+)/);
  if (!m) return 0;
  return new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z`).getTime();
}

export function parseEventListXml(xmlStr) {
  let doc;
  try { doc = parser.parse(xmlStr); } catch { return { passes: [], flags: [], messages: [] }; }

  const file = doc?.FILE || doc;

  const passes = (Array.isArray(file?.PASS) ? file.PASS : []).map(p => ({
    id:  strVal(p.ID),
    dt:  strVal(p.DT),
    tsMs: parseDt(strVal(p.DT)),
    bb:  strVal(p.BB),
    lp:  intVal(p.LP),
    st:  strVal(p.ST),
    it:  (p.IT !== undefined && p.IT !== '') ? intVal(p.IT) : null,
    lt:  (p.LT !== undefined && p.LT !== '') ? intVal(p.LT) : null,
    dr:  strVal(p.DR),
  }));

  const rawFlags = Array.isArray(file?.FLAG) ? file.FLAG : [];
  const flags = rawFlags.map(f => ({
    id: strVal(f.ID),
    dt: strVal(f.DT),
    tsMs: parseDt(strVal(f.DT)),
    fl: strVal(f.FL),
    lv: strVal(f.LV),
  }));

  const messages = (Array.isArray(file?.MSGE) ? file.MSGE : []).map(m => ({
    id: strVal(m.ID),
    dt: strVal(m.DT),
    me: strVal(m.ME),
    mt: strVal(m.MT),
  }));

  return { passes, flags, messages };
}

export function parseXml(filename, content) {
  if (filename === 'ENTRY_LIST.XML') {
    const { session, entries } = parseEntryListXml(content);
    return { type: 'entryList', session, entries };
  }
  if (filename === 'RESULT_LIST.XML') {
    const results = parseResultListXml(content);
    return { type: 'resultList', results };
  }
  if (filename === 'EVENT_LIST_TOTAL.XML') {
    return { type: 'eventListTotal', ...parseEventListXml(content) };
  }
  if (filename === 'EVENT_LIST_UPDATE.XML') {
    return { type: 'eventListUpdate', ...parseEventListXml(content) };
  }
  return null;
}
