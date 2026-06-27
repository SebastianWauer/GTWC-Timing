'use strict';

/* ---------------------------------------------------------------
   Sidebar Renderer
   Right analysis panel: best sectors, theoretical best,
   manufacturers, car detail history.
   --------------------------------------------------------------- */

let _manufacturerSort = 'count'; // 'count' | 'pos'
let _mfrExpanded = new Set();   // which manufacturers are expanded
let _lastSidebarArgs = null;

function renderSidebar(container, vm, selectedNr) {
  _lastSidebarArgs = [container, vm, selectedNr];
  const { announcements, bestSectors, theoreticalBest, manufacturers, cars } = vm;

  let html = '';

  // ---- Race Control ----
  html += `<div class="sidebar-section">
    <h3>Race Control</h3>`;
  if (announcements && announcements.length > 0) {
    const msgs = [...announcements].reverse().slice(0, 6);
    for (const item of msgs) {
      const time = formatRcTime(item.dt || '');
      html += `<div class="sidebar-rc-msg">${time ? `<span class="sidebar-rc-time">${time}</span>` : ''}<span class="sidebar-rc-text">${escHtml(item.text || '')}</span></div>`;
    }
  } else {
    html += `<div style="color:var(--color-text-muted);font-size:10px">-</div>`;
  }
  html += `</div>`;

  // ---- Best Sectors ----
  const theoStr = theoreticalBest ? escHtml(theoreticalBest.formatted) : '';
  html += `<div class="sidebar-section">
    <h3>Best Sectors${theoStr ? `<span class="sector-theo-best"><span class="sector-theo-label">Theoretical Best:</span> ${theoStr}</span>` : ''}</h3>`;
  if (bestSectors && bestSectors.length > 0) {
    for (const s of bestSectors) {
      const sectorCar = cars.find(c => c.nr === s.carNr);
      const logo = sectorCar ? window.LogoUtils.imgTag(sectorCar.manufacturer, 16) : '';
      const driver = sectorCar?.drivers?.find(d => d.id === s.driverId) || sectorCar?.drivers?.[0];
      const driverLabel = (() => {
        if (!driver?.name) return '';
        const parts = driver.name.trim().split(/\s+/);
        const last = parts.pop();
        const initial = parts.length > 0 ? parts[0][0] + '. ' : '';
        return escHtml(initial + last);
      })();
      html += `<div class="best-sector-row">
        <span class="best-sector-key">${escHtml(s.key)}</span>
        <span class="best-sector-time">${escHtml(s.formatted)}</span>
        <span class="best-sector-spacer"></span>
        <span class="best-sector-car">#${escHtml(s.carNr || '?')}</span>
        ${logo ? `<span class="best-sector-logo">${logo}</span>` : ''}
        ${driverLabel ? `<span class="best-sector-driver">${driverLabel}</span>` : ''}
      </div>`;
    }
  } else {
    html += `<div style="color:var(--color-text-muted);font-size:10px">–</div>`;
  }

  html += `</div>`;

  // ---- Manufacturers ----
  const mfrBtnCount = `<button class="mfr-sort-btn${_manufacturerSort === 'count' ? ' active' : ''}" data-sort="count"># Autos</button>`;
  const mfrBtnPos   = `<button class="mfr-sort-btn${_manufacturerSort === 'pos'   ? ' active' : ''}" data-sort="pos">Position</button>`;
  html += `<div class="sidebar-section">
    <h3>Manufacturers <span class="mfr-sort-btns">${mfrBtnCount}${mfrBtnPos}</span></h3>`;
  if (manufacturers && Object.keys(manufacturers).length > 0) {
    const entries = Object.entries(manufacturers);
    const sorted = _manufacturerSort === 'pos'
      ? entries.sort((a, b) => (a[1].bestPos ?? Infinity) - (b[1].bestPos ?? Infinity))
      : entries.sort((a, b) => b[1].count - a[1].count);
    for (const [make, info] of sorted) {
      const expanded = _mfrExpanded.has(make);
      const chevron = expanded ? '▾' : '▸';
      const mfrCars = cars
        .filter(c => c.manufacturer === make)
        .sort((a, b) => (a.pos || 999) - (b.pos || 999));

      if (expanded) {
        const bestCar = info.bestNr ? cars.find(c => c.nr === info.bestNr) : null;
        const bestNrStr   = info.bestNr  ? `#${escHtml(String(info.bestNr))}` : '';
        const bestTeamStr = bestCar?.team ? escHtml(bestCar.team) : '';
        const bestPosStr  = info.bestPos  ? `P${info.bestPos}` : '';
        const otherCars   = mfrCars.filter(c => c.nr !== info.bestNr);
        html += `<div class="mfr-block">
          <div class="manufacturer-row mfr-toggle" data-make="${escHtml(make)}">
            <span class="mfr-chevron">${chevron}</span>
            <span class="mfr-name">${escHtml(make)} <span class="mfr-count">(${info.count})</span></span>
            <span class="manufacturer-best">
              <span class="mfr-best-nr">${bestNrStr}</span>
              <span class="mfr-best-team">${bestTeamStr}</span>
              <span class="mfr-best-pos">${bestPosStr}</span>
            </span>
          </div>`;
        for (const c of otherCars) {
          html += `<div class="mfr-car-row">
            <span class="mfr-car-spacer"></span>
            <span class="mfr-best-nr">#${escHtml(c.nr)}</span>
            <span class="mfr-best-team">${escHtml(c.team || '')}</span>
            <span class="mfr-best-pos">P${c.pos || '–'}</span>
          </div>`;
        }
        html += `</div>`;
      } else {
        const bestCar = info.bestNr ? cars.find(c => c.nr === info.bestNr) : null;
        const bestNrStr   = info.bestNr  ? `#${escHtml(String(info.bestNr))}` : '';
        const bestTeamStr = bestCar?.team ? escHtml(bestCar.team) : '';
        const bestPosStr  = info.bestPos  ? `P${info.bestPos}` : '';
        html += `<div class="manufacturer-row mfr-toggle" data-make="${escHtml(make)}">
          <span class="mfr-chevron">${chevron}</span>
          <span class="mfr-name">${escHtml(make)} <span class="mfr-count">(${info.count})</span></span>
          <span class="manufacturer-best">
            <span class="mfr-best-nr">${bestNrStr}</span>
            <span class="mfr-best-team">${bestTeamStr}</span>
            <span class="mfr-best-pos">${bestPosStr}</span>
          </span>
        </div>`;
      }
    }
  } else {
    html += `<div style="color:var(--color-text-muted);font-size:10px">–</div>`;
  }
  html += `</div>`;

  // ---- Car Detail ----
  if (selectedNr) {
    const car = cars.find(c => c.nr === selectedNr);
    if (car) {
      html += renderCarDetail(car, vm);
    }
  }

  container.innerHTML = html;

  // Use one delegated click handler on the (persistent) container instead of
  // re-attaching per element on every render. The sidebar re-renders every
  // ~2s in live mode, which made per-render listeners unreliable to click.
  if (!container._sidebarDelegated) {
    container._sidebarDelegated = true;
    container.addEventListener('click', (e) => {
      const sortBtn = e.target.closest('.mfr-sort-btn');
      if (sortBtn) {
        _manufacturerSort = sortBtn.dataset.sort;
        if (_lastSidebarArgs) renderSidebar(..._lastSidebarArgs);
        return;
      }
      const toggle = e.target.closest('.mfr-toggle');
      if (toggle) {
        const make = toggle.dataset.make;
        if (_mfrExpanded.has(make)) _mfrExpanded.delete(make);
        else _mfrExpanded.add(make);
        if (_lastSidebarArgs) renderSidebar(..._lastSidebarArgs);
      }
    });
  }
}

