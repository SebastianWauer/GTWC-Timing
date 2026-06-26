'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseTimeToMs, formatMs, formatGap, parseEntryListXml, parseResultListXml, mergeEntryAndResult } = require('../src/xml-parser');

// -----------------------------------------------------------------------
// parseTimeToMs (legacy string parser)
// -----------------------------------------------------------------------
test('parses m:ss.mmm format', () => assert.equal(parseTimeToMs('1:23.456'), 83456));
test('parses ss.mmm format', () => assert.equal(parseTimeToMs('23.456'), 23456));
test('parses 2-digit ms', () => assert.equal(parseTimeToMs('23.45'), 23450));
test('returns null for dash', () => assert.equal(parseTimeToMs('-'), null));
test('returns null for empty string', () => assert.equal(parseTimeToMs(''), null));
test('returns null for null', () => assert.equal(parseTimeToMs(null), null));
test('parses plain integer ms', () => assert.equal(parseTimeToMs('114690'), 114690));

// -----------------------------------------------------------------------
// formatMs
// -----------------------------------------------------------------------
test('formats ms with minutes', () => assert.equal(formatMs(83456), '1:23.456'));
test('formats ms without minutes', () => assert.equal(formatMs(23456), '23.456'));
test('formats zero', () => assert.equal(formatMs(0), '0.000'));
test('returns dash for null', () => assert.equal(formatMs(null), '-'));
test('formats 114690ms → 1:54.690', () => assert.equal(formatMs(114690), '1:54.690'));

// -----------------------------------------------------------------------
// formatGap
// -----------------------------------------------------------------------
test('formats gap 0 as dash', () => assert.equal(formatGap(0), '-'));
test('formats gap 64ms as +0.064', () => assert.equal(formatGap(64), '+0.064'));
test('formats gap 1234ms as +1.234', () => assert.equal(formatGap(1234), '+1.234'));
test('formats gap 65000ms (over 1min)', () => assert.equal(formatGap(65000), '+1:05.000'));

// -----------------------------------------------------------------------
// parseEntryListXml – real SRO format
// -----------------------------------------------------------------------
const ENTRY_XML = `<?xml version="1.0"?>
<FILE>
  <SESS>
    <Competition>GTWorldChEU pwrd by AWS Endurance Cup</Competition>
    <Meeting>GT WorldChEU pwrd by AWS Endurance Cup Round 1</Meeting>
    <Session>Free Practice 1</Session>
    <Track>Paul Ricard Short</Track>
    <StartTime>10.04.2026 14:25:00.000</StartTime>
  </SESS>
  <ENTR>
    <Bib>10</Bib>
    <Car>Porsche 911 GT3 R EVO</Car>
    <Class>Gold Cup</Class>
    <Driver1><Country>BEL</Country><First>Gilles</First><Last>Magnus</Last><Short>MAG</Short><Id>1</Id></Driver1>
    <Driver2><Country>SWE</Country><First>Robin</First><Last>Knutsson</Last><Short>KNU</Short><Id>2</Id></Driver2>
    <Driver3><Country /><First /><Last /><Short /><Id /></Driver3>
    <Driver4><Country /><First /><Last /><Short /><Id /></Driver4>
    <Team>Boutsen VDS</Team>
  </ENTR>
  <ENTR>
    <Bib>11</Bib>
    <Car>Aston Martin Vantage AMR GT3 EVO</Car>
    <Class>Bronze Cup</Class>
    <Driver1><Country>BRA</Country><First>Marcelo</First><Last>Tomasoni</Last><Short>TOM</Short><Id>1</Id></Driver1>
    <Driver2><Country /><First /><Last /><Short /><Id /></Driver2>
    <Driver3><Country /><First /><Last /><Short /><Id /></Driver3>
    <Driver4><Country /><First /><Last /><Short /><Id /></Driver4>
    <Team>Comtoyou Racing</Team>
  </ENTR>
</FILE>`;

test('parses ENTRY_LIST session info', () => {
  const { session } = parseEntryListXml(ENTRY_XML);
  assert.equal(session.sessionName, 'Free Practice 1');
  assert.equal(session.trackName, 'Paul Ricard Short');
  assert.equal(session.competition, 'GTWorldChEU pwrd by AWS Endurance Cup');
});

test('parses ENTRY_LIST entries count', () => {
  const { entries } = parseEntryListXml(ENTRY_XML);
  assert.equal(entries.size, 2);
});

test('parses ENTRY_LIST car 10 fields', () => {
  const { entries } = parseEntryListXml(ENTRY_XML);
  const e = entries.get('10');
  assert.ok(e);
  assert.equal(e.className, 'Gold Cup');
  assert.equal(e.vehicle, 'Porsche 911 GT3 R EVO');
  assert.equal(e.manufacturer, 'Porsche');
  assert.equal(e.team, 'Boutsen VDS');
  assert.equal(e.drivers.length, 2);
  assert.equal(e.drivers[0].id, '1');
  assert.equal(e.drivers[0].sourceId, '1');
  assert.equal(e.drivers[0].seatIndex, '1');
  assert.equal(e.drivers[0].name, 'Gilles Magnus');
  assert.equal(e.drivers[1].name, 'Robin Knutsson');
});

