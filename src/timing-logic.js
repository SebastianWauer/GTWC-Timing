'use strict';

const { formatMs } = require('./xml-parser');

/** Format elapsed ms as M:SS (no milliseconds — for stint display) */
function formatDuration(ms) {
  if (!ms || ms < 0) return '-';
  const totalSec = Math.round(ms / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Format elapsed ms as M:SS.t (with tenths — for pit time display) */
function formatDurationTenths(ms) {
  if (!ms || ms < 0) return '-';
  const totalTenths = Math.floor(ms / 100);
  const tenths = totalTenths % 10;
  const totalSec = Math.floor(totalTenths / 10);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}.${tenths}`;
}

// -----------------------------------------------------------------------
// Class badge colours (README §3.1)
// -----------------------------------------------------------------------
// README §3.1 — also maps SRO real names ("Pro Cup", "Gold Cup", etc.)
const CLASS_COLORS = {
  // Canonical keys (README)
  PRO:    { bg: '#ffffff', text: '#000000', label: 'PRO' },
  GOLD:   { bg: '#d4a017', text: '#000000', label: 'GOLD' },
  SILVER: { bg: '#3a6bbf', text: '#ffffff', label: 'SILVER' },
  BRONZE: { bg: '#7b4f2e', text: '#ffffff', label: 'BRONZE' },
  'PRO-AM': { bg: '#2d7a3a', text: '#ffffff', label: 'PRO-AM' },
  AM:       { bg: '#7b4f2e', text: '#ffffff', label: 'AM' },
  // SRO actual class names
  'PRO CUP':    { bg: '#ffffff', text: '#000000', label: 'PRO' },
  'GOLD CUP':   { bg: '#d4a017', text: '#000000', label: 'GOLD' },
  'SILVER CUP': { bg: '#3a6bbf', text: '#ffffff', label: 'SILVER' },
  'BRONZE CUP': { bg: '#7b4f2e', text: '#ffffff', label: 'BRONZE' },
  'PRO-AM CUP': { bg: '#2d7a3a', text: '#ffffff', label: 'PRO-AM' },
  'PROAM CUP':  { bg: '#2d7a3a', text: '#ffffff', label: 'PRO-AM' },
  'AM CUP':     { bg: '#7b4f2e', text: '#ffffff', label: 'AM' },
};

function getClassColor(className) {
  if (!className) return { bg: '#444', text: '#fff', label: '?' };
  const key = String(className).toUpperCase().trim();
  return CLASS_COLORS[key] || { bg: '#444', text: '#fff', label: className };
}

// -----------------------------------------------------------------------
// Sector / lap colour classification (README §3.2)
// Returns one of: 'purple'|'blue'|'green'|'yellow'|null
// Caller checks in priority order: overall > class > car > driver
// -----------------------------------------------------------------------

/**
 * Classify a sector/lap time cell colour.
 *
 * @param {number|null} timeMs         - The time to classify (ms)
 * @param {number|null} driverBestMs   - Personal best of active driver (ms)
 * @param {number|null} carBestMs      - Best across all drivers on this car (ms)
 * @param {number|null} classBestMs    - Best in class (ms)
 * @param {number|null} overallBestMs  - Overall session best (ms)
 * @returns {'purple'|'blue'|'green'|'yellow'|null}
 */
function classifyTimeColor(timeMs, driverBestMs, carBestMs, classBestMs, overallBestMs) {
  if (timeMs === null || timeMs === undefined) return null;
  if (overallBestMs !== null && overallBestMs !== undefined && timeMs <= overallBestMs) return 'purple';
  if (classBestMs !== null && classBestMs !== undefined && timeMs <= classBestMs) return 'blue';
  if (carBestMs !== null && carBestMs !== undefined && timeMs <= carBestMs) return 'green';
  if (driverBestMs !== null && driverBestMs !== undefined && timeMs <= driverBestMs) return 'yellow';
  return null;
}

// -----------------------------------------------------------------------
// Gap / Interval calculation (class-aware)
// -----------------------------------------------------------------------

/**
 * Recompute Gap and Interval for all cars in the given (optionally filtered) list.
 * Mutates each car's computedGap / computedInterval.
 * Based on lap count and last lap time delta.
 */
function computeGapInterval(cars, classFilter) {
  // Initialize all cars with their raw feed values
  for (const car of cars) {
    car.computedGap = car.gap !== undefined ? car.gap : '-';
    car.computedInterval = car.interval !== undefined ? car.interval : '-';
  }

  // For the class-filtered subset, the class leader always gets '-'
  const workingList = classFilter
    ? cars.filter(c => c.className === classFilter)
    : cars;
  const sorted = [...workingList].sort((a, b) => a.pos - b.pos);

  if (sorted.length > 0) {
    sorted[0].computedGap = '-';
    sorted[0].computedInterval = '-';
  }
}

// -----------------------------------------------------------------------
// Build a rich "view model" snapshot for the frontend
// (includes computed colour indices per cell)
// -----------------------------------------------------------------------

function buildViewModel(snapshot, classFilter) {
  const { cars, allCars, session, announcements, classes, manufacturers, bestSectors, sessionBestSectors, theoreticalBest, outLapCars, neutralizationPhases } = snapshot;

  // True session-wide bests (all classes) — used for purple
  const overallSectorBests = {};
  for (const [key, sec] of Object.entries(sessionBestSectors || bestSectors || {})) {
    overallSectorBests[key] = sec.ms;
  }

  // Per-class bests computed from ALL cars (for blue — each car vs its own class)
  const carsForOverall = allCars || cars;
  const classBestLapByClass = {};
  const classSectorBestsByClass = {};
  for (const car of carsForOverall) {
    const cls = car.className;
    if (car.bestLap?.ms != null) {
      if (!classBestLapByClass[cls] || car.bestLap.ms < classBestLapByClass[cls]) {
        classBestLapByClass[cls] = car.bestLap.ms;
      }
    }
    if (!classSectorBestsByClass[cls]) classSectorBestsByClass[cls] = {};
    for (const [key, sec] of Object.entries(car._bestSectors || {})) {
      if (sec.ms != null) {
        const cur = classSectorBestsByClass[cls][key];
        if (!cur || sec.ms < cur) classSectorBestsByClass[cls][key] = sec.ms;
      }
    }
  }

  // Fold current live sectors of every car into the bests so that only the
  // real-time fastest car gets purple/blue — not all who beat the old finalized best.
  // (_bestSectors only updates on lap completion, so without this two cars can both
  // appear purple while both are ahead of the previous finalized best.)
  for (const car of carsForOverall) {
    const cls = car.className;
    for (const [key, sec] of Object.entries(car.sectors || {})) {
      if (sec?.ms == null) continue;
      if (overallSectorBests[key] == null || sec.ms < overallSectorBests[key]) {
        overallSectorBests[key] = sec.ms;
      }
      if (!classSectorBestsByClass[cls]) classSectorBestsByClass[cls] = {};
      const cur = classSectorBestsByClass[cls][key];
      if (cur == null || sec.ms < cur) classSectorBestsByClass[cls][key] = sec.ms;
    }
  }

  // Overall best lap across ALL classes (purple)
  let overallBestLap = null;
  for (const car of carsForOverall) {
    if (car.bestLap?.ms != null && (overallBestLap === null || car.bestLap.ms < overallBestLap)) {
      overallBestLap = car.bestLap.ms;
    }
  }

  const classCars = classFilter ? cars.filter(c => c.className === classFilter) : cars;
  computeGapInterval(cars, classFilter);

  const now = Date.now();

  const carViews = classCars.map(car => {
    const carBestLap      = car.bestLap?.ms ?? null;
    const driverBestLap   = car._bestLapByDriver?.[car.activeDriverId]?.ms ?? null;
    const carClassBestLap = classBestLapByClass[car.className] ?? null;
    const carClassSectors = classSectorBestsByClass[car.className] ?? {};

    // Colour for bestLap cell
    const bestLapColor = classifyTimeColor(
      carBestLap, driverBestLap, carBestLap, carClassBestLap, overallBestLap
    );

    // Colour for lastLap cell
    const lastLapColor = classifyTimeColor(
      car.lastLap?.ms, driverBestLap, carBestLap, carClassBestLap, overallBestLap
    );

    // Sector colours for current live sectors
    const sectorViews = {};
    const sectorKeys = Object.keys(car.sectors || {}).sort();
    for (const key of sectorKeys) {
      const sec = car.sectors[key];
      const carSectorBest    = car._bestSectors?.[key]?.ms ?? null;
      const driverSectorBest = car._bestSectorsByDriver?.[car.activeDriverId]?.[key]?.ms ?? null;
      const color = classifyTimeColor(
        sec.ms,
        driverSectorBest,
        carSectorBest,
        carClassSectors[key] ?? null,
        overallSectorBests[key] ?? null
      );
      sectorViews[key] = { raw: sec.raw, ms: sec.ms, color };
    }

    // Fastest driver for this car (lowest best-lap ms)
    const blEntries = Object.entries(car._bestLapByDriver || {});
    const fastestDriverId = blEntries.length > 0
      ? blEntries.reduce((best, curr) => curr[1].ms < best[1].ms ? curr : best)[0]
      : null;

    // Lap counts per driver (from finalized lap history)
    const lapsByDriver = {};
    for (const lap of car.lapHistory || []) {
      if (lap.driverId) lapsByDriver[lap.driverId] = (lapsByDriver[lap.driverId] || 0) + 1;
    }

    return {
      nr: car.nr,
      pos: car.pos,
      posChange: (car.startPos > 0 && car.pos > 0) ? car.startPos - car.pos : null,
      classPos: car.classPos,
      className: car.className,
      classColor: getClassColor(car.className),
      activeDriverId: car.activeDriverId,
      activeDriverName: car.activeDriverName,
      drivers: car.drivers,
      fastestDriverId,
      lapsByDriver,
      team: car.team,
      vehicle: car.vehicle,
      manufacturer: car.manufacturer,
      laps: car.laps,
      gap: car.computedGap ?? car.gap,
      interval: car.computedInterval ?? car.interval,
      isOnOutLap: outLapCars ? outLapCars.has(car.nr) : false,
      lastLap: { raw: car.lastLap?.raw, ms: car.lastLap?.ms, color: lastLapColor },
      bestLap: { raw: car.bestLap?.raw, ms: car.bestLap?.ms, color: bestLapColor },
      bestLapNr: car.bestLapNr,
      pitTime: car.inPit && car._pitEntryTimeMs
        ? formatDurationTenths(now - car._pitEntryTimeMs)
        : (car._lastPitDurationMs ? formatDurationTenths(car._lastPitDurationMs) : '-'),
      pitCount: car.pitCount,
      inPit: car.inPit,
      stintTime: car.inPit && car._pitEntryTimeMs && car._stintStartTimeMs
        ? formatDuration(car._pitEntryTimeMs - car._stintStartTimeMs)
        : (!car.inPit && car._stintStartTimeMs ? formatDuration(now - car._stintStartTimeMs) : '-'),
      tlw: car.tlw,
      sectors: sectorViews,
      classBestLap: carClassBestLap,
      classSectorBests: carClassSectors,
      lapHistory: car.lapHistory,
      bestLapByDriver: car._bestLapByDriver,
      bestSectorsByKey: car._bestSectors,
      bestSectorsByDriver: car._bestSectorsByDriver,
    };
  });

  return {
    cars: carViews,
    session,
    announcements,
    neutralizationPhases,
    classes,
    activeClass: classFilter,
    manufacturers,
    overallBestLap,
    overallSectorBests,
    bestSectors: Object.entries(bestSectors || {}).map(([key, sec]) => ({
      key,
      ms: sec.ms,
      formatted: formatMs(sec.ms),
      carNr: sec.carNr,
      driverId: sec.driverId,
    })).sort((a, b) => a.key.localeCompare(b.key)),
    theoreticalBest: theoreticalBest
      ? { ms: theoreticalBest.ms, formatted: formatMs(theoreticalBest.ms) }
      : null,
  };
}

module.exports = { getClassColor, classifyTimeColor, computeGapInterval, buildViewModel, CLASS_COLORS, formatMs };
