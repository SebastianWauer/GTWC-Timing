'use strict';

const { formatMs } = require('./xml-parser');

class DataStore {
  constructor() {
    this.cars = new Map();        // nr -> CarRecord
    this.session = {};            // from ENTRY_LIST SESS block
    this.announcements = [];
    this._entryMap = new Map();   // nr -> entry data (from ENTRY_LIST)
    this._listeners = [];
    this._hasEventList = false;   // true once EVENT_LIST_TOTAL loaded
    this._liveSectors = new Map(); // nr -> {s1, s2, drId} — in-progress lap sectors, persists across updates
    this._outLapCars = new Set();  // nr -> currently on out-lap (after PO, before next F)
    this._flagHistory = [];
  }

  reset() {
    this.cars = new Map();
    this.session = {};
    this.announcements = [];
    this._entryMap = new Map();
    this._hasEventList = false;
    this._liveSectors = new Map();
    this._outLapCars = new Set();
    this._flagHistory = [];
  }

  // -----------------------------------------------------------------------
  // Ingest parsed data
  // -----------------------------------------------------------------------

  applyEntryList({ session, entries }) {
    Object.assign(this.session, session);
    this._entryMap = entries;
    // Merge entry data into existing car records
    for (const [nr, entry] of entries) {
      const car = this.cars.get(nr);
      if (car) this._applyEntryToCar(car, entry);
    }
    this._notify('session');
  }

  applyResultList({ results }) {
    const incomingNrs = new Set(
      results.map(r => r.nr).filter(nr => parseInt(nr, 10) < 9000)
    );
    // Remove stale cars not present in this result list (old sessions, virtual entries)
    for (const nr of this.cars.keys()) {
      if (!incomingNrs.has(nr)) this.cars.delete(nr);
    }
    for (const res of results) {
      if (parseInt(res.nr, 10) >= 9000) continue;
      this._upsertFromResult(res);
    }
    this._recomputeClassPositions();
    this._notify('cars');
  }

  applyAnnouncements({ messages }) {
    this.announcements = messages;
    this._notify('announcements');
  }

