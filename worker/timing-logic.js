'use strict';

import { formatMs } from './xml-parser.js';

function formatDuration(ms) {
  if (!ms || ms < 0) return '-';
  const totalSec = Math.round(ms / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatDurationTenths(ms) {
  if (!ms || ms < 0) return '-';
  const totalTenths = Math.floor(ms / 100);
  const tenths = totalTenths % 10;
  const totalSec = Math.floor(totalTenths / 10);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}.${tenths}`;
}

export const CLASS_COLORS = {
  PRO:    { bg: '#ffffff', text: '#000000', label: 'PRO' },
  GOLD:   { bg: '#d4a017', text: '#000000', label: 'GOLD' },
  SILVER: { bg: '#3a6bbf', text: '#ffffff', label: 'SILVER' },
  BRONZE: { bg: '#7b4f2e', text: '#ffffff', label: 'BRONZE' },
  'PRO-AM': { bg: '#2d7a3a', text: '#ffffff', label: 'PRO-AM' },
  AM:       { bg: '#7b4f2e', text: '#ffffff', label: 'AM' },
  'PRO CUP':    { bg: '#ffffff', text: '#000000', label: 'PRO' },
  'GOLD CUP':   { bg: '#d4a017', text: '#000000', label: 'GOLD' },
  'SILVER CUP': { bg: '#3a6bbf', text: '#ffffff', label: 'SILVER' },
  'BRONZE CUP': { bg: '#7b4f2e', text: '#ffffff', label: 'BRONZE' },
  'PRO-AM CUP': { bg: '#2d7a3a', text: '#ffffff', label: 'PRO-AM' },
  'PROAM CUP':  { bg: '#2d7a3a', text: '#ffffff', label: 'PRO-AM' },
  'AM CUP':     { bg: '#7b4f2e', text: '#ffffff', label: 'AM' },
};

export function getClassColor(className) {
  if (!className) return { bg: '#444', text: '#fff', label: '?' };
  const key = String(className).toUpperCase().trim();
  return CLASS_COLORS[key] || { bg: '#444', text: '#fff', label: className };
}

export function classifyTimeColor(timeMs, driverBestMs, carBestMs, classBestMs, overallBestMs) {
  if (timeMs === null || timeMs === undefined) return null;
  if (overallBestMs !== null && overallBestMs !== undefined && timeMs <= overallBestMs) return 'purple';
  if (classBestMs !== null && classBestMs !== undefined && timeMs <= classBestMs) return 'blue';
  if (carBestMs !== null && carBestMs !== undefined && timeMs <= carBestMs) return 'green';
  if (driverBestMs !== null && driverBestMs !== undefined && timeMs <= driverBestMs) return 'yellow';
  return null;
}

export function computeGapInterval(cars, classFilter) {
  for (const car of cars) {
    // When a class is selected, prefer class-relative gap/interval if available.
    const gap = classFilter && car.classGap !== undefined ? car.classGap : car.gap;
    const interval = classFilter && car.classInterval !== undefined ? car.classInterval : car.interval;
    car.computedGap = gap !== undefined ? gap : '-';
    car.computedInterval = interval !== undefined ? interval : '-';
  }

  const workingList = classFilter
    ? cars.filter(c => c.className === classFilter)
    : cars;
  const sorted = [...workingList].sort((a, b) => a.pos - b.pos);

  if (sorted.length > 0) {
    sorted[0].computedGap = '-';
    sorted[0].computedInterval = '-';
  }
}

export function buildViewModel(snapshot, classFilter) {
  const { cars, allCars, session, announcements, classes, manufacturers, bestSectors, sessionBestSectors, theoreticalBest, outLapCars, neutralizationPhases } = snapshot;

  const overallSectorBests = {};
  for (const [key, sec] of Object.entries(sessionBestSectors || bestSectors || {})) {
    overallSectorBests[key] = sec.ms;
  }

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

    const bestLapColor = classifyTimeColor(
      carBestLap, driverBestLap, carBestLap, carClassBestLap, overallBestLap
    );

    const lastLapColor = classifyTimeColor(
      car.lastLap?.ms, driverBestLap, carBestLap, carClassBestLap, overallBestLap
    );

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

    const blEntries = Object.entries(car._bestLapByDriver || {});
    const fastestDriverId = blEntries.length > 0
      ? blEntries.reduce((best, curr) => curr[1].ms < best[1].ms ? curr : best)[0]
      : null;

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
      statusLabel: car.statusLabel || null,
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