test('keeps source driver ids and stores seat index separately', () => {
  const xml = `<?xml version="1.0"?>
<FILE>
  <ENTR>
    <Bib>51</Bib>
    <Car>Ferrari 296 GT3 EVO</Car>
    <Class>Pro Cup</Class>
    <Driver1><First>Alessio</First><Last>Rovera</Last><Short>ROV</Short><Id>2</Id></Driver1>
    <Driver2><First>Tommaso</First><Last>Mosca</Last><Short>MOS</Short><Id>3</Id></Driver2>
    <Driver3><First>Nicklas</First><Last>Nielsen</Last><Short>NNI</Short><Id>4</Id></Driver3>
    <Team>AF Corse</Team>
  </ENTR>
</FILE>`;
  const { entries } = parseEntryListXml(xml);
  const drivers = entries.get('51').drivers;
  assert.deepEqual(
    drivers.map(driver => ({ id: driver.id, sourceId: driver.sourceId, seatIndex: driver.seatIndex, name: driver.name })),
    [
      { id: '2', sourceId: '2', seatIndex: '1', name: 'Alessio Rovera' },
      { id: '3', sourceId: '3', seatIndex: '2', name: 'Tommaso Mosca' },
      { id: '4', sourceId: '4', seatIndex: '3', name: 'Nicklas Nielsen' },
    ]
  );
});

test('parses ENTRY_LIST Aston Martin manufacturer', () => {
  const { entries } = parseEntryListXml(ENTRY_XML);
  assert.equal(entries.get('11').manufacturer, 'Aston Martin');
});

// -----------------------------------------------------------------------
// parseResultListXml – real SRO format (ms integers)
// -----------------------------------------------------------------------
const RESULT_XML = `<?xml version="1.0"?>
<FILE>
  <RES>
    <Bib>3</Bib><Rank>1</Rank><Pos>1</Pos><StartPos>0</StartPos>
    <Laps>32</Laps><Time>114690</Time><BestTime>114690</BestTime>
    <BestLap>30</BestLap><LastTime>297929</LastTime><LastLap>32</LastLap>
    <Gap>0</Gap><Diff>0</Diff>
  </RES>
  <RES>
    <Bib>84</Bib><Rank>2</Rank><Pos>2</Pos><StartPos>0</StartPos>
    <Laps>37</Laps><Time>114754</Time><BestTime>114754</BestTime>
    <BestLap>4</BestLap><LastTime>167474</LastTime><LastLap>37</LastLap>
    <Gap>64</Gap><Diff>64</Diff>
  </RES>
</FILE>`;

test('parses RESULT_LIST count', () => {
  assert.equal(parseResultListXml(RESULT_XML).length, 2);
});

test('parses RESULT_LIST leader (gap=0 → dash)', () => {
  const results = parseResultListXml(RESULT_XML);
  const leader = results[0];
  assert.equal(leader.nr, '3');
  assert.equal(leader.pos, 1);
  assert.equal(leader.laps, 32);
  assert.equal(leader.bestLap.ms, 114690);
  assert.equal(leader.bestLap.raw, '1:54.690');
  assert.equal(leader.gap, '-');
  assert.equal(leader.interval, '-');
});

test('parses RESULT_LIST second car gap', () => {
  const r = parseResultListXml(RESULT_XML)[1];
  assert.equal(r.nr, '84');
  assert.equal(r.gap, '+0.064');
  assert.equal(r.interval, '+0.064');
});

// -----------------------------------------------------------------------
// mergeEntryAndResult
// -----------------------------------------------------------------------
test('merge combines entry and result by bib', () => {
  const { entries } = parseEntryListXml(ENTRY_XML);
  const results = parseResultListXml(RESULT_XML);
  // results use bib 3 and 84, entries use 10 and 11 — no overlap
  // add a matching entry
  entries.set('3', { className: 'Pro Cup', vehicle: 'BMW M4', manufacturer: 'BMW', team: 'Schubert', drivers: [{ id: '1', name: 'Van der Linde', short: 'VDL', country: 'ZAF' }] });
  const merged = mergeEntryAndResult(entries, results);
  const car3 = merged.find(c => c.nr === '3');
  assert.ok(car3);
  assert.equal(car3.className, 'Pro Cup');
  assert.equal(car3.manufacturer, 'BMW');
  assert.equal(car3.activeDriverName, 'Van der Linde');
  assert.equal(car3.bestLap.ms, 114690);
});
