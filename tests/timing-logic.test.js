'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { computeGapInterval, buildViewModel } = require('../src/timing-logic');
const { DataStore } = require('../src/data-store');

// -----------------------------------------------------------------------
// Classenfilter – Gap/Int muss auf Klassenbasis berechnet werden
// -----------------------------------------------------------------------

function makeCar(nr, className, pos, gap, interval) {
  return {
    nr, className, pos, gap, interval,
    classPos: pos,
    bestLap: { raw: '-', ms: null },
    lastLap: { raw: '-', ms: null },
    sectors: {},
    _bestSectors: {},
    _bestLapByDriver: {},
    drivers: [],
    activeDriverId: '',
    activeDriverName: '',
    inPit: false,
    lapHistory: [],
  };
}

test('computeGapInterval: leader has dash gaps', () => {
  const cars = [
    makeCar('7', 'PRO', 1, '-', '-'),
    makeCar('11', 'PRO', 2, '+0.5', '+0.5'),
  ];
  computeGapInterval(cars, null);
  assert.equal(cars[0].computedGap, '-');
  assert.equal(cars[0].computedInterval, '-');
});

test('computeGapInterval: follower preserves raw gap from feed', () => {
  const cars = [
    makeCar('7', 'PRO', 1, '-', '-'),
    makeCar('11', 'PRO', 2, '+1.2', '+1.2'),
  ];
  computeGapInterval(cars, null);
  assert.equal(cars[1].computedGap, '+1.2');
});

test('computeGapInterval: with classFilter only processes filtered class', () => {
  const cars = [
    makeCar('1', 'PRO', 1, '-', '-'),
    makeCar('2', 'GOLD', 2, '+10.0', '+10.0'),
    makeCar('3', 'PRO', 3, '+2.0', '+2.0'),
  ];
  computeGapInterval(cars, 'PRO');
  // Car #1 is class leader
  assert.equal(cars[0].computedGap, '-');
  // Car #3 is second in PRO class
  assert.equal(cars[2].computedGap, '+2.0');
  // Car #2 (GOLD) not in filter – should be unchanged
  assert.equal(cars[1].computedGap, '+10.0');
});

// -----------------------------------------------------------------------
// DataStore + class filter integration
// -----------------------------------------------------------------------
function loadTestCars(store) {
  // entry list
  store.applyEntryList({ session: {}, entries: new Map([
    ['1', { className: 'Pro Cup',  vehicle: 'BMW M4',        manufacturer: 'BMW',     team: 'Team A', drivers: [{ id: 'd1', name: 'Driver A', short: 'DA', country: 'DE' }] }],
    ['2', { className: 'Pro Cup',  vehicle: 'Ferrari 296',   manufacturer: 'Ferrari', team: 'Team B', drivers: [{ id: 'd2', name: 'Driver B', short: 'DB', country: 'IT' }] }],
    ['3', { className: 'Gold Cup', vehicle: 'Porsche 911',   manufacturer: 'Porsche', team: 'Team C', drivers: [{ id: 'd3', name: 'Driver C', short: 'DC', country: 'DE' }] }],
  ]) });
  // result list
  store.applyResultList({ results: [
    { nr: '1', pos: 1, laps: 5, bestLap: { ms: 100000, raw: '1:40.000' }, bestLapNr: 3, lastLap: { ms: 101000, raw: '1:41.000' }, gap: '-', gapMs: 0, interval: '-', intervalMs: 0, inPit: false, pitCount: 0, pitTime: '-', stintTime: '-', tlw: 0, sectors: {} },
    { nr: '2', pos: 2, laps: 5, bestLap: { ms: 100500, raw: '1:40.500' }, bestLapNr: 2, lastLap: { ms: 101000, raw: '1:41.000' }, gap: '+0.500', gapMs: 500, interval: '+0.500', intervalMs: 500, inPit: false, pitCount: 0, pitTime: '-', stintTime: '-', tlw: 0, sectors: {} },
    { nr: '3', pos: 3, laps: 4, bestLap: { ms: 105000, raw: '1:45.000' }, bestLapNr: 1, lastLap: { ms: 106000, raw: '1:46.000' }, gap: '+5.000', gapMs: 5000, interval: '+5.000', intervalMs: 5000, inPit: false, pitCount: 0, pitTime: '-', stintTime: '-', tlw: 0, sectors: {} },
  ] });
}

test('DataStore: manufacturer count filtered by class', () => {
  const store = new DataStore();
  loadTestCars(store);

  const snapAll = store.getSnapshot(null);
  assert.equal(Object.keys(snapAll.manufacturers).length, 3);

  const snapPro = store.getSnapshot('Pro Cup');
  assert.equal(Object.keys(snapPro.manufacturers).length, 2);
  assert.ok(snapPro.manufacturers['BMW']);
  assert.ok(snapPro.manufacturers['Ferrari']);
  assert.equal(snapPro.manufacturers['Porsche'], undefined);
});