  // passes = array of PASS records, flags = FLAG records, messages = MSGE records
  // isTotal: true → replace all history; false → merge incremental update
  applyEventList({ passes, flags, messages, isTotal }) {
    if (isTotal) {
      for (const car of this.cars.values()) {
        car.lapHistory = [];
        car._bestSectors = {};
        car._bestSectorsByDriver = {};
        car._bestLapByDriver = {};
        car.pitCount = 0;
        car.tlw = 0;
        car._pitEntryTimeMs = null;
        car._stintStartTimeMs = null;
        car._lastPitDurationMs = null;
      }
      this._liveSectors = new Map();
      this._hasEventList = false;
      this._flagHistory = [];
    }

    // Flag status: use last flag record
    if (flags && flags.length > 0) {
      this.session.flag = flags[flags.length - 1].fl;
      if (isTotal) {
        this._flagHistory = flags.map(f => ({ ...f }));
      } else {
        const seen = new Set(this._flagHistory.map(f => `${f.id}|${f.dt}|${f.fl}|${f.lv}`));
        for (const flag of flags) {
          const key = `${flag.id}|${flag.dt}|${flag.fl}|${flag.lv}`;
          if (!seen.has(key)) {
            this._flagHistory.push({ ...flag });
            seen.add(key);
          }
        }
        this._flagHistory.sort((a, b) => (a.tsMs || 0) - (b.tsMs || 0));
      }
    }

    // Race control messages — total load replaces, incremental updates accumulate
    if (messages && messages.length > 0) {
      if (isTotal) {
        this.announcements = messages.map(m => ({ text: m.me, dt: m.dt, type: m.mt }));
      } else {
        const seen = new Set(this.announcements.map(a => `${a.dt}|${a.text}`));
        for (const m of messages) {
          const key = `${m.dt}|${m.me}`;
          if (!seen.has(key)) {
            this.announcements.push({ text: m.me, dt: m.dt, type: m.mt });
            seen.add(key);
          }
        }
      }
    }

    for (const p of passes) {
      const nr = p.bb;
      if (!nr || !p.st || parseInt(nr, 10) >= 9000) continue;

      const st = p.st;
      const car = this.cars.get(nr);

      // Pit in/out
      if (st === 'PI') {
        if (car) {
          car.inPit = true;
          car.pitCount += 1;
          car._pitEntryTimeMs = p.tsMs || Date.now();
        }
        continue;
      }
      if (st === 'PO') {
        if (car) {
          car.inPit = false;
          if (car._pitEntryTimeMs) {
            car._lastPitDurationMs = (p.tsMs || Date.now()) - car._pitEntryTimeMs;
          }
          car._stintStartTimeMs = p.tsMs || Date.now();
          this._outLapCars.add(nr);
          if (p.dr) {
            const entry = this._entryMap.get(nr);
            const driver = this._resolveEntryDriver(entry, p.dr);
            if (driver) {
              car.activeDriverId = driver.id;
              car.activeDriverName = driver.name;
            }
          }
        }
        continue;
      }

      // Sector passes — LP is only reliable on F (finish) station.
      // _liveSectors stores the last-seen value per sector per car (never cleared mid-session).
      // car.sectors is always rebuilt from _liveSectors so old values persist until replaced.

      if (st === 'I1' && p.it !== null) {
        // First sector time: clear out-lap badge AND act as fallback for missing PO events
        this._outLapCars.delete(nr);
        if (car && car.inPit) car.inPit = false;
        const ls = this._liveSectors.get(nr) || {};
        ls.s1 = p.it; ls.s2 = null; ls.s3 = null; // new lap starts
        if (p.dr) {
          ls.drId = p.dr;
          // Update active driver on every lap start — more reliable than PO alone
          if (car) {
            const entry = this._entryMap.get(nr);
            const driver = this._resolveEntryDriver(entry, p.dr);
            if (driver) {
              car.activeDriverId = driver.id;
              car.activeDriverName = driver.name;
            }
          }
        }
        this._liveSectors.set(nr, ls);
        this._syncSectors(nr);

      } else if (st === 'I2' && p.it !== null) {
        const ls = this._liveSectors.get(nr) || {};
        ls.s2 = p.it; ls.s3 = null;
        this._liveSectors.set(nr, ls);
        this._syncSectors(nr);

      } else if (st === 'I3' && p.it !== null) {
        const ls = this._liveSectors.get(nr) || {};
        ls.s3 = p.it;
        this._liveSectors.set(nr, ls);
        this._syncSectors(nr);

      } else if (st === 'F' && p.lp) {
        this._outLapCars.delete(nr);
        const ls = this._liveSectors.get(nr) || {};
        // I3 may have already set s3; only overwrite if F carries its own sector value
        if (p.it !== null && ls.s3 === null) ls.s3 = p.it;
        this._liveSectors.set(nr, ls);
        this._syncSectors(nr);
        const lapData = { drId: ls.drId || p.dr, s1: ls.s1 ?? null, s2: ls.s2 ?? null, s3: ls.s3 ?? null, lt: p.lt ?? null };
        this._finalizePassLap(nr, p.lp, lapData);
      } else if (!['I1', 'I2', 'I3', 'F'].includes(st)) {
        // Unknown station type — log so we can identify TLW and other codes in live sessions
        console.log(`[ST?] car=${nr} st=${st} id=${p.id} dt=${p.dt} it=${p.it} lp=${p.lp}`);
        // Track Limit Warning candidates: increment tlw if car exists
        if (car && (st === 'TL' || st === 'TW' || st === 'LW' || st === 'WA')) {
          car.tlw += 1;
        }
      }
    }

    // For total loads: seed _liveSectors from the last completed lap so old values persist
    if (isTotal) {
      for (const car of this.cars.values()) {
        if (car.lapHistory.length > 0) {
          const lastLap = car.lapHistory[car.lapHistory.length - 1];
          const ls = this._liveSectors.get(car.nr) || {};
          if (lastLap.sectors.S1) ls.s1 = lastLap.sectors.S1.ms;
          if (lastLap.sectors.S2) ls.s2 = lastLap.sectors.S2.ms;
          if (lastLap.sectors.S3) ls.s3 = lastLap.sectors.S3.ms;
          this._liveSectors.set(car.nr, ls);
          this._syncSectors(car.nr);
        }
      }
    }

    this._hasEventList = true;
    this._recomputeClassPositions();
    this._notify('cars');
  }

