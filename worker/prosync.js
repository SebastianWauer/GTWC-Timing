/**
 * ProSync client — Swiss Timing public live-timing backend.
 *
 * The official SRO live timing (racing.liveresults.swisstiming.com) reads from
 * Swiss Timing's public "ps-cache" cluster. These endpoints are NOT IP-locked,
 * so a Cloudflare Worker can poll them directly — no FTP, no whitelist, no poller.
 *
 * Cache URL: https://ps-cache.web.swisstiming.com/node/db/RAC_PROD/<CHANNEL>.json
 * Channels (UUIDs UPPERCASE!):
 *   SRO_SEASONS_JSON                       → { CurrentSeason, AllSeasons }
 *   SRO_<season>_SEASON_JSON               → { Meetings, Series, PresentationMeetingId }
 *   SRO_<season>_SCHEDULE_<MEETING>_JSON   → { Units, Competitions, PresentationRoundId }
 *   SRO_<season>_TIMING_<UNIT>_JSON        → { UntInfo, Results }
 *   SRO_<season>_COMP_DETAIL_<UNIT>_JSON   → { Competitors, Classes, IntermediateDefinitions }
 */

const PS_BASE = 'https://ps-cache.web.swisstiming.com/node/db/RAC_PROD';
const PROFILE = 'SRO';

// Map ProSync competition SerieId/name → our series keys (GTWorldCh, GT4)
const SERIES_MATCHERS = [
  { key: 'GTWorldCh', test: (name) => /GTWorldCh|World Challenge|Endurance Cup|Sprint Cup/i.test(name) },
  { key: 'GT4', test: (name) => /GT4/i.test(name) },
];