test('DataStore: classes list always complete regardless of filter', () => {
  const store = new DataStore();
  loadTestCars(store);
  const snap = store.getSnapshot('Pro Cup');
  assert.ok(snap.classes.includes('Pro Cup'));
  assert.ok(snap.classes.includes('Gold Cup'));
});

// -----------------------------------------------------------------------
// Theoretical best time
// -----------------------------------------------------------------------
test('DataStore: theoretical best is sum of best sectors', () => {
  const store = new DataStore();
  // Manually insert lap history with sector times
  store.applyEntryList({ session: {}, entries: new Map([
    ['7', { className: 'Pro Cup', vehicle: 'BMW M4', manufacturer: 'BMW', team: 'T', drivers: [{ id: 'd1', name: 'A', short: 'A', country: 'DE' }] }],
  ]) });
  store.applyResultList({ results: [
    { nr: '7', pos: 1, laps: 2, bestLap: { ms: 107000, raw: '1:47.000' }, bestLapNr: 2, lastLap: { ms: 108000, raw: '1:48.000' }, gap: '-', gapMs: 0, interval: '-', intervalMs: 0, inPit: false, pitCount: 0, pitTime: '-', stintTime: '-', tlw: 0, sectors: {} },
  ] });

  // Manually add lap history with sectors
  const car = store.cars.get('7');
  car.lapHistory = [
    { lapNr: 1, driverId: 'd1', driverName: 'A', lapTime: { ms: 108000, raw: '1:48.000' }, sectors: { S1: { ms: 35000 }, S2: { ms: 43000 }, S3: { ms: 30000 } } },
    { lapNr: 2, driverId: 'd1', driverName: 'A', lapTime: { ms: 107000, raw: '1:47.000' }, sectors: { S1: { ms: 34000 }, S2: { ms: 43000 }, S3: { ms: 30000 } } },
  ];
  car._bestSectors = { S1: { ms: 34000, lapNr: 2, driverId: 'd1' }, S2: { ms: 43000, lapNr: 1, driverId: 'd1' }, S3: { ms: 30000, lapNr: 1, driverId: 'd1' } };

  const snap = store.getSnapshot(null);
  assert.ok(snap.theoreticalBest);
  assert.equal(snap.theoreticalBest.ms, 34000 + 43000 + 30000);
});

test('DataStore: event driver refs map to normalized seat ids', () => {
  const store = new DataStore();
  store.applyEntryList({ session: {}, entries: new Map([
    ['51', {
      className: 'Pro Cup',
      vehicle: 'Ferrari 296',
      manufacturer: 'Ferrari',
      team: 'AF Corse',
      drivers: [
        { id: '2', sourceId: '2', seatIndex: '1', name: 'Alessio Rovera', short: 'ROV', country: 'ITA' },
        { id: '3', sourceId: '3', seatIndex: '2', name: 'Tommaso Mosca', short: 'MOS', country: 'ITA' },
        { id: '4', sourceId: '4', seatIndex: '3', name: 'Nicklas Nielsen', short: 'NNI', country: 'DEN' },
      ],
    }],
  ]) });
  store.applyResultList({ results: [
    { nr: '51', pos: 1, laps: 2, bestLap: { ms: 137000, raw: '2:17.000' }, bestLapNr: 2, lastLap: { ms: 138000, raw: '2:18.000' }, gap: '-', gapMs: 0, interval: '-', intervalMs: 0, inPit: false, pitCount: 0, pitTime: '-', stintTime: '-', tlw: 0, sectors: {} },
  ] });

  store.applyEventList({
    isTotal: true,
    flags: [],
    messages: [],
    passes: [
      { bb: '51', st: 'I1', it: 39000, lp: 2, lt: null, dr: '2', tsMs: 1 },
      { bb: '51', st: 'I2', it: 62000, lp: 2, lt: null, dr: '2', tsMs: 2 },
      { bb: '51', st: 'I3', it: 35000, lp: 2, lt: null, dr: '2', tsMs: 3 },
      { bb: '51', st: 'F',  it: null,  lp: 2, lt: 136000, dr: '2', tsMs: 4 },
      { bb: '51', st: 'I1', it: 39100, lp: 3, lt: null, dr: '3', tsMs: 5 },
      { bb: '51', st: 'I2', it: 62100, lp: 3, lt: null, dr: '3', tsMs: 6 },
      { bb: '51', st: 'I3', it: 35100, lp: 3, lt: null, dr: '3', tsMs: 7 },
      { bb: '51', st: 'F',  it: null,  lp: 3, lt: 136300, dr: '3', tsMs: 8 },
    ],
  });

  const car = store.cars.get('51');
  assert.equal(car.lapHistory[0].driverId, '2');
  assert.equal(car.lapHistory[0].driverName, 'Alessio Rovera');
  assert.equal(car.lapHistory[1].driverId, '3');
  assert.equal(car.lapHistory[1].driverName, 'Tommaso Mosca');
  assert.equal(car.activeDriverId, '3');
  assert.equal(car.activeDriverName, 'Tommaso Mosca');
});