  _finalizePassLap(nr, lapNr, pending) {
    const car = this.cars.get(nr);
    if (!car || !pending.lt) return;

    // Skip outlaps / pit laps (>5 min) — no meaningful sector data
    if (pending.lt > 300000) return;

    // Already recorded
    if (car.lapHistory.some(l => l.lapNr === lapNr)) return;

    const sectors = {};
    if (pending.s1 !== null) sectors.S1 = { ms: pending.s1, raw: formatMs(pending.s1) };
    if (pending.s2 !== null) sectors.S2 = { ms: pending.s2, raw: formatMs(pending.s2) };
    if (pending.s3 !== null) sectors.S3 = { ms: pending.s3, raw: formatMs(pending.s3) };

    const lapTime = { ms: pending.lt, raw: formatMs(pending.lt) };

    // Resolve driver from entry list. SRO feeds can mix seat-position style
    // references with entry-list Id values, so we normalize to our internal
    // seat-based driver id and keep matching tolerant here.
    const entry = this._entryMap.get(nr);
    const driver = this._resolveEntryDriver(entry, pending.drId) || entry?.drivers?.[0];
    const driverId = driver?.id || String(pending.drId || '1');
    const driverName = driver?.name || '';

    const lapRecord = { lapNr, driverId, driverName, lapTime, sectors };
    car.lapHistory.push(lapRecord);
    this._updateBests(car, lapRecord);

    // Best lap per driver
    const existing = car._bestLapByDriver[driverId];
    if (!existing || pending.lt < existing.ms) {
      car._bestLapByDriver[driverId] = { ms: pending.lt, lapNr };
    }
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  _syncSectors(nr) {
    const ls = this._liveSectors.get(nr);
    const car = this.cars.get(nr);
    if (!car || !ls) return;
    const s = {};
    if (ls.s1 != null) s.S1 = { ms: ls.s1, raw: formatMs(ls.s1) };
    if (ls.s2 != null) s.S2 = { ms: ls.s2, raw: formatMs(ls.s2) };
    if (ls.s3 != null) s.S3 = { ms: ls.s3, raw: formatMs(ls.s3) };
    car.sectors = s;
  }

  _resolveEntryDriver(entry, driverRef) {
    if (!entry?.drivers?.length) return null;
    const ref = String(driverRef || '').trim();
    if (!ref) return null;

    return entry.drivers.find(driver => driver.id === ref)
      || entry.drivers.find(driver => driver.sourceId && String(driver.sourceId) === ref)
      || entry.drivers.find(driver => driver.seatIndex && String(driver.seatIndex) === ref)
      || entry.drivers[Math.max(0, parseInt(ref, 10) - 1)]
      || null;
  }

  _upsertFromResult(res) {
    const nr = res.nr;
    if (!nr) return;
    // Skip virtual/SC entries: any nr >= 9000, or cars not in entry list once loaded
    if (parseInt(nr, 10) >= 9000) return;
    if (this._entryMap.size > 0 && !this._entryMap.has(nr)) return;

    if (!this.cars.has(nr)) {
      this.cars.set(nr, this._emptyCarRecord(nr));
    }
    const car = this.cars.get(nr);

    // Apply live result fields
    car.pos = res.pos;
    if (res.startPos > 0 && car.startPos === 0) car.startPos = res.startPos;
    car.laps = res.laps;
    car.bestLap = res.bestLap;
    car.bestLapNr = res.bestLapNr;
    car.lastLap = res.lastLap;
    car.gap = res.gap;
    car.gapMs = res.gapMs;
    car.interval = res.interval;
    car.intervalMs = res.intervalMs;
    // inPit / sectors / pit stats: trust EVENT_LIST once loaded — RESULT_LIST has no these fields
    if (!this._hasEventList) {
      car.inPit = res.inPit;
      car.sectors = res.sectors || {};
      car.pitCount = res.pitCount;
      car.tlw = res.tlw;
    }

    // Merge entry if available
    const entry = this._entryMap.get(nr);
    if (entry) this._applyEntryToCar(car, entry);

    // Record lap in history from RESULT_LIST only if EVENT_LIST not yet loaded
    if (!this._hasEventList && res.lastLap?.ms && res.laps > 0) {
      this._recordLap(car, res.laps, res.lastLap);
    }
    // Record best lap per driver — only from RESULT_LIST before EVENT_LIST loads;
    // afterwards EVENT_LIST data is authoritative for driver attribution
    if (!this._hasEventList && res.bestLap?.ms) {
      this._recordBestLap(car, res.bestLapNr, res.bestLap.ms);
    }
  }

  _applyEntryToCar(car, entry) {
    car.className = entry.className || car.className;
    car.vehicle = entry.vehicle || car.vehicle;
    car.manufacturer = entry.manufacturer || car.manufacturer;
    car.team = entry.team || car.team;
    if (entry.drivers?.length) {
      car.drivers = entry.drivers;
      if (!car.activeDriverId) {
        car.activeDriverId = entry.drivers[0]?.id || '';
        car.activeDriverName = entry.drivers[0]?.name || '';
      }
    }
  }

  _emptyCarRecord(nr) {
    return {
      nr,
      pos: 0,
      classPos: 0,
      className: '',
      team: '',
      vehicle: '',
      manufacturer: '',
      drivers: [],
      activeDriverId: '',
      activeDriverName: '',
      laps: 0,
      gap: '-',
      gapMs: 0,
      interval: '-',
      intervalMs: 0,
      lastLap: { raw: '-', ms: null },
      bestLap: { raw: '-', ms: null },
      bestLapNr: 0,
      startPos: 0,
      pitCount: 0,
      inPit: false,
      tlw: 0,
      sectors: {},
      lapHistory: [],
      _bestSectors: {},
      _bestSectorsByDriver: {},
      _bestLapByDriver: {},
      _pitEntryTimeMs: null,    // timestamp of last PI event
      _stintStartTimeMs: null,  // timestamp of last PO event
      _lastPitDurationMs: null, // PI→PO duration of last completed pit stop
    };
  }

  _recomputeClassPositions() {
    // Group by class, sort by pos, assign classPos
    const byClass = {};
    for (const car of this.cars.values()) {
      if (!byClass[car.className]) byClass[car.className] = [];
      byClass[car.className].push(car);
    }
    for (const cls of Object.values(byClass)) {
      cls.sort((a, b) => a.pos - b.pos);
      cls.forEach((car, i) => { car.classPos = i + 1; });
    }
  }

  _recordLap(car, lapNr, lapTime) {
    const exists = car.lapHistory.find(l => l.lapNr === lapNr);
    if (!exists) {
      const lap = {
        lapNr,
        driverId: car.activeDriverId,
        driverName: car.activeDriverName,
        lapTime,
        sectors: { ...car.sectors },
      };
      car.lapHistory.push(lap);
      this._updateBests(car, lap);
    }
  }

  _recordBestLap(car, lapNr, ms) {
    const dId = car.activeDriverId || 'unknown';
    const existing = car._bestLapByDriver[dId];
    if (!existing || ms < existing.ms) {
      car._bestLapByDriver[dId] = { ms, lapNr };
    }
  }

  _updateBests(car, lap) {
    for (const [key, sec] of Object.entries(lap.sectors || {})) {
      if (!sec?.ms) continue;
      const ex = car._bestSectors[key];
      if (!ex || sec.ms < ex.ms) {
        car._bestSectors[key] = { ms: sec.ms, lapNr: lap.lapNr, driverId: lap.driverId };
      }
      if (lap.driverId) {
        if (!car._bestSectorsByDriver[lap.driverId]) car._bestSectorsByDriver[lap.driverId] = {};
        const dEx = car._bestSectorsByDriver[lap.driverId][key];
        if (!dEx || sec.ms < dEx.ms) {
          car._bestSectorsByDriver[lap.driverId][key] = { ms: sec.ms, lapNr: lap.lapNr };
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Snapshot / query
  // -----------------------------------------------------------------------

  getSnapshot(classFilter = null) {
    const sorted = (arr) => arr.sort((a, b) => a.pos - b.pos || a.nr.localeCompare(b.nr, undefined, { numeric: true }));
    const allCars = sorted(Array.from(this.cars.values()));
    const cars = classFilter ? allCars.filter(c => c.className === classFilter) : allCars;

    return {
      cars,
      allCars,                                                     // always unfiltered — for true session bests
      session: this.session,
      announcements: this.announcements,
      classes: this._getClasses(),
      manufacturers: this._getManufacturers(classFilter),
      bestSectors: this._getSessionBestSectors(classFilter),       // class-filtered — for sidebar display
      sessionBestSectors: this._getSessionBestSectors(null),       // always unfiltered — for purple
      theoreticalBest: this._getTheoreticalBest(classFilter),
      outLapCars: this._outLapCars,
      neutralizationPhases: this._getNeutralizationPhases(),
    };
  }

  _getNeutralizationPhases() {
    const history = [...this._flagHistory].sort((a, b) => (a.tsMs || 0) - (b.tsMs || 0));
    const phases = [];
    let current = null;

    for (const flag of history) {
      const type = this._getNeutralizationType(flag.fl);
      const lap = parseInt(flag.lv, 10);
      const lapNr = Number.isFinite(lap) && lap > 0 ? lap : null;

      if (!type) {
        if (current) {
          current.endLap = lapNr ?? current.endLap ?? current.startLap;
          phases.push(this._finalizeNeutralizationPhase(current));
          current = null;
        }
        continue;
      }

      if (!current) {
        if (lapNr == null) continue;
        current = { type, startLap: lapNr, endLap: lapNr };
        continue;
      }

      if (current.type === type) {
        if (lapNr != null) current.endLap = Math.max(current.endLap ?? current.startLap, lapNr);
        continue;
      }

      current.endLap = lapNr ?? current.endLap ?? current.startLap;
      phases.push(this._finalizeNeutralizationPhase(current));
      if (lapNr != null) {
        current = { type, startLap: lapNr, endLap: lapNr };
      } else {
        current = null;
      }
    }

    if (current) phases.push(this._finalizeNeutralizationPhase(current));
    return phases.filter(Boolean);
  }

  _finalizeNeutralizationPhase(phase) {
    if (!phase || phase.startLap == null) return null;
    const endLap = Math.max(phase.startLap, phase.endLap ?? phase.startLap);
    return { type: phase.type, startLap: phase.startLap, endLap };
  }

  _getNeutralizationType(flagValue) {
    const value = String(flagValue || '').toUpperCase().trim();
    if (!value) return null;
    if (value.includes('SC') && !value.includes('VSC')) return 'SC';
    if (value.includes('VSC') || value.includes('FCY') || value.includes('YELLOW')) return 'FCY';
    return null;
  }

  _getClasses() {
    const s = new Set();
    for (const c of this.cars.values()) if (c.className) s.add(c.className);
    return Array.from(s).sort();
  }

  _getManufacturers(classFilter) {
    const data = {};
    for (const car of this.cars.values()) {
      if (classFilter && car.className !== classFilter) continue;
      const make = car.manufacturer || 'Unknown';
      if (!data[make]) data[make] = { count: 0, bestPos: Infinity, bestNr: '' };
      data[make].count += 1;
      const pos = classFilter ? car.classPos : car.pos;
      if (pos > 0 && pos < data[make].bestPos) {
        data[make].bestPos = pos;
        data[make].bestNr = car.nr;
      }
    }
    for (const v of Object.values(data)) {
      if (v.bestPos === Infinity) v.bestPos = null;
    }
    return data;
  }

  _getSessionBestSectors(classFilter) {
    const best = {};
    for (const car of this.cars.values()) {
      if (classFilter && car.className !== classFilter) continue;
      for (const [key, sec] of Object.entries(car._bestSectors)) {
        if (!sec?.ms) continue;
        if (!best[key] || sec.ms < best[key].ms) {
          best[key] = { ms: sec.ms, carNr: car.nr, driverId: sec.driverId };
        }
      }
    }
    return best;
  }

  _getTheoreticalBest(classFilter) {
    const bests = this._getSessionBestSectors(classFilter);
    const keys = Object.keys(bests).sort();
    if (!keys.length) return null;
    let total = 0;
    for (const k of keys) {
      if (!bests[k]?.ms) return null;
      total += bests[k].ms;
    }
    return { ms: total, sectors: bests };
  }

  on(event, fn) { this._listeners.push({ event, fn }); }

  _notify(event) {
    for (const l of this._listeners) {
      if (l.event === event || l.event === '*') l.fn(event);
    }
  }
}

module.exports = { DataStore };