export async function fetchChannel(channel) {
  const url = `${PS_BASE}/${channel}.json?s=unknown&t=${Date.now()}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'gtwc-timing-worker' } });
  if (!res.ok) return null;
  const json = await res.json();
  return json?.content?.full ?? null;
}

/**
 * Discover the current meeting and the live/most-recent unit per series.
 * Returns { season, meetingId, meetingName, perSeries: { <seriesKey>: { unitId, unitName, competitionName } } }
 */
export async function discover(seriesKeys) {
  const seasons = await fetchChannel(`${PROFILE}_SEASONS_JSON`);
  const season = seasons?.CurrentSeason;
  if (!season) return null;

  const seasonDoc = await fetchChannel(`${PROFILE}_${season}_SEASON_JSON`);
  const meetingId = seasonDoc?.PresentationMeetingId
    || pickLiveMeeting(seasonDoc?.Meetings);
  if (!meetingId) return null;
  const meetingName = seasonDoc?.Meetings?.[meetingId]?.Name || '';

  const schedule = await fetchChannel(
    `${PROFILE}_${season}_SCHEDULE_${meetingId.toUpperCase()}_JSON`
  );
  if (!schedule) return null;

  const competitions = schedule.Competitions || {};
  const units = schedule.Units || {};

  // Group units by competition, then map competition → series key
  const perSeries = {};
  for (const key of seriesKeys) {
    const comp = findCompetitionForSeries(competitions, key);
    if (!comp) continue;
    const liveUnit = pickUnitForCompetition(units, comp.Id);
    if (!liveUnit) continue;

    // Full session list for this series' competition (for the session picker)
    const sessions = Object.values(units)
      .filter(u => u.CompetitionId === comp.Id)
      .sort((a, b) => (a.ListIndex || 0) - (b.ListIndex || 0))
      .map(u => ({ unitId: u.Id, name: u.Name, code: u.Code, state: u.State, type: u.Type }));

    perSeries[key] = {
      unitId: liveUnit.Id,
      unitName: liveUnit.Name,
      unitCode: liveUnit.Code,
      unitState: liveUnit.State,
      competitionName: comp.Name,
      sessions,
    };
  }

  return { season, meetingId, meetingName, perSeries };
}

function pickLiveMeeting(meetings) {
  if (!meetings) return null;
  const arr = Object.values(meetings);
  const live = arr.find(m => m.State === 1);
  if (live) return live.Id;
  // else most recent by ListIndex
  arr.sort((a, b) => (b.ListIndex || 0) - (a.ListIndex || 0));
  return arr[0]?.Id || null;
}

function findCompetitionForSeries(competitions, seriesKey) {
  const matcher = SERIES_MATCHERS.find(m => m.key === seriesKey);
  const arr = Object.values(competitions);
  if (matcher) {
    const hit = arr.find(c => matcher.test(c.Name || ''));
    if (hit) return hit;
  }
  // fallback: substring on the raw key
  return arr.find(c => (c.Name || '').includes(seriesKey)) || null;
}

/**
 * Pick the "current" unit for a competition: a live one (State 1) if present,
 * else the latest started/finished one (highest ListIndex among State 1/2).
 */
function pickUnitForCompetition(units, competitionId) {
  const arr = Object.values(units).filter(u => u.CompetitionId === competitionId);
  if (!arr.length) return null;
  const live = arr.find(u => u.State === 1);
  if (live) return live;
  const started = arr.filter(u => u.State === 1 || u.State === 2);
  const pool = started.length ? started : arr;
  pool.sort((a, b) => (b.ListIndex || 0) - (a.ListIndex || 0));
  return pool[0];
}

/** Fetch TIMING + COMP_DETAIL for a unit. */
export async function fetchUnit(season, unitId) {
  const U = unitId.toUpperCase();
  const [timing, detail] = await Promise.all([
    fetchChannel(`${PROFILE}_${season}_TIMING_${U}_JSON`),
    fetchChannel(`${PROFILE}_${season}_COMP_DETAIL_${U}_JSON`),
  ]);
  return { timing, detail };
}

// -----------------------------------------------------------------------
// Adapter: ProSync TIMING + COMP_DETAIL → snapshot for buildViewModel
// -----------------------------------------------------------------------

export function parseMs(t) {
  if (!t || typeof t !== 'string') return null;
  const m = t.match(/^(?:(\d+):)?(\d+)\.(\d+)$/);
  if (!m) return null;
  const min = parseInt(m[1] || '0', 10);
  const sec = parseInt(m[2], 10);
  const frac = parseInt(m[3].padEnd(3, '0').slice(0, 3), 10);
  return (min * 60 + sec) * 1000 + frac;
}

const FLAG_MAP = { 0: 'GREEN', 1: 'GREEN', 2: 'YELLOW', 3: 'FCY', 4: 'SC', 5: 'RED', 6: 'CHEQUERED' };

// Result status is a bit-flag (Swiss Timing): 4=DNF, 8=Excluded, 16=DNS.
// Anything without these bits is running/classified.
function statusLabel(st) {
  const s = Number(st) || 0;
  if (s & 16) return 'DNS';
  if (s & 8) return 'EXC';
  if (s & 4) return 'DNF';
  return null;
}

// Normalise Swiss Timing class names to the clean display names the dashboard
// uses. In particular "PAM" / "Pro-AM Cup" → "Pro-Am" (matches the PRO-AM
// colour + all our Pro-Am class logic). Returns "" for unknown.
const CLASS_NAME_MAP = {
  PAM: 'Pro-Am', 'PRO-AM': 'Pro-Am', PROAM: 'Pro-Am',
  AM: 'AM', SILVER: 'Silver', PRO: 'Pro', GOLD: 'Gold', BRONZE: 'Bronze',
};
// Swiss Timing manufacturer names → the keys used by the logo table.
const MANUFACTURER_MAP = {
  'BMW M': 'BMW',
  'Mercedes': 'Mercedes-AMG',
  'Mercedes AMG': 'Mercedes-AMG',
};
function normalizeManufacturer(name) {
  const n = (name || '').trim();
  return MANUFACTURER_MAP[n] || n;
}

// Format a ProSync gap value ("3.841", "1 Lap") for display ("+3.841", "+1 Lap").
function fmtGap(v) {
  if (v == null || v === '') return undefined;
  const s = String(v).trim();
  if (s === '0' || s === '0.000') return undefined;
  if (/lap/i.test(s)) return s.startsWith('+') ? s : '+' + s;
  if (/^\d/.test(s)) return '+' + s;
  return s;
}

function normalizeClass(cls) {
  if (!cls) return '';
  const short = String(cls.ShortName || '').trim().toUpperCase();
  if (CLASS_NAME_MAP[short]) return CLASS_NAME_MAP[short];
  const full = String(cls.Name || '').trim().toUpperCase().replace(/\s*CUP$/, '');
  if (CLASS_NAME_MAP[full]) return CLASS_NAME_MAP[full];
  // fallback: original short name (or stripped full name)
  return cls.ShortName || (cls.Name || '').replace(/\s*Cup$/i, '') || '';
}

/**
 * Build a snapshot object compatible with buildViewModel().
 * lapHistoryStore: Map<nr, Array<{lap,ms,raw}>> persisted across polls (accumulates history).
 */
export function buildSnapshot({ timing, detail, sessionName, lapHistoryStore }) {
  const competitors = detail?.Competitors || {};
  const classes = detail?.Classes || {};
  const interDefs = (detail?.IntermediateDefinitions || []).map(d => d.Name);
  const results = timing?.Results || {};
  const untInfo = timing?.UntInfo || {};

  const cars = [];
  for (const [cid, comp] of Object.entries(competitors)) {
    const r = results[cid]?.MainResult || {};
    const cls = classes[comp.ClassId] || {};
    const nr = String(comp.Bib ?? '').trim();

    // Skip entries whose start number doesn't begin with a digit
    // (safety car, course cars, test entries, etc.)
    if (!/^\d/.test(nr)) continue;

    const drivers = Object.values(comp.Drivers || {})
      .sort((a, b) => (a.ListIndex || 0) - (b.ListIndex || 0))
      .map(d => ({
        id: d.Id,
        firstName: d.FirstName,
        lastName: d.LastName,
        name: `${d.FirstName || ''} ${d.LastName || ''}`.trim(),
        shortName: d.ShortName,
        license: d.LicenseTypeName,
        country: d.CountryCode,
        active: d.Id === comp.CurrentDriverId,
      }));
    const activeDriver = drivers.find(d => d.active);
    const activeDriverName = activeDriver?.name || '';

    // Sectors from the last lap's intermediates
    const sectors = {};
    const inters = r.LastLap?.Intermediates || r.BestTime?.Intermediates || [];
    inters.forEach((iv, i) => {
      const key = interDefs[i] || `S${i + 1}`;
      sectors[key] = { raw: iv.Time, ms: parseMs(iv.Time), speed: iv.Speed };
    });

    const bestMs = parseMs(r.BestTime?.Time);
    const lastMs = parseMs(r.LastLap?.Time);

    // Accumulate lap history across polls
    let lapHistory = lapHistoryStore.get(nr) || [];
    const lastLapNr = r.LastLap?.LapNumber;
    if (lastLapNr && lastMs != null && !lapHistory.some(l => l.lap === lastLapNr)) {
      lapHistory = [...lapHistory, {
        lap: lastLapNr,
        ms: lastMs,
        raw: r.LastLap.Time,
        sectors: inters.map(iv => ({ raw: iv.Time, ms: parseMs(iv.Time) })),
        driverId: comp.CurrentDriverId,
      }];
      lapHistoryStore.set(nr, lapHistory);
    }

    cars.push({
      nr,
      pos: r.Rank ?? 9999,
      classPos: r.ClassRank ?? null,
      className: normalizeClass(cls),
      classNameFull: cls.Name || '',
      drivers,
      activeDriverId: comp.CurrentDriverId,
      activeDriverName,
      team: comp.TeamName || '',
      car: comp.CarTypeName || '',
      vehicle: comp.CarTypeName || '',
      manufacturer: normalizeManufacturer(comp.ManufacturerName),
      lastLap: { raw: r.LastLap?.Time, ms: lastMs },
      bestLap: { raw: r.BestTime?.Time, ms: bestMs },
      bestLapNr: r.BestTime?.LapNumber ?? null,
      sectors,
      laps: r.TotalLapCount ?? 0,
      pitCount: comp.PitStopCount ?? 0,
      inPit: !!comp.InPitLane,
      status: r.Status,
      statusLabel: statusLabel(r.Status),
      gap: fmtGap(r.Behind),            // to overall leader
      interval: fmtGap(r.Diff),         // to car ahead (overall)
      classGap: fmtGap(r.ClassBehind),  // to class leader
      classInterval: fmtGap(r.ClassDiff), // to car ahead in class
      totalTime: r.TotalTime || null,
      lapHistory,
      _bestLapByDriver: {},
    });
  }

  cars.sort((a, b) => a.pos - b.pos);

  const flag = FLAG_MAP[untInfo.TrackFlag] || 'GREEN';
  const session = {
    sessionName: sessionName || '',
    flag: untInfo.ChequeredFlag ? 'CHEQUERED' : flag,
    remainingTime: untInfo.RemainingTime || null,
    startTime: untInfo.StartRealTime || null,
  };

  // Race Control messages (most recent last, matching the sidebar renderer)
  const announcements = (detail?.Messages || [])
    .map(m => ({ dt: m.Time, text: m.Text, type: m.Type }))
    .reverse();

  return {
    cars,
    allCars: cars,
    session,
    announcements,
    classes: classListFrom(classes),
    manufacturers: {},
    bestSectors: {},
    sessionBestSectors: {},
    theoreticalBest: {},
    outLapCars: new Set(),
    neutralizationPhases: [],
  };
}

function classListFrom(classes) {
  return Object.values(classes)
    .sort((a, b) => (a.ListIndex || 0) - (b.ListIndex || 0))
    .map(normalizeClass)
    .filter(Boolean);
}