function formatRcTime(dt) {
  const m = dt.match(/(\d{2}):(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}:${m[3]}` : '';
}

function renderCarDetail(car, vm) {
  const { colorClass, classify = () => null } = window.ColorUtils;
  const overallBestLap   = vm?.overallBestLap ?? null;
  const classBestLap     = car.classBestLap   ?? null;   // per-car's-class best
  const classSectorBests = car.classSectorBests ?? {};   // per-car's-class sector bests
  const overallSectors   = vm?.overallSectorBests ?? Object.fromEntries((vm?.bestSectors || []).map(s => [s.key, s.ms]));

  let html = `<div class="sidebar-section">
    <h3>Car #${escHtml(car.nr)} – Detail</h3>
    <div class="detail-header">${escHtml(car.team || '')} / ${escHtml(car.vehicle || '')}</div>`;

  // Best lap per driver — 4-level colour vs car/class/overall
  if (car.bestLapByDriver && Object.keys(car.bestLapByDriver).length > 0) {
    html += `<div class="detail-driver-best">`;
    const carBestLap = car.bestLap?.ms ?? null;
    for (const [dId, info] of Object.entries(car.bestLapByDriver)) {
      const driverName = shortName(car.drivers?.find(d => d.id === dId)?.name) || dId;
      const color = classify(info.ms, info.ms, carBestLap, classBestLap, overallBestLap);
      html += `<div>${escHtml(driverName)}: <span class="${colorClass(color)}">${formatMs(info.ms)}</span> (Rd ${info.lapNr})</div>`;
    }
    html += `</div>`;
  }

  // Lap history table with 4-level colour on every cell
  const laps = car.lapHistory || [];
  if (laps.length > 0) {
    const sectorKeys = [...new Set(laps.flatMap(l => Object.keys(l.sectors || {})))].sort();
    html += `<div style="overflow-x:auto"><table class="lap-history-table">
      <thead><tr>
        <th>Lap</th>
        <th>Driver</th>
        ${sectorKeys.map(k => `<th>${escHtml(k)}</th>`).join('')}
        <th>Time</th>
      </tr></thead>
      <tbody>`;

    for (const lap of [...laps].reverse()) {
      const lapMs      = lap.lapTime?.ms ?? null;
      const driverName = shortName(lap.driverName) || lap.driverId || '-';
      const driverBest = car.bestLapByDriver?.[lap.driverId]?.ms ?? null;
      const carBestLap = car.bestLap?.ms ?? null;
      const lapColor   = classify(lapMs, driverBest, carBestLap, classBestLap, overallBestLap);

      html += `<tr>
        <td>${lap.lapNr}</td>
        <td style="text-align:left;color:var(--color-text-dim)">${escHtml(driverName)}</td>
        ${sectorKeys.map(k => {
          const s = lap.sectors?.[k];
          if (!s) return `<td>-</td>`;
          const carSecBest    = car.bestSectorsByKey?.[k]?.ms ?? null;
          const driverSecBest = car.bestSectorsByDriver?.[lap.driverId]?.[k]?.ms ?? null;
          const secColor      = classify(s.ms, driverSecBest, carSecBest, classSectorBests[k] ?? null, overallSectors[k] ?? null);
          return `<td class="${colorClass(secColor)}">${escHtml(s.raw || '-')}</td>`;
        }).join('')}
        <td class="${colorClass(lapColor)}">${lap.lapTime?.raw || '-'}</td>
      </tr>`;
    }

    html += `</tbody></table></div>`;
  } else {
    html += `<div style="color:var(--color-text-muted);font-size:10px;margin-top:4px">No lap history available</div>`;
  }

  html += `</div>`;
  return html;
}

function formatMs(ms) {
  if (ms === null || ms === undefined) return '-';
  const totalSec = Math.floor(ms / 1000);
  const msRem = ms % 1000;
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  if (minutes > 0) {
    return `${minutes}:${String(seconds).padStart(2, '0')}.${String(msRem).padStart(3, '0')}`;
  }
  return `${seconds}.${String(msRem).padStart(3, '0')}`;
}

function renderLapTimeChart(laps, options = {}) {
  return renderMultiLapTimeChart([{ nr: 'selected', lapHistory: laps }], options);
}

function renderMultiLapTimeChart(cars, options = {}) {
  const { showHeader = true, phases = [] } = options;
  const palette = ['#60a5fa', '#f97316', '#4ade80', '#facc15', '#c084fc', '#f87171'];
  const series = cars
    .map((car, index) => ({
      nr: car.nr,
      team: car.team || '',
      color: palette[index % palette.length],
      laps: (car.lapHistory || [])
        .filter(lap => lap?.lapTime?.ms)
        .map(lap => ({ lapNr: lap.lapNr, ms: lap.lapTime.ms, raw: lap.lapTime.raw || formatMs(lap.lapTime.ms) })),
    }))
    .filter(seriesItem => seriesItem.laps.length > 0);

  if (series.length === 0) return '';

  const width = 360;
  const height = 170;
  const paddingTop = 12;
  const paddingRight = 12;
  const paddingBottom = 24;
  const paddingLeft = 42;
  const plotWidth = width - paddingLeft - paddingRight;
  const plotHeight = height - paddingTop - paddingBottom;

  const allLaps = series.flatMap(seriesItem => seriesItem.laps);
  const values = allLaps.map(lap => lap.ms);
  const minMs = Math.min(...values);
  const axisMaxMs = Math.round(minMs * 1.15);
  const maxMs = Math.min(Math.max(...values), axisMaxMs);
  const rangeMs = Math.max(maxMs - minMs, 1);
  const yTopLabel = formatMs(maxMs);
  const yBottomLabel = formatMs(minMs);
  const lapNumbers = [...new Set(allLaps.map(lap => lap.lapNr))].sort((a, b) => a - b);
  const xStartLabel = `Lap ${lapNumbers[0]}`;
  const xEndLabel = `Lap ${lapNumbers[lapNumbers.length - 1]}`;
  const firstLapNr = lapNumbers[0];
  const lastLapNr = lapNumbers[lapNumbers.length - 1];
  const lapIndex = new Map(lapNumbers.map((lapNr, index) => [lapNr, index]));
  const xForLap = (lapNr) => paddingLeft + (lapNumbers.length === 1 ? plotWidth / 2 : (lapIndex.get(lapNr) / (lapNumbers.length - 1)) * plotWidth);

  const seriesWithPoints = series.map(seriesItem => ({
    ...seriesItem,
    points: seriesItem.laps.map(lap => ({
      ...lap,
      x: xForLap(lap.lapNr),
      y: paddingTop + ((maxMs - lap.ms) / rangeMs) * plotHeight,
    })),
  }));

  const phaseBands = phases
    .map(phase => {
      const startLap = Math.max(firstLapNr, phase.startLap);
      const endLap = Math.min(lastLapNr, phase.endLap);
      if (endLap < startLap) return null;

      const startIndex = lapIndex.has(startLap) ? lapIndex.get(startLap) : lapNumbers.findIndex(lapNr => lapNr >= startLap);
      let endIndex = lapIndex.has(endLap) ? lapIndex.get(endLap) : -1;
      if (endIndex === -1) {
        for (let index = lapNumbers.length - 1; index >= 0; index--) {
          if (lapNumbers[index] <= endLap) {
            endIndex = index;
            break;
          }
        }
      }
      if (startIndex < 0 || endIndex < 0 || endIndex < startIndex) return null;

      const leftX = xForLap(lapNumbers[startIndex]);
      const rightX = xForLap(lapNumbers[endIndex]);
      const stepWidth = lapNumbers.length === 1 ? plotWidth : plotWidth / Math.max(lapNumbers.length - 1, 1);
      const bandStart = Math.max(paddingLeft, leftX - stepWidth / 2);
      const bandEnd = Math.min(paddingLeft + plotWidth, rightX + stepWidth / 2);
      return {
        ...phase,
        x: bandStart,
        width: Math.max(2, bandEnd - bandStart),
      };
    })
    .filter(Boolean);

  return `<div class="lap-chart-block">
    ${showHeader ? `<div class="lap-chart-header">
      <span class="lap-chart-title">Lap Times</span>
      <span class="lap-chart-range">${escHtml(yBottomLabel)} - ${escHtml(yTopLabel)}</span>
    </div>` : ''}
    <div class="lap-chart-legend">
      ${seriesWithPoints.map(seriesItem => `<span class="lap-chart-legend-item"><span class="lap-chart-legend-swatch" style="background:${seriesItem.color}"></span>#${escHtml(seriesItem.nr)}</span>`).join('')}
    </div>
    <svg class="lap-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-label="Lap time chart">
      ${phaseBands.map(phase => `<rect class="lap-chart-phase lap-chart-phase--${phase.type.toLowerCase()}" x="${phase.x.toFixed(1)}" y="${paddingTop}" width="${phase.width.toFixed(1)}" height="${plotHeight}">
        <title>${escHtml(phase.type)} Lap ${escHtml(phase.startLap)}-${escHtml(phase.endLap)}</title>
      </rect>`).join('')}
      <line class="lap-chart-axis" x1="${paddingLeft}" y1="${paddingTop}" x2="${paddingLeft}" y2="${paddingTop + plotHeight}"></line>
      <line class="lap-chart-axis" x1="${paddingLeft}" y1="${paddingTop + plotHeight}" x2="${paddingLeft + plotWidth}" y2="${paddingTop + plotHeight}"></line>
      <line class="lap-chart-grid" x1="${paddingLeft}" y1="${paddingTop}" x2="${paddingLeft + plotWidth}" y2="${paddingTop}"></line>
      <line class="lap-chart-grid" x1="${paddingLeft}" y1="${paddingTop + plotHeight / 2}" x2="${paddingLeft + plotWidth}" y2="${paddingTop + plotHeight / 2}"></line>
      <text class="lap-chart-label" x="${paddingLeft - 6}" y="${paddingTop + 4}" text-anchor="end">${escHtml(yTopLabel)}</text>
      <text class="lap-chart-label" x="${paddingLeft - 6}" y="${paddingTop + plotHeight + 4}" text-anchor="end">${escHtml(yBottomLabel)}</text>
      <text class="lap-chart-label" x="${paddingLeft}" y="${height - 6}" text-anchor="start">${escHtml(xStartLabel)}</text>
      <text class="lap-chart-label" x="${paddingLeft + plotWidth}" y="${height - 6}" text-anchor="end">${escHtml(xEndLabel)}</text>
      ${seriesWithPoints.map(seriesItem => `<polyline class="lap-chart-line" style="stroke:${seriesItem.color}" points="${seriesItem.points.map(point => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ')}"></polyline>`).join('')}
      ${seriesWithPoints.map(seriesItem => seriesItem.points.map(point => `<circle class="lap-chart-point" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="2.5" style="fill:${seriesItem.color}"><title>Car #${escHtml(seriesItem.nr)} Lap ${escHtml(point.lapNr)}: ${escHtml(point.raw)}</title></circle>`).join('')).join('')}
    </svg>
  </div>`;
}

function shortName(fullName) {
  if (!fullName) return '';
  const parts = String(fullName).trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  return `${parts[0][0]}. ${parts.slice(1).join(' ')}`;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

window.SidebarRenderer = { renderSidebar, renderLapTimeChart, renderMultiLapTimeChart };
